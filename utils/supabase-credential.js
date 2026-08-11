/**
 * Supabase service-role credential validation.
 *
 * Accepts ONLY server credentials:
 *   1. Modern Supabase secret keys:  sb_secret_<...>
 *   2. Legacy service_role JWTs:     eyJ<header>.<payload>.<signature>
 *      (payload must declare role === "service_role")
 *
 * Explicitly REJECTS:
 *   - sb_publishable_...  (modern publishable/client key)
 *   - legacy anon / public JWTs (role === "anon")
 *   - any other sb_ prefixed key
 *   - missing / empty / unparseable values
 *
 * Safe diagnostics only — never expose the full secret.
 */

function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  return key.trim();
}

/** Decode the payload of a JWT (header.payload.signature). Returns object or null. */
function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    // base64url → base64
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Does this legacy JWT declare the given role? */
function legacyJwtHasRole(token, expectedRole) {
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  return (
    typeof payload.role === 'string' &&
    payload.role.trim().toLowerCase() === String(expectedRole).toLowerCase()
  );
}

/**
 * Is this a valid Supabase SERVICE-ROLE credential?
 * Accepts modern sb_secret_ keys and legacy service_role JWTs.
 */
function isSupabaseServiceRoleKey(key) {
  const trimmed = normalizeKey(key);
  if (!trimmed) return false;

  // Modern secret keys.
  if (trimmed.startsWith('sb_secret_')) {
    return trimmed.length > 'sb_secret_'.length;
  }

  // Modern publishable/client keys — explicitly rejected.
  if (trimmed.startsWith('sb_publishable_')) return false;

  // Any other sb_ prefixed key (anon, unknown) — rejected.
  if (trimmed.startsWith('sb_')) return false;

  // Legacy service_role JWT.
  if (trimmed.startsWith('eyJ')) {
    return legacyJwtHasRole(trimmed, 'service_role');
  }

  return false;
}

/** Safe first-4-char prefix for logging. Never returns the full secret. */
function safeCredentialPrefix(key) {
  const trimmed = normalizeKey(key);
  if (!trimmed) return '(missing)';
  return trimmed.slice(0, 4);
}

/** Human-readable, safe description of the key for diagnostics. */
function describeSupabaseKeyType(key) {
  const trimmed = normalizeKey(key);
  if (!trimmed) return 'missing';

  if (isSupabaseServiceRoleKey(trimmed)) {
    return trimmed.startsWith('sb_secret_') ? 'modern-secret' : 'legacy-service-role';
  }
  if (trimmed.startsWith('sb_publishable_')) return 'publishable-rejected';
  if (trimmed.startsWith('sb_')) return 'unknown-sb-rejected';
  if (trimmed.startsWith('eyJ')) return 'legacy-jwt-rejected';
  return 'invalid';
}

module.exports = {
  isSupabaseServiceRoleKey,
  safeCredentialPrefix,
  describeSupabaseKeyType,
};
