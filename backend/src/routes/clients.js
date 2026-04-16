'use strict';
const express = require('express');
const router = express.Router();
const { Client } = require('../models');
const Joi = require('joi');

const clientSchema = Joi.object({
  tenant_id: Joi.string().uuid().required(),
  name: Joi.string().min(2).max(120).required(),
  email: Joi.string().email().optional().allow(null, ''),
  phone: Joi.string().max(30).optional().allow(null, ''),
  document: Joi.string().max(20).optional().allow(null, ''),
  address: Joi.string().max(255).optional().allow(null, ''),
  notes: Joi.string().max(2000).optional().allow(null, ''),
  is_active: Joi.boolean().default(true),
});

const updateSchema = clientSchema.fork(
  ['tenant_id', 'name'],
  (field) => field.optional()
);

// GET /api/clients?tenant_id=...&search=...
router.get('/', async (req, res) => {
  try {
    const { tenant_id, search } = req.query;
    const where = {};
    if (tenant_id) where.tenant_id = tenant_id;
    if (search) {
      const { Op } = require('sequelize');
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
      ];
    }
    const clients = await Client.findAll({
      where,
      order: [['name', 'ASC']],
    });
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients
router.post('/', async (req, res) => {
  try {
    const { error, value } = clientSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const client = await Client.create(value);
    res.status(201).json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  try {
    const client = await Client.findByPk(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id
router.patch('/:id', async (req, res) => {
  try {
    const { error, value } = updateSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const client = await Client.findByPk(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

    await client.update(value);
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id  (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const client = await Client.findByPk(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
    await client.destroy();
    res.json({ message: 'Cliente removido com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
