'use strict';

/**
 * Testes de integração — routes/whatsapp.js
 *
 * Utiliza supertest para simular requisições HTTP à rota.
 * Mocks: verifyToken (auth), PaymentSchedule+Tenant (models), notifyClientPayment+sendWhatsApp (service).
 */

const request = require('supertest');
const express = require('express');

// ── Mocks globais ─────────────────────────────────────────────

jest.mock('../middlewares/auth', () => ({
  verifyToken: (req, _res, next) => {
    req.userId   = 'user-test-id';
    req.tenantId = 'tenant-test-id';
    next();
  },
}));

const mockNotifyClientPayment = jest.fn();
const mockSendWhatsApp        = jest.fn();
const mockGetStatus           = jest.fn();

jest.mock('../services/whatsappService', () => ({
  notifyClientPayment: mockNotifyClientPayment,
  sendWhatsApp:        mockSendWhatsApp,
  getStatus:           mockGetStatus,
}));

const mockScheduleFindByPk = jest.fn();
const mockTenantFindByPk   = jest.fn();

jest.mock('../models', () => ({
  PaymentSchedule: { findByPk: mockScheduleFindByPk },
  Tenant:          { findByPk: mockTenantFindByPk },
}));

// ── Bootstrap do app ──────────────────────────────────────────

let app;

beforeAll(() => {
  const whatsappRouter = require('../routes/whatsapp');
  app = express();
  app.use(express.json());
  app.use('/api/whatsapp', whatsappRouter);
});

afterEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────
// GET /api/whatsapp/status
// ─────────────────────────────────────────────────────────────
describe('GET /api/whatsapp/status', () => {
  it('retorna 200 com status do provider', async () => {
    mockGetStatus.mockResolvedValue({ configured: true, provider: 'twilio' });

    const res = await request(app).get('/api/whatsapp/status');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.provider).toBe('twilio');
  });

  it('retorna 500 quando getStatus lança erro', async () => {
    mockGetStatus.mockRejectedValue(new Error('Falha de conexão'));

    const res = await request(app).get('/api/whatsapp/status');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Falha de conexão/);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/whatsapp/test
// ─────────────────────────────────────────────────────────────
describe('POST /api/whatsapp/test', () => {
  it('400 quando "to" não é informado', async () => {
    const res = await request(app)
      .post('/api/whatsapp/test')
      .send({ message: 'Teste' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('400 quando "to" tem menos de 10 dígitos', async () => {
    const res = await request(app)
      .post('/api/whatsapp/test')
      .send({ to: '1199', message: 'teste' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('DDD');
  });

  it('200 com envio simulado', async () => {
    mockSendWhatsApp.mockResolvedValue({ simulated: true, provider: 'twilio', to: '5511999990000' });

    const res = await request(app)
      .post('/api/whatsapp/test')
      .send({ to: '11999990000' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.simulated).toBe(true);
  });

  it('200 com envio real (simulated: false)', async () => {
    mockSendWhatsApp.mockResolvedValue({ sid: 'SM123', status: 'queued' });

    const res = await request(app)
      .post('/api/whatsapp/test')
      .send({ to: '11999990000', message: 'Meu teste' });

    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(false);
    expect(res.body.result.sid).toBe('SM123');
  });

  it('502 quando sendWhatsApp lança erro', async () => {
    mockSendWhatsApp.mockRejectedValue(new Error('Provider indisponível'));

    const res = await request(app)
      .post('/api/whatsapp/test')
      .send({ to: '11999990000' });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Provider indisponível/);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/whatsapp/notify/payment
// ─────────────────────────────────────────────────────────────
describe('POST /api/whatsapp/notify/payment — disparos de cobrança', () => {
  const validSchedule = {
    id:           'sched-uuid-001',
    tenant_id:    'tenant-test-id',
    client_phone: '11999990000',
    client_name:  'Maria Oliveira',
    due_date:     '2026-05-10',
    amount:       '200.00',
    description:  'Serviço de design gráfico',
    custom_message: null,
  };

  it('400 quando schedule_id não é enviado', async () => {
    const res = await request(app)
      .post('/api/whatsapp/notify/payment')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/schedule_id/i);
  });

  it('404 quando schedule não é encontrado', async () => {
    mockScheduleFindByPk.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/whatsapp/notify/payment')
      .send({ schedule_id: 'nao-existe' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/não encontrada/i);
  });

  it('422 quando cliente não tem telefone', async () => {
    mockScheduleFindByPk.mockResolvedValue({ ...validSchedule, client_phone: null });

    const res = await request(app)
      .post('/api/whatsapp/notify/payment')
      .send({ schedule_id: 'sched-uuid-001' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/sem telefone/i);
  });

  it('200 — envia cobrança com simulated: true', async () => {
    mockScheduleFindByPk.mockResolvedValue(validSchedule);
    mockTenantFindByPk.mockResolvedValue({ name: 'Studio Legal' });
    mockNotifyClientPayment.mockResolvedValue({ simulated: true, provider: 'twilio', to: '5511999990000' });

    const res = await request(app)
      .post('/api/whatsapp/notify/payment')
      .send({ schedule_id: 'sched-uuid-001' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.simulated).toBe(true);

    // verifica que notifyClientPayment foi chamado com o schedule e tenantName corretos
    expect(mockNotifyClientPayment).toHaveBeenCalledWith(validSchedule, 'Studio Legal');
  });

  it('200 — envia cobrança com resultado real (simulated: false)', async () => {
    mockScheduleFindByPk.mockResolvedValue(validSchedule);
    mockTenantFindByPk.mockResolvedValue({ name: 'Barbearia Top' });
    mockNotifyClientPayment.mockResolvedValue({ sid: 'SM_PAY_001', status: 'queued' });

    const res = await request(app)
      .post('/api/whatsapp/notify/payment')
      .send({ schedule_id: 'sched-uuid-001' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.simulated).toBe(false);
    expect(res.body.result.sid).toBe('SM_PAY_001');
  });

  it('200 — envia cobrança mesmo sem tenant cadastrado (tenantName undefined)', async () => {
    mockScheduleFindByPk.mockResolvedValue(validSchedule);
    mockTenantFindByPk.mockResolvedValue(null); // tenant não encontrado
    mockNotifyClientPayment.mockResolvedValue({ simulated: true });

    const res = await request(app)
      .post('/api/whatsapp/notify/payment')
      .send({ schedule_id: 'sched-uuid-001' });

    expect(res.status).toBe(200);
    // tenantName deve ser undefined (notifyClientPayment usa fallback "seu prestador")
    expect(mockNotifyClientPayment).toHaveBeenCalledWith(validSchedule, undefined);
  });

  it('502 quando notifyClientPayment lança erro', async () => {
    mockScheduleFindByPk.mockResolvedValue(validSchedule);
    mockTenantFindByPk.mockResolvedValue({ name: 'Salão X' });
    mockNotifyClientPayment.mockRejectedValue(new Error('Falha ao enviar WhatsApp (twilio): timeout'));

    const res = await request(app)
      .post('/api/whatsapp/notify/payment')
      .send({ schedule_id: 'sched-uuid-001' });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Falha ao enviar/);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/whatsapp/send
// ─────────────────────────────────────────────────────────────
describe('POST /api/whatsapp/send', () => {
  it('400 quando "to" não é informado', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ message: 'Olá' });
    expect(res.status).toBe(400);
  });

  it('400 quando "message" não é informado', async () => {
    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ to: '11999990000' });
    expect(res.status).toBe(400);
  });

  it('200 retorna resultado do envio', async () => {
    mockSendWhatsApp.mockResolvedValue({ sid: 'SM_SEND', status: 'sent' });

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ to: '11999990000', message: 'Mensagem manual' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result.sid).toBe('SM_SEND');
  });

  it('502 quando sendWhatsApp falha', async () => {
    mockSendWhatsApp.mockRejectedValue(new Error('Serviço indisponível'));

    const res = await request(app)
      .post('/api/whatsapp/send')
      .send({ to: '11999990000', message: 'Teste' });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
  });
});
