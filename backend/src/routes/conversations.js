const express = require('express');
const router = express.Router();
const { Conversation, Message, Tenant, KnowledgeBase } = require('../models');
const { generateGroqReply } = require('../services/groqService');

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

    res.status(201).json(conversation);
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

module.exports = router;
