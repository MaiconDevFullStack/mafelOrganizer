const express = require('express');
const router = express.Router();
const { Conversation, Message, Tenant, KnowledgeBase, Appointment, ServiceSlot } = require('../models');
const { generateGroqReply } = require('../services/groqService');

// GET /conversations?tenant_id=xxx[&status=open|closed|all]
// Carrega apenas a última mensagem por conversa para listagem rápida;
// o histórico completo é buscado sob demanda via GET /:id/messages.
router.get('/', async (req, res) => {
  try {
    const { tenant_id, status } = req.query;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id obrigatório' });

    const where = { tenant_id };
    if (status && status !== 'all') where.status = status;

    const conversations = await Conversation.findAll({
      where,
      include: [{
        model: Message,
        as: 'messages',
        // Carrega apenas a última mensagem por conversa (preview)
        limit: 1,
        order: [['createdAt', 'DESC']],
        separate: true, // evita produto cartesiano com JOIN
      }],
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

    // Retorna a mensagem de boas-vindas exatamente como cadastrada pelo prestador
    const welcomeMessage = tenant.welcome_message || null;

    res.status(201).json({ ...conversation.toJSON(), welcomeMessage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /conversations/:id/messages[?limit=50&offset=0]
// Suporta paginação para não carregar todo o histórico de uma vez.
router.get('/:id/messages', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const conversation = await Conversation.findByPk(req.params.id, {
      include: [{
        model: Message,
        as: 'messages',
        order: [['created_at', 'ASC']],
        limit,
        offset,
        separate: true,
      }],
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

    // Busca conversa (com últimas 20 mensagens para contexto) e tenant em paralelo
    const [conversation, ] = await Promise.all([
      Conversation.findByPk(req.params.id, {
        include: [{
          model: Message,
          as: 'messages',
          order: [['created_at', 'ASC']],
          limit: 20,
          separate: true,
        }],
      }),
    ]);
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

    // Salva mensagem do cliente e busca tenant em paralelo
    const [clientMsg, tenant] = await Promise.all([
      Message.create({
        conversation_id: conversation.id,
        author: 'client',
        text,
      }),
      Tenant.findByPk(conversation.tenant_id),
    ]);

    const previousMsgs = conversation.messages || [];

    // Chama Groq com KB do tenant + agenda real para cruzar com agendamentos
    const agentReply = await generateGroqReply(
      text, tenant, previousMsgs, KnowledgeBase,
      { Appointment, ServiceSlot },
    );

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
