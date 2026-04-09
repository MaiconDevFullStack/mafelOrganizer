'use strict';

/**
 * routes/whatsapp.js
 *
 * GET  /api/whatsapp/status   — verifica conexão com o provider configurado
 * POST /api/whatsapp/test     — envia mensagem de teste para um número
 */

const express  = require('express');
const router   = express.Router();
const Joi      = require('joi');
const { verifyToken } = require('../middlewares/auth');
const { sendWhatsApp, getStatus } = require('../services/whatsappService');

// ─────────────────────────────────────────────────────────────
// GET /api/whatsapp/status
// Retorna o estado da conexão com o provider (sem credenciais expostas).
// ─────────────────────────────────────────────────────────────
router.get('/status', verifyToken, async (req, res) => {
  try {
    const status = await getStatus();
    return res.json(status);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/whatsapp/test
// Body: { to: "11999990000", message: "Texto de teste" }
// Exige autenticação — só admin/provider pode usar.
// ─────────────────────────────────────────────────────────────
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
    return res.json({
      success: true,
      simulated: result.simulated || false,
      result,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error:   err.message,
    });
  }
});

module.exports = router;
