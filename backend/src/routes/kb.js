'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { KnowledgeBase } = require('../models');
const Joi = require('joi');
const { invalidateTenantKbCache } = require('../services/groqService');

// ── Extratores de texto (mesma lógica do groqService) ─────────
// Extraímos o texto no momento do upload e persistimos no banco.
// Isso garante que o conteúdo esteja disponível mesmo após o
// filesystem efêmero do Railway ser limpo num redeploy/restart.
let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch (_) {}
try { mammoth  = require('mammoth');   } catch (_) {}

async function extractTextFromFile(filepath, filetype) {
  try {
    if (filetype === 'txt' || filetype === 'md') {
      return fs.readFileSync(filepath, 'utf8');
    }
    if (filetype === 'pdf' && pdfParse) {
      const data = await pdfParse(fs.readFileSync(filepath));
      return data.text || '';
    }
    if ((filetype === 'docx' || filetype === 'doc') && mammoth) {
      const result = await mammoth.extractRawText({ path: filepath });
      return result.value || '';
    }
  } catch (err) {
    console.warn(`[KB Upload] Falha ao extrair texto: ${err.message}`);
  }
  return '';
}

// ── Diretório de uploads ───────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../../../uploads/kb');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Configuração Multer ───────────────────────────────────────
const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `kb_${ts}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('Tipo de arquivo não permitido. Use PDF, DOCX, TXT ou MD.'));
  },
});

// GET /api/kb?tenant_id=...
router.get('/', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    const where = {};
    if (tenant_id) where.tenant_id = tenant_id;
    const docs = await KnowledgeBase.findAll({
      where,
      order: [['created_at', 'DESC']],
    });
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kb/upload  (multipart/form-data: file + tenant_id + description)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { tenant_id, description } = req.body;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!tenant_id || !uuidRegex.test(tenant_id)) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'tenant_id inválido ou ausente' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const filetype = ALLOWED_TYPES[req.file.mimetype] || path.extname(req.file.originalname).replace('.', '');

    // Extrai texto imediatamente e persiste no banco para sobreviver
    // a redeployments (filesystem Railway é efêmero).
    const extractedContent = await extractTextFromFile(req.file.path, filetype);
    if (extractedContent) {
      console.log(`[KB Upload] Texto extraído: ${extractedContent.length} chars de ${req.file.originalname}`);
    } else {
      console.warn(`[KB Upload] Nenhum texto extraído de ${req.file.originalname} (tipo: ${filetype})`);
    }

    const doc = await KnowledgeBase.create({
      tenant_id,
      original_name: req.file.originalname,
      filename: req.file.filename,
      filetype,
      filesize: req.file.size,
      description: description || null,
      content: extractedContent || null,
      status: 'ready',
    });

    // Invalida cache de chunks do tenant para reindexar o novo doc
    invalidateTenantKbCache(tenant_id);

    res.status(201).json(doc);
  } catch (err) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(err.message.includes('Tipo') ? 400 : 500).json({ error: err.message });
  }
});

// DELETE /api/kb/:id  (soft delete + remove arquivo físico)
router.delete('/:id', async (req, res) => {
  try {
    const doc = await KnowledgeBase.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });

    const filepath = path.join(UPLOAD_DIR, doc.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }

    await doc.destroy();

    // Invalida cache de chunks do tenant após remoção
    invalidateTenantKbCache(doc.tenant_id);

    res.json({ message: 'Documento removido com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Erro multer
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
