/**
 * Admin authentication for NOOD backend endpoints.
 *
 * Protects manual broadcast / admin endpoints. Uses a shared secret token set
 * via NOOD_ADMIN_TOKEN (env). Requests must carry it in the `x-admin-token`
 * header (or `Authorization: Bearer <token>`).
 *
 * Never expose an unauthenticated public broadcast endpoint.
 */

const crypto = require('crypto');

function getAdminToken() {
  return String(process.env.NOOD_ADMIN_TOKEN || '').trim();
}

function isAdminConfigured() {
  return getAdminToken().length >= 16;
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware. Rejects with 401 when the request lacks a valid admin
 * token. When NOOD_ADMIN_TOKEN is not configured, admin endpoints are
 * DISABLED (fail closed — do not silently allow).
 */
function requireAdmin(req, res, next) {
  if (!isAdminConfigured()) {
    return res.status(503).json({
      success: false,
      message: 'Admin endpoints disabled: NOOD_ADMIN_TOKEN is not configured.',
    });
  }

  const header = String(req.headers['x-admin-token'] || '');
  const authHeader = String(req.headers['authorization'] || '');
  const bearer = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  const provided = header || bearer;

  if (!provided || !timingSafeEqualString(provided, getAdminToken())) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  next();
}

module.exports = { requireAdmin, isAdminConfigured };
