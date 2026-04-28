'use strict';

const Groq     = require('groq-sdk');
const fs       = require('fs');
const path     = require('path');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');

const UPLOAD_DIR = path.join(__dirname, '../../../uploads/kb');

// ── Modelos ────────────────────────────────────────────────────
// Llama 3.1 8B  → saudações, fluxos simples, sumarizações internas
// Llama 3.3 70B → respostas baseadas em KB, raciocínio complexo
const MODEL_FAST   = process.env.GROQ_MODEL_FAST   || 'llama-3.1-8b-instant';
const MODEL_STRONG = process.env.GROQ_MODEL_STRONG || 'llama-3.3-70b-versatile';

// ── Chunking ───────────────────────────────────────────────────
const CHUNK_SIZE        = 700;   // chars por chunk (maior = mais contexto por trecho)
const CHUNK_OVERLAP     = 120;   // sobreposição entre chunks consecutivos
const TOP_K_RAW         = 14;    // chunks candidatos antes da deduplicação
const TOP_K_FINAL       = 7;     // chunks finais após deduplicação
const MAX_KB_CHARS      = 6500;  // limite total de chars de KB no prompt
// Sem limiar de score mínimo: TF-IDF ranqueia, o LLM decide relevância semântica.
// Aplicar threshold lexical bloqueia perguntas com sinônimos/paráfrases válidas.
const JACCARD_THRESHOLD = 0.50;  // similaridade máxima entre chunks (dedup)
// Peso extra para bigrams no score TF-IDF: melhora frases compostas
const BIGRAM_BOOST      = 1.5;   // multiplicador de score para bigrams da query

// ── Histórico e sumarização ───────────────────────────────────
const HISTORY_KEEP     = 6;   // mensagens recentes mantidas íntegras
const SUMMARY_TRIGGER  = 10;  // a partir de N msgs históricas, sumariza as antigas

// ── Cache em memória ──────────────────────────────────────────
// textCache    : filename       → { text, mtime }
// chunkCache   : tenantId       → { chunks, ts }    (TTL = CHUNK_CACHE_TTL)
// summaryCache : conversationId → { summary, seenCount }
const textCache    = new Map();
const chunkCache   = new Map();
const summaryCache = new Map();
const CHUNK_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ─────────────────────────────────────────────────────────────
// 1. EXTRAÇÃO DE TEXTO COM CACHE POR ARQUIVO
// ─────────────────────────────────────────────────────────────

/**
 * Extrai texto de um doc KB, usando cache baseado em mtime.
 */
async function extractText(doc) {
  // ── Prioridade 1: conteúdo persistido no banco ─────────────────
  // Garante funcionamento mesmo após filesystem ephemero ser limpo
  // (Railway apaga uploads a cada redeploy/restart).
  if (doc.content && doc.content.trim()) {
    const cached = textCache.get(doc.filename);
    if (cached && cached.mtime === -1) return cached.text; // cache DB hit
    textCache.set(doc.filename, { text: doc.content.trim(), mtime: -1 });
    return doc.content.trim();
  }

  // ── Prioridade 2: arquivo em disco (dev local / first upload) ──
  const filepath = path.join(UPLOAD_DIR, doc.filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`[Groq] Arquivo não encontrado e sem content no banco: ${doc.filename}`);
    return '';
  }

  const mtime  = fs.statSync(filepath).mtimeMs;
  const cached = textCache.get(doc.filename);
  if (cached && cached.mtime === mtime) return cached.text;

  try {
    const type = (doc.filetype || '').toLowerCase();
    let text = '';

    if (type === 'txt' || type === 'md') {
      text = fs.readFileSync(filepath, 'utf8');
    } else if (type === 'pdf') {
      const data = await pdfParse(fs.readFileSync(filepath));
      text = data.text || '';
    } else if (type === 'docx' || type === 'doc') {
      const result = await mammoth.extractRawText({ path: filepath });
      text = result.value || '';
    }

    textCache.set(doc.filename, { text, mtime });
    return text;
  } catch (err) {
    console.warn(`[Groq] Falha ao extrair texto de ${doc.filename}: ${err.message}`);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────
// 2. CHUNKING COM SOBREPOSIÇÃO + DEDUPLICAÇÃO INTRA-CHUNK
// ─────────────────────────────────────────────────────────────

/**
 * Remove sentenças duplicadas ou quase-duplicadas dentro de um texto.
 * Usa Jaccard sobre trigramas de palavras para detectar repetição.
 */
function deduplicateSentences(text) {
  const sentences = text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  if (sentences.length <= 1) return text;

  const seen  = [];
  const kept  = [];

  for (const sent of sentences) {
    const toks = tokenize(sent);
    const trig = new Set(buildNgrams(toks, 3));
    const isDuplicate = seen.some(seenTrig => jaccardSetSimilarity(trig, seenTrig) > 0.6);
    if (!isDuplicate) {
      kept.push(sent);
      seen.push(trig);
    }
  }

  return kept.join(' ');
}

/** Gera n-gramas de tokens como strings "a|b|c". */
function buildNgrams(tokens, n) {
  const result = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    result.push(tokens.slice(i, i + n).join('|'));
  }
  return result;
}

