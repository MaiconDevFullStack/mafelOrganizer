'use strict';

/**
 * routes/scheduling.js
 * Endpoint conversacional de agendamento.
 *
 * POST /api/scheduling/step
 * Body: { tenant_id, conversation_id, step, payload: { text } }
 *
 * O frontend mantém o estado local (step + session), mas o backend
 * também persiste o estado na coluna session_data da Conversation
 * para tolerância a recarregamentos de página.
 */

const express  = require('express');
const router   = express.Router();
const { Tenant, Conversation, Message, Appointment, KnowledgeBase, User } = require('../models');
const { processSchedulingStep } = require('../services/schedulingService');
const Joi = require('joi');

const stepSchema = Joi.object({
  tenant_id:       Joi.string().uuid().required(),
  conversation_id: Joi.string().uuid().optional().allow(null, ''),
  step:            Joi.string().valid('init', 'set_name', 'set_phone', 'select_slot').required(),
  payload:         Joi.object({ text: Joi.string().allow('').optional() }).default({}),
});

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
