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
        // Data/hora local de Brasília como string — sem depender do TZ do servidor
        const brDate = new Date(now.getTime() - 3 * 60 * 60 * 1000); // subtrai 3h do UTC
        const brHH        = String(brDate.getUTCHours()).padStart(2, '0');
        const brMM        = String(brDate.getUTCMinutes()).padStart(2, '0');
        const currentTime = `${brHH}:${brMM}`;           // "HH:MM"
        const todayDate   = brDate.toISOString().slice(0, 10); // "YYYY-MM-DD" (BR)
        const todayDay    = brDate.getUTCDate();           // 1-31

        const { Op } = require('sequelize');

        // Busca registros cujo notify_time começa com HH:MM (compatível com HH:MM e HH:MM:SS)
        const candidates = await PSModel.findAll({
          where: {
            status: 'active',
            notify_time: { [Op.like]: `${currentTime}%` },
          },
        });

        for (const schedule of candidates) {
          try {
            // ── Deduplicação: calcula data BR do último envio ──────────
            let lastNotifiedDateBR = null;
            if (schedule.last_notified_at) {
              const lastUTC = new Date(schedule.last_notified_at);
              const lastBR  = new Date(lastUTC.getTime() - 3 * 60 * 60 * 1000);
              lastNotifiedDateBR = lastBR.toISOString().slice(0, 10); // "YYYY-MM-DD" em BR
            }

            // Já enviou hoje (horário BR)? Pula.
            if (lastNotifiedDateBR === todayDate) continue;

            // ── Verifica se deve disparar hoje ─────────────────────────
            let shouldSend = false;

            if (schedule.recurrence === 'once') {
              // Dispara apenas no dia do vencimento, uma única vez
              shouldSend = schedule.due_date === todayDate &&
                           schedule.notification_status === 'pending';
            } else if (schedule.recurrence === 'monthly') {
              // Dispara todo mês no dia recurring_day
              shouldSend = Number(schedule.recurring_day) === todayDay;
            } else {
              // weekly / yearly: dispara no dia do vencimento
              shouldSend = schedule.due_date === todayDate;
            }

            if (!shouldSend) continue;

            // ── Busca nome do tenant e envia ───────────────────────────
            const tenant = await TenantModelForNotif.findByPk(schedule.tenant_id, { attributes: ['name'] });
            const tenantName = tenant?.name || '';

            await notifyClientPayment(schedule, tenantName);

            // Marca envio (armazena timestamp UTC real)
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

    sendScheduledPaymentNotifications();
    setInterval(sendScheduledPaymentNotifications, 60 * 1000); // a cada minuto

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
