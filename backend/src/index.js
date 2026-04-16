require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { sequelize } = require('./models');

const authRouter          = require('./routes/auth');
const tenantsRouter       = require('./routes/tenants');
const conversationsRouter = require('./routes/conversations');
const paymentsRouter      = require('./routes/payments');
const clientsRouter       = require('./routes/clients');
const kbRouter            = require('./routes/kb');
const subscriptionsRouter = require('./routes/subscriptions');
const schedulingRouter    = require('./routes/scheduling');
const whatsappRouter      = require('./routes/whatsapp');

const app = express();

// ── Segurança e middlewares globais ──────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Rate limiting global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Health check — ANTES de tudo para o Railway validar o deploy ──
let dbReady = false;
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', db: dbReady, ts: new Date() });
});

// ── Raiz sem parâmetros → redireciona para login (admin) ──────
// Se vier com ?tenant=... o chat é servido diretamente sem login.
// /chat/<slug> cai no fallback SPA abaixo (também sem login).
app.get('/', (req, res) => {
  if (req.query.tenant) {
    // URL legada do chat: /?tenant=<slug> → serve o chat sem login
    return res.sendFile(path.join(__dirname, '../../frontend/index.html'));
  }
  res.redirect('/login.html');
});

// ── Servir frontend estático ──────────────────────────────────
app.use(express.static(path.join(__dirname, '../../frontend')));

