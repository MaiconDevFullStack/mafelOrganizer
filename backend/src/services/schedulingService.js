'use strict';

/**
 * schedulingService.js
 * Responsável por:
 *  1. Gerar slots de horários disponíveis (via KB + agenda existente)
 *  2. Criar o agendamento no banco
 *  3. Notificar o prestador via WhatsApp
 */

const { Op }          = require('sequelize');
const { notifyProvider } = require('./whatsappService');

// ── Configuração de horários padrão ────────────────────────────
const WORK_START  = 8;    // hora de início (inclusive)
const WORK_END    = 18;   // hora de fim (exclusive)
const SLOT_HOURS  = 1;    // duração de cada slot em horas
const DAYS_AHEAD  = 7;    // quantos dias à frente gerar slots
const MAX_SLOTS   = 10;   // limite de slots retornados ao cliente

// Dias da semana de trabalho (0=Dom, 1=Seg … 6=Sáb)
const WORK_DAYS = [1, 2, 3, 4, 5, 6]; // Seg a Sáb

// ─────────────────────────────────────────────────────────────
// 1. BUSCA SERVIÇOS NA BASE DE CONHECIMENTO (via Groq)
// ─────────────────────────────────────────────────────────────

/**
 * Usa a KB do tenant para extrair nomes de serviços disponíveis.
 * Retorna array de strings ou array vazio se não encontrar.
 * Chama o modelo leve (FAST) pois é uma extração estruturada simples.
 */
async function extractServicesFromKB(Groq, tenant, KnowledgeBase) {
  const { buildKbContext } = require('./groqService');

  // Reusa buildKbContext interno — chama com query genérica
  const { context: kbText } = await buildKbContext(KnowledgeBase, tenant.id, 'serviços disponíveis preços horários');
  if (!kbText.trim()) return [];

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'seu_groq_api_key_aqui') return [];

  const groqClient = new Groq({ apiKey });
  try {
    const resp = await groqClient.chat.completions.create({
      model: process.env.GROQ_MODEL_FAST || 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content:
            'Você é um extrator de dados. Leia o texto da base de conhecimento e retorne APENAS uma lista JSON de strings com os nomes dos serviços disponíveis. Ex: ["Corte de cabelo","Manicure"]. Se não encontrar, retorne [].',
        },
        { role: 'user', content: kbText.slice(0, 3000) },
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const raw = resp.choices[0]?.message?.content?.trim() || '[]';
    const match = raw.match(/\[.*\]/s);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[Scheduling] Falha ao extrair serviços da KB:', e.message);
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// 2. GERAÇÃO DE SLOTS DISPONÍVEIS
// ─────────────────────────────────────────────────────────────

/**
 * Gera slots de DAYS_AHEAD dias, filtra os já ocupados via DB.
 *
 * @param {Object} Appointment – model Sequelize
 * @param {string} tenantId
 * @returns {Array<Date>} slots livres
 */
async function generateAvailableSlots(Appointment, tenantId) {
  const now     = new Date();
  const cutoff  = new Date(now.getTime() + 60 * 60 * 1000); // 1h no futuro mínimo
  const end     = new Date(now);
  end.setDate(end.getDate() + DAYS_AHEAD + 1);

  // Busca slots já ocupados no período
  const booked = await Appointment.findAll({
    where: {
      tenant_id: tenantId,
      status:    { [Op.ne]: 'cancelled' },
      scheduled_at: { [Op.between]: [cutoff, end] },
    },
    attributes: ['scheduled_at'],
  });

  const bookedSet = new Set(
    booked.map(a => new Date(a.scheduled_at).toISOString())
  );

  const slots = [];
  const cursor = new Date(now);
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(cursor.getHours() + 1); // começa na próxima hora cheia

  while (slots.length < MAX_SLOTS && cursor < end) {
    const dayOfWeek = cursor.getDay();
    const hour      = cursor.getHours();

    if (
      WORK_DAYS.includes(dayOfWeek) &&
      hour >= WORK_START &&
      hour < WORK_END &&
      cursor > cutoff &&
      !bookedSet.has(cursor.toISOString())
    ) {
      slots.push(new Date(cursor));
    }

    cursor.setHours(cursor.getHours() + SLOT_HOURS);
  }

  return slots;
}

// ─────────────────────────────────────────────────────────────
// 3. FORMATA SLOTS PARA EXIBIÇÃO NO CHAT
// ─────────────────────────────────────────────────────────────

function formatSlots(slots) {
  return slots.map((dt, i) => {
    const dateStr = dt.toLocaleDateString('pt-BR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
    });
    const timeStr = dt.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit',
    });
    return `${i + 1}. ${dateStr} às ${timeStr}`;
  });
}

// ─────────────────────────────────────────────────────────────
// 4. CRIA AGENDAMENTO + NOTIFICA PRESTADOR
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object} data – { tenant_id, conversation_id, client_name,
 *                          client_phone, service_name, scheduled_at, notes }
 * @param {Object} tenant      – registro Tenant
 * @param {Object} Appointment – model Sequelize
 * @param {Object} User        – model Sequelize
 */
