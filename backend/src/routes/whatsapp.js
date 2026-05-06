'use strict';

/**
 * routes/whatsapp.js
 *
 * GET  /api/whatsapp/status          — verifica conexão com o provider
 * POST /api/whatsapp/test            — mensagem de teste para um número
 * POST /api/whatsapp/notify/payment  — lembrete de cobrança para cliente
 * POST /api/whatsapp/send            — mensagem manual para qualquer número
 */

const express  = require('express');
const router   = express.Router();
const Joi      = require('joi');
const { verifyToken } = require('../middlewares/auth');
const { PaymentSchedule, Tenant } = require('../models');
const { sendWhatsApp, notifyClientPayment, getStatus } = require('../services/whatsappService');

// ── GET /api/whatsapp/status ─────────────────────────────────
router.get('/status', verifyToken, async (req, res) => {
  try {
    const status = await getStatus();
    return res.json(status);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/whatsapp/test ──────────────────────────────────
const testSchema = Joi.object({
  to:      Joi.string().min(10).max(20).required()
    .messages({ 'string.min': 'Informe o número com DDD (mínimo 10 dígitos).' }),
  message: Joi.string().min(1).max(1000).default('✅ Teste de integração WhatsApp — MafelOrganizer.'),
});

router.post('/test', verifyToken, async (req, res) => {
  const { error, value } = testSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  try {
    const result = await sendWhatsApp(value.to, value.message);
    return res.json({ success: true, simulated: result.simulated || false, result });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
});

// ── POST /api/whatsapp/notify/payment ────────────────────────
// Envia lembrete de cobrança para o cliente de um PaymentSchedule.
// Body: { schedule_id: "<uuid>" }
router.post('/notify/payment', verifyToken, async (req, res) => {
  const { schedule_id } = req.body;
  if (!schedule_id) return res.status(400).json({ error: 'schedule_id obrigatório' });

  try {
    const schedule = await PaymentSchedule.findByPk(schedule_id);
    if (!schedule) return res.status(404).json({ error: 'Cobrança não encontrada' });
    if (!schedule.client_phone) {
      return res.status(422).json({ error: 'Cliente sem telefone cadastrado' });
    }

    const tenant = await Tenant.findByPk(schedule.tenant_id);
    const result = await notifyClientPayment(schedule, tenant?.name);

    return res.json({ success: true, simulated: result.simulated || false, result });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
});

// ── POST /api/whatsapp/send ──────────────────────────────────
// Mensagem livre para qualquer número (uso manual pelo prestador).
// Body: { to: "11999990000", message: "Texto…" }
const sendSchema = Joi.object({
  to:      Joi.string().min(10).max(20).required(),
  message: Joi.string().min(1).max(4096).required(),
});

router.post('/send', verifyToken, async (req, res) => {
  const { error, value } = sendSchema.validate(req.body, { stripUnknown: true });
  if (error) return res.status(400).json({ error: error.details[0].message });

  try {
    const result = await sendWhatsApp(value.to, value.message);
    return res.json({ success: true, simulated: result.simulated || false, result });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
});

// ── GET /api/whatsapp/debug-pending ────────────────────────────────────────
// Retorna todas as cobranças ativas com notify_time definido (sem auth — apenas diagnóstico).
// Remove esta rota após confirmar o funcionamento em produção.
router.get('/debug-pending', async (req, res) => {
  try {
    const { PaymentSchedule: PS } = require('../models');
    const { Op } = require('sequelize');
    const now = new Date();
    const br  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const brHH = String(br.getUTCHours()).padStart(2, '0');
    const brMM = String(br.getUTCMinutes()).padStart(2, '0');
    const currentTime = `${brHH}:${brMM}`;
    const todayDate   = br.toISOString().slice(0, 10);

    const records = await PS.findAll({
      where: { status: 'active', notify_time: { [Op.ne]: null } },
      attributes: ['id', 'client_name', 'client_phone', 'due_date', 'recurrence',
                   'recurring_day', 'notify_time', 'notification_status', 'last_notified_at'],
      order: [['notify_time', 'ASC']],
    });

    return res.json({
      server_utc:  now.toISOString(),
      server_br:   br.toISOString(),
      current_time_br: currentTime,
      today_date_br:   todayDate,
      provider:    process.env.WHATSAPP_PROVIDER || 'twilio',
      whatsapp_from: process.env.TWILIO_WHATSAPP_FROM || '(não definido)',
      content_sid: process.env.TWILIO_CONTENT_SID  || '(não definido — usando texto livre)',
      total: records.length,
      records,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
