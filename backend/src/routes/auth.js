'use strict';
const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const { Op } = require('sequelize');
const { User, Tenant } = require('../models');
const { verifyToken } = require('../middlewares/auth');

const SECRET     = process.env.JWT_SECRET      || 'mafel_jwt_secret_dev_2026';
const EXPIRATION = process.env.JWT_EXPIRATION  || '8h';

/* ──────────────────────────────────────────────
   POST /api/auth/login
   Body: { email, password }
   Retorno: { token, user: { id, name, email, role, tenant_id, tenant_slug } }
────────────────────────────────────────────── */
router.post('/login', async (req, res) => {
  try {
    const { identifier, email: legacyEmail, password } = req.body || {};
    const rawId = (identifier || legacyEmail || '').trim();

    if (!rawId || !password) {
      return res.status(400).json({ error: 'E-mail (ou celular) e senha são obrigatórios.' });
    }

    // Detecta se é e-mail ou celular (mantém só dígitos para celular)
    const isEmail  = rawId.includes('@');
    const phoneNum = rawId.replace(/\D/g, '');

    // Busca pelo e-mail OU pelo celular (sem filtrar is_active para dar msg específica)
    const user = await User.findOne({
      where: {
        [Op.or]: isEmail
          ? [{ email: rawId.toLowerCase() }]
          : [{ phone: phoneNum }, { email: rawId.toLowerCase() }],
      },
      include: [{ model: Tenant, as: 'tenant', attributes: ['slug', 'name'] }],
    });

    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const valid = await user.validatePassword(password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Conta pendente de pagamento
    if (!user.is_active) {
      return res.status(403).json({
        error: 'Conta ainda não ativada. Conclua o pagamento PIX para liberar o acesso.',
        code:  'PENDING_PAYMENT',
      });
    }

    const payload = {
      id:        user.id,
      name:      user.name,
      email:     user.email,
      role:      user.role,
      tenant_id: user.tenant_id || null,
    };

    const token = jwt.sign(payload, SECRET, { expiresIn: EXPIRATION });

    return res.json({
      token,
      user: {
        ...payload,
        tenant_slug: user.tenant ? user.tenant.slug : null,
        tenant_name: user.tenant ? user.tenant.name : null,
      },
    });
  } catch (err) {
    console.error('Auth login error:', err);
    return res.status(500).json({ error: 'Erro interno ao autenticar.' });
  }
});

/* ──────────────────────────────────────────────
   GET /api/auth/me
   Header: Authorization: Bearer <token>
   Retorno: dados do usuário logado
────────────────────────────────────────────── */
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'name', 'email', 'role', 'tenant_id', 'is_active'],
      include: [{ model: Tenant, as: 'tenant', attributes: ['slug', 'name', 'primary_color', 'logo_url'] }],
    });

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Usuário inativo ou não encontrado.' });
    }

    return res.json({
      id:          user.id,
      name:        user.name,
      email:       user.email,
      role:        user.role,
      tenant_id:   user.tenant_id,
      tenant_slug: user.tenant ? user.tenant.slug : null,
      tenant_name: user.tenant ? user.tenant.name : null,
    });
  } catch (err) {
    console.error('Auth me error:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

module.exports = router;