// ── Rotas da API ──────────────────────────────────────────────
app.use('/api/auth',          authRouter);
app.use('/api/tenants',       tenantsRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/payments',      paymentsRouter);
app.use('/api/clients',       clientsRouter);
app.use('/api/kb',            kbRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/scheduling',    schedulingRouter);
app.use('/api/whatsapp',      whatsappRouter);

// ── Fallback SPA ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

// ── Inicialização ─────────────────────────────────────────────
// O servidor sobe PRIMEIRO para o healthcheck do Railway passar,
// depois conecta ao banco de forma assíncrona.
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀  Servidor rodando na porta ${PORT}`);
});

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅  Banco de dados conectado.');
    await sequelize.sync({ alter: true });
    console.log('✅  Models sincronizados.');
    dbReady = true;

    // ── Job: fecha conversas abertas sem atividade há 30 min ──
    // Roda logo ao iniciar e, depois, a cada 15 minutos.
    const { Conversation: ConvModel, Message: MsgModel } = require('./models');
    async function autoCloseInactive() {
      try {
        const { Op } = require('sequelize');
        const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 min atrás
        const stale = await ConvModel.findAll({
          where: { status: 'open', updatedAt: { [Op.lt]: cutoff } },
        });
        if (stale.length > 0) {
          const ids = stale.map((c) => c.id);
          await ConvModel.update({ status: 'closed' }, { where: { id: { [Op.in]: ids } } });
          console.log(`🔒  Auto-fechou ${stale.length} conversa(s) inativa(s).`);
        }
      } catch (e) {
        console.warn('⚠️  autoCloseInactive:', e.message);
      }
    }
    autoCloseInactive();
    setInterval(autoCloseInactive, 15 * 60 * 1000);

    // ── Job: envia notificações de cobrança no horário cadastrado ──
    // Roda a cada minuto. Usa horário de Brasília (UTC-3).
    const { PaymentSchedule: PSModel, Tenant: TenantModelForNotif } = require('./models');
    const { notifyClientPayment } = require('./services/whatsappService');

    // Normaliza registros antigos que possam ter HH:MM:SS no notify_time
    (async () => {
      try {
        const { Op: OpFix, literal } = require('sequelize');
        const toFix = await PSModel.findAll({
          where: { notify_time: { [OpFix.like]: '__:__:__%' } },
          attributes: ['id', 'notify_time'],
        });
        for (const s of toFix) {
          await s.update({ notify_time: s.notify_time.slice(0, 5) });
        }
        if (toFix.length > 0) console.log(`🔧 notify_time normalizado em ${toFix.length} registro(s).`);
      } catch (e) { console.warn('normalize notify_time:', e.message); }
    })();

    async function sendScheduledPaymentNotifications() {
      try {
        // ── Hora atual em Brasília (UTC-3) ──────────────────────────────
        const now = new Date();
        const brDate      = new Date(now.getTime() - 3 * 60 * 60 * 1000);
        const brHH        = String(brDate.getUTCHours()).padStart(2, '0');
        const brMM        = String(brDate.getUTCMinutes()).padStart(2, '0');
        const currentTime = `${brHH}:${brMM}`;
        const todayDate   = brDate.toISOString().slice(0, 10);
        const todayDay    = brDate.getUTCDate();

        const { Op } = require('sequelize');

        // ── Busca candidatos ──────────────────────────────────────────
        // once: só envia se notification_status=pending (envio único)
        // recorrentes: sem restrição de status — deduplicação via last_notified_at
        const candidates = await PSModel.findAll({
          where: {
            notify_time: { [Op.like]: `${currentTime}%` },
            [Op.or]: [
              { recurrence: 'once',    notification_status: 'pending' },
              { recurrence: 'monthly' },
              { recurrence: 'weekly'  },
              { recurrence: 'yearly'  },
            ],
          },
        });

        for (const schedule of candidates) {
          try {
            // ── Deduplicação por data BR ───────────────────────────────
            let lastNotifiedDateBR = null;
            if (schedule.last_notified_at) {
              const lastBR = new Date(new Date(schedule.last_notified_at).getTime() - 3 * 60 * 60 * 1000);
              lastNotifiedDateBR = lastBR.toISOString().slice(0, 10);
            }
            if (lastNotifiedDateBR === todayDate) continue;

            // ── Verifica se deve disparar hoje ─────────────────────────
            let shouldSend = false;
            if (schedule.recurrence === 'once') {
              shouldSend = schedule.due_date === todayDate;
            } else if (schedule.recurrence === 'monthly') {
              shouldSend = Number(schedule.recurring_day) === todayDay;
            } else {
              shouldSend = schedule.due_date === todayDate;
            }
            if (!shouldSend) continue;

            // ── Envia ──────────────────────────────────────────────────
            const tenant = await TenantModelForNotif.findByPk(schedule.tenant_id, { attributes: ['name'] });
            await notifyClientPayment(schedule, tenant?.name || '');

            const updates = { last_notified_at: now };
            if (schedule.recurrence === 'once') updates.notification_status = 'sent';
            await schedule.update(updates);

            console.log(`📤 Notificação enviada: cliente="${schedule.client_name}" recorrência=${schedule.recurrence} data=${todayDate} horário=${currentTime}`);
          } catch (err) {
            console.error(`⚠️  Erro ao notificar cobrança ${schedule.id}:`, err.message);
          }
        }
      } catch (e) {
        console.warn('⚠️  sendScheduledPaymentNotifications:', e.message);
      }
    }

    // ── Catch-up: recupera notificações perdidas do dia ──────────────
    // Roda uma vez na inicialização — captura qualquer registro cujo
    // notify_time já passou hoje mas nunca foi enviado (ex: server restart)
    async function catchUpTodayNotifications() {
      try {
        const now     = new Date();
        const brDate  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
        const brHH    = String(brDate.getUTCHours()).padStart(2, '0');
        const brMM    = String(brDate.getUTCMinutes()).padStart(2, '0');
        const todayDate = brDate.toISOString().slice(0, 10);
        const todayDay  = brDate.getUTCDate();

        const { Op } = require('sequelize');

        // Catch-up para once: nunca notificados, vencimento hoje, horário já passou
        // Catch-up para recorrentes: não notificados hoje, dia bate, horário já passou
        const missed = await PSModel.findAll({
          where: {
            notify_time: { [Op.ne]: null },
            [Op.or]: [
              { recurrence: 'once',    notification_status: 'pending', due_date: todayDate, last_notified_at: null },
              { recurrence: 'monthly', recurring_day: todayDay },
              { recurrence: 'weekly',  due_date: todayDate },
              { recurrence: 'yearly',  due_date: todayDate },
            ],
          },
        });

        for (const schedule of missed) {
          if (!schedule.notify_time) continue;
          // Deduplicação: já enviou hoje em horário BR?
          if (schedule.last_notified_at) {
            const lastBR = new Date(new Date(schedule.last_notified_at).getTime() - 3 * 60 * 60 * 1000);
            if (lastBR.toISOString().slice(0, 10) === todayDate) continue;
          }
          // Só envia se o horário programado já passou
          const [hh, mm] = schedule.notify_time.split(':').map(Number);
          const scheduledMinutes = hh * 60 + mm;
          const nowMinutes = brDate.getUTCHours() * 60 + brDate.getUTCMinutes();
          if (scheduledMinutes > nowMinutes) continue;

          try {
            const tenant = await TenantModelForNotif.findByPk(schedule.tenant_id, { attributes: ['name'] });
            await notifyClientPayment(schedule, tenant?.name || '');
            const updates = { last_notified_at: now };
            if (schedule.recurrence === 'once') updates.notification_status = 'sent';
            await schedule.update(updates);
            console.log(`🔔 [catch-up] Notificação recuperada: cliente="${schedule.client_name}" horário=${schedule.notify_time}`);
          } catch (err) {
            console.error(`⚠️  [catch-up] Erro ao notificar ${schedule.id}:`, err.message);
          }
        }
      } catch (e) {
        console.warn('⚠️  catchUpTodayNotifications:', e.message);
      }
    }

    catchUpTodayNotifications(); // dispara 1x na inicialização
    sendScheduledPaymentNotifications();
    setInterval(sendScheduledPaymentNotifications, 60 * 1000);

    const { Tenant: TenantModel } = require('./models');
    const { Op } = require('sequelize');
    function _toAgentSlug(name) {
      return (name || 'assistente')
        .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '').trim()
        .replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 60) || 'assistente';
    }
    const withoutSlug = await TenantModel.findAll({ where: { agent_slug: null } });
    for (const t of withoutSlug) {
      let base = _toAgentSlug(t.agent_name);
      let finalSlug = base;
      let suffix = 1;
      while (true) {
        const exists = await TenantModel.findOne({ where: { agent_slug: finalSlug, id: { [Op.ne]: t.id } } });
        if (!exists) break;
        finalSlug = base + '-' + suffix++;
      }
      await t.update({ agent_slug: finalSlug });
      console.log(`✅  agent_slug gerado: "${t.agent_name}" → /chat/${finalSlug}`);
    }
  } catch (err) {
    console.error('❌  Erro ao conectar ao banco:', err.message);
    // Não encerra o processo — o servidor continua rodando
    // para permitir diagnóstico via /api/health
  }
})();

module.exports = app;
