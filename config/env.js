const path = require('path');

const SUPPORTED_NODE_ENVS = new Set(['development', 'test', 'production']);
const SUPPORTED_CURRENCIES = new Set(['USD']);
const SUPPORTED_WIPAY_ENVS = new Set(['sandbox', 'live']);
const SUPPORTED_CHECKOUT_SHIPPING_MODES = new Set(['fixed']);
let loaded = false;
let cachedEnv = null;

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseBoolean(name, fallback = false) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value.`);
}

function parsePositiveInteger(name, fallback) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseNonNegativeInteger(name, fallback) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function parsePercent(name, fallback) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a percentage between 0 and 100.`);
  }
  return value;
}

function parseCurrency(name, fallback = 'USD') {
  const value = safeString(process.env[name], fallback).toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(value)) {
    throw new Error(`${name} must be USD.`);
  }
  return value;
}

function parseAllowedValue(name, allowed, fallback) {
  const value = safeString(process.env[name], fallback).toLowerCase();
  if (!allowed.has(value)) {
    throw new Error(`${name} has an unsupported value.`);
  }
  return value;
}

function loadLocalEnvFiles(rootDir) {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(rootDir, '.env'), override: false });
  dotenv.config({ path: path.join(rootDir, '.env.local'), override: false });
}

function applyTestSafetyDefaults() {
  if (parseBoolean('ALLOW_TEST_EXTERNAL_SERVICES', false)) {
    return;
  }

  delete process.env.REDIS_URL;
  process.env.STORAGE_DRIVER = 'json';
  process.env.LOCAL_STATE_FALLBACK_ENABLED = 'true';
  process.env.PAYPAL_ENABLED = 'false';
  process.env.WIPAY_ENABLED = 'false';
  process.env.NOOD_DISABLE_BACKGROUND_WORKERS = 'true';
  process.env.NOOD_CATALOG_FORCE_JSON = '1';
}

