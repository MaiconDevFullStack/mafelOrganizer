'use strict';

/**
 * Testes unitários — groqService.js (pipeline de KB)
 *
 * Coberturas:
 *   tokenize          – normalização, remoção de stopwords e acentos
 *   expandQuery       – expansão de sinônimos de domínio
 *   splitIntoChunks   – chunking com sobreposição
 *   scoreChunk        – score TF-IDF unigram + bigram boost
 *   selectTopChunks   – ranking e deduplicação de chunks
 *   buildSystemPrompt – três modos: com KB, KB vazia, sem KB
 *   buildKbContext    – pipeline completo (fs+DB mockados)
 *
 * Fixture de KB: barbearia/salão realista com preços, horários,
 * formas de pagamento, cancelamento e localização.
 */

process.env.NODE_ENV = 'test';

jest.mock('axios');
jest.mock('twilio');
jest.mock('groq-sdk');
jest.mock('pdf-parse');
jest.mock('mammoth');
jest.mock('fs');

const fs   = require('fs');
const path = require('path');

// ── Carrega o serviço APÓS configurar NODE_ENV ─────────────────
const svc = require('../services/groqService');
const {
  tokenize,
  expandQuery,
  splitIntoChunks,
  scoreChunk,
  buildIdf,
  selectTopChunks,
  buildSystemPrompt,
} = svc._internals;

// ─────────────────────────────────────────────────────────────
// FIXTURE: texto KB de uma barbearia
// ─────────────────────────────────────────────────────────────
const KB_FIXTURE = `
Barbearia Estilo Certo — FAQ e Informações

HORÁRIOS DE FUNCIONAMENTO
Segunda a sexta-feira: 09h às 20h
Sábados: 09h às 18h
Domingos e feriados: fechado

SERVIÇOS E PREÇOS
Corte de cabelo masculino: R$ 45,00
Barba completa (navalha): R$ 35,00
Corte + Barba (combo): R$ 70,00
Progressiva masculina: R$ 150,00
Coloração: a partir de R$ 80,00
Hidratação capilar: R$ 60,00

FORMAS DE PAGAMENTO
Aceitamos: dinheiro, cartão de débito, cartão de crédito (parcelamos em até 3x sem juros) e Pix.
Chave Pix: barbearia.estilocerto@email.com

POLÍTICA DE CANCELAMENTO E REAGENDAMENTO
Cancelamentos com menos de 2 horas de antecedência estão sujeitos a cobrança de 50% do valor do serviço.
Para reagendar, entre em contato pelo WhatsApp com no mínimo 3 horas de antecedência.
Clientes que não comparecem sem aviso (no-show) serão cobrados integralmente na próxima visita.

AGENDAMENTO
Os agendamentos podem ser feitos pelo WhatsApp, pelo site ou diretamente pelo chat.
Confirmaremos sua reserva em até 30 minutos.

LOCALIZAÇÃO E CONTATO
Rua das Flores, 123 — Bairro Centro, São Paulo — SP
WhatsApp: (11) 91234-5678
E-mail: contato@estilocerto.com.br
Estacionamento gratuito disponível no local.

PROGRAMA DE FIDELIDADE
A cada 10 cortes realizados, o cliente ganha 1 corte gratuito.
O controle é feito pelo nosso sistema — basta informar seu telefone no caixa.

PRODUTOS PARA VENDA
Vendemos produtos para barba e cabelo de marcas nacionais e importadas.
Os preços variam de R$ 25,00 a R$ 200,00.
`.trim();

