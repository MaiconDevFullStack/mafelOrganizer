'use strict';
/**
 * Rotas de Assinatura (SaaS) + webhook Mercado Pago
 *
 * POST   /api/subscriptions/initiate      — cria tenant + user + PIX (chamado pelo /auth/register)
 * GET    /api/subscriptions/check/:mpId   — polling de status do pagamento
 * POST   /api/subscriptions/mp-webhook    — webhook do Mercado Pago (sem auth)
 * GET    /api/subscriptions/my            — assinatura ativa do tenant logado
 */

const router     = require('express').Router();
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { Tenant, User, Subscription } = require('../models');
const { verifyToken } = require('../middlewares/auth');
const bcrypt = require('bcryptjs');
const Joi    = require('joi');

// ─── helpers ────────────────────────────────────────────────────────────────

function buildMPClient() {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) throw new Error('MERCADOPAGO_ACCESS_TOKEN não configurado no .env');
  return new MercadoPagoConfig({ accessToken: token });
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50) || 'tenant';
}

const PLANS = {
  monthly: { amount: 59.90, label: 'Plano Mensal', days: 30 },
  annual:  { amount: 599.90, label: 'Plano Anual',  days: 365 },
};

const registerSchema = Joi.object({
  // dados do prestador
  name:          Joi.string().min(2).max(100).required(),
  email:         Joi.string().email().required(),
  phone:         Joi.string().pattern(/^\d{10,11}$/).optional().allow(''),
  password:      Joi.string().min(6).required(),
  // dados do negócio
  business_name: Joi.string().min(2).max(100).required(),
  business_slug: Joi.string().pattern(/^[a-z0-9-]+$/).min(2).max(50).optional().allow(''),
  // plano
  plan:          Joi.string().valid('monthly', 'annual').required(),
});

// ─── POST /api/subscriptions/initiate ───────────────────────────────────────
// Cria tenant (inativo) + user (inativo) + cobrança PIX no Mercado Pago
router.post('/initiate', async (req, res) => {
  try {
    const { error, value } = registerSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ error: error.details.map(d => d.message).join('; ') });
    }

    const { name, email, phone, password, business_name, plan } = value;
    let   { business_slug } = value;

    // E-mail já cadastrado?
    const existingUser = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(409).json({ error: 'E-mail já cadastrado. Faça login.' });
    }

    // Gera slug único para o tenant
    if (!business_slug) business_slug = slugify(business_name);
    let finalSlug = business_slug;
    let suffix = 1;
    while (await Tenant.findOne({ where: { slug: finalSlug } })) {
      finalSlug = `${business_slug}-${suffix++}`;
    }

    const planInfo = PLANS[plan];

    // ── Cria Tenant (inativo até pagamento confirmado) ──
    const tenant = await Tenant.create({
      name:        business_name,
      slug:        finalSlug,
      agent_slug:  finalSlug,
      agent_name:  business_name,
      plan:        'basic',
      is_active:   false,   // ativa após pagamento
    });

    // ── Cria User (inativo até pagamento confirmado) ──
    const user = await User.create({
      name:          name,
      email:         email.toLowerCase(),
      phone:         phone ? phone.replace(/\D/g, '') : null,
      password_hash: password,
      role:          'provider',
      tenant_id:     tenant.id,
      is_active:     false, // ativa após pagamento
    });

    // ── Gera cobrança PIX no Mercado Pago ──────────────
    let pixData = null;
    let mpPaymentId = null;
    let mpStatus = 'pending';
    let pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    try {
      const mpClient  = buildMPClient();
      const paymentApi = new Payment(mpClient);

      const mpResult = await paymentApi.create({
        body: {
          transaction_amount: planInfo.amount,
          description:        `${planInfo.label} - Mafel Organizer (${business_name})`,
          payment_method_id:  'pix',
          date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          payer: {
            email: email.toLowerCase(),
            first_name: name.split(' ')[0],
            last_name:  name.split(' ').slice(1).join(' ') || '-',
          },
          metadata: {
            tenant_id: tenant.id,
            plan,
          },
          notification_url: process.env.MP_WEBHOOK_URL || null,
        },
        requestOptions: {
          idempotencyKey: `register-${tenant.id}`,
        },
      });

      mpPaymentId = String(mpResult.id);
      mpStatus    = mpResult.status;
      pixData     = mpResult.point_of_interaction?.transaction_data || null;
      if (mpResult.date_of_expiration) {
        pixExpiresAt = new Date(mpResult.date_of_expiration);
      }
    } catch (mpErr) {
      // Se MP falhar (ex.: token de sandbox inválido), retorna dados sem QR
      console.error('⚠️  Mercado Pago PIX error:', mpErr.message || mpErr);
    }

    // ── Cria registro de Subscription ───────────────────
    const subscription = await Subscription.create({
      tenant_id:      tenant.id,
      plan,
      amount:         planInfo.amount,
      status:         'pending',
      mp_payment_id:  mpPaymentId,
      mp_status:      mpStatus,
      pix_code:       pixData?.qr_code       || null,
      pix_qr_base64:  pixData?.qr_code_base64 || null,
      pix_expires_at: pixExpiresAt,
    });

    return res.status(201).json({
      message:        'Registro iniciado. Aguardando pagamento PIX.',
      subscription_id: subscription.id,
      mp_payment_id:  mpPaymentId,
      pix_code:       subscription.pix_code,
      pix_qr_base64:  subscription.pix_qr_base64,
      pix_expires_at: subscription.pix_expires_at,
      plan_label:     planInfo.label,
      amount:         planInfo.amount,
    });

  } catch (err) {
    console.error('Subscription initiate error:', err);
    return res.status(500).json({ error: 'Erro interno ao iniciar cadastro.' });
  }
});

