'use strict';

const Groq     = require('groq-sdk');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');

const UPLOAD_DIR = path.join(__dirname, '../../../uploads/kb');

// ── Modelos ────────────────────────────────────────────────────
// Llama 3.1 8B → respostas rápidas, saudações, fluxos simples
// Llama 3.3 70B → raciocínio complexo, KB relevante, perguntas técnicas
const MODEL_FAST   = process.env.GROQ_MODEL_FAST   || 'llama-3.1-8b-instant';
const MODEL_STRONG = process.env.GROQ_MODEL_STRONG || 'llama-3.3-70b-versatile';

// ── Chunking ───────────────────────────────────────────────────
const CHUNK_SIZE    = 700;   // chars por chunk
const CHUNK_OVERLAP = 120;   // sobreposição entre chunks consecutivos
const TOP_K_CHUNKS  = 5;     // chunks mais relevantes enviados ao modelo
const MAX_KB_CHARS  = 3500;  // limite total de chars de KB no prompt

// ── Histórico ─────────────────────────────────────────────────
const HISTORY_LIMIT = 10;

// ── Cache em memória ──────────────────────────────────────────
// textCache : filename  → { text, mtime }   (invalidado por mtime do arquivo)
// chunkCache: tenantId  → { chunks, ts }    (TTL = CHUNK_CACHE_TTL)
const textCache  = new Map();
const chunkCache = new Map();
const CHUNK_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ─────────────────────────────────────────────────────────────
// 1. EXTRAÇÃO DE TEXTO COM CACHE POR ARQUIVO
// ─────────────────────────────────────────────────────────────

/**
 * Extrai texto de um doc KB, usando cache baseado em mtime.
 */
async function extractText(doc) {
  const filepath = path.join(UPLOAD_DIR, doc.filename);
  if (!fs.existsSync(filepath)) return '';

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
// 2. CHUNKING COM SOBREPOSIÇÃO
// ─────────────────────────────────────────────────────────────

/**
 * Divide um texto em chunks com sobreposição para preservar contexto
 * entre segmentos adjacentes.
 */
function splitIntoChunks(text, docName) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end   = Math.min(start + CHUNK_SIZE, text.length);
    const slice = text.slice(start, end).trim();
    if (slice.length > 60) chunks.push({ source: docName, text: slice });
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────
// 3. RELEVÂNCIA: TF-IDF SIMPLIFICADO
// ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'que','com','para','uma','por','mais','como','mas','seu','sua','nos','das',
  'dos','ser','foi','ele','ela','não','sim','isso','este','essa','aqui','também',
  'the','and','for','are','this','that','with','from','have','not','will','você',
  'sobre','numa','num','nao','pode','tem','ter','são','está','pelo','pela','pois',
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
  for (const qt of queryTokens) {
    const tf = chunkTokens.filter(t => t === qt).length / len;
    score += tf * (idf.get(qt) || 1);
  }
  return score;
}

/**
 * Seleciona os top-K chunks mais relevantes para a query do usuário.
 */
