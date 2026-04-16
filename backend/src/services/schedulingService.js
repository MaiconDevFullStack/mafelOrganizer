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

const DAYS_AHEAD = 14;  // quantos dias à frente verificar slots
const MAX_SLOTS  = 10;  // limite de slots retornados ao cliente

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
 * Gera slots disponíveis consultando a tabela service_slots do tenant.
 *
 * @param {Object} Appointment  – model Sequelize
 * @param {Object} ServiceSlot  – model Sequelize
 * @param {string} tenantId
 * @returns {Array<{date: Date, service_name: string|null, duration_minutes: number}>}
 */
async function generateAvailableSlots(Appointment, ServiceSlot, tenantId) {
  const now    = new Date();
  const cutoff = new Date(now.getTime() + 60 * 60 * 1000); // mínimo 1h no futuro
  const end    = new Date(now);
  end.setDate(end.getDate() + DAYS_AHEAD + 1);

  // Busca configuração de slots ativos do tenant
  const serviceSlots = await ServiceSlot.findAll({
    where: { tenant_id: tenantId, is_active: true },
    order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
  });

  if (!serviceSlots.length) return [];

  // Conta agendamentos no período para calcular max_bookings
  const booked = await Appointment.findAll({
    where: {
      tenant_id: tenantId,
      status:    { [Op.ne]: 'cancelled' },
      scheduled_at: { [Op.between]: [cutoff, end] },
    },
    attributes: ['scheduled_at'],
  });

  // Mapa: isoString -> contagem de agendamentos
  const bookingCounts = new Map();
  for (const a of booked) {
    const key = new Date(a.scheduled_at).toISOString();
    bookingCounts.set(key, (bookingCounts.get(key) || 0) + 1);
  }

  const slots = [];

  // Itera pelos próximos DAYS_AHEAD dias
  for (let d = 0; d <= DAYS_AHEAD && slots.length < MAX_SLOTS; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const dayOfWeek = day.getDay();

    // Filtra slots configurados para este dia da semana
    const daySlots = serviceSlots.filter(s => s.day_of_week === dayOfWeek);

    for (const ss of daySlots) {
      if (slots.length >= MAX_SLOTS) break;

      const [hh, mm] = ss.start_time.split(':').map(Number);
      const slotDate = new Date(day);
      slotDate.setHours(hh, mm, 0, 0);

      if (slotDate <= cutoff) continue; // muito próximo

      const key   = slotDate.toISOString();
      const count = bookingCounts.get(key) || 0;
      if (count < (ss.max_bookings || 1)) {
        slots.push({
          date:             slotDate,
          service_name:     ss.service_name || null,
          duration_minutes: ss.duration_minutes || 60,
        });
      }
    }
  }

  return slots;
}

// ─────────────────────────────────────────────────────────────
// 3. FORMATA SLOTS PARA EXIBIÇÃO NO CHAT
// ─────────────────────────────────────────────────────────────

function formatSlots(slots) {
  return slots.map((slot, i) => {
    const dt      = slot.date || slot; // compatível com Date simples
    const dateStr = dt.toLocaleDateString('pt-BR', {
      weekday: 'short', day: '2-digit', month: '2-digit',
    });
    const timeStr = dt.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit',
    });
    const svcStr  = slot.service_name ? ` — ${slot.service_name}` : '';
    return `${i + 1}. ${dateStr} às ${timeStr}${svcStr}`;
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
  const { Appointment, KnowledgeBase, User, ServiceSlot } = models;
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

      const slots = await generateAvailableSlots(Appointment, ServiceSlot, tenant.id);
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
        sessionUpdate: {
          client_phone: phone,
          slots: slots.map(s => ({
            date:             s.date.toISOString(),
            service_name:     s.service_name,
            duration_minutes: s.duration_minutes,
          })),
        },
      };
    }

    // ── SELECT_SLOT: cria agendamento ─────────────────────────
    case 'select_slot': {
      const choice   = parseInt((payload.text || '').trim(), 10);
      const slotList = (session.slots || []).map(s =>
        typeof s === 'object' && s.date
          ? { date: new Date(s.date), service_name: s.service_name, duration_minutes: s.duration_minutes }
          : { date: new Date(s), service_name: null, duration_minutes: 60 }
      );

      if (isNaN(choice) || choice < 1 || choice > slotList.length) {
        const lines = formatSlots(slotList);
        return {
          reply: `Opção inválida. Por favor, escolha um número de 1 a ${slotList.length}:\n\n${lines.join('\n')}`,
          nextStep: 'select_slot',
          sessionUpdate: {},
        };
      }

      const chosen      = slotList[choice - 1];
      const serviceName = chosen.service_name || (session.services || [])[0] || null;

      const { appointment } = await createAppointment(
        {
          tenant_id:       tenant.id,
          conversation_id: session.conversation_id,
          client_name:     session.client_name,
          client_phone:    session.client_phone,
          service_name:    serviceName,
          scheduled_at:    chosen.date,
        },
        tenant,
        Appointment,
        User
      );

      const dtStr = chosen.date.toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      });
      const tmStr = chosen.date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

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