// ─── GET /api/subscriptions/check/:mpPaymentId ──────────────────────────────
// Polling de status pelo frontend enquanto o usuário vê o QR code
router.get('/check/:mpPaymentId', async (req, res) => {
  try {
    const sub = await Subscription.findOne({
      where: { mp_payment_id: req.params.mpPaymentId },
      include: [{ model: Tenant, as: 'tenant', attributes: ['slug', 'name', 'is_active'] }],
    });
    if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada.' });

    return res.json({
      status:      sub.status,
      mp_status:   sub.mp_status,
      plan:        sub.plan,
      amount:      sub.amount,
      expires_at:  sub.expires_at,
      tenant_slug: sub.tenant?.slug,
      active:      sub.status === 'active',
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao verificar assinatura.' });
  }
});

// ─── POST /api/subscriptions/mp-webhook ─────────────────────────────────────
// Recebe notificações do Mercado Pago (sem auth JWT)
router.post('/mp-webhook', async (req, res) => {
  try {
    const { action, data } = req.body || {};
    if (!action || !data?.id) return res.sendStatus(200); // ignora pings

    if (!['payment.updated', 'payment.created'].includes(action)) {
      return res.sendStatus(200);
    }

    // Consulta o pagamento no MP para obter status atualizado
    let mpPayment;
    try {
      const mpClient   = buildMPClient();
      const paymentApi = new Payment(mpClient);
      mpPayment = await paymentApi.get({ id: String(data.id) });
    } catch (err) {
      console.error('Webhook: erro ao buscar pagamento MP:', err.message);
      return res.sendStatus(200);
    }

    const mpId     = String(mpPayment.id);
    const mpStatus = mpPayment.status; // approved | pending | rejected | cancelled

    const subscription = await Subscription.findOne({ where: { mp_payment_id: mpId } });
    if (!subscription) return res.sendStatus(200); // pagamento não é nosso

    // Atualiza status do MP
    subscription.mp_status = mpStatus;

    if (mpStatus === 'approved' && subscription.status !== 'active') {
      const planInfo  = PLANS[subscription.plan] || PLANS.monthly;
      const startsAt  = new Date();
      const expiresAt = new Date(startsAt.getTime() + planInfo.days * 24 * 60 * 60 * 1000);

      subscription.status    = 'active';
      subscription.starts_at = startsAt;
      subscription.expires_at = expiresAt;

      // Ativa o tenant e o user provider
      await Tenant.update({ is_active: true }, { where: { id: subscription.tenant_id } });
      await User.update(
        { is_active: true },
        { where: { tenant_id: subscription.tenant_id, role: 'provider' } }
      );

      console.log(`✅  Assinatura ${subscription.id} ATIVA — tenant ${subscription.tenant_id}`);
    } else if (['rejected', 'cancelled'].includes(mpStatus)) {
      subscription.status = 'cancelled';
    }

    await subscription.save();
    return res.sendStatus(200);

  } catch (err) {
    console.error('Webhook MP error:', err);
    return res.sendStatus(500);
  }
});

// ─── GET /api/subscriptions/my — restrito ao prestador logado ───────────────
router.get('/my', verifyToken, async (req, res) => {
  try {
    const { tenant_id } = req.user;
    if (!tenant_id) return res.status(400).json({ error: 'Usuário sem tenant.' });

    const sub = await Subscription.findOne({
      where:  { tenant_id, status: ['active', 'pending'] },
      order:  [['createdAt', 'DESC']],
    });

    if (!sub) return res.status(404).json({ error: 'Nenhuma assinatura encontrada.' });

    return res.json({
      id:          sub.id,
      plan:        sub.plan,
      amount:      sub.amount,
      status:      sub.status,
      expires_at:  sub.expires_at,
      starts_at:   sub.starts_at,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar assinatura.' });
  }
});

module.exports = router;