function selectTopChunks(allChunks, query, k) {
  if (!allChunks.length) return [];
  const queryTokens = tokenize(query);
  const idf         = buildIdf(allChunks);

  return allChunks
    .map(chunk => ({
      ...chunk,
      score: scoreChunk(tokenize(chunk.text), queryTokens, idf),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ─────────────────────────────────────────────────────────────
// 4. CONSTRUÇÃO DO CONTEXTO KB COM CACHE
// ─────────────────────────────────────────────────────────────

/**
 * Monta o contexto KB enviando apenas os chunks mais relevantes
 * para a mensagem atual. O conjunto de chunks do tenant é cacheado
 * por TTL para evitar releitura de arquivos a cada mensagem.
 */
async function buildKbContext(KnowledgeBase, tenantId, userQuery) {
  const docs = await KnowledgeBase.findAll({
    where:  { tenant_id: tenantId, status: 'ready' },
    order:  [['created_at', 'DESC']],
    limit:  30,
  });
  if (!docs.length) return '';

  // ── Cache de chunks por tenant ──
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
        allChunks.push({ source: doc.original_name, text: doc.description });
      }
    }
    chunkCache.set(tenantId, { chunks: allChunks, ts: Date.now() });
    console.log(`[Groq] Cache KB atualizado: tenant=${tenantId} chunks=${allChunks.length}`);
  }

  // ── Seleciona top-K mais relevantes para esta query ──
  const topChunks = selectTopChunks(allChunks, userQuery, TOP_K_CHUNKS);

  let context    = '';
  let totalChars = 0;
  for (const chunk of topChunks) {
    if (totalChars >= MAX_KB_CHARS) break;
    const entry     = `[${chunk.source}]\n${chunk.text}`;
    const remaining = MAX_KB_CHARS - totalChars;
    context   += (context ? '\n\n---\n\n' : '') + entry.slice(0, remaining);
    totalChars += entry.length;
  }

  return context;
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

/**
 * Retorna MODEL_FAST ou MODEL_STRONG com base em heurísticas locais.
 * Nenhuma chamada de API é feita aqui — decisão 100% local e instantânea.
 *
 * Regras (por ordem de prioridade):
 *   1. Saudações / respostas de cortesia              → FAST
 *   2. Mensagem curta (< 55 chars) sem KB             → FAST
 *   3. Palavras-chave de complexidade                 → STRONG
 *   4. Contexto KB presente + conversa >= 4 turnos    → STRONG
 *   5. Contexto KB presente + mensagem > 70 chars     → STRONG
 *   6. Demais casos                                   → FAST
 */
function selectModel(userText, hasKb, historyLen) {
  const lower = userText.toLowerCase().trim();

  if (SIMPLE_RE.some(p => p.test(lower)))                          return MODEL_FAST;
  if (userText.length < 55 && !hasKb)                              return MODEL_FAST;
  if (COMPLEX_KW.some(kw => lower.includes(kw)))                   return MODEL_STRONG;
  if (hasKb && historyLen >= 4)                                     return MODEL_STRONG;
  if (hasKb && userText.length > 70)                               return MODEL_STRONG;
  return MODEL_FAST;
}

// ─────────────────────────────────────────────────────────────
// 6. SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt(tenant, kbContext) {
  const agentName   = tenant.agent_name        || 'Assistente';
  const companyName = tenant.name              || 'a empresa';
  const welcome     = tenant.welcome_message   || '';

  let prompt  = `Você é ${agentName}, o assistente virtual inteligente de ${companyName}. `;
  prompt     += `Responda sempre em português, de forma cordial, objetiva e útil. `;
  if (welcome) prompt += `Sua saudação padrão é: "${welcome}". `;
  prompt     += `Jamais invente informações que não estejam na base de conhecimento ou no contexto fornecido. `;
  prompt     += `Se não souber a resposta, diga educadamente que vai verificar e sugerir que o cliente entre em contato diretamente.\n\n`;

  if (kbContext.trim()) {
    prompt += `## Base de Conhecimento (trechos mais relevantes para esta mensagem)\n\n`;
    prompt += `Use APENAS as informações abaixo para responder:\n\n`;
    prompt += kbContext;
  } else {
    prompt += `Nenhuma base de conhecimento foi configurada ainda. `;
    prompt += `Responda com base no contexto da conversa e informações gerais sobre ${companyName}.`;
  }

  return prompt;
}

// ─────────────────────────────────────────────────────────────
// 7. FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Gera a resposta do agente via Groq.
 *
 * Melhorias aplicadas:
 *  - Chunks relevantes por TF-IDF (só os top-K chegam ao prompt)
 *  - Cache de texto extraído por arquivo (invalidado por mtime)
 *  - Cache de chunks por tenant (TTL de 5 min)
 *  - Seleção automática de modelo: llama-3.1-8b-instant para fluxos
 *    simples; llama-3.3-70b-versatile somente quando necessário
 *
 * @param {string} userText      – mensagem atual do usuário
 * @param {Object} tenant        – registro Tenant do Sequelize
 * @param {Array}  previousMsgs  – mensagens anteriores [{author, text}]
 * @param {Object} KnowledgeBase – model Sequelize KnowledgeBase
 * @returns {Promise<string>}    resposta do agente
 */
async function generateGroqReply(userText, tenant, previousMsgs = [], KnowledgeBase) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'seu_groq_api_key_aqui') {
    console.warn('[Groq] GROQ_API_KEY não configurada. Usando resposta fallback.');
    return fallbackReply(userText, tenant);
  }

  try {
    const groq      = new Groq({ apiKey });
    const kbContext = await buildKbContext(KnowledgeBase, tenant.id, userText);
    const sysPrompt = buildSystemPrompt(tenant, kbContext);

    const history = previousMsgs
      .slice(-HISTORY_LIMIT)
      .map(m => ({
        role:    m.author === 'agent' ? 'assistant' : 'user',
        content: m.text,
      }));

    const messages = [
      { role: 'system', content: sysPrompt },
      ...history,
      { role: 'user',   content: userText },
    ];

    const model = selectModel(userText, !!kbContext.trim(), history.length);

    console.log(
      `[Groq] model=${model === MODEL_FAST ? 'FAST(8B)' : 'STRONG(70B)'} ` +
      `| kb=${!!kbContext.trim()} | hist=${history.length} | chars=${userText.length}`
    );

    const completion = await groq.chat.completions.create({
      model,
      messages,
      temperature: model === MODEL_FAST ? 0.3 : 0.5,
      max_tokens:  model === MODEL_FAST ? 256  : 512,
    });

    return completion.choices[0]?.message?.content?.trim() || fallbackReply(userText, tenant);
  } catch (err) {
    console.error('[Groq] Erro na chamada à API:', err.message);
    return fallbackReply(userText, tenant);
  }
}

// ─────────────────────────────────────────────────────────────
// 8. FALLBACK (sem API)
// ─────────────────────────────────────────────────────────────

function fallbackReply(userText, tenant) {
  const lower   = userText.toLowerCase();
  const welcome = tenant?.welcome_message || 'Como posso ajudar?';
  const agent   = tenant?.agent_name     || 'Assistente';

  if (/ol[aá]|^oi\b|hello/.test(lower))                              return `${welcome} Sou ${agent}. Em que posso ajudar?`;
  if (/pagamento|fatura|boleto/.test(lower))                         return 'Para consultar pagamentos ou emitir faturas, entre em contato com nossa equipe ou acesse o portal do cliente.';
  if (/agendamento|hor[aá]rio/.test(lower))                          return 'Posso ajudar com agendamentos! Por favor, informe a data e o serviço desejado.';
  return 'Entendi! Pode me dar mais detalhes sobre sua necessidade? Farei o meu melhor para ajudar.';
}

// ─────────────────────────────────────────────────────────────
// 9. UTILITÁRIO: INVALIDAR CACHE DE UM TENANT
//    (chamar ao fazer upload de novo documento KB)
// ─────────────────────────────────────────────────────────────

/**
 * Remove os chunks cacheados de um tenant para forçar reindexação
 * na próxima mensagem. Deve ser chamado na rota de upload de KB.
 */
function invalidateTenantKbCache(tenantId) {
  chunkCache.delete(tenantId);
  console.log(`[Groq] Cache KB invalidado para tenant=${tenantId}`);
}

module.exports = { generateGroqReply, invalidateTenantKbCache, buildKbContext };
