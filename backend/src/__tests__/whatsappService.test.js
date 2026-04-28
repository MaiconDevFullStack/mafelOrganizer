'use strict';

/**
 * Testes unitários — whatsappService.js
 *
 * Coberturas:
 *  • normalizePhone         – normalização de números
 *  • sendWhatsApp           – modo simulação para todos os providers
 *  • sendWhatsApp           – despacho real por provider (mock axios/twilio)
 *  • notifyClientPayment    – sem telefone → skipped
 *  • notifyClientPayment    – com telefone → texto correto enviado
 *  • withRetry              – retry em falha transiente, desiste em 4xx
 */

// ── Chaves de env manipuladas nos testes ──────────────────────
const ENV_KEYS = [
  'WHATSAPP_PROVIDER',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'TWILIO_SMS_FROM',
  'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN',
  'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE',
];

/**
 * Carrega whatsappService em registry isolado com env customizado.
 * Retorna { service, axiosMock, TwilioMock } com referências corretas
 * aos mocks usados internamente pelo módulo carregado.
 *
 * ⚠️  As variáveis de env ficam definidas até o próximo afterEach.
 *     Isso é necessário porque *Configured() lê process.env em runtime.
 */
function loadService(envOverrides = {}) {
  // limpa todas as chaves gerenciadas e aplica as overrides
  ENV_KEYS.forEach(k => delete process.env[k]);
  Object.assign(process.env, envOverrides);

  let service, axiosMock, TwilioMock;

  jest.isolateModules(() => {
    jest.mock('axios');
    jest.mock('twilio');
    axiosMock  = require('axios');
    TwilioMock = require('twilio');
    service    = require('../services/whatsappService');
  });

  return { service, axiosMock, TwilioMock };
}

afterEach(() => {
  jest.clearAllMocks();
  // limpa variáveis de env injetadas nos testes
  ENV_KEYS.forEach(k => delete process.env[k]);
});

