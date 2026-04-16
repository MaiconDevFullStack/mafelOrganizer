const express = require('express');
const router = express.Router();
const { Conversation, Message, Tenant, KnowledgeBase } = require('../models');
const { generateGroqReply, generateWelcome } = require('../services/groqService');

// GET /conversations?tenant_id=xxx[&status=open|closed|all]
router.get('/', async (req, res) => {
  try {
    const { tenant_id, status } = req.query;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id obrigatório' });

    const where = { tenant_id };
    if (status && status !== 'all') where.status = status;

    const conversations = await Conversation.findAll({
      where,
      include: [{ model: Message, as: 'messages', order: [['createdAt', 'ASC']] }],
      order: [['updatedAt', 'DESC']],
    });
    res.json(conversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations — iniciar conversa
router.post('/', async (req, res) => {
  try {
    const { tenant_id, client_name, client_email, channel } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id obrigatório' });

    const tenant = await Tenant.findByPk(tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });

    const conversation = await Conversation.create({
      tenant_id,
      client_name,
      client_email,
      channel: channel || 'web',
    });

    // Gera saudação dinâmica (contextual ao horário e à KB disponível)
    // Executa em paralelo para não bloquear a resposta
    const welcomeMessage = await generateWelcome(tenant, KnowledgeBase);

    res.status(201).json({ ...conversation.toJSON(), welcomeMessage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /conversations/:id/messages
router.get('/:id/messages', async (req, res) => {
  try {
    const conversation = await Conversation.findByPk(req.params.id, {
      include: [{ model: Message, as: 'messages', order: [['created_at', 'ASC']] }],
    });
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.json(conversation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:id/messages — enviar mensagem e receber resposta do agente
router.post('/:id/messages', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Mensagem não pode ser vazia' });

    const conversation = await Conversation.findByPk(req.params.id, {
      include: [{ model: Message, as: 'messages' }],
    });
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

    // Salva mensagem do cliente
    const clientMsg = await Message.create({
      conversation_id: conversation.id,
      author: 'client',
      text,
    });

    // Busca tenant e histórico anterior para contexto
    const tenant = await Tenant.findByPk(conversation.tenant_id);
    const previousMsgs = conversation.messages || [];

    // Chama Groq com KB do tenant
    const agentReply = await generateGroqReply(text, tenant, previousMsgs, KnowledgeBase);

    const agentMsg = await Message.create({
      conversation_id: conversation.id,
      author: 'agent',
      text: agentReply,
    });

    res.json({ clientMessage: clientMsg, agentMessage: agentMsg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:id/messages/human — mensagem manual do prestador (sem IA)
router.post('/:id/messages/human', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Mensagem não pode ser vazia' });

    const conversation = await Conversation.findByPk(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

    const msg = await Message.create({
      conversation_id: conversation.id,
      author: 'human',
      text,
    });

    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /conversations/:id — atualizar status (open, escalated, closed)
router.patch('/:id', async (req, res) => {
  try {
    const conversation = await Conversation.findByPk(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

    const { status } = req.body;
    if (status) await conversation.update({ status });

    res.json(conversation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:id/close — encerrar sessão do cliente
// Aceita chamadas de navigator.sendBeacon (sem body), não exige auth.
router.post('/:id/close', async (req, res) => {
  try {
    const conversation = await Conversation.findByPk(req.params.id);
    if (!conversation) return res.status(204).send();          // já inexistente — ok
    if (conversation.status === 'open') {
      await conversation.update({ status: 'closed' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
