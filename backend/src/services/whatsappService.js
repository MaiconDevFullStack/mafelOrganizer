'use strict';

/**
 * whatsappService.js
 *
 * Suporta dois providers, escolhidos por WHATSAPP_PROVIDER no .env:
 *
 *   WHATSAPP_PROVIDER=evolution   (padrão — Evolution API auto-hospedada)
 *     EVOLUTION_API_URL     ex: https://evolution.seuservidor.com
 *     EVOLUTION_API_KEY     chave da instância
 *     EVOLUTION_INSTANCE    nome da instância
 *
 *   WHATSAPP_PROVIDER=meta        (WhatsApp Cloud API oficial da Meta)
 *     WHATSAPP_PHONE_ID     ID do número no Business Manager
 *     WHATSAPP_TOKEN        Token permanente ou de sistema
 *
 * Se nenhuma variável estiver configurada, loga a mensagem em modo
 * simulação sem lançar erro (útil em desenvolvimento).
 */

const axios = require('axios');

// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────
const PROVIDER        = (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase();
const META_API_VER    = 'v19.0';
const META_BASE_URL   = `https://graph.facebook.com/${META_API_VER}`;
const RETRY_ATTEMPTS  = 3;
const RETRY_DELAY_MS  = 1_500;

// ─────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────────────────────

/**
 * Normaliza para E.164 sem "+".
 * "11 9 9999-0000" → "5511999990000"
 */
function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

/** Espera `ms` milissegundos. */
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Executa `fn` com até `attempts` tentativas, back-off linear.
 */
async function withRetry(fn, attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts;
      const status = err.response?.status;
      // Não tenta de novo para erros de autenticação / payload inválido
      if (status === 401 || status === 403 || status === 400) throw err;
      if (!isLast) {
        console.warn(`[WhatsApp] Tentativa ${i}/${attempts} falhou. Aguardando ${delayMs * i}ms…`);
        await wait(delayMs * i);
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────
// PROVIDER: EVOLUTION API
// ─────────────────────────────────────────────────────────────

function evolutionConfigured() {
  return !!(
    process.env.EVOLUTION_API_URL &&
    process.env.EVOLUTION_API_KEY &&
    process.env.EVOLUTION_INSTANCE
  );
}

async function sendViaEvolution(phone, text) {
  const url      = process.env.EVOLUTION_API_URL.replace(/\/$/, '');
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  const endpoint = `${url}/message/sendText/${instance}`;

  const response = await axios.post(
    endpoint,
    {
      number:      phone,
      textMessage: { text },
      options:     { delay: 500, presence: 'composing' },
    },
    {
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      timeout: 12_000,
    }
  );

  return response.data;
}

/** Verifica se a instância Evolution está conectada ao WhatsApp. */
async function evolutionStatus() {
  if (!evolutionConfigured()) return { configured: false };
  const url      = process.env.EVOLUTION_API_URL.replace(/\/$/, '');
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;

  try {
    const resp = await axios.get(`${url}/instance/connectionState/${instance}`, {
      headers: { apikey: apiKey },
      timeout: 8_000,
    });
    return { configured: true, provider: 'evolution', state: resp.data };
  } catch (err) {
    return {
      configured: true,
      provider:   'evolution',
      error:      err.response?.data?.message || err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// PROVIDER: META WHATSAPP CLOUD API
// ─────────────────────────────────────────────────────────────

function metaConfigured() {
  return !!(process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_TOKEN);
}

async function sendViaMeta(phone, text) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token   = process.env.WHATSAPP_TOKEN;
  const endpoint = `${META_BASE_URL}/${phoneId}/messages`;

  const response = await axios.post(
    endpoint,
    {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                phone,
      type:              'text',
      text:              { preview_url: false, body: text },
    },
    {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 12_000,
    }
  );

  return response.data;
}

/** Retorna o status do número Meta (créditos, qualidade, etc.). */
async function metaStatus() {
  if (!metaConfigured()) return { configured: false };
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token   = process.env.WHATSAPP_TOKEN;

  try {
    const resp = await axios.get(`${META_BASE_URL}/${phoneId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params:  { fields: 'display_phone_number,verified_name,quality_rating,platform_type' },
      timeout: 8_000,
    });
    return { configured: true, provider: 'meta', info: resp.data };
  } catch (err) {
    return {
      configured: true,
      provider:   'meta',
      error:      err.response?.data?.error?.message || err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// DISPATCHER PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Envia mensagem de texto pelo provider configurado.
 * Retorna o payload de confirmação da API ou { simulated: true }.
 *
 * @param {string} toPhone  – número no formato bruto ("11 9 9999-0000")
 * @param {string} text     – texto da mensagem
 */
async function sendWhatsApp(toPhone, text) {
  const phone = normalizePhone(toPhone);

  // ── Modo simulação ──────────────────────────────────────────
  if (PROVIDER === 'evolution' && !evolutionConfigured()) {
    console.warn('[WhatsApp] Evolution não configurada → SIMULANDO envio.');
    console.warn(`  Para: ${phone}\n  Texto: ${text}`);
    return { simulated: true, provider: 'evolution', to: phone };
  }
  if (PROVIDER === 'meta' && !metaConfigured()) {
    console.warn('[WhatsApp] Meta não configurada → SIMULANDO envio.');
    console.warn(`  Para: ${phone}\n  Texto: ${text}`);
    return { simulated: true, provider: 'meta', to: phone };
  }

  // ── Envio real com retry ────────────────────────────────────
  try {
    let result;
    if (PROVIDER === 'meta') {
      result = await withRetry(() => sendViaMeta(phone, text));
      console.log(`[WhatsApp][Meta] Enviado para ${phone}.`);
    } else {
      result = await withRetry(() => sendViaEvolution(phone, text));
      console.log(`[WhatsApp][Evolution] Enviado para ${phone}.`);
    }
    return result;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[WhatsApp] Falha definitiva ao enviar:', detail);
    throw new Error(`Falha ao enviar WhatsApp (${PROVIDER}): ${JSON.stringify(detail)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// NOTIFICAÇÃO DE AGENDAMENTO
// ─────────────────────────────────────────────────────────────

function buildProviderMessage(appointment, tenantName) {
  const dt      = new Date(appointment.scheduled_at);
  const dateStr = dt.toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const timeStr = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  return [
    `🗓️ *Novo Agendamento — ${tenantName || 'seu negócio'}*`,
    ``,
    `👤 *Cliente:* ${appointment.client_name}`,
    `📱 *Telefone:* ${appointment.client_phone}`,
    `🔧 *Serviço:* ${appointment.service_name || 'Não especificado'}`,
    `📅 *Data:* ${dateStr}`,
    `⏰ *Hora:* ${timeStr}`,
    appointment.notes ? `📝 *Obs:* ${appointment.notes}` : null,
    ``,
    `✅ Agendamento confirmado via chat.`,
  ].filter(l => l !== null).join('\n');
}

async function notifyProvider(providerPhone, appointment, tenantName) {
  if (!providerPhone) {
    console.warn('[WhatsApp] Nenhum telefone de prestador. Notificação ignorada.');
    return { skipped: true };
  }
  const text = buildProviderMessage(appointment, tenantName);
  return sendWhatsApp(providerPhone, text);
}

// ─────────────────────────────────────────────────────────────
// STATUS / DIAGNÓSTICO
// ─────────────────────────────────────────────────────────────

async function getStatus() {
  if (PROVIDER === 'meta')       return metaStatus();
  if (PROVIDER === 'evolution')  return evolutionStatus();
  return { configured: false, error: `Provider desconhecido: ${PROVIDER}` };
}

module.exports = {
  sendWhatsApp,
  notifyProvider,
  normalizePhone,
  getStatus,
};
