require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
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
app.use(compression());          // gzip em todas as respostas
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// Log verboso apenas em desenvolvimento
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));

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
// Arquivos de assets recebem cache de 7 dias; index.html nunca é cacheado.
app.use(express.static(path.join(__dirname, '../../frontend'), {
  setHeaders(res, filePath) {
    // Nunca cachear o HTML (o SPA precisa da versão mais recente)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      // CSS, JS, imagens: cache imutável de 7 dias
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  },
}));

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
// Retorna index.html APENAS para rotas de navegação (sem extensão de arquivo).
// Requisições para arquivos inexistentes (.js, .css, .png, etc.) recebem 404
// para evitar que o browser tente baixar o HTML como se fosse o arquivo pedido.
app.get('*', (req, res) => {
  const hasExtension = /\.([a-zA-Z0-9]{1,8})$/.test(req.path);
  if (hasExtension) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
    // alter:true compara e executa ALTERs no PostgreSQL a cada reinício — muito lento.
    // Em produção usamos sync() sem alter; para aplicar mudanças de schema use migrations.
    const syncOptions = process.env.NODE_ENV === 'production' ? {} : { alter: true };
    await sequelize.sync(syncOptions);
    console.log('✅  Models sincronizados.');

    // ── Migrações coluna a coluna (idempotente, suporta filesystem efêmero) ──
    // Adiciona colunas novas em produção sem usar alter:true global (lento).
    try {
      await sequelize.query(
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS content TEXT;`
      );
      console.log('✅  Coluna knowledge_bases.content garantida.');
    } catch (migErr) {
      console.warn('[Migration] Aviso ao garantir coluna content:', migErr.message);
    }

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

    // ── Reset de notification_status para cobranças recorrentes ─────────────
    // Cada tipo de recorrência tem sua própria janela de reset:
    //   monthly → reseta quando last_notified_at é do mês anterior
    //   weekly  → reseta quando last_notified_at foi há >= 6 dias (próxima semana)
    //   yearly  → reseta quando last_notified_at foi há >= 11 meses
    async function resetRecurrenceNotificationStatus() {
      try {
        const { Op } = require('sequelize');
        const now = new Date();
        const br  = toBrDate(now);

        // monthly: reseta no primeiro dia do mês atual (em relação ao UTC)
        const firstOfMonthBR = new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), 1) + 3 * 60 * 60 * 1000);

        // weekly: last_notified_at há mais de 6 dias (144h)
        const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

        // yearly: last_notified_at há mais de 335 dias (quase 1 ano)
        const elevenMonthsAgo = new Date(now.getTime() - 335 * 24 * 60 * 60 * 1000);

        const results = await Promise.all([
          // monthly
          PSModel.update(
            { notification_status: 'pending' },
            { where: { recurrence: 'monthly', notification_status: 'sent', last_notified_at: { [Op.lt]: firstOfMonthBR } } }
          ),
          // weekly
          PSModel.update(
            { notification_status: 'pending' },
            { where: { recurrence: 'weekly',  notification_status: 'sent', last_notified_at: { [Op.lt]: sixDaysAgo } } }
          ),
          // yearly
          PSModel.update(
            { notification_status: 'pending' },
            { where: { recurrence: 'yearly',  notification_status: 'sent', last_notified_at: { [Op.lt]: elevenMonthsAgo } } }
          ),
        ]);

        const totalReset = results.reduce((acc, r) => acc + (Array.isArray(r) ? r[0] : 0), 0);
        if (totalReset > 0) {
          console.log(`🔄 ${totalReset} cobrança(s) recorrente(s) reativada(s) (weekly/monthly/yearly).`);
        }
      } catch (e) {
        console.warn('⚠️  resetRecurrenceNotificationStatus:', e.message);
      }
    }

    // ── Job principal: roda a cada minuto ────────────────────────────
    // Lógica de dispáro por tipo de recorrência:
    //   once    → confirma que due_date === hoje
    //   monthly → confirma que recurring_day === dia do mês de hoje
    //   weekly  → confirma que hoje >= due_date E (hoje - due_date) % 7 === 0 dias
    //   yearly  → confirma que mês+dia de due_date === mês+dia de hoje
    async function sendScheduledPaymentNotifications() {
      try {
        const now         = new Date();
        const br          = toBrDate(now);
        const brHH        = String(br.getUTCHours()).padStart(2, '0');
        const brMM        = String(br.getUTCMinutes()).padStart(2, '0');
        const currentTime = `${brHH}:${brMM}`;
        const todayDate   = br.toISOString().slice(0, 10);
        const todayDay    = br.getUTCDate();
        const todayMonth  = br.getUTCMonth() + 1; // 1-12

        const { Op } = require('sequelize');

        // Todos os registros ativos (pending ou failed) cujo notify_time bate com o minuto atual
        const candidates = await PSModel.findAll({
          where: {
            status:              'active',
            notification_status: { [Op.in]: ['pending', 'failed'] },
            notify_time:         { [Op.like]: `${currentTime}%` },
          },
        });

        // Log de atividade do job (visível nos logs do Railway)
        if (candidates.length > 0) {
          console.log(`[Job Cobranças] ${currentTime} BR — ${candidates.length} candidato(s) encontrado(s).`);
        } else {
          // Log a cada 10 minutos para confirmar que o job está rodando
          const brMin = br.getUTCMinutes();
          if (brMin % 10 === 0) {
            console.log(`[Job Cobranças] ${currentTime} BR — ativo, nenhuma cobrança pendente neste minuto.`);
          }
        }

        for (const schedule of candidates) {
          try {
            let shouldSend = false;

            if (schedule.recurrence === 'once') {
              // Dispara exatamente no dia de vencimento
              shouldSend = (schedule.due_date === todayDate);

            } else if (schedule.recurrence === 'monthly') {
              // Dispara todo mês no dia configurado
              shouldSend = (Number(schedule.recurring_day) === todayDay);

            } else if (schedule.recurrence === 'weekly') {
              // Dispara a cada 7 dias a partir do due_date original
              const dueParts = (schedule.due_date || '').split('-').map(Number);
              if (dueParts.length === 3) {
                const dueMs   = Date.UTC(dueParts[0], dueParts[1] - 1, dueParts[2]);
                const todayMs = Date.UTC(
                  br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate()
                );
                const diffDays = Math.round((todayMs - dueMs) / 86_400_000);
                shouldSend = (diffDays >= 0 && diffDays % 7 === 0);
              }

            } else if (schedule.recurrence === 'yearly') {
              // Dispara todo ano no mesmo mês e dia do due_date
              const dueParts = (schedule.due_date || '').split('-').map(Number);
              if (dueParts.length === 3) {
                shouldSend = (dueParts[1] === todayMonth && dueParts[2] === todayDay);
              }
            }

            if (!shouldSend) continue;

            if (!schedule.client_phone) {
              console.warn(`[Cobrança] Sem telefone para ${schedule.client_name} (id=${schedule.id}). Pulando.`);
              continue;
            }

            const tenant = await TenantModelForNotif.findByPk(schedule.tenant_id, { attributes: ['name'] });
            await notifyClientPayment(schedule, tenant?.name || '');

            // Marca como enviado — resetRecurrenceNotificationStatus() devolve 'pending' no próximo ciclo
            await schedule.update({ notification_status: 'sent', last_notified_at: now });

            console.log(`📤 Notificado: "${schedule.client_name}" recorrência=${schedule.recurrence} data=${todayDate} horário=${currentTime}`);
          } catch (err) {
            await schedule.update({ notification_status: 'failed' }).catch(() => {});
            console.error(`⚠️  Erro ao notificar cobrança ${schedule.id}:`, err.message);
          }
        }
      } catch (e) {
        console.warn('⚠️  sendScheduledPaymentNotifications:', e.message);
      }
    }

    // ── Catch-up: recupera notificações pend pend entes do dia que foram perdidas
    //    (ex: servidor reiniciado depois do horário cadastrado)
    async function catchUpTodayNotifications() {
      try {
        const now       = new Date();
        const br        = toBrDate(now);
        const todayDate = br.toISOString().slice(0, 10);
        const todayDay  = br.getUTCDate();
        const todayMonth = br.getUTCMonth() + 1;
        const nowMin    = br.getUTCHours() * 60 + br.getUTCMinutes();

        const { Op } = require('sequelize');

        const missed = await PSModel.findAll({
          where: {
            status:              'active',
            notification_status: { [Op.in]: ['pending', 'failed'] },
            notify_time:         { [Op.ne]: null },
          },
        });

        for (const schedule of missed) {
          try {
            // Verifica se o dia correto é hoje (mesma lógica do job principal)
            let isToday = false;
            if (schedule.recurrence === 'once') {
              isToday = (schedule.due_date === todayDate);
            } else if (schedule.recurrence === 'monthly') {
              isToday = (Number(schedule.recurring_day) === todayDay);
            } else if (schedule.recurrence === 'weekly') {
              const dueParts = (schedule.due_date || '').split('-').map(Number);
              if (dueParts.length === 3) {
                const dueMs   = Date.UTC(dueParts[0], dueParts[1] - 1, dueParts[2]);
                const todayMs = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate());
                const diffDays = Math.round((todayMs - dueMs) / 86_400_000);
                isToday = (diffDays >= 0 && diffDays % 7 === 0);
              }
            } else if (schedule.recurrence === 'yearly') {
              const dueParts = (schedule.due_date || '').split('-').map(Number);
              if (dueParts.length === 3) {
                isToday = (dueParts[1] === todayMonth && dueParts[2] === todayDay);
              }
            }
            if (!isToday) continue;

            if (!schedule.client_phone) continue;

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

    await resetRecurrenceNotificationStatus(); // garante pending correto ao iniciar
    await catchUpTodayNotifications();          // recupera perdidos do dia
    sendScheduledPaymentNotifications();
    setInterval(sendScheduledPaymentNotifications, 60 * 1000);
    // Reset de recorrência roda a cada hora (weekly detectado em até 1h após janela)
    setInterval(resetRecurrenceNotificationStatus, 60 * 60 * 1000);

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
