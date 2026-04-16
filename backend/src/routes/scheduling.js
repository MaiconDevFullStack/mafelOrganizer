'use strict';

/**
 * routes/scheduling.js
 * Endpoint conversacional de agendamento + CRUD de horários de atendimento.
 */

const express  = require('express');
const router   = express.Router();
const { Tenant, Conversation, Message, Appointment, KnowledgeBase, User, ServiceSlot } = require('../models');
const { processSchedulingStep } = require('../services/schedulingService');
const { authMiddleware } = require('../middlewares/auth');
const Joi = require('joi');

const stepSchema = Joi.object({
  tenant_id:       Joi.string().uuid().required(),
  conversation_id: Joi.string().uuid().optional().allow(null, ''),
  step:            Joi.string().valid('init', 'set_name', 'set_phone', 'select_slot').required(),
  payload:         Joi.object({ text: Joi.string().allow('').optional() }).default({}),
});

const slotSchema = Joi.object({
  tenant_id:        Joi.string().uuid().required(),
  day_of_week:      Joi.number().integer().min(0).max(6).required(),
  start_time:       Joi.string().pattern(/^\d{2}:\d{2}$/).required()
    .messages({ 'string.pattern.base': 'start_time deve estar no formato HH:MM' }),
  duration_minutes: Joi.number().integer().min(15).max(480).default(60),
  service_name:     Joi.string().max(100).optional().allow(null, ''),
  max_bookings:     Joi.number().integer().min(1).default(1),
  is_active:        Joi.boolean().default(true),
});

// ─────────────────────────────────────────────────────────────
// POST /api/scheduling/step  (público — usado pelo chat)
// ─────────────────────────────────────────────────────────────
router.post('/step', async (req, res) => {
  const { error, value } = stepSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { tenant_id, conversation_id, step, payload } = value;

  try {
    const tenant = await Tenant.findByPk(tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });

    let session = { conversation_id };
    let conversation = null;

    if (conversation_id) {
      conversation = await Conversation.findByPk(conversation_id);
      if (conversation?.session_data?.scheduling) {
        session = { ...session, ...conversation.session_data.scheduling };
      }
    }

    const result = await processSchedulingStep(
      step,
      payload,
      session,
      tenant,
      { Appointment, KnowledgeBase, User, ServiceSlot }
    );

    if (conversation) {
      const newScheduling = { ...session, ...result.sessionUpdate };
      const currentData = conversation.session_data || {};
      await conversation.update({
        session_data: { ...currentData, scheduling: newScheduling },
      });
      if (result.reply) {
        await Message.create({
          conversation_id: conversation.id,
          author: 'agent',
          text:   result.reply,
        });
      }
    }

    return res.json({
      reply:       result.reply,
      nextStep:    result.nextStep,
      appointment: result.appointment || null,
    });

  } catch (err) {
    console.error('[Scheduling] Erro:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/scheduling/appointments?tenant_id=...  (autenticado)
// ─────────────────────────────────────────────────────────────
router.get('/appointments', authMiddleware, async (req, res) => {
  try {
    const { tenant_id, status } = req.query;
    const where = {};
    if (tenant_id) where.tenant_id = tenant_id;
    if (status)    where.status    = status;

    const rows = await Appointment.findAll({
      where,
      order: [['scheduled_at', 'ASC']],
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET  /api/scheduling/slots?tenant_id=...   (autenticado)
// POST /api/scheduling/slots                 (autenticado)
// PATCH/DELETE /api/scheduling/slots/:id     (autenticado)
// ─────────────────────────────────────────────────────────────

router.get('/slots', authMiddleware, async (req, res) => {
  try {
    const where = {};
    if (req.query.tenant_id) where.tenant_id = req.query.tenant_id;
    const rows = await ServiceSlot.findAll({
      where,
      order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/slots', authMiddleware, async (req, res) => {
  const { error, value } = slotSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const slot = await ServiceSlot.create(value);
    res.status(201).json(slot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/slots/:id', authMiddleware, async (req, res) => {
  try {
    const slot = await ServiceSlot.findByPk(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot não encontrado' });
    const allowed = ['day_of_week', 'start_time', 'duration_minutes', 'service_name', 'max_bookings', 'is_active'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    await slot.update(update);
    res.json(slot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/slots/:id', authMiddleware, async (req, res) => {
  try {
    const slot = await ServiceSlot.findByPk(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot não encontrado' });
    await slot.destroy();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


// ─────────────────────────────────────────────────────────────
// POST /api/scheduling/step
// ─────────────────────────────────────────────────────────────
router.post('/step', async (req, res) => {
  const { error, value } = stepSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { tenant_id, conversation_id, step, payload } = value;

  try {
    // ── Carrega tenant ──────────────────────────────────────
    const tenant = await Tenant.findByPk(tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });

    // ── Carrega sessão ──────────────────────────────────────
    let session = { conversation_id };
    let conversation = null;

    if (conversation_id) {
      conversation = await Conversation.findByPk(conversation_id);
      if (conversation?.session_data?.scheduling) {
        session = { ...session, ...conversation.session_data.scheduling };
      }
    }

    // ── Processa o passo ────────────────────────────────────
    const result = await processSchedulingStep(
      step,
      payload,
      session,
      tenant,
      { Appointment, KnowledgeBase, User }
    );

    // ── Persiste estado na conversa ─────────────────────────
    if (conversation) {
      const newScheduling = { ...session, ...result.sessionUpdate };
      const currentData = conversation.session_data || {};
      await conversation.update({
        session_data: { ...currentData, scheduling: newScheduling },
      });

      // Salva a mensagem do agente no histórico da conversa
      if (result.reply) {
        await Message.create({
          conversation_id: conversation.id,
          author: 'agent',
          text:   result.reply,
        });
      }
    }

    // ── Resposta ────────────────────────────────────────────
    return res.json({
      reply:       result.reply,
      nextStep:    result.nextStep,
      appointment: result.appointment || null,
    });

  } catch (err) {
    console.error('[Scheduling] Erro:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/scheduling/appointments?tenant_id=...
// ─────────────────────────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    const { tenant_id, status } = req.query;
    const where = {};
    if (tenant_id) where.tenant_id = tenant_id;
    if (status)    where.status    = status;

    const rows = await Appointment.findAll({
      where,
      order: [['scheduled_at', 'ASC']],
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
