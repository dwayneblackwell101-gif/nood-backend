/**
 * Production configuration validation — additive readiness helpers.
 * Does not change runtime behavior beyond reporting.
 */

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(safeString(value).toLowerCase());
}

function validateProductionConfig(env = process.env) {
  const isProduction = safeString(env.NODE_ENV).toLowerCase() === 'production';
  const issues = [];
  const warnings = [];

  function requireKey(key, message) {
    if (!safeString(env[key])) {
      issues.push({ level: 'error', key, message: message || `${key} is required.` });
    }
  }

  function warnKey(key, message) {
    warnings.push({ level: 'warn', key, message });
  }

  if (!isProduction) {
    return {
      ok: true,
      production: false,
      issues,
      warnings: [{ level: 'info', message: 'Not production — validation advisory only.' }],
    };
  }

  requireKey('REDIS_URL', 'REDIS_URL is required for multi-instance production.');
  requireKey('STORAGE_DRIVER', 'STORAGE_DRIVER should be redis in production.');
  if (safeString(env.STORAGE_DRIVER) && safeString(env.STORAGE_DRIVER) !== 'redis') {
    issues.push({
      level: 'error',
      key: 'STORAGE_DRIVER',
      message: 'STORAGE_DRIVER must be redis in production.',
    });
  }

  requireKey('SHOPIFY_STORE_DOMAIN');
  requireKey('SHOPIFY_STOREFRONT_ACCESS_TOKEN');
  requireKey('SHOPIFY_ADMIN_ACCESS_TOKEN');
  requireKey('SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN');
  requireKey('SHOPIFY_WEBHOOK_SECRET');

  // Either admin key is sufficient (server accepts both headers).
  if (!safeString(env.ADMIN_API_KEY) && !safeString(env.NOOD_ADMIN_API_KEY)) {
    issues.push({
      level: 'error',
      key: 'ADMIN_API_KEY',
      message: 'ADMIN_API_KEY or NOOD_ADMIN_API_KEY is required.',
    });
  }

  if (!safeString(env.SHOPIFY_SHOP_ID) && !safeString(env.SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID)) {
    warnings.push({
      level: 'warn',
      key: 'SHOPIFY_SHOP_ID',
      message:
        'SHOPIFY_SHOP_ID recommended for Customer Account API auth fallback (mobile OAuth tokens).',
    });
  }

  const mediaDriver = safeString(env.REVIEWS_MEDIA_DRIVER, 'local');
  const mediaBase = safeString(env.REVIEWS_MEDIA_PUBLIC_BASE_URL);
  if (mediaDriver === 'local' && !mediaBase) {
    warnings.push({
      level: 'warn',
      key: 'REVIEWS_MEDIA_DRIVER',
      message:
        'Local review media without CDN base is unsafe on ephemeral disks. Prefer url driver + CDN HTTPS URLs or set REVIEWS_MEDIA_PUBLIC_BASE_URL.',
    });
  }

  // Default PayPal on when unset (matches server PAYPAL_ENABLED default).
  const payPalEnabled = safeString(env.PAYPAL_ENABLED, 'true').toLowerCase();
  if (!['0', 'false', 'no', 'off'].includes(payPalEnabled)) {
    requireKey('PAYPAL_CLIENT_ID');
    requireKey('PAYPAL_CLIENT_SECRET');
  }

  if (!safeString(env.ORDERS_CARRIER_WEBHOOK_SECRET)) {
    warnings.push({
      level: 'warn',
      key: 'ORDERS_CARRIER_WEBHOOK_SECRET',
      message: 'Carrier webhooks are open without ORDERS_CARRIER_WEBHOOK_SECRET.',
    });
  }

  return {
    ok: issues.length === 0,
    production: true,
    issues,
    warnings,
  };
}

module.exports = {
  validateProductionConfig,
};
