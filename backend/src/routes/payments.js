const express = require('express');
const router = express.Router();
const { PaymentSchedule, Transaction, Invoice } = require('../models');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');

const scheduleSchema = Joi.object({
  tenant_id:      Joi.string().uuid().required(),
  type:           Joi.string().valid('receivable', 'payable').default('receivable'),
  category:       Joi.string().max(60).optional().allow(null, ''),
  client_name:    Joi.string().required(),
  client_email:   Joi.string().email().optional().allow(null, ''),
  client_phone:   Joi.string().max(20).optional().allow(null, ''),
  description:    Joi.string().optional().allow(null, ''),
  amount:         Joi.number().positive().required(),
  currency:       Joi.string().length(3).default('BRL'),
  due_date:       Joi.string().isoDate().required(),
  recurrence:     Joi.string().valid('once', 'weekly', 'monthly', 'yearly').default('once'),
  recurring_day:  Joi.number().integer().min(1).max(31).optional().allow(null),
  payment_method: Joi.string().valid('boleto', 'pix', 'credit_card', 'debit').default('pix'),
  notes:          Joi.string().optional().allow(null, ''),
});

// GET /payments/schedules?tenant_id=...&type=receivable|payable&status=active
router.get('/schedules', async (req, res) => {
  try {
    const { tenant_id, type, status } = req.query;
    const where = {};
    if (tenant_id) where.tenant_id = tenant_id;
    if (type) where.type = type;
    if (status) where.status = status;
    const schedules = await PaymentSchedule.findAll({ where, order: [['due_date', 'ASC']] });
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /payments/stats?tenant_id=...
router.get('/stats', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const { Op, fn, col, literal } = require('sequelize');
    const where = tenant_id ? { tenant_id } : {};
    const today = new Date().toISOString().split('T')[0];

    const [receivable, payable, overdueRec, overduePay] = await Promise.all([
      PaymentSchedule.sum('amount', { where: { ...where, type: 'receivable', status: 'active' } }),
      PaymentSchedule.sum('amount', { where: { ...where, type: 'payable', status: 'active' } }),
      PaymentSchedule.count({ where: { ...where, type: 'receivable', status: 'active', due_date: { [Op.lt]: today } } }),
      PaymentSchedule.count({ where: { ...where, type: 'payable', status: 'active', due_date: { [Op.lt]: today } } }),
    ]);

    res.json({
      total_receivable: parseFloat(receivable || 0),
      total_payable: parseFloat(payable || 0),
      overdue_receivable: overdueRec,
      overdue_payable: overduePay,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /payments/schedules — criado pelo prestador (cadastra data de vencimento)
router.post('/schedules', async (req, res) => {
  try {
    const { error, value } = scheduleSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const schedule = await PaymentSchedule.create({
      ...value,
      notification_status: 'pending',
    });

    // TODO: enfileirar job para notificar cliente (BullMQ)
    // await notificationQueue.add('notify-client', { scheduleId: schedule.id });

    res.status(201).json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /payments/schedules/:id
router.get('/schedules/:id', async (req, res) => {
  try {
    const schedule = await PaymentSchedule.findByPk(req.params.id, {
      include: [{ model: Transaction, as: 'transactions', include: [{ model: Invoice, as: 'invoice' }] }],
    });
    if (!schedule) return res.status(404).json({ error: 'Agendamento não encontrado' });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /payments/schedules/:id — atualizar status ou campos do agendamento
router.patch('/schedules/:id', async (req, res) => {
  try {
    const schedule = await PaymentSchedule.findByPk(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Agendamento não encontrado' });
    const allowed = ['status', 'description', 'notes', 'due_date', 'amount', 'recurrence', 'payment_method', 'category'];
    const updates = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    await schedule.update(updates);
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /payments/schedules/:id/execute — executar cobrança manualmente
router.post('/schedules/:id/execute', async (req, res) => {
  try {
    const schedule = await PaymentSchedule.findByPk(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Agendamento não encontrado' });
    if (schedule.status !== 'active') {
      return res.status(400).json({ error: 'Agendamento não está ativo' });
    }

    const transaction = await Transaction.create({
      schedule_id: schedule.id,
      amount: schedule.amount,
      status: 'pending',
      attempts: 1,
    });

    // Stub PSP — substituir por chamada real ao gateway de pagamento
    const pspSuccess = true; // TODO: integrar gateway real (ex: Stripe, Asaas, Pagar.me)
    const newStatus = pspSuccess ? 'success' : 'failed';
    await transaction.update({ status: newStatus, processed_at: new Date() });

    if (pspSuccess) {
      const invoice = await Invoice.create({
        transaction_id: transaction.id,
        number: `INV-${uuidv4().split('-')[0].toUpperCase()}`,
        total: schedule.amount,
        status: 'paid',
        issued_at: new Date(),
        paid_at: new Date(),
      });

      if (schedule.recurrence === 'once') {
        await schedule.update({ status: 'completed' });
      }

      return res.json({ status: 'success', transaction, invoice });
    }

    res.json({ status: 'failed', transaction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