async function createAppointment(data, tenant, Appointment, User) {
  const appointment = await Appointment.create({
    tenant_id:       data.tenant_id,
    conversation_id: data.conversation_id || null,
    client_name:     data.client_name,
    client_phone:    data.client_phone,
    service_name:    data.service_name   || null,
    scheduled_at:    data.scheduled_at,
    notes:           data.notes          || null,
    status:          'confirmed',
    notified_provider: false,
  });

  // Busca o prestador principal do tenant (role = 'provider' ou admin com phone)
  const provider = await User.findOne({
    where: {
      tenant_id: tenant.id,
      is_active: true,
      [Op.or]: [{ role: 'provider' }, { role: 'admin' }],
    },
    order: [['created_at', 'ASC']],
  });

  let notifyResult = { skipped: true };
  if (provider?.phone) {
    try {
      notifyResult = await notifyProvider(provider.phone, appointment, tenant.name);
      await appointment.update({ notified_provider: true });
    } catch (err) {
      console.error('[Scheduling] Erro ao notificar prestador:', err.message);
    }
  } else {
    console.warn(`[Scheduling] Nenhum prestador com telefone encontrado para tenant=${tenant.id}`);
  }

  return { appointment, notifyResult };
}

// ─────────────────────────────────────────────────────────────
// 5. ORQUESTRA O FLUXO CONVERSACIONAL
// ─────────────────────────────────────────────────────────────

/**
 * Processa cada passo do fluxo de agendamento no chat.
 *
 * steps: 'init' | 'set_name' | 'set_phone' | 'select_slot'
 *
 * @returns {Object} { reply: string, nextStep: string, sessionUpdate: Object, appointment?: Object }
 */
async function processSchedulingStep(step, payload, session, tenant, models) {
  const { Appointment, KnowledgeBase, User } = models;
  const Groq = require('groq-sdk');

  switch (step) {

    // ── INIT: exibe prompt de nome ────────────────────────────
    case 'init': {
      const services = await extractServicesFromKB(Groq, tenant, KnowledgeBase);
      const serviceList = services.length
        ? `\n\nServiços disponíveis:\n` + services.map((s, i) => `• ${s}`).join('\n')
        : '';

      return {
        reply: `Ótimo! Vou te ajudar a contratar um serviço. 😊${serviceList}\n\nPrimeiro, me diga seu **Nome completo**:`,
        nextStep: 'set_name',
        sessionUpdate: { services },
      };
    }

    // ── SET_NAME: salva nome, pede telefone ───────────────────
    case 'set_name': {
      const name = (payload.text || '').trim();
      if (name.length < 2) {
        return {
          reply: 'Por favor, informe um nome válido.',
          nextStep: 'set_name',
          sessionUpdate: {},
        };
      }
      return {
        reply: `Perfeito, ${name}! Agora me informe seu **Telefone** (com DDD):`,
        nextStep: 'set_phone',
        sessionUpdate: { client_name: name },
      };
    }

    // ── SET_PHONE: valida telefone, exibe slots ───────────────
    case 'set_phone': {
      const phone = (payload.text || '').replace(/\D/g, '');
      if (phone.length < 10 || phone.length > 13) {
        return {
          reply: 'Número inválido. Informe o telefone com DDD, ex: 11 9 8888-7777.',
          nextStep: 'set_phone',
          sessionUpdate: {},
        };
      }

      const slots = await generateAvailableSlots(Appointment, tenant.id);
      if (!slots.length) {
        return {
          reply: 'Poxa, não encontrei horários disponíveis nos próximos dias. Por favor, entre em contato diretamente para verificar a agenda.',
          nextStep: 'done',
          sessionUpdate: { client_phone: phone },
        };
      }

      const lines = formatSlots(slots);
      const slotsText = lines.join('\n');

      return {
        reply:
          `Horários disponíveis:\n\n${slotsText}\n\nDigite o **número** do horário desejado:`,
        nextStep:      'select_slot',
        sessionUpdate: { client_phone: phone, slots: slots.map(s => s.toISOString()) },
      };
    }

    // ── SELECT_SLOT: cria agendamento ─────────────────────────
    case 'select_slot': {
      const choice   = parseInt((payload.text || '').trim(), 10);
      const slotList = (session.slots || []).map(s => new Date(s));

      if (isNaN(choice) || choice < 1 || choice > slotList.length) {
        const lines = formatSlots(slotList);
        return {
          reply: `Opção inválida. Por favor, escolha um número de 1 a ${slotList.length}:\n\n${lines.join('\n')}`,
          nextStep: 'select_slot',
          sessionUpdate: {},
        };
      }

      const chosen      = slotList[choice - 1];
      const serviceName = (session.services || [])[0] || null;

      const { appointment } = await createAppointment(
        {
          tenant_id:       tenant.id,
          conversation_id: session.conversation_id,
          client_name:     session.client_name,
          client_phone:    session.client_phone,
          service_name:    serviceName,
          scheduled_at:    chosen,
        },
        tenant,
        Appointment,
        User
      );

      const dtStr = chosen.toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      });
      const tmStr = chosen.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

      return {
        reply:
          `✅ **Agendamento confirmado!**\n\n` +
          `👤 Nome: ${session.client_name}\n` +
          `📱 Telefone: ${session.client_phone}\n` +
          `🔧 Serviço: ${serviceName || 'A definir'}\n` +
          `📅 Data: ${dtStr}\n` +
          `⏰ Hora: ${tmStr}\n\n` +
          `O prestador foi notificado. Até lá! 😊`,
        nextStep:    'done',
        sessionUpdate: {},
        appointment,
      };
    }

    default:
      return {
        reply: 'Ops, algo deu errado no fluxo de agendamento. Por favor, tente novamente.',
        nextStep: 'done',
        sessionUpdate: {},
      };
  }
}

module.exports = {
  processSchedulingStep,
  generateAvailableSlots,
  formatSlots,
};
