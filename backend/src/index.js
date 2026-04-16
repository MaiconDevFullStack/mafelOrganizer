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

    // ── Helpers de timezone BR ───────────────────────────────────────
    function toBrDate(utcDate) {
      return new Date(new Date(utcDate).getTime() - 3 * 60 * 60 * 1000);
    }
    function brNow() {
      return toBrDate(new Date());
    }

    // ── Reset mensal: devolve notification_status=pending para cobranças
    //    recorrentes cujo last_notified_at é de um mês anterior ao atual.
    //    Isso espelha exatamente o comportamento de "once":
    //    pending → (envia) → sent → (mês vira) → pending → ...
    async function resetMonthlyNotificationStatus() {
      try {
        const { Op } = require('sequelize');
        const br = brNow();
        // Primeiro dia do mês atual em UTC (para comparar com last_notified_at que fica em UTC)
        // Converte: primeiro dia do mês BR → UTC equivalente
        const firstOfMonthBR = new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), 1) + 3 * 60 * 60 * 1000);

        const updated = await PSModel.update(
          { notification_status: 'pending' },
          {
            where: {
              recurrence:          { [Op.in]: ['monthly', 'weekly', 'yearly'] },
              notification_status: 'sent',
              last_notified_at:    { [Op.lt]: firstOfMonthBR },
            },
          }
        );
        const count = Array.isArray(updated) ? updated[0] : 0;
        if (count > 0) console.log(`🔄 ${count} cobrança(s) recorrente(s) resetada(s) para pending (novo mês).`);
      } catch (e) {
        console.warn('⚠️  resetMonthlyNotificationStatus:', e.message);
      }
    }

    // ── Job principal: roda a cada minuto ────────────────────────────
    // Mesmo padrão para once e recorrentes:
    //   notification_status = 'pending'  →  verifica horário/dia  →  envia  →  'sent'
    // No início de cada mês, resetMonthlyNotificationStatus() devolve 'pending'.
    async function sendScheduledPaymentNotifications() {
      try {
        const now         = new Date();
        const br          = toBrDate(now);
        const brHH        = String(br.getUTCHours()).padStart(2, '0');
        const brMM        = String(br.getUTCMinutes()).padStart(2, '0');
        const currentTime = `${brHH}:${brMM}`;
        const todayDate   = br.toISOString().slice(0, 10);
        const todayDay    = br.getUTCDate();

        const { Op } = require('sequelize');

        // Todos os registros pendentes cujo notify_time bate com o minuto atual
        const candidates = await PSModel.findAll({
          where: {
            notification_status: 'pending',
            notify_time: { [Op.like]: `${currentTime}%` },
          },
        });

        for (const schedule of candidates) {
          try {
            // Verifica se o dia correto chegou
            let shouldSend = false;
            if (schedule.recurrence === 'once') {
              shouldSend = schedule.due_date === todayDate;
            } else if (schedule.recurrence === 'monthly') {
              shouldSend = Number(schedule.recurring_day) === todayDay;
            } else {
              // weekly / yearly: dispara no dia do vencimento
              shouldSend = schedule.due_date === todayDate;
            }
            if (!shouldSend) continue;

            const tenant = await TenantModelForNotif.findByPk(schedule.tenant_id, { attributes: ['name'] });
            await notifyClientPayment(schedule, tenant?.name || '');

            // Marca como enviado — resetMonthlyNotificationStatus() devolve 'pending' no mês seguinte
            await schedule.update({ notification_status: 'sent', last_notified_at: now });

            console.log(`📤 Notificação enviada: cliente="${schedule.client_name}" recorrência=${schedule.recurrence} data=${todayDate} horário=${currentTime}`);
          } catch (err) {
            console.error(`⚠️  Erro ao notificar cobrança ${schedule.id}:`, err.message);
          }
        }
      } catch (e) {
        console.warn('⚠️  sendScheduledPaymentNotifications:', e.message);
      }
    }

    // ── Catch-up: recupera notificações pendentes do dia que foram perdidas
    //    (ex: servidor reiniciado depois do horário cadastrado)
    async function catchUpTodayNotifications() {
      try {
        const now       = new Date();
        const br        = toBrDate(now);
        const todayDate = br.toISOString().slice(0, 10);
        const todayDay  = br.getUTCDate();
        const nowMin    = br.getUTCHours() * 60 + br.getUTCMinutes();

        const { Op } = require('sequelize');

        const missed = await PSModel.findAll({
          where: {
            notification_status: 'pending',
            notify_time: { [Op.ne]: null },
          },
        });

        for (const schedule of missed) {
          try {
            // Verifica se o dia correto é hoje
            let isToday = false;
            if (schedule.recurrence === 'once') {
              isToday = schedule.due_date === todayDate;
            } else if (schedule.recurrence === 'monthly') {
              isToday = Number(schedule.recurring_day) === todayDay;
            } else {
              isToday = schedule.due_date === todayDate;
            }
            if (!isToday) continue;

            // Só envia se o horário já passou
            const [hh, mm] = schedule.notify_time.split(':').map(Number);
            if ((hh * 60 + mm) > nowMin) continue;

            const tenant = await TenantModelForNotif.findByPk(schedule.tenant_id, { attributes: ['name'] });
            await notifyClientPayment(schedule, tenant?.name || '');
            await schedule.update({ notification_status: 'sent', last_notified_at: now });

            console.log(`🔔 [catch-up] Notificação recuperada: cliente="${schedule.client_name}" horário=${schedule.notify_time}`);
          } catch (err) {
            console.error(`⚠️  [catch-up] Erro ao notificar ${schedule.id}:`, err.message);
          }
        }
      } catch (e) {
        console.warn('⚠️  catchUpTodayNotifications:', e.message);
      }
    }

    await resetMonthlyNotificationStatus(); // garante pending correto ao iniciar
    await catchUpTodayNotifications();       // recupera perdidos do dia
    sendScheduledPaymentNotifications();
    setInterval(sendScheduledPaymentNotifications, 60 * 1000);
    // Reset mensal roda também uma vez por dia (meia-noite BR = 03:00 UTC)
    setInterval(resetMonthlyNotificationStatus, 60 * 60 * 1000);

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