function validateEnv() {
  const nodeEnv = parseAllowedValue(
    'NODE_ENV',
    SUPPORTED_NODE_ENVS,
    process.env.NODE_ENV || 'development'
  );
  process.env.NODE_ENV = nodeEnv;

  const env = {
    NODE_ENV: nodeEnv,
    PAYPAL_ENABLED: parseBoolean('PAYPAL_ENABLED', true),
    PAYPAL_RECONCILIATION_ENABLED: parseBoolean('PAYPAL_RECONCILIATION_ENABLED', true),
    WIPAY_ENABLED: parseBoolean('WIPAY_ENABLED', false),
    LOCAL_STATE_FALLBACK_ENABLED: parseBoolean('LOCAL_STATE_FALLBACK_ENABLED', nodeEnv !== 'production'),
    PAYMENT_LOCK_TTL_SECONDS: parsePositiveInteger('PAYMENT_LOCK_TTL_SECONDS', 60),
    RECONCILIATION_LOCK_TTL_SECONDS: parsePositiveInteger('RECONCILIATION_LOCK_TTL_SECONDS', 120),
    RECONCILIATION_PROVIDER_TIMEOUT_MS: parsePositiveInteger('RECONCILIATION_PROVIDER_TIMEOUT_MS', 15000),
    RECONCILIATION_MAX_BATCH_SIZE: parsePositiveInteger('RECONCILIATION_MAX_BATCH_SIZE', 50),
    CATALOG_SYNC_LOCK_TTL_SECONDS: parsePositiveInteger('CATALOG_SYNC_LOCK_TTL_SECONDS', 900),
    CATALOG_SYNC_LOCK_RENEW_SECONDS: parsePositiveInteger('CATALOG_SYNC_LOCK_RENEW_SECONDS', 300),
    CATALOG_MAX_COUNT_DROP_PERCENT: parsePercent('CATALOG_MAX_COUNT_DROP_PERCENT', 50),
    CATALOG_MIN_PRODUCT_COUNT: parseNonNegativeInteger('CATALOG_MIN_PRODUCT_COUNT', 0),
    CATALOG_VERSION_RETENTION_COUNT: parsePositiveInteger('CATALOG_VERSION_RETENTION_COUNT', 5),
    CATALOG_FAILED_VERSION_RETENTION_DAYS: parsePositiveInteger('CATALOG_FAILED_VERSION_RETENTION_DAYS', 14),
    CATALOG_SCHEMA_VERSION: parsePositiveInteger('CATALOG_SCHEMA_VERSION', 1),
    CATALOG_LEGACY_FALLBACK_ENABLED: parseBoolean('CATALOG_LEGACY_FALLBACK_ENABLED', nodeEnv !== 'production'),
    CHECKOUT_MAX_QUANTITY_PER_LINE: parsePositiveInteger('CHECKOUT_MAX_QUANTITY_PER_LINE', 10),
    CHECKOUT_MAX_TOTAL_QUANTITY: parsePositiveInteger('CHECKOUT_MAX_TOTAL_QUANTITY', 50),
    CHECKOUT_MAX_LINE_ITEMS: parsePositiveInteger('CHECKOUT_MAX_LINE_ITEMS', 50),
    CHECKOUT_PRICING_MAX_AGE_SECONDS: parsePositiveInteger('CHECKOUT_PRICING_MAX_AGE_SECONDS', 900),
    CHECKOUT_FIXED_SHIPPING_CENTS: parseNonNegativeInteger('CHECKOUT_FIXED_SHIPPING_CENTS', 0),
    CHECKOUT_PRICING_SCHEMA_VERSION: parsePositiveInteger('CHECKOUT_PRICING_SCHEMA_VERSION', 1),
    CHECKOUT_SHIPPING_MODE: parseAllowedValue('CHECKOUT_SHIPPING_MODE', SUPPORTED_CHECKOUT_SHIPPING_MODES, 'fixed'),
    WEBHOOK_JOB_LEASE_SECONDS: parsePositiveInteger('WEBHOOK_JOB_LEASE_SECONDS', 60),
    WEBHOOK_RETRY_BASE_SECONDS: parsePositiveInteger('WEBHOOK_RETRY_BASE_SECONDS', 5),
    WEBHOOK_RETRY_MAX_SECONDS: parsePositiveInteger('WEBHOOK_RETRY_MAX_SECONDS', 900),
    WEBHOOK_MAX_ATTEMPTS: parsePositiveInteger('WEBHOOK_MAX_ATTEMPTS', 8),
    WEBHOOK_WORKER_POLL_MS: parsePositiveInteger('WEBHOOK_WORKER_POLL_MS', 1000),
    WEBHOOK_WORKER_HEARTBEAT_SECONDS: parsePositiveInteger('WEBHOOK_WORKER_HEARTBEAT_SECONDS', 15),
    WEBHOOK_WORKER_STALE_SECONDS: parsePositiveInteger('WEBHOOK_WORKER_STALE_SECONDS', 60),
    WEBHOOK_COMPLETED_RETENTION_SECONDS: parsePositiveInteger('WEBHOOK_COMPLETED_RETENTION_SECONDS', 604800),
    WEBHOOK_DEAD_LETTER_RETENTION_SECONDS: parsePositiveInteger('WEBHOOK_DEAD_LETTER_RETENTION_SECONDS', 2592000),
    REDIS_NAMESPACE: safeString(process.env.REDIS_NAMESPACE, 'nood'),
    SHOPIFY_CURRENCY: parseCurrency('SHOPIFY_CURRENCY', 'USD'),
    PAYMENT_CURRENCY: parseCurrency('PAYMENT_CURRENCY', 'USD'),
    WALLET_CURRENCY: parseCurrency('WALLET_CURRENCY', 'USD'),
    WIPAY_ENVIRONMENT: parseAllowedValue('WIPAY_ENVIRONMENT', SUPPORTED_WIPAY_ENVS, 'sandbox'),
  };

  if (env.CATALOG_SYNC_LOCK_RENEW_SECONDS >= env.CATALOG_SYNC_LOCK_TTL_SECONDS) {
    throw new Error('CATALOG_SYNC_LOCK_RENEW_SECONDS must be lower than CATALOG_SYNC_LOCK_TTL_SECONDS.');
  }

  if (env.PAYPAL_ENABLED && nodeEnv === 'production') {
    if (!safeString(process.env.PAYPAL_CLIENT_ID) || !safeString(process.env.PAYPAL_CLIENT_SECRET)) {
      throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required when PAYPAL_ENABLED is true.');
    }
  }

  if (env.WIPAY_ENABLED && nodeEnv === 'production') {
    if (!safeString(process.env.WIPAY_ACCOUNT_NUMBER) || !safeString(process.env.WIPAY_API_KEY)) {
      throw new Error('WIPAY_ACCOUNT_NUMBER and WIPAY_API_KEY are required when WIPAY_ENABLED is true.');
    }
  }

  return env;
}

function loadEnv(options = {}) {
  if (loaded && !options.forceReload) return cachedEnv;

  const rootDir = options.rootDir || path.join(__dirname, '..');
  const nodeEnv = safeString(process.env.NODE_ENV, 'development').toLowerCase();

  if (nodeEnv === 'development') {
    loadLocalEnvFiles(rootDir);
  }

  if (nodeEnv === 'test') {
    applyTestSafetyDefaults();
  }

  cachedEnv = validateEnv();
  loaded = true;
  return cachedEnv;
}

function resetEnvForTests() {
  loaded = false;
  cachedEnv = null;
}

module.exports = {
  loadEnv,
  parseBoolean,
  parseCurrency,
  parseNonNegativeInteger,
  parsePercent,
  parsePositiveInteger,
  resetEnvForTests,
  validateEnv,
};
