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

module.exports = router;
