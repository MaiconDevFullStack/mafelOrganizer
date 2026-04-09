const express = require('express');
const router = express.Router();
const { Tenant, Client, PaymentSchedule, KnowledgeBase, Conversation } = require('../models');
const Joi = require('joi');

// Converte agent_name em slug de URL amigável
// Ex: "Assistente Demo" → "assistente-demo", "Sofia IA" → "sofia-ia"
function toAgentSlug(name) {
  return (name || 'assistente')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 60) || 'assistente';
}

module.exports.toAgentSlug = toAgentSlug;

const schema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  slug: Joi.string().pattern(/^[a-z0-9-]+$/).min(2).max(50).required()
    .messages({ 'string.pattern.base': 'Slug deve conter apenas letras minúsculas, números e hífens' }),
  plan: Joi.string().valid('basic', 'professional', 'enterprise').default('basic'),
  agent_name: Joi.string().max(60).optional().allow(''),
  primary_color: Joi.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().allow(''),
  background_url: Joi.string().uri().optional().allow(null, ''),
  logo_url: Joi.string().uri().optional().allow(null, ''),
  welcome_message: Joi.string().max(300).optional().allow(''),
  is_active: Joi.boolean().optional(),
  settings: Joi.object().optional(),
});

const updateSchema = schema.fork(
  ['name', 'slug'],
  (f) => f.optional()
);

// GET /tenants?all=true (superadmin) | padrão só ativos
router.get('/', async (req, res) => {
  try {
    const where = req.query.all === 'true' ? {} : { is_active: true };
    const tenants = await Tenant.findAll({ where, order: [['createdAt', 'DESC']] });
    res.json(tenants);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /tenants/stats — contagens por tenant para o dashboard
router.get('/stats', async (req, res) => {
  try {
    const tenants = await Tenant.findAll({ order: [['createdAt', 'DESC']] });
    const stats = await Promise.all(
      tenants.map(async (t) => {
        const [clients, receivable, payable, conversations, kbDocs] = await Promise.all([
          Client.count({ where: { tenant_id: t.id } }),
          PaymentSchedule.count({ where: { tenant_id: t.id, type: 'receivable', status: 'active' } }),
          PaymentSchedule.count({ where: { tenant_id: t.id, type: 'payable',    status: 'active' } }),
          Conversation.count({ where: { tenant_id: t.id } }),
          KnowledgeBase.count({ where: { tenant_id: t.id } }),
        ]);
        return { id: t.id, clients, receivable, payable, conversations, kbDocs };
      })
    );
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /tenants/agent/:agentSlug — busca tenant pelo slug do agente (URL personalizada do chat)
router.get('/agent/:agentSlug', async (req, res) => {
  try {
    const tenant = await Tenant.findOne({
      where: { agent_slug: req.params.agentSlug, is_active: true },
    });
    if (!tenant) return res.status(404).json({ error: 'Agente não encontrado' });
    res.json(tenant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /tenants/:slug
router.get('/:slug', async (req, res) => {
  try {
    const tenant = await Tenant.findOne({ where: { slug: req.params.slug } });
    if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });
    res.json(tenant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /tenants
router.post('/', async (req, res) => {
  try {
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    // Auto-gera agent_slug a partir do agent_name
    if (!value.agent_slug && value.agent_name) {
      value.agent_slug = toAgentSlug(value.agent_name);
    }
    const tenant = await Tenant.create(value);
    res.status(201).json(tenant);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Slug já em uso' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /tenants/:id
router.patch('/:id', async (req, res) => {
  try {
    const { error, value } = updateSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const tenant = await Tenant.findByPk(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });
    // Recomputa agent_slug se agent_name foi alterado
    if (value.agent_name !== undefined && !value.agent_slug) {
      value.agent_slug = toAgentSlug(value.agent_name);
    }
    await tenant.update(value);
    res.json(tenant);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Slug já em uso' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /tenants/:id — desativa (soft)
router.delete('/:id', async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });
    await tenant.update({ is_active: false });
    res.json({ message: 'Prestador desativado com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
