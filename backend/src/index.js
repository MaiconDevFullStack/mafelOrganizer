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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date() });
});

// ── Fallback SPA ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

// ── Inicialização ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅  Banco de dados conectado.');
    await sequelize.sync({ alter: true });
    console.log('✅  Models sincronizados.');

    // Backfill: gera agent_slug para tenants existentes que ainda não têm
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

    app.listen(PORT, () => {
      console.log(`🚀  Servidor rodando em http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌  Erro ao iniciar servidor:', err);
    process.exit(1);
  }
})();

module.exports = app;