/** Similaridade de Jaccard entre dois Sets. */
function jaccardSetSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  let inter = 0;
  for (const item of setA) if (setB.has(item)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/**
 * Divide um texto em chunks com sobreposição, removendo conteúdo
 * redundante dentro de cada chunk antes de armazená-lo.
 */
function splitIntoChunks(text, docName) {
  // Limpa espaços excessivos e linhas em branco
  const cleaned = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const chunks  = [];
  let start = 0;

  while (start < cleaned.length) {
    const end   = Math.min(start + CHUNK_SIZE, cleaned.length);
    const slice = deduplicateSentences(cleaned.slice(start, end).trim());
    if (slice.length > 60) chunks.push({ source: docName, text: slice });
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────
// 3. RELEVÂNCIA: TF-IDF SIMPLIFICADO
// ─────────────────────────────────────────────────────────────

// ATENÇÃO: tokenize() remove acentos ANTES de filtrar, portanto as stopwords
// devem estar sem acento para que o filtro funcione corretamente.
const STOPWORDS = new Set([
  'que','com','para','uma','por','mais','como','mas','seu','sua','nos','das',
  'dos','ser','foi','ele','ela','nao','sim','isso','este','essa','aqui','tambem',
  'the','and','for','are','this','that','with','from','have','not','will','voce',
  'sobre','numa','num','pode','tem','ter','sao','esta','pelo','pela','pois',
  'muito','pouco','mesmo','ainda','onde','quando','quem','qual','quais','como',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove acentos
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function buildIdf(allChunks) {
  const df = new Map();
  const N  = allChunks.length || 1;
  for (const chunk of allChunks) {
    for (const term of new Set(tokenize(chunk.text))) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [term, count] of df) {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
  return idf;
}

function scoreChunk(chunkTokens, queryTokens, idf) {
  const len = chunkTokens.length || 1;
  let score = 0;

  // Unigrams
  for (const qt of queryTokens) {
    const tf = chunkTokens.filter(t => t === qt).length / len;
    score += tf * (idf.get(qt) || 1);
  }

  // Bigrams da query: boost para correspondência de frases compostas
  // ex.: "valor plano", "prazo entrega", "forma pagamento"
  const chunkText = chunkTokens.join(' ');
  for (let i = 0; i < queryTokens.length - 1; i++) {
    const bigram = `${queryTokens[i]} ${queryTokens[i + 1]}`;
    const count  = (chunkText.split(bigram).length - 1);
    if (count > 0) score += (count / len) * BIGRAM_BOOST;
  }

  return score;
}

// ─────────────────────────────────────────────────────────────
// 3b. EXPANSÃO LEVE DE QUERY
// ─────────────────────────────────────────────────────────────

/**
 * Mapa de sinônimos de domínio: expande a query com termos relacionados
 * para melhorar o recall do TF-IDF sem alterar a intenção do usuário.
 */
const SYNONYM_MAP = {
  // Financeiro / cobranças
  'preco':     ['valor','custo','preco','mensalidade','tarifa'],
  'valor':     ['preco','valor','custo','mensalidade','tarifa'],
  'pagamento': ['pagamento','pagar','cobrar','boleto','fatura','pix','nota'],
  'boleto':    ['boleto','fatura','cobranca','vencimento'],
  'desconto':  ['desconto','promocao','oferta','cupom'],
  'plano':     ['plano','pacote','servico','contrato','modalidade'],
  // Agendamentos
  'horario':   ['horario','agendamento','agenda','disponibilidade','turno'],
  'agendar':   ['agendar','marcar','confirmar','reservar'],
  'cancelar':  ['cancelar','cancelamento','reagendar','desmarcar'],
  // Suporte / contato
  'contato':   ['contato','email','telefone','whatsapp','falar'],
  'suporte':   ['suporte','atendimento','ajuda','duvida','problema'],
  'endereco':  ['endereco','localizacao','local','onde','como chegar'],
  // Prazos / entregas
  'prazo':     ['prazo','tempo','demora','entrega','quando'],
  'entrega':   ['entrega','envio','prazo','expedicao','frete'],
};

/**
 * Expande os tokens da query com sinônimos do SYNONYM_MAP,
 * retornando um array de tokens sem duplicatas.
 */
function expandQuery(tokens) {
  const expanded = new Set(tokens);
  for (const tok of tokens) {
    const syns = SYNONYM_MAP[tok];
    if (syns) syns.forEach(s => expanded.add(s));
  }
  return [...expanded];
}

/**
 * Seleciona os top-K chunks mais relevantes para a query do usuário,
 * depois aplica deduplicação inter-chunk por similaridade Jaccard para
 * evitar enviar conteúdo redundante ao modelo.
 *
 * Retorna também `hasRelevantContent` (bool) — falso quando nenhum chunk
 * atingiu MIN_CHUNK_SCORE (KB existe mas não tem resposta para a pergunta).
 */
function selectTopChunks(allChunks, query, kRaw, kFinal) {
  if (!allChunks.length) return { chunks: [], hasRelevantContent: false };

  const rawTokens   = tokenize(query);
  const queryTokens = expandQuery(rawTokens); // expande com sinônimos
  const idf         = buildIdf(allChunks);

  // Pontua e ordena
  const scored = allChunks
    .map(chunk => ({
      ...chunk,
      score: scoreChunk(tokenize(chunk.text), queryTokens, idf),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, kRaw);

  // hasRelevantContent: true se o melhor score > 0 (algum token da query
  // aparece na KB). Score 0 significa que NENHUM token coincide lexicalmente,
  // mas o LLM ainda assim recebe os top chunks para julgamento semântico.
  const best = scored[0]?.score || 0;
  const hasRelevantContent = best > 0;

  // Deduplicação inter-chunk: descarta chunks muito similares entre si
  const selected  = [];
  const tokenSets = []; // Set de trigramas de cada chunk já selecionado

  for (const chunk of scored) {
    const toks = tokenize(chunk.text);
    const trig = new Set(buildNgrams(toks, 3));
    const tooSimilar = tokenSets.some(
      existing => jaccardSetSimilarity(trig, existing) >= JACCARD_THRESHOLD
    );
    if (!tooSimilar) {
      selected.push(chunk);
      tokenSets.push(trig);
      if (selected.length >= kFinal) break;
    }
  }

  return { chunks: selected, hasRelevantContent };
}

// ─────────────────────────────────────────────────────────────
// 4. CONSTRUÇÃO DO CONTEXTO KB COM CACHE
// ─────────────────────────────────────────────────────────────

/**
 * Monta o contexto KB enviando apenas os chunks mais relevantes
 * para a mensagem atual, sem redundâncias.
 *
 * Retorna { context: string, hasKb: bool, hasRelevantContent: bool }
 *   - hasKb              → tenant tem documentos na KB
 *   - hasRelevantContent → algum chunk passou o limiar MIN_CHUNK_SCORE
 */
async function buildKbContext(KnowledgeBase, tenantId, userQuery) {
  const docs = await KnowledgeBase.findAll({
    where:  { tenant_id: tenantId, status: 'ready' },
    order:  [['created_at', 'DESC']],
    limit:  30,
  });
  if (!docs.length) return { context: '', hasKb: false, hasRelevantContent: false };

  // ── Cache de chunks por tenant ──────────────────────────────
  let allChunks;
  const cached = chunkCache.get(tenantId);
  if (cached && (Date.now() - cached.ts) < CHUNK_CACHE_TTL) {
    allChunks = cached.chunks;
  } else {
    allChunks = [];
    for (const doc of docs) {
      const text = await extractText(doc);
      if (text.trim()) {
        allChunks.push(...splitIntoChunks(text, doc.original_name));
      } else if (doc.description) {
        // Documento sem arquivo (só descrição)
        allChunks.push({ source: doc.original_name, text: doc.description.trim() });
      }
    }
    chunkCache.set(tenantId, { chunks: allChunks, ts: Date.now() });
    console.log(`[Groq] Cache KB: tenant=${tenantId} chunks=${allChunks.length}`);
  }

  // ── Seleciona e deduplica ───────────────────────────────────
  const { chunks: topChunks, hasRelevantContent } = selectTopChunks(
    allChunks, userQuery, TOP_K_RAW, TOP_K_FINAL
  );

  let context    = '';
  let totalChars = 0;
  for (const chunk of topChunks) {
    if (totalChars >= MAX_KB_CHARS) break;
    const entry     = `[${chunk.source}]\n${chunk.text}`;
    const remaining = MAX_KB_CHARS - totalChars;
    context   += (context ? '\n\n---\n\n' : '') + entry.slice(0, remaining);
    totalChars += entry.length;
  }

  return { context, hasKb: true, hasRelevantContent };
}

// ─────────────────────────────────────────────────────────────
// 5. SELEÇÃO INTELIGENTE DE MODELO
// ─────────────────────────────────────────────────────────────

/** Padrões que indicam mensagem simples → usa modelo rápido. */
const SIMPLE_RE = [
  /^(ol[aá]|oi|hey|e a[ií]|bom dia|boa tarde|boa noite|tudo bem|tudo bom)\b/i,
  /^(obrigad[ao]|valeu|tchau|at[eé] logo|at[eé] mais|adeus|flw)\b/i,
  /^(sim|n[ãa]o|ok|certo|entendi|blz|beleza|perfeito|combinado)\b/i,
];

/** Palavras que indicam necessidade de raciocínio → usa modelo forte. */
const COMPLEX_KW = [
  'explique','explica','como funciona','detalhe','detalhes','processo',
  'passo a passo','procedimento','regulamento','contrato','legislação',
  'compare','diferença','análise','analise','calcule','cálculo',
  'relatório','resumo completo','liste tudo','todos os','normativa',
  'juridico','jurídico','cláusula','política','termos',
];

function selectModel(userText, hasKb, historyLen) {
  const lower = userText.toLowerCase().trim();
  if (SIMPLE_RE.some(p => p.test(lower)))                return MODEL_FAST;
  if (userText.length < 55 && !hasKb)                    return MODEL_FAST;
  if (COMPLEX_KW.some(kw => lower.includes(kw)))         return MODEL_STRONG;
  if (hasKb && historyLen >= 4)                          return MODEL_STRONG;
  if (hasKb && userText.length > 70)                     return MODEL_STRONG;
  return MODEL_FAST;
}

// ─────────────────────────────────────────────────────────────
// 5b. DETECÇÃO DE INTENÇÃO DE AGENDAMENTO + CONSULTA AO BANCO
// ─────────────────────────────────────────────────────────────

/**
 * Detecta se a mensagem do cliente trata de agendamento/horários.
 * Usada para decidir se os slots reais do banco devem ser injetados
 * no system prompt antes de chamar o modelo.
 */
const SCHEDULING_INTENT_RE =
  /\b(agendar?|marcar?|reservar?|hor[aá]rio[s]?|dispon[ií]vel|disponibilidade|vaga|quando|que dia|que hora|agenda|encaixe|atendo|atendimento|quero marcar|quero agendar)\b/i;

/**
 * Consulta os slots reais cadastrados pelo prestador (service_slots)
 * e desconta os já reservados (appointments), retornando apenas os livres.
 * Lógica idêntica à do schedulingService, duplicada aqui para evitar
 * dependência circular (schedulingService já importa groqService).
 *
 * @param {Object} Appointment  – model Sequelize
 * @param {Object} ServiceSlot  – model Sequelize
 * @param {string} tenantId
 * @returns {Promise<Array<{date: Date, service_name: string|null, duration_minutes: number}>>}
 */
async function queryAvailableSlots(Appointment, ServiceSlot, tenantId) {
  const { Op } = require('sequelize');
  const DAYS = 14;
  const MAX  = 10;

  const now    = new Date();
  const cutoff = new Date(now.getTime() + 60 * 60 * 1000); // mínimo 1h à frente
  const end    = new Date(now);
  end.setDate(end.getDate() + DAYS + 1);

  const serviceSlots = await ServiceSlot.findAll({
    where: { tenant_id: tenantId, is_active: true },
    order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
  });
  if (!serviceSlots.length) return [];

  // Carrega agendamentos futuros não cancelados
  const booked = await Appointment.findAll({
    where: {
      tenant_id:    tenantId,
      status:       { [Op.ne]: 'cancelled' },
      scheduled_at: { [Op.between]: [cutoff, end] },
    },
    attributes: ['scheduled_at'],
  });

  // Mapa ISO → contagem de ocupações
  const bookingCounts = new Map();
  for (const a of booked) {
    const key = new Date(a.scheduled_at).toISOString();
    bookingCounts.set(key, (bookingCounts.get(key) || 0) + 1);
  }

  const slots = [];
  for (let d = 0; d <= DAYS && slots.length < MAX; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const dayOfWeek = day.getDay();

    const daySlots = serviceSlots.filter(s => s.day_of_week === dayOfWeek);
    for (const ss of daySlots) {
      if (slots.length >= MAX) break;

      const [hh, mm] = ss.start_time.split(':').map(Number);
      const slotDate = new Date(day);
      slotDate.setHours(hh, mm, 0, 0);

      if (slotDate <= cutoff) continue;

      const occupied = bookingCounts.get(slotDate.toISOString()) || 0;
      if (occupied < (ss.max_bookings || 1)) {
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

/**
 * Formata os slots disponíveis como lista numerada para injeção no system prompt.
 */
function formatSlotsText(slots) {
  if (!slots.length) {
    return 'Nenhum horário disponível nos próximos 14 dias.';
  }
  return slots
    .map((slot, i) => {
      const dt      = slot.date;
      const dateStr = dt.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
      const timeStr = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const svc     = slot.service_name ? ` — ${slot.service_name}` : '';
      return `${i + 1}. ${dateStr} às ${timeStr}${svc}`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// 6. SUMARIZAÇÃO DO HISTÓRICO
// ─────────────────────────────────────────────────────────────

/**
 * Quando o histórico cresce além de SUMMARY_TRIGGER mensagens,
 * resume as mais antigas com o MODEL_FAST para reduzir tokens.
 * As HISTORY_KEEP mensagens mais recentes são preservadas íntegras.
 *
 * @returns {{ summary: string|null, recentHistory: Array }}
 */
async function summarizeHistory(groq, messages) {
  if (messages.length <= SUMMARY_TRIGGER) {
    return { summary: null, recentHistory: messages };
  }

  const toSummarize = messages.slice(0, messages.length - HISTORY_KEEP);
  const recent      = messages.slice(-HISTORY_KEEP);

  const transcript = toSummarize
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`)
    .join('\n');

  try {
    const res = await groq.chat.completions.create({
      model: MODEL_FAST,
      messages: [
        {
          role: 'system',
          content: 'Você é um assistente de sumarização. Resuma o histórico de conversa abaixo em até 5 frases concisas em português, preservando os pontos essenciais discutidos. Não adicione nenhuma informação nova.',
        },
        { role: 'user', content: transcript },
      ],
      temperature:       0.1,
      max_tokens:        200,
      frequency_penalty: 0.5,
    });

    const summary = res.choices[0]?.message?.content?.trim() || null;
    console.log(`[Groq] Histórico sumarizado (${toSummarize.length} msgs → ${summary?.length || 0} chars)`);
    return { summary, recentHistory: recent };
  } catch (err) {
    console.warn('[Groq] Falha na sumarização do histórico:', err.message);
    // fallback: mantém só as recentes sem resumo
    return { summary: null, recentHistory: recent };
  }
}

// ─────────────────────────────────────────────────────────────
// 7. SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────

/**
 * Constrói o system prompt com grau de restrição proporcional à KB:
 *  - Sem KB          → assistente genérico amigável
 *  - KB presente     → EXCLUSIVAMENTE baseado nos trechos fornecidos
 *  - Resumo incluso  → adiciona contexto do histórico sumarizado
 */
function buildSystemPrompt(tenant, kbContext, hasKb, historySummary, slotsText = null) {
  const agentName   = tenant.agent_name || 'Assistente';
  const companyName = tenant.name       || 'a empresa';

  let prompt = `Você é ${agentName}, o assistente virtual oficial de ${companyName}.\n`;
  prompt    += `Responda SEMPRE em português, de forma cordial, clara e objetiva.\n`;
  prompt    += `Nunca se apresente novamente nem repita saudações — o cliente já recebeu a mensagem de boas-vindas.\n`;

  if (hasKb && kbContext.trim()) {
    // Modo KB-exclusivo: respostas estritamente baseadas nos trechos fornecidos
    prompt += `\n## REGRAS ABSOLUTAS — BASE DE CONHECIMENTO\n`;
    prompt += `1. Sua única fonte de verdade são os trechos da Base de Conhecimento abaixo. Não use conhecimento externo.\n`;
    prompt += `2. Leia TODOS os trechos antes de responder. A resposta pode estar distribuída em mais de um trecho.\n`;
    prompt += `3. Ao responder, use as informações EXATAMENTE como constam na base: preserve valores, prazos, nomes e regras.\n`;
    prompt += `4. Se a pergunta não puder ser respondida com base nos trechos fornecidos, responda EXATAMENTE:\n`;
    prompt += `   "Não encontrei essa informação na minha base de conhecimento. Para mais detalhes, entre em contato diretamente com a equipe de ${companyName}."\n`;
    prompt += `5. PROIBIDO: inventar, inferir, supor ou complementar com dados que não estejam nos trechos.\n`;
    prompt += `6. PROIBIDO: citar nomes de arquivos ou referências técnicas internas na resposta.\n`;
    prompt += `7. Quando houver listas, preços, etapas ou condições na base, reproduza-os de forma organizada (use listas ou tópicos).\n`;
    prompt += `8. Se a base tiver informação parcial (responde parte da dúvida), forneça o que está disponível e indique o que não foi encontrado.\n`;
    prompt += `9. Seja direto e objetivo. Não adicione frases genéricas de introdução ou encerramento desnecessárias.\n`;
    prompt += `\n## BASE DE CONHECIMENTO — trechos selecionados para esta mensagem\n\n`;
    prompt += kbContext;
    prompt += `\n\n---\n`;
    prompt += `Responda com base EXCLUSIVAMENTE nos trechos acima. Se a informação não estiver lá, use a frase do item 4.`;
  } else if (hasKb && !kbContext.trim()) {
    // KB existe mas nenhum chunk foi relevante — instruído a recusar
    prompt += `\nA empresa possui uma base de conhecimento, mas nenhum trecho relevante foi localizado para esta pergunta.\n`;
    prompt += `Responda EXATAMENTE: "Não encontrei essa informação na minha base de conhecimento. Para mais detalhes, entre em contato diretamente com a equipe de ${companyName}."\n`;
    prompt += `NUNCA invente, suponha ou use conhecimento externo.\n`;
  } else {
    // Sem KB configurada
    prompt += `\nNenhuma base de conhecimento foi configurada para este agente ainda.\n`;
    prompt += `Responda somente com base no contexto da conversa atual. Jamais invente dados específicos como preços, prazos ou procedimentos internos de ${companyName}.\n`;
  }

  // Agenda real: injetada quando queryAvailableSlots retornou dados
  if (slotsText !== null) {
    prompt += `\n\n## AGENDA REAL — horários livres (dados em tempo real do banco)\n`;
    prompt += slotsText + '\n';
    prompt += `Use SOMENTE estes horários ao responder sobre disponibilidade. `;
    prompt += `Não mencione horários que não estejam nesta lista.\n`;
  }

  if (historySummary) {
    prompt += `\n\n## Resumo do início desta conversa\n${historySummary}`;
  }

  return prompt;
}

// ─────────────────────────────────────────────────────────────
// 8. FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Gera a resposta do agente via Groq.
 *
 * Pipeline:
 *  1. buildKbContext  → chunks relevantes deduplicados + flag de relevância
 *  2. Resposta antecipada se KB existe mas nada foi encontrado
 *  3. summarizeHistory → comprime histórico longo (> SUMMARY_TRIGGER msgs)
 *  4. buildSystemPrompt com modo KB-exclusivo forçado quando aplicável
 *  5. Chamada Groq com frequency_penalty + presence_penalty
 *
 * @param {string} userText      – mensagem atual do usuário
 * @param {Object} tenant        – registro Tenant do Sequelize
 * @param {Array}  previousMsgs  – mensagens anteriores [{author, text}]
 * @param {Object} KnowledgeBase – model Sequelize KnowledgeBase
 * @param {Object} [extraModels] – { Appointment, ServiceSlot } para cruzar agenda real
 * @returns {Promise<string>}    resposta do agente
 */
async function generateGroqReply(userText, tenant, previousMsgs = [], KnowledgeBase, extraModels = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'seu_groq_api_key_aqui') {
    console.warn('[Groq] GROQ_API_KEY não configurada. Usando resposta fallback.');
    return fallbackReply(userText, tenant);
  }

  try {
    const groq = new Groq({ apiKey });

    // 1. Contexto KB
    const { context: kbContext, hasKb, hasRelevantContent } =
      await buildKbContext(KnowledgeBase, tenant.id, userText);

    // 2. Log de relevância lexical (não bloqueia mais — o LLM faz a triagem semântica)
    if (hasKb && !hasRelevantContent) {
      console.log(`[Groq] Score TF-IDF=0 para query (sem match lexical) — enviando top chunks para o modelo fazer triagem semântica.`);
    }

    // 2b. Agenda real: cruzamento service_slots × appointments
    // Ativado quando a mensagem tem intenção de agendamento/horário
    let slotsText = null;
    const { Appointment: AppModel, ServiceSlot: SlotModel } = extraModels;
    if (AppModel && SlotModel && SCHEDULING_INTENT_RE.test(userText)) {
      try {
        const liveSlots = await queryAvailableSlots(AppModel, SlotModel, tenant.id);
        slotsText = formatSlotsText(liveSlots);
        console.log(`[Groq] Agenda real: ${liveSlots.length} slot(s) livre(s) para tenant=${tenant.id}`);
      } catch (sErr) {
        console.warn('[Groq] Falha ao consultar agenda real:', sErr.message);
      }
    }

    // 3. Histórico: sumariza se muito longo
    const rawHistory = previousMsgs
      .slice(-Math.max(SUMMARY_TRIGGER + HISTORY_KEEP, 20))
      .map(m => ({
        role:    m.author === 'agent' ? 'assistant' : 'user',
        content: m.text,
      }));

    const { summary, recentHistory } = await summarizeHistory(groq, rawHistory);

    // 4. System prompt KB-exclusivo + agenda real (quando aplicável)
    const sysPrompt = buildSystemPrompt(tenant, kbContext, hasKb, summary, slotsText);

    // 5. Montar mensagens
    const messages = [
      { role: 'system', content: sysPrompt },
      ...recentHistory,
      { role: 'user',   content: userText },
    ];

    const usingKb    = hasKb && !!kbContext.trim();
    const usingSlots  = slotsText !== null;
    // Agenda real exige modelo forte para interpretar lista corretamente
    const model = usingSlots
      ? MODEL_STRONG
      : selectModel(userText, usingKb, recentHistory.length);

    // Parâmetros de geração:
    // - KB ou agenda real → temperatura mínima para máxima fidelidade + tokens amplos
    // - Sem KB / fast     → temperatura levemente maior para naturalidade
    const useGrounded = usingKb || usingSlots;
    const temperature = useGrounded ? 0.1 : (model === MODEL_FAST ? 0.3 : 0.4);
    const max_tokens  = useGrounded
      ? (model === MODEL_STRONG ? 1024 : 512)   // grounded: resposta pode ser longa
      : (model === MODEL_FAST   ? 256  : 512);  // sem base: respostas mais concisas

    console.log(
      `[Groq] model=${model === MODEL_FAST ? 'FAST(8B)' : 'STRONG(70B)'} ` +
      `| hasKb=${hasKb} usingKb=${usingKb} slots=${usingSlots} relevante=${hasRelevantContent} ` +
      `| temp=${temperature} maxTok=${max_tokens} ` +
      `| hist=${recentHistory.length}${summary ? '+resumo' : ''} ` +
      `| kbChars=${kbContext.length} queryLen=${userText.length}`
    );

    const completion = await groq.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
      frequency_penalty: useGrounded ? 0.3 : 0.6,
      presence_penalty:  useGrounded ? 0.1 : 0.4,
    });

    return completion.choices[0]?.message?.content?.trim() || fallbackReply(userText, tenant);
  } catch (err) {
    console.error('[Groq] Erro na chamada à API:', err.message);
    return fallbackReply(userText, tenant);
  }
}

// ─────────────────────────────────────────────────────────────
// 9. FALLBACK (sem API key configurada)
// ─────────────────────────────────────────────────────────────

function fallbackReply(userText, tenant) {
  const lower   = userText.toLowerCase();
  const welcome = tenant?.welcome_message || 'Como posso ajudar?';
  const agent   = tenant?.agent_name     || 'Assistente';

  if (/ol[aá]|^oi\b|hello/.test(lower))            return `Olá! Em que posso ajudar?`;
  if (/pagamento|fatura|boleto/.test(lower))        return 'Para consultar pagamentos ou emitir faturas, entre em contato com nossa equipe ou acesse o portal do cliente.';
  if (/agendamento|hor[aá]rio/.test(lower))         return 'Posso ajudar com agendamentos! Por favor, informe a data e o serviço desejado.';
  return 'Entendi! Pode me dar mais detalhes sobre sua necessidade? Farei o meu melhor para ajudar.';
}

// ─────────────────────────────────────────────────────────────
// 10. UTILITÁRIOS DE CACHE
// ─────────────────────────────────────────────────────────────

/**
 * Remove os chunks e resumos cacheados de um tenant para forçar
 * reindexação na próxima mensagem. Chamado na rota de upload/delete de KB.
 */
function invalidateTenantKbCache(tenantId) {
  chunkCache.delete(tenantId);
  summaryCache.delete(tenantId);
  console.log(`[Groq] Cache KB+resumo invalidado para tenant=${tenantId}`);
}

// ─────────────────────────────────────────────────────────────
// 11. SAUDAÇÃO INICIAL DINÂMICA
// ─────────────────────────────────────────────────────────────

/**
 * Gera a mensagem de abertura da conversa de forma dinâmica.
 * Usa a welcome_message do tenant como instrução de persona e injeta:
 *  - Saudação adequada ao horário (bom dia / boa tarde / boa noite)
 *  - Prévia dos tópicos disponíveis na KB (se houver)
 *  - Variação natural a cada sessão (temperature 0.8)
 *
 * @param {Object} tenant        – registro Tenant
 * @param {Object} KnowledgeBase – model Sequelize
 * @returns {Promise<string>}
 */
async function generateWelcome(tenant, KnowledgeBase) {
  const apiKey = process.env.GROQ_API_KEY;
  const agentName   = tenant.agent_name      || 'Assistente';
  const companyName = tenant.name            || 'nossa empresa';
  const baseWelcome = tenant.welcome_message || `Olá! Sou ${agentName} de ${companyName}. Como posso ajudar?`;

  // Sem API key → retorna a mensagem base gravada pelo prestador
  if (!apiKey || apiKey === 'seu_groq_api_key_aqui') return baseWelcome;

  try {
    // ── Horário de Brasília ──────────────────────────────────
    const hourBR  = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
    const h       = parseInt(hourBR, 10);
    const period  = h < 12 ? 'manhã' : h < 18 ? 'tarde' : 'noite';
    const greeting = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';

    // ── Tópicos disponíveis na KB (listagem rápida) ──────────
    let kbHint = '';
    try {
      const docs = await KnowledgeBase.findAll({
        where: { tenant_id: tenant.id, status: 'ready' },
        attributes: ['description', 'original_name'],
        limit: 5,
      });
      if (docs.length > 0) {
        const topics = docs
          .map(d => d.description || d.original_name)
          .filter(Boolean)
          .join(', ');
        kbHint = `\nA base de conhecimento cobre os seguintes tópicos: ${topics}.`;
      }
    } catch (_) { /* KB indisponível — não bloqueia */ }

    const groq = new Groq({ apiKey });

    const systemMsg =
      `Você é ${agentName}, o assistente virtual de ${companyName}.\n` +
      `Responda SEMPRE em português.\n` +
      `A mensagem de boas-vindas configurada pelo prestador é: "${baseWelcome}".\n` +
      `Use essa mensagem como inspiração/persona, mas adapte naturalmente ao momento atual (${period}).` +
      kbHint;

    const userMsg =
      `Gere UMA saudação de abertura para um novo cliente que acabou de abrir o chat agora.\n` +
      `Comece com "${greeting}!", mencione seu nome (${agentName}) e a empresa (${companyName}), ` +
      `e convide o cliente a falar sobre o que precisa.` +
      (kbHint ? ` Se achar natural, mencione brevemente os temas que pode ajudar.` : '') +
      `\nSeja caloroso, conciso (máx 3 frases) e variado — evite repetir palavra por palavra a mensagem base.`;

    const completion = await groq.chat.completions.create({
      model:       MODEL_FAST,
      messages:    [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
      temperature: 0.8,   // variação natural a cada sessão
      max_tokens:  120,
    });

    return completion.choices[0]?.message?.content?.trim() || baseWelcome;
  } catch (err) {
    console.warn('[Groq] generateWelcome falhou, usando mensagem base:', err.message);
    return baseWelcome;
  }
}

module.exports = { generateGroqReply, generateWelcome, invalidateTenantKbCache, buildKbContext };

// ── Exportações internas exclusivas para testes unitários ─────
// Não use em código de produção — utilize apenas em __tests__/
if (process.env.NODE_ENV === 'test') {
  module.exports._internals = {
    tokenize,
    expandQuery,
    splitIntoChunks,
    scoreChunk,
    buildIdf,
    selectTopChunks,
    buildSystemPrompt,
    SYNONYM_MAP,
    SCHEDULING_INTENT_RE,
    queryAvailableSlots,
    formatSlotsText,
  };
}