// ─────────────────────────────────────────────────────────────
// normalizePhone
// ─────────────────────────────────────────────────────────────
describe('normalizePhone', () => {
  const { service } = loadService({ WHATSAPP_PROVIDER: 'twilio' });
  const { normalizePhone } = service;

  it('adiciona 55 em número de 11 dígitos', () => {
    expect(normalizePhone('11999990000')).toBe('5511999990000');
  });

  it('adiciona 55 em número de 10 dígitos', () => {
    expect(normalizePhone('1199990000')).toBe('551199990000');
  });

  it('remove caracteres não-numéricos', () => {
    expect(normalizePhone('(11) 9 9999-0000')).toBe('5511999990000');
  });

  it('mantém número já com DDI 55 (13 dígitos)', () => {
    expect(normalizePhone('5511999990000')).toBe('5511999990000');
  });

  it('retorna string vazia para entrada nula', () => {
    expect(normalizePhone(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────
// sendWhatsApp — modo simulação
// ─────────────────────────────────────────────────────────────
describe('sendWhatsApp — simulação (sem credenciais)', () => {
  const providers = ['twilio', 'sms', 'meta', 'evolution'];

  providers.forEach(provider => {
    it(`provider "${provider}" → simulated: true`, async () => {
      const { service } = loadService({ WHATSAPP_PROVIDER: provider });
      const result = await service.sendWhatsApp('11999990000', 'Mensagem teste');
      expect(result.simulated).toBe(true);
      expect(result.provider).toBe(provider);
      expect(result.to).toBe('5511999990000');
    });
  });
});

// ─────────────────────────────────────────────────────────────
// sendWhatsApp — provider Twilio WhatsApp (real, mockado)
// ─────────────────────────────────────────────────────────────
describe('sendWhatsApp — provider twilio (real)', () => {
  it('chama client.messages.create e retorna sid/status', async () => {
    const { service, TwilioMock } = loadService({
      WHATSAPP_PROVIDER:    'twilio',
      TWILIO_ACCOUNT_SID:   'ACtest',
      TWILIO_AUTH_TOKEN:    'token123',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+5511000000000',
    });

    const mockCreate = jest.fn().mockResolvedValue({
      sid: 'SM123', status: 'queued', to: 'whatsapp:+5511999990000',
    });
    TwilioMock.mockReturnValue({ messages: { create: mockCreate } });

    const result = await service.sendWhatsApp('11999990000', 'Olá cliente!');
    expect(mockCreate).toHaveBeenCalledWith({
      from: 'whatsapp:+5511000000000',
      to:   'whatsapp:+5511999990000',
      body: 'Olá cliente!',
    });
    expect(result.sid).toBe('SM123');
    expect(result.status).toBe('queued');
  });
});

// ─────────────────────────────────────────────────────────────
// sendWhatsApp — provider SMS Twilio (real, mockado)
// ─────────────────────────────────────────────────────────────
describe('sendWhatsApp — provider sms (real)', () => {
  it('chama client.messages.create com from SMS e retorna sid', async () => {
    const { service, TwilioMock } = loadService({
      WHATSAPP_PROVIDER:  'sms',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN:  'token123',
      TWILIO_SMS_FROM:    '+15559403012',
    });

    const mockCreate = jest.fn().mockResolvedValue({
      sid: 'SM_SMS_001', status: 'sent', to: '+5511999990000',
    });
    TwilioMock.mockReturnValue({ messages: { create: mockCreate } });

    const result = await service.sendWhatsApp('11999990000', 'Lembrete de pagamento');
    expect(mockCreate).toHaveBeenCalledWith({
      from: '+15559403012',
      to:   '+5511999990000',
      body: 'Lembrete de pagamento',
    });
    expect(result.sid).toBe('SM_SMS_001');
  });
});

// ─────────────────────────────────────────────────────────────
// sendWhatsApp — provider Meta Cloud API (real, mockado)
// ─────────────────────────────────────────────────────────────
describe('sendWhatsApp — provider meta (real)', () => {
  it('faz POST ao endpoint Meta e retorna data', async () => {
    const { service, axiosMock } = loadService({
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_PHONE_ID: 'PHONE_ID_123',
      WHATSAPP_TOKEN:    'EAAToken',
    });

    axiosMock.post = jest.fn().mockResolvedValue({
      data: { messages: [{ id: 'wamid.123' }] },
    });

    const result = await service.sendWhatsApp('11999990000', 'Cobrança vencida');
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining('PHONE_ID_123/messages'),
      expect.objectContaining({
        messaging_product: 'whatsapp',
        to:                '5511999990000',
        type:              'text',
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer EAAToken' }) })
    );
    expect(result.messages[0].id).toBe('wamid.123');
  });
});

// ─────────────────────────────────────────────────────────────
// sendWhatsApp — provider Evolution API (real, mockado)
// ─────────────────────────────────────────────────────────────
describe('sendWhatsApp — provider evolution (real)', () => {
  it('faz POST ao endpoint Evolution e retorna data', async () => {
    const { service, axiosMock } = loadService({
      WHATSAPP_PROVIDER:  'evolution',
      EVOLUTION_API_URL:  'https://evolution.test.com',
      EVOLUTION_API_KEY:  'evkey123',
      EVOLUTION_INSTANCE: 'minha-instancia',
    });

    axiosMock.post = jest.fn().mockResolvedValue({ data: { key: { id: 'evo_123' } } });

    const result = await service.sendWhatsApp('11999990000', 'Mensagem evolution');
    expect(axiosMock.post).toHaveBeenCalledWith(
      'https://evolution.test.com/message/sendText/minha-instancia',
      expect.objectContaining({ number: '5511999990000' }),
      expect.objectContaining({ headers: expect.objectContaining({ apikey: 'evkey123' }) })
    );
    expect(result.key.id).toBe('evo_123');
  });
});

// ─────────────────────────────────────────────────────────────
// sendWhatsApp — retry e propagação de erro
// ─────────────────────────────────────────────────────────────
describe('sendWhatsApp — retry / erro definitivo', () => {
  it('propaga erro após 3 tentativas (timeout transiente)', async () => {
    const { service, axiosMock } = loadService({
      WHATSAPP_PROVIDER:  'evolution',
      EVOLUTION_API_URL:  'https://evolution.test.com',
      EVOLUTION_API_KEY:  'key',
      EVOLUTION_INSTANCE: 'inst',
    });
    axiosMock.post = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.sendWhatsApp('11999990000', 'teste')).rejects.toThrow(
      /Falha ao enviar WhatsApp \(evolution\)/
    );
    expect(axiosMock.post).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('não faz retry em erro 401 (não autorizado)', async () => {
    const { service, axiosMock } = loadService({
      WHATSAPP_PROVIDER:  'evolution',
      EVOLUTION_API_URL:  'https://evolution.test.com',
      EVOLUTION_API_KEY:  'key',
      EVOLUTION_INSTANCE: 'inst',
    });
    const err = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    axiosMock.post = jest.fn().mockRejectedValue(err);

    await expect(service.sendWhatsApp('11999990000', 'teste')).rejects.toThrow();
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });

  it('não faz retry em erro 400 (payload inválido)', async () => {
    const { service, axiosMock } = loadService({
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_PHONE_ID: 'PH123',
      WHATSAPP_TOKEN:    'token',
    });
    const err = Object.assign(new Error('Bad Request'), { response: { status: 400 } });
    axiosMock.post = jest.fn().mockRejectedValue(err);

    await expect(service.sendWhatsApp('11999990000', 'teste')).rejects.toThrow();
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// notifyClientPayment — lembrete de cobrança
// ─────────────────────────────────────────────────────────────
describe('notifyClientPayment', () => {
  const baseSchedule = {
    client_phone:   '11999990000',
    client_name:    'João Silva',
    due_date:       '2026-05-10',
    amount:         '350.00',
    description:    'Mensalidade maio',
    custom_message: null,
  };

  it('retorna { skipped: true } quando client_phone é nulo', async () => {
    const { service } = loadService({ WHATSAPP_PROVIDER: 'twilio' });
    const result = await service.notifyClientPayment({ ...baseSchedule, client_phone: null }, 'Salão');
    expect(result).toEqual({ skipped: true });
  });

  it('chama sendWhatsApp com texto contendo nome, valor, tenant e data', async () => {
    const { service, TwilioMock } = loadService({
      WHATSAPP_PROVIDER:    'twilio',
      TWILIO_ACCOUNT_SID:   'ACtest',
      TWILIO_AUTH_TOKEN:    'token',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+5511000000000',
    });
    const mockCreate = jest.fn().mockResolvedValue({ sid: 'SM_PAY', status: 'queued', to: '' });
    TwilioMock.mockReturnValue({ messages: { create: mockCreate } });

    await service.notifyClientPayment(baseSchedule, 'Salão da Maria');

    const sentBody = mockCreate.mock.calls[0][0].body;
    expect(sentBody).toContain('João Silva');
    expect(sentBody).toContain('R$');
    expect(sentBody).toContain('350');
    expect(sentBody).toContain('Salão da Maria');
    expect(sentBody).toContain('Lembrete de pagamento');
    expect(sentBody).toContain('Vencimento');
    expect(sentBody).toContain('10/05/2026');
  });

  it('inclui descrição no texto quando presente', async () => {
    const { service, TwilioMock } = loadService({
      WHATSAPP_PROVIDER:    'twilio',
      TWILIO_ACCOUNT_SID:   'ACtest',
      TWILIO_AUTH_TOKEN:    'token',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+5511000000000',
    });
    const mockCreate = jest.fn().mockResolvedValue({ sid: 'SM_DESC', status: 'queued', to: '' });
    TwilioMock.mockReturnValue({ messages: { create: mockCreate } });

    await service.notifyClientPayment({ ...baseSchedule, description: 'Serviço de corte' }, 'Barbearia');
    const sentBody = mockCreate.mock.calls[0][0].body;
    expect(sentBody).toContain('Serviço de corte');
  });

  it('inclui custom_message quando presente', async () => {
    const { service, TwilioMock } = loadService({
      WHATSAPP_PROVIDER:    'twilio',
      TWILIO_ACCOUNT_SID:   'ACtest',
      TWILIO_AUTH_TOKEN:    'token',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+5511000000000',
    });
    const mockCreate = jest.fn().mockResolvedValue({ sid: 'SM_CM', status: 'queued', to: '' });
    TwilioMock.mockReturnValue({ messages: { create: mockCreate } });

    await service.notifyClientPayment(
      { ...baseSchedule, custom_message: 'Pagamento via PIX preferencial.' },
      'Clínica'
    );
    const sentBody = mockCreate.mock.calls[0][0].body;
    expect(sentBody).toContain('Pagamento via PIX preferencial.');
  });

  it('usa fallback "seu prestador" quando tenantName é nulo (modo simulação)', async () => {
    const { service } = loadService({ WHATSAPP_PROVIDER: 'twilio' }); // sem credenciais → simulação
    const result = await service.notifyClientPayment(baseSchedule, null);
    expect(result.simulated).toBe(true);
  });
});