// ─────────────────────────────────────────────────────────────
// tokenize
// ─────────────────────────────────────────────────────────────
describe('tokenize', () => {
  it('converte para minúsculas e remove acentos', () => {
    const tokens = tokenize('Horários de Funcionamento');
    expect(tokens).toContain('horarios');
    expect(tokens).toContain('funcionamento');
  });

  it('remove stopwords', () => {
    const tokens = tokenize('qual é o horário de atendimento');
    expect(tokens).not.toContain('qual');
    expect(tokens).not.toContain('de');
    expect(tokens).toContain('horario');
    expect(tokens).toContain('atendimento');
  });

  it('remove pontuação e caracteres especiais', () => {
    const tokens = tokenize('Rua das Flores, 123 — Centro');
    expect(tokens).toContain('rua');
    expect(tokens).toContain('flores');
    expect(tokens).toContain('123');
    expect(tokens).toContain('centro');
    expect(tokens).not.toContain(',');
    expect(tokens).not.toContain('—');
  });

  it('filtra tokens curtos (≤ 2 chars)', () => {
    const tokens = tokenize('de um em ao os');
    expect(tokens.every(t => t.length > 2)).toBe(true);
  });

  it('retorna array vazio para string vazia', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('normaliza "preço" → "preco"', () => {
    expect(tokenize('qual o preço do corte?')).toContain('preco');
  });
});

// ─────────────────────────────────────────────────────────────
// expandQuery
// ─────────────────────────────────────────────────────────────
describe('expandQuery', () => {
  it('expande "preco" com sinônimos de domínio', () => {
    const expanded = expandQuery(['preco']);
    expect(expanded).toContain('valor');
    expect(expanded).toContain('custo');
    expect(expanded).toContain('mensalidade');
    expect(expanded).toContain('tarifa');
  });

  it('expande "pagamento" com termos financeiros', () => {
    const expanded = expandQuery(['pagamento']);
    expect(expanded).toContain('boleto');
    expect(expanded).toContain('pix');
    expect(expanded).toContain('fatura');
  });

  it('expande "horario" com termos de agendamento', () => {
    const expanded = expandQuery(['horario']);
    expect(expanded).toContain('agendamento');
    expect(expanded).toContain('disponibilidade');
  });

  it('expande "cancelar" com reagendamento', () => {
    const expanded = expandQuery(['cancelar']);
    expect(expanded).toContain('cancelamento');
    expect(expanded).toContain('reagendar');
  });

  it('mantém tokens originais sem sinônimos', () => {
    const expanded = expandQuery(['barbearia', 'corte']);
    expect(expanded).toContain('barbearia');
    expect(expanded).toContain('corte');
  });

  it('não duplica tokens já presentes', () => {
    const expanded = expandQuery(['valor', 'preco']);
    const set = new Set(expanded);
    expect(set.size).toBe(expanded.length); // sem duplicatas
  });
});

// ─────────────────────────────────────────────────────────────
// splitIntoChunks
// ─────────────────────────────────────────────────────────────
describe('splitIntoChunks', () => {
  it('gera chunks a partir de texto longo', () => {
    const chunks = splitIntoChunks(KB_FIXTURE, 'faq.txt');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('todos os chunks têm source e text', () => {
    const chunks = splitIntoChunks(KB_FIXTURE, 'faq.txt');
    for (const c of chunks) {
      expect(c.source).toBe('faq.txt');
      expect(typeof c.text).toBe('string');
      expect(c.text.length).toBeGreaterThan(60);
    }
  });

  it('retorna array vazio para texto muito curto', () => {
    const chunks = splitIntoChunks('Olá.', 'curto.txt');
    expect(chunks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// scoreChunk + buildIdf
// ─────────────────────────────────────────────────────────────
describe('scoreChunk', () => {
  const chunks = splitIntoChunks(KB_FIXTURE, 'faq.txt');
  const idf    = buildIdf(chunks);

  it('score > 0 quando query compartilha tokens com o chunk', () => {
    const chunkTokens  = tokenize('Corte de cabelo masculino: R$ 45,00');
    const queryTokens  = expandQuery(tokenize('quanto custa o corte'));
    const score        = scoreChunk(chunkTokens, queryTokens, idf);
    expect(score).toBeGreaterThan(0);
  });

  it('score = 0 quando não há tokens em comum', () => {
    const chunkTokens = tokenize('Informações sobre localização e estacionamento');
    const queryTokens = expandQuery(tokenize('xyz abc zzz'));
    const score       = scoreChunk(chunkTokens, queryTokens, idf);
    expect(score).toBe(0);
  });

  it('bigram boost aumenta score de frase composta', () => {
    const chunkTokens   = tokenize('formas de pagamento: dinheiro, cartão, Pix');
    const bigramQ       = expandQuery(tokenize('forma pagamento'));
    const unigramQ      = expandQuery(tokenize('pagamento'));
    const scoreBigram   = scoreChunk(chunkTokens, bigramQ, idf);
    const scoreUnigram  = scoreChunk(chunkTokens, unigramQ, idf);
    expect(scoreBigram).toBeGreaterThanOrEqual(scoreUnigram);
  });
});

// ─────────────────────────────────────────────────────────────
// selectTopChunks — ranking de relevância com KB real
// ─────────────────────────────────────────────────────────────
describe('selectTopChunks — relevância com KB de barbearia', () => {
  const allChunks = splitIntoChunks(KB_FIXTURE, 'faq.txt');

  // Teste helper: retorna o trecho concatenado dos top chunks
  function getTopText(query) {
    const { chunks } = selectTopChunks(allChunks, query, 14, 7);
    return chunks.map(c => c.text).join(' ');
  }

  it('query sobre preço do corte → traz chunk de serviços e preços', () => {
    const text = getTopText('quanto custa o corte de cabelo');
    expect(text).toMatch(/45/);
  });

  it('query sobre horário → traz chunk de funcionamento', () => {
    const text = getTopText('qual o horário de funcionamento');
    expect(text).toMatch(/09h|segunda|sábado|sabado/i);
  });

  it('query sobre pagamento → traz chunk de formas de pagamento', () => {
    const text = getTopText('vocês aceitam cartão e pix?');
    expect(text).toMatch(/cartão|pix|dinheiro/i);
  });

  it('query sobre cancelamento → traz política de cancelamento', () => {
    const text = getTopText('posso cancelar meu agendamento?');
    expect(text).toMatch(/cancelamento|antecedência|antecedencia|cancelar/i);
  });

  it('query sobre localização → traz endereço', () => {
    const text = getTopText('onde fica a barbearia?');
    expect(text).toMatch(/rua|centro|são paulo/i);
  });

  it('query sobre fidelidade → traz programa de fidelidade', () => {
    const text = getTopText('tem programa de pontos ou fidelidade?');
    expect(text).toMatch(/fidelidade|gratu[íi]to|10 cortes/i);
  });

  it('query sem relação com KB → hasRelevantContent = false se score=0', () => {
    // Tokens completamente fora do vocabulário da KB
    const result = selectTopChunks(allChunks, 'xyzxyz qqqqqq zzzzz', 14, 7);
    expect(result.hasRelevantContent).toBe(false);
  });

  it('retorna no máximo TOP_K_FINAL chunks', () => {
    const { chunks } = selectTopChunks(allChunks, 'serviço preço pagamento corte barba', 14, 7);
    expect(chunks.length).toBeLessThanOrEqual(7);
  });

  it('no resultado, o chunk de maior score aparece primeiro', () => {
    const query = 'barba navalha preço valor';
    const { chunks } = selectTopChunks(allChunks, query, 14, 7);
    // chunk[0] tem o maior score — deve conter "barba" ou "35"
    expect(chunks[0].text).toMatch(/barba|35/i);
  });

  it('sem chunks disponíveis → retorna array vazio', () => {
    const result = selectTopChunks([], 'qualquer pergunta', 14, 7);
    expect(result.chunks).toHaveLength(0);
    expect(result.hasRelevantContent).toBe(false);
  });

  // Teste para expansão de sinônimos: "valor" deve encontrar chunks com "preço"
  it('expansão de sinônimos: query "valor" encontra chunks com "preço"', () => {
    const { chunks, hasRelevantContent } = selectTopChunks(
      allChunks, 'valor do serviço', 14, 7
    );
    expect(hasRelevantContent).toBe(true);
    const text = chunks.map(c => c.text).join(' ');
    expect(text).toMatch(/R\$|preço|custo|45|35|70/i);
  });
});

// ─────────────────────────────────────────────────────────────
// buildSystemPrompt
// ─────────────────────────────────────────────────────────────
describe('buildSystemPrompt', () => {
  const tenant = { agent_name: 'NomeAgente', name: 'EmpresaTeste' };
  const KB_TRECHO = 'Horário: 09h às 20h. Preço: R$ 45,00.';

  it('modo COM KB: contém nome do agente e empresa', () => {
    const prompt = buildSystemPrompt(tenant, KB_TRECHO, true, null);
    expect(prompt).toContain('NomeAgente');
    expect(prompt).toContain('EmpresaTeste');
  });

  it('modo COM KB: contém regras absolutas e o trecho da KB', () => {
    const prompt = buildSystemPrompt(tenant, KB_TRECHO, true, null);
    expect(prompt).toContain('BASE DE CONHECIMENTO');
    expect(prompt).toContain('fonte de verdade');
    expect(prompt).toContain(KB_TRECHO);
    expect(prompt).toMatch(/PROIBIDO.*inventar/i);
  });

  it('modo COM KB: frase de recusa padronizada está presente', () => {
    const prompt = buildSystemPrompt(tenant, KB_TRECHO, true, null);
    expect(prompt).toContain('Não encontrei essa informação na minha base de conhecimento');
    expect(prompt).toContain('EmpresaTeste');
  });

  it('modo COM KB: encerra com instrução de exclusividade', () => {
    const prompt = buildSystemPrompt(tenant, KB_TRECHO, true, null);
    expect(prompt).toContain('EXCLUSIVAMENTE nos trechos acima');
  });

  it('modo KB VAZIA (hasKb=true, contexto vazio): instrui recusa sem invenção', () => {
    const prompt = buildSystemPrompt(tenant, '', true, null);
    expect(prompt).toContain('nenhum trecho relevante foi localizado');
    expect(prompt).toContain('NUNCA invente');
    expect(prompt).not.toContain('BASE DE CONHECIMENTO');
  });

  it('modo SEM KB (hasKb=false): não inclui seção de regras absolutas', () => {
    const prompt = buildSystemPrompt(tenant, '', false, null);
    expect(prompt).not.toContain('BASE DE CONHECIMENTO');
    expect(prompt).not.toContain('PROIBIDO');
    expect(prompt).toContain('configurada para este agente ainda');
  });

  it('inclui resumo de histórico quando fornecido', () => {
    const summary = 'Cliente perguntou sobre horários e preços.';
    const prompt  = buildSystemPrompt(tenant, KB_TRECHO, true, summary);
    expect(prompt).toContain('Resumo do início desta conversa');
    expect(prompt).toContain(summary);
  });

  it('não inclui seção de resumo quando historySummary é null', () => {
    const prompt = buildSystemPrompt(tenant, KB_TRECHO, true, null);
    expect(prompt).not.toContain('Resumo do início desta conversa');
  });

  it('usa "Assistente" e "a empresa" como fallback quando tenant não tem nome', () => {
    const prompt = buildSystemPrompt({}, KB_TRECHO, true, null);
    expect(prompt).toContain('Assistente');
    expect(prompt).toContain('a empresa');
  });
});

// ─────────────────────────────────────────────────────────────
// buildKbContext — pipeline completo (fs + DB mockados)
// ─────────────────────────────────────────────────────────────
describe('buildKbContext', () => {
  const TENANT_ID = 'tenant-barbearia-001';

  const mockDoc = {
    id:            'doc-001',
    tenant_id:     TENANT_ID,
    original_name: 'faq-barbearia.txt',
    filename:      'kb_001.txt',
    filetype:      'txt',
    description:   'FAQ da barbearia',
    status:        'ready',
  };

  const KnowledgeBaseMock = {
    findAll: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Invalida o chunkCache do tenant principal antes de cada teste
    svc.invalidateTenantKbCache(TENANT_ID);
    // Mock do sistema de arquivos
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ mtimeMs: Date.now() }); // mtime único por teste
    fs.readFileSync.mockReturnValue(KB_FIXTURE);
  });

  it('retorna hasKb=false quando não há documentos', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'qualquer');
    expect(result.hasKb).toBe(false);
    expect(result.context).toBe('');
  });

  it('retorna hasKb=true e contexto não vazio para query relevante', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'quanto custa o corte');
    expect(result.hasKb).toBe(true);
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.hasRelevantContent).toBe(true);
  });

  it('contexto retornado contém informações de preço para query sobre custo', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'qual o valor do corte de cabelo');
    expect(result.context).toMatch(/45|R\$|corte/i);
  });

  it('contexto retornado contém horários para query sobre funcionamento', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'qual o horário de atendimento');
    expect(result.context).toMatch(/09h|segunda|sábado|sabado/i);
  });

  it('contexto retornado contém cancelamento para query sobre cancelar', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'como cancelo meu agendamento');
    expect(result.context).toMatch(/cancelamento|antecedência|antecedencia/i);
  });

  it('contexto retornado contém pix/cartão para query sobre pagamento', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'aceita pix');
    expect(result.context).toMatch(/pix|cartão|dinheiro/i);
  });

  it('contexto retornado contém endereço para query sobre localização', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'onde fica a barbearia endereço');
    expect(result.context).toMatch(/rua|flores|centro/i);
  });

  it('hasRelevantContent=false para query sem match lexical', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'xyzxyz aaaaaa zzzzz');
    expect(result.hasRelevantContent).toBe(false);
  });

  it('contexto não ultrapassa MAX_KB_CHARS (6500)', async () => {
    KnowledgeBaseMock.findAll.mockResolvedValue([mockDoc]);
    const result = await svc.buildKbContext(KnowledgeBaseMock, TENANT_ID, 'informações gerais sobre tudo');
    expect(result.context.length).toBeLessThanOrEqual(6500);
  });

  it('usa description do doc quando arquivo não existe', async () => {
    // Usa tenant e filename únicos para evitar textCache de outros testes
    const tenantDesc = 'tenant-desc-only-999';
    svc.invalidateTenantKbCache(tenantDesc);
    fs.existsSync.mockReturnValue(false); // arquivo não disponível
    const docSemArquivo = {
      ...mockDoc,
      tenant_id:     tenantDesc,
      filename:      'kb_desc_only_999.txt',
      description:   'Barbearia aberta de segunda a sábado das 09h às 20h',
    };
    KnowledgeBaseMock.findAll.mockResolvedValue([docSemArquivo]);

    const result = await svc.buildKbContext(KnowledgeBaseMock, tenantDesc, 'horário de funcionamento');
    expect(result.hasKb).toBe(true);
    expect(result.context).toContain('segunda');
  });

  it('lê do cache de chunks na segunda chamada sem re-processar', async () => {
    // Usa tenant e filename únicos para estado limpo
    const tenantCache = 'tenant-cache-test-888';
    svc.invalidateTenantKbCache(tenantCache);
    // Garante que textCache não intercepte — usa mtime diferente
    fs.statSync.mockReturnValue({ mtimeMs: Date.now() });
    const docCache = { ...mockDoc, tenant_id: tenantCache, filename: 'kb_cache_888.txt' };
    KnowledgeBaseMock.findAll.mockResolvedValue([docCache]);

    await svc.buildKbContext(KnowledgeBaseMock, tenantCache, 'preço corte');
    // Na 1ª chamada, readFileSync deve ter sido invocado
    const callsAfterFirst = fs.readFileSync.mock.calls.length;

    await svc.buildKbContext(KnowledgeBaseMock, tenantCache, 'horário');
    // Na 2ª chamada, chunkCache evita re-processar → readFileSync NÃO é chamado novamente
    const callsAfterSecond = fs.readFileSync.mock.calls.length;

    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
    expect(callsAfterSecond).toBe(callsAfterFirst); // zero chamadas adicionais
  });
});
