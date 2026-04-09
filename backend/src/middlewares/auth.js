'use strict';
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'mafel_jwt_secret_dev_2026';

/**
 * Middleware: verifica token Bearer no header Authorization.
 * Popula req.user com { id, role, tenant_id, name, email }.
 */
function verifyToken(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

/**
 * Middleware: restringe acesso a usuários com role 'admin' (superadmin).
 * Deve ser usado APÓS verifyToken.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao super administrador.' });
  }
  next();
}

/**
 * Middleware: restringe acesso a usuários com tenant_id preenchido (prestadores).
 * Deve ser usado APÓS verifyToken.
 */
function requireTenant(req, res, next) {
  if (!req.user || !req.user.tenant_id) {
    return res.status(403).json({ error: 'Acesso restrito a prestadores.' });
  }
  next();
}

module.exports = { verifyToken, requireAdmin, requireTenant };
