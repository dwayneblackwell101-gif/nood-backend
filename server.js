const { loadEnv } = require('./config/env');
loadEnv();

const crypto = require('crypto');
const os = require('os');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

let createStorage;
try {
  console.log('[REDIS LOAD 1] requiring ./storage');
  ({ createStorage } = require('./storage'));
} catch (error) {
  console.error('[REDIS LOAD 1] failed:', error.code || error.name, error.message);
  throw error;
}

let fetchShopifyCustomerOrders;
try {
  console.log('[SERVER LOAD] requiring ./shopify-customer-orders');
  ({ fetchShopifyCustomerOrders } = require('./shopify-customer-orders'));
} catch (error) {
  console.error('[SERVER LOAD] failed:', error.code || error.name, error.message);
  throw error;
}
const {
  getPayPalConfig,
  hasPayPalCredentials,
  createPayPalOrder,
  capturePayPalOrder,
  getPayPalOrder,
} = require('./paypal');
const { mountCatalog, getCatalogReadiness, getCatalogCache } = require('./catalog');
const { getWebhookReadiness, mountShopifyWebhookBodyParser } = require('./catalog/webhooks');
const { adminGraphql } = require('./catalog/shopify');
const { createDiscountsHandler } = require('./catalog/discounts');
const {
  assertUsdCurrency,
  centsToUsd,
  requirePositiveCents,
  usdToCents,
} = require('./lib/money');
const { createCustomerAuthMiddleware } = require('./auth/customer-auth');
const { createRedisLockService } = require('./storage/redis-lock');
const { createRedisWalletService } = require('./wallet/redis-wallet');
const { createPaymentStateService } = require('./payments/payment-state');
const { createPayPalPaymentService } = require('./payments/paypal-service');
const { verifyPayPalPayment } = require('./payments/paypal-verification');
const { createPayPalReconciliationService } = require('./payments/reconciliation-service');
const {
  assertTrustedPricingSelfTest,
  hashSnapshot,
  priceCart,
  revalidateSnapshot,
  snapshotToCartItems,
  verifySnapshotHash,
} = require('./checkout/cart-pricing');
const { createReturnRequestHandlers } = require('./refunds/return-requests');
const shopifyRefundSync = require('./refunds/shopify-refund-sync');
const { createWalletRefundService } = require('./refunds/wallet-refund');
const { createRefundService } = require('./refunds/refund-service');
const { fetchRefundableShopifyOrder } = require('./refunds/shopify-refund-verifier');
const {
  getShopifyOrderAccessToken,
  hasShopifyOrderAdminAccessToken,
  getShopifyOrderTokenSource,
  validateShopifyOrderCreateAccess,
  assertShopifyOrderCreateAccess,
} = require('./shopify-order-access');
const { normalizeTrinidadPhoneForShopify } = require('./phone-normalize');
const app = express();
const storage = createStorage();
const pendingOrders = storage.pendingOrders.items;
const failedPaidOrders = storage.failedPaidOrders.items;
const paymentRecords = storage.paymentRecords.items;
const reconciliationRecords = storage.reconciliationRecords;
const walletTransactions = storage.walletTransactions.items;
const redisNamespace = safeString(process.env.REDIS_NAMESPACE, 'nood');
const lockService = createRedisLockService({ redis: storage.redis, namespace: redisNamespace });
const redisWallet = createRedisWalletService({ redis: storage.redis, namespace: redisNamespace });
const paymentState = createPaymentStateService({ redis: storage.redis, namespace: redisNamespace });
const paypalPaymentService = createPayPalPaymentService({
  paymentState,
  lockService,
  paypalClient: {
    createOrder: createPayPalOrder,
    captureOrder: capturePayPalOrder,
    getOrder: getPayPalOrder,
  },
  expectedMerchantId: safeString(process.env.PAYPAL_MERCHANT_ID),
  lockTtlSeconds: Number(process.env.PAYMENT_LOCK_TTL_SECONDS || 60),
});
const payPalReconciliationService = createPayPalReconciliationService({
  paymentState,
  lockService,
  reconciliationRecords,
  failedPaidOrders,
  paypalVerifier: {
    verify: (input) => verifyPayPalPayment({
      ...input,
      paypalClient: { getOrder: getPayPalOrder },
    }),
  },
  shopifyLookup: findExistingShopifyOrderForRecovery,
  createShopifyOrder,
  getCatalogCache,
  expectedMerchantId: safeString(process.env.PAYPAL_MERCHANT_ID),
  lockTtlSeconds: Number(process.env.RECONCILIATION_LOCK_TTL_SECONDS || 120),
});
const requireCustomerAuth = createCustomerAuthMiddleware();
const walletRefundService = createWalletRefundService({
  walletTransactions,
  persistWalletTransactions,
  safeMoney,
  safeString,
  defaultCurrency: 'USD',
});
const refundService = createRefundService({
  refundRequests: storage.refundRequests,
  lockService,
  redisWallet,
  walletRefundService,
  fetchShopifyOrder: fetchRefundableShopifyOrder,
  paypalRefundsEnabled: ['1', 'true', 'yes'].includes(
    safeString(process.env.PAYPAL_REFUNDS_ENABLED, 'false').toLowerCase()
  ),
  shippingPolicy: safeString(process.env.REFUND_SHIPPING_POLICY, 'none').toLowerCase(),
});
const returnRequestHandlers = createReturnRequestHandlers({
  refundService,
  shopifyRefundSync,
});

const createNotificationsRouter = require('./notifications/push-notifications');
const notificationsRouter = createNotificationsRouter({
  pushTokens: storage.pushTokens,
  requireAdminApiKey,
});

const PORT = Number(process.env.PORT || 3000);
const LOCAL_IP = safeString(process.env.LOCAL_IP) || getLocalNetworkIp();
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const APP_DEEP_LINK_SCHEME = safeString(process.env.APP_DEEP_LINK_SCHEME, 'noodapp');
const SHOPIFY_APP_AUTH_CALLBACK_URI = safeString(
  process.env.SHOPIFY_APP_AUTH_CALLBACK_URI,
  'shop.66320990292.nood://auth/callback'
);
const PAYPAL_CURRENCY = safeString(process.env.PAYPAL_CURRENCY, 'USD').toUpperCase();
const SHOPIFY_CURRENCY = safeString(process.env.SHOPIFY_CURRENCY, 'USD').toUpperCase();
const WALLET_CURRENCY = safeString(process.env.WALLET_CURRENCY, 'USD').toUpperCase();
const PAYMENT_CURRENCY = safeString(process.env.PAYMENT_CURRENCY, 'USD').toUpperCase();
const PAYPAL_USD_TO_TTD_RATE = Number(process.env.PAYPAL_USD_TO_TTD_RATE || 6.8);
const PAYPAL_WALLET_MIN_CENTS = Number(process.env.PAYPAL_WALLET_MIN_CENTS || 100);
const PAYPAL_WALLET_MAX_CENTS = Number(process.env.PAYPAL_WALLET_MAX_CENTS || 100000);
const BACKEND_BASE_URL = getBackendBaseUrl();

function normalizeWiPayAccountNumber(rawValue) {
  return String(rawValue || '').replace(/\D/g, '');
}

function resolveWiPayAccountNumber() {
  const fromEnv = normalizeWiPayAccountNumber(process.env.WIPAY_ACCOUNT_NUMBER);
  if (fromEnv) {
    return fromEnv;
  }

  return '';
}

const WIPAY_ACCOUNT_NUMBER = resolveWiPayAccountNumber();
const WIPAY_API_KEY = safeString(process.env.WIPAY_API_KEY);

function resolveWiPayEnvironmentConfig() {
  const candidates = [
    ['WIPAY_ENVIRONMENT', process.env.WIPAY_ENVIRONMENT],
    ['WIPAY_ENV', process.env.WIPAY_ENV],
    ['WIPAY_MODE', process.env.WIPAY_MODE],
  ];

  for (const [source, value] of candidates) {
    const raw = safeString(value).toLowerCase();
    if (!raw) continue;

    if (['sandbox', 'test', 'staging', 'dev', 'development'].includes(raw)) {
      return { environment: 'sandbox', source, raw };
    }

    if (['live', 'production', 'prod'].includes(raw)) {
      return { environment: 'live', source, raw };
    }

    throw new Error(`Invalid ${source}. Expected "sandbox" or "live".`);
  }

  return { environment: 'sandbox', source: 'default', raw: '' };
}

function finalizeWiPayEnvironmentConfig(config) {
  return config;
}

const wipayEnvironmentConfig = finalizeWiPayEnvironmentConfig(resolveWiPayEnvironmentConfig());
const WIPAY_ENVIRONMENT = wipayEnvironmentConfig.environment;
const WIPAY_ENVIRONMENT_SOURCE = wipayEnvironmentConfig.source;
const WIPAY_ENVIRONMENT_RAW = wipayEnvironmentConfig.raw;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_ADMIN_API_VERSION = safeString(process.env.SHOPIFY_ADMIN_API_VERSION, '2025-10');
let shopifyOrderAccessState = {
  ok: false,
  message: 'Shopify order access has not been validated yet.',
  scopes: [],
  tokenSource: getShopifyOrderTokenSource(),
  missingOrderScopes: ['write_orders'],
  hasShopifyOrderAdminAccessToken: hasShopifyOrderAdminAccessToken(),
  tokenFingerprint: '',
};
function trimValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getConfiguredAdminApiKeys() {
  const keys = [];
  const adminKey = trimValue(process.env.ADMIN_API_KEY);
  const noodKey = trimValue(process.env.NOOD_ADMIN_API_KEY);

  if (adminKey) keys.push(adminKey);
  if (noodKey && noodKey !== adminKey) keys.push(noodKey);

  return keys;
}

function getConfiguredAdminApiKey() {
  const keys = getConfiguredAdminApiKeys();
  return keys[0] || '';
}

assertProductionConfig();

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

app.use(helmet());

app.use(
  cors({
    origin: getCorsOrigin(),
    credentials: true,
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: IS_PRODUCTION ? 300 : 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: true,
      message: 'Too many requests. Please try again shortly.',
    },
  })
);
mountShopifyWebhookBodyParser(app);

app.use((req, res, next) => {
  if (req._shopifyWebhookRawBody) {
    return next();
  }
  return express.json({ limit: process.env.REQUEST_BODY_LIMIT || '1mb' })(req, res, next);
});

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '0.00';
  return num.toFixed(2);
}

function isPrivateOrLocalUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return true;
  }
}

function getBackendBaseUrl() {
  const configuredUrl = safeString(process.env.BACKEND_BASE_URL);

  if (IS_PRODUCTION) {
    if (!configuredUrl) {
      throw new Error('BACKEND_BASE_URL is required in production.');
    }

    if (!configuredUrl.startsWith('https://') || isPrivateOrLocalUrl(configuredUrl)) {
      throw new Error(
        'BACKEND_BASE_URL must be a public HTTPS URL in production. Local IPs are not allowed.'
      );
    }

    return configuredUrl.replace(/\/+$/, '');
  }

  return (configuredUrl || `http://${LOCAL_IP}:${PORT}`).replace(/\/+$/, '');
}

function isIpv4Address(iface) {
  return iface?.family === 'IPv4' || iface?.family === 4;
}

function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const iface of entries || []) {
      if (!isIpv4Address(iface) || iface.internal) {
        continue;
      }

      const address = safeString(iface.address);
      if (
        address.startsWith('192.168.') ||
        address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
      ) {
        return address;
      }
    }
  }

  return '127.0.0.1';
}

function getDevelopmentCorsOrigins() {
  const origins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://${LOCAL_IP}:${PORT}`,
    'http://localhost:8081',
    'http://localhost:19006',
  ]);

  return Array.from(origins);
}

function getCorsOrigin() {
  if (!IS_PRODUCTION) {
    const allowedOrigins = getDevelopmentCorsOrigins();

    return (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || isPrivateOrLocalUrl(origin)) {
        return callback(null, true);
      }

      return callback(null, true);
    };
  }

  const allowedOrigins = String(process.env.NOOD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin is not allowed by NOOD production CORS policy.'));
  };
}

function getProvidedAdminApiKey(req) {
  const headerCandidates = [
    req.get('x-nood-admin-api-key'),
    req.headers['x-nood-admin-api-key'],
    req.get('x-admin-key'),
    req.headers['x-admin-key'],
    req.get('x-admin-api-key'),
    req.headers['x-admin-api-key'],
  ];

  for (const value of headerCandidates) {
    const trimmed = trimValue(value);
    if (trimmed) {
      return trimmed;
    }
  }

  return '';
}

function requireAdminApiKey(req, res, next) {
  const configuredKeys = getConfiguredAdminApiKeys();
  const providedKey = getProvidedAdminApiKey(req);
  const configured = configuredKeys.length > 0;
  const headerProvided = providedKey.length > 0;
  const match =
    configured &&
    headerProvided &&
    configuredKeys.some((configuredKey) => timingSafeStringEqual(configuredKey, providedKey));

  if (!configured) {
    return res.status(503).json({
      success: false,
      error: true,
      message: 'Admin API key missing in server .env',
    });
  }

  if (!match) {
    return res.status(401).json({
      success: false,
      error: true,
      message: 'Admin API key required',
      hint: 'Send x-nood-admin-api-key or x-admin-key (or legacy x-admin-api-key).',
    });
  }

  return next();
}

function timingSafeStringEqual(expected, received) {
  const expectedValue = trimValue(expected);
  const receivedValue = trimValue(received);

  if (!expectedValue || !receivedValue) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedValue, 'utf8');
  const receivedBuffer = Buffer.from(receivedValue, 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function assertProductionConfig() {
  if (!IS_PRODUCTION) return;

  if (!process.env.NOOD_ALLOWED_ORIGINS) {
    throw new Error('NOOD_ALLOWED_ORIGINS is required in production.');
  }

  if (!getConfiguredAdminApiKey()) {
    throw new Error('ADMIN_API_KEY or NOOD_ADMIN_API_KEY is required in production.');
  }

  if (SHOPIFY_CURRENCY !== 'USD' || WALLET_CURRENCY !== 'USD' || PAYMENT_CURRENCY !== 'USD') {
    throw new Error('Production requires SHOPIFY_CURRENCY, WALLET_CURRENCY, and PAYMENT_CURRENCY to be USD.');
  }

  if (!process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN) {
    throw new Error('SHOPIFY_STOREFRONT_ACCESS_TOKEN is required for customer authentication.');
  }

  if (storage.storageDriver !== 'redis' || !safeString(process.env.REDIS_URL)) {
    throw new Error('Production requires STORAGE_DRIVER=redis and REDIS_URL for persistent state.');
  }

  if (!WIPAY_ACCOUNT_NUMBER) {
    throw new Error('WIPAY_ACCOUNT_NUMBER is required in production.');
  }

  if (WIPAY_ENVIRONMENT === 'live' && !WIPAY_API_KEY) {
    throw new Error('WIPAY_API_KEY is required when WIPAY_ENVIRONMENT=live.');
  }
}

function isValidPositiveMoney(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 1;
}

function getWiPayPaymentUrl(data) {
  if (!data || typeof data !== 'object') return null;

  return data.url || data.payment_url || data.redirect_url || data.link || null;
}

function logWiPayCreatePaymentRequest(payload, paymentUrl = '') {
  console.log('[WIPAY ENV]', payload.get('environment') || WIPAY_ENVIRONMENT);
  console.log('[WIPAY ACCOUNT]', payload.get('account_number') || WIPAY_ACCOUNT_NUMBER);
  console.log('[WIPAY CURRENCY]', payload.get('currency') || 'TTD');
  console.log('[WIPAY METHOD]', payload.get('method') || 'credit_card');
  if (paymentUrl) {
    console.log('[WIPAY PAYMENT URL]', paymentUrl);
  }

  let responseUrlHost = '';
  try {
    responseUrlHost = new URL(String(payload.get('response_url') || '')).host;
  } catch {
    responseUrlHost = '';
  }

  console.log('[WIPAY ENV] create-payment payload (non-secret)', {
    environment: payload.get('environment') || WIPAY_ENVIRONMENT,
    environment_source: WIPAY_ENVIRONMENT_SOURCE,
    environment_raw: WIPAY_ENVIRONMENT_RAW || null,
    country_code: payload.get('country_code'),
    fee_structure: payload.get('fee_structure'),
    order_id: payload.get('order_id'),
    origin: payload.get('origin'),
    total: payload.get('total'),
    response_url_host: responseUrlHost,
  });
}

function isHttpsPaymentUrl(value) {
  return safeString(value).startsWith('https://');
}

function getPayPalApprovalUrl(data) {
  const links = Array.isArray(data?.links) ? data.links : [];
  return links.find((link) => link?.rel === 'approve')?.href || null;
}

function getRequestIdempotencyKey(req, fallback = '') {
  return safeString(
    req.get?.('idempotency-key') ||
      req.get?.('x-idempotency-key') ||
      req.body?.idempotencyKey ||
      req.body?.idempotency_key ||
      fallback
  );
}

function getCartFingerprint(cartItems = []) {
  const normalized = (Array.isArray(cartItems) ? cartItems : []).map((item) => ({
    variantId: safeString(item?.variantId || item?.id),
    quantity: Number(item?.quantity || 1),
    price: safeMoney(item?.price || 0),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function getPayPalCaptureDetails(captureData = {}) {
  const capture =
    captureData?.purchase_units?.[0]?.payments?.captures?.[0] ||
    captureData?.purchase_units?.[0]?.payments?.authorizations?.[0] ||
    {};
  return {
    id: safeString(capture?.id || captureData?.id),
    status: safeString(capture?.status || captureData?.status),
    amount: safeString(capture?.amount?.value || captureData?.purchase_units?.[0]?.amount?.value),
    currency: safeString(capture?.amount?.currency_code || captureData?.purchase_units?.[0]?.amount?.currency_code).toUpperCase(),
  };
}

function verifyPayPalCaptureAmount({ captureData, expectedAmountCents, expectedCurrency = 'USD' }) {
  const details = getPayPalCaptureDetails(captureData);
  if (captureData?.status !== 'COMPLETED' && details.status !== 'COMPLETED') {
    const error = new Error(`PayPal payment was ${captureData?.status || details.status || 'not completed'}.`);
    error.statusCode = 400;
    throw error;
  }

  if (!details.id) {
    const error = new Error('PayPal capture ID missing.');
    error.statusCode = 400;
    throw error;
  }

  if (details.currency !== expectedCurrency) {
    const error = new Error('PayPal capture currency mismatch.');
    error.statusCode = 400;
    throw error;
  }

  const capturedCents = usdToCents(details.amount);
  if (capturedCents !== Number(expectedAmountCents)) {
    const error = new Error('PayPal capture amount mismatch.');
    error.statusCode = 400;
    throw error;
  }

  return { ...details, amountCents: capturedCents };
}

function normalizeShopifyVariantGid(rawVariantId) {
  const raw = safeString(rawVariantId);
  if (!raw) return '';

  const match = raw.match(/ProductVariant\/(\d+)/);
  const variantId = match?.[1] || raw;

  return variantId ? `gid://shopify/ProductVariant/${variantId}` : '';
}

function getCartItemsFromBody(body = {}) {
  return Array.isArray(body.cartItems)
    ? body.cartItems
    : Array.isArray(body.cart)
      ? body.cart
      : Array.isArray(body.items)
        ? body.items
        : [];
}

function getCartComputedTotal(body = {}) {
  const items = getCartItemsFromBody(body);

  const total = items.reduce((sum, item) => {
    const quantity = Number(item?.quantity || 1);
    const price = Number(item?.price || item?.amount || item?.unit_price || 0);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return sum;
    }

    if (!Number.isFinite(price) || price < 0) {
      return sum;
    }

    return sum + quantity * price;
  }, 0);

  return safeMoney(total);
}

function getRequestTotal(body = {}) {
  const directAmount =
    body.total ??
    body.amount ??
    body?.purchase_units?.[0]?.amount?.value;

  if (directAmount !== undefined && directAmount !== null && directAmount !== '') {
    return safeMoney(directAmount);
  }

  return getCartComputedTotal(body);
}

function assertCheckoutTotalMatches(body = {}) {
  const computed = getCartComputedTotal(body);
  const hasStatedTotal =
    body.total !== undefined && body.total !== null && body.total !== '';

  if (hasStatedTotal) {
    const stated = safeMoney(body.total);
    if (stated !== computed) {
      const error = new Error(
        `Checkout total mismatch. Cart totals ${computed} but request sent ${stated}.`
      );
      error.statusCode = 400;
      throw error;
    }
  }

  if (!isValidPositiveMoney(computed)) {
    const error = new Error('Invalid checkout total. Minimum is 1.00.');
    error.statusCode = 400;
    throw error;
  }

  return computed;
}

function resolveCheckoutSessionId(body = {}) {
  return safeString(
    body.checkoutSessionId ||
      body.clientOrderId ||
      body.localOrderId ||
      body.pendingCheckoutId
  );
}

function findPendingByCheckoutSessionId(checkoutSessionId) {
  const sessionId = safeString(checkoutSessionId);
  if (!sessionId) return null;

  for (const [orderId, pending] of pendingOrders.entries()) {
    if (
      safeString(pending?.checkoutSessionId) === sessionId ||
      safeString(pending?.clientOrderId) === sessionId ||
      safeString(pending?.localOrderId) === sessionId
    ) {
      return { orderId, pending };
    }
  }

  return null;
}

function findWalletCheckoutPaymentRecord(checkoutSessionId) {
  const sessionId = safeString(checkoutSessionId);
  if (!sessionId) return null;

  return (
    Array.from(paymentRecords.values()).find((record) => {
      return (
        safeString(record?.provider).toLowerCase() === 'wallet' &&
        (safeString(record?.orderId) === sessionId ||
          safeString(record?.clientOrderId) === sessionId)
      );
    }) || null
  );
}

function validateCheckoutData({
  total,
  cartItems,
  name,
  email,
  phone,
  shippingAddress,
  requireShipping = true,
  requireEmail = true,
}) {
  const errors = [];

  if (!isValidPositiveMoney(total)) {
    errors.push('Invalid total. Minimum is 1.00.');
  }

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    errors.push('Cart is empty.');
  } else {
    cartItems.forEach((item, index) => {
      const label = safeString(item?.title, `item ${index + 1}`);
      const quantity = Number(item?.quantity);
      const price = Number(item?.price);

      if (!safeString(item?.variantId)) {
        errors.push(`${label} is missing Shopify variantId.`);
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        errors.push(`${label} is missing a valid quantity.`);
      }

      if (!Number.isFinite(price) || price <= 0) {
        errors.push(`${label} has an invalid price.`);
      }
    });
  }

  if (!safeString(name)) {
    errors.push('Customer name is required.');
  }

  if (requireEmail && !safeString(email)) {
    errors.push('Customer email is required.');
  }

  if (!safeString(phone)) {
    errors.push('Customer phone is required.');
  }

  if (requireShipping) {
    const address = shippingAddress || {};

    if (
      !safeString(address.fullName || address.name || name) ||
      !safeString(address.phone || phone) ||
      !safeString(address.address1 || address.address) ||
      !safeString(address.city) ||
      !safeString(address.region || address.province || address.state)
    ) {
      errors.push('Complete shipping address is required.');
    }
  }

  return errors;
}

function getReturnOrderId(query) {
  return String(
    query.order_id ||
      query.orderId ||
      query.orderid ||
      query.reference ||
      query.ref ||
      ''
  ).trim();
}

function getReturnTransactionId(query) {
  return String(
    query.transaction_id ||
      query.transactionId ||
      query.transactionid ||
      query.transaction_ref ||
      query.transactionRef ||
      query.txn_id ||
      query.txnid ||
      query.transaction_reference ||
      ''
  ).trim();
}

function getReturnStatus(query) {
  return String(
    query.status ||
      query.response ||
      query.response_status ||
      query.payment_status ||
      query.transaction_status ||
      ''
  )
    .trim()
    .toLowerCase();
}

function buildAppRedirect(path, params = {}) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.append(key, String(value));
    }
  });

  return `${APP_DEEP_LINK_SCHEME}://${path}?${query.toString()}`;
}

function sendPaymentResult(req, res, params = {}) {
  const redirectUrl = buildAppRedirect('payment-result', params);
  const wantsJson =
    safeString(req.query.return_json) === '1' ||
    safeString(req.query.format).toLowerCase() === 'json' ||
    safeString(req.get('accept')).includes('application/json');

  console.log('[PAYMENT RESULT REDIRECT]', {
    status: params.status,
    type: params.type || null,
    method: params.method || null,
    order_id: params.order_id || null,
    transaction_id: params.transaction_id || null,
    shopify_order_id: params.shopify_order_id || null,
    shopify_order_name: params.shopify_order_name || null,
    reason: params.reason || null,
    recovery_id: params.recovery_id || null,
    wantsJson,
    redirect_url: redirectUrl,
  });

  if (wantsJson) {
    return res.json({
      success: params.status === 'success',
      redirect_url: redirectUrl,
      ...params,
    });
  }

  return res.redirect(redirectUrl);
}

function buildShopifyAddress(address = {}, fallbackName = 'NOOD Customer', fallbackPhone = '') {
  if (!address || typeof address !== 'object') {
    return null;
  }

  const fullName = safeString(address.fullName || address.name, fallbackName);
  const [firstName, ...rest] = fullName.split(' ');
  const lastName = rest.join(' ') || 'Customer';
  const address1 = safeString(address.address1 || address.address);
  const city = safeString(address.city);
  const province = safeString(address.region || address.province || address.state);

  if (!address1 || !city) {
    return null;
  }

  const shippingPhone =
    normalizeTrinidadPhoneForShopify(safeString(address.phone), 'shipping_address') ||
    normalizeTrinidadPhoneForShopify(safeString(fallbackPhone), 'shipping_fallback');

  return {
    firstName: firstName || 'NOOD',
    lastName,
    phone: shippingPhone || undefined,
    address1,
    address2: safeString(address.address2) || undefined,
    city,
    province: province || undefined,
    country: safeString(address.country, 'Trinidad and Tobago'),
    zip: safeString(address.postalCode || address.zip) || undefined,
  };
}

function generateReturnToken() {
  return crypto.randomBytes(32).toString('hex');
}

function persistPendingOrders() {
  storage.pendingOrders.persist();
}

function persistFailedPaidOrders() {
  storage.failedPaidOrders.persist();
}

function persistPaymentRecords() {
  storage.paymentRecords.persist();
}

function persistWalletTransactions() {
  storage.walletTransactions.persist();
}

function getShopifyErrorDetails(error) {
  return {
    message: error?.message || 'Shopify order creation failed',
    statusCode: error?.response?.status || error?.statusCode || null,
    responseBody: error?.response?.data || null,
    shopifyDetails: error?.shopifyDetails || null,
    stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack,
  };
}

function getPaymentKey(provider, transactionId) {
  return `${safeString(provider).toLowerCase()}:${safeString(transactionId)}`;
}

function getPaymentRecord(provider, transactionId) {
  const key = getPaymentKey(provider, transactionId);
  return key.endsWith(':') ? null : paymentRecords.get(key);
}

function savePaymentRecord(record) {
  const paymentKey = getPaymentKey(record.provider, record.transactionId);
  const nextRecord = {
    ...record,
    paymentKey,
    updatedAt: new Date().toISOString(),
    createdAt: record.createdAt || new Date().toISOString(),
  };

  paymentRecords.set(paymentKey, nextRecord);
  persistPaymentRecords();
  return nextRecord;
}

function getUsdToTtdRate() {
  if (!Number.isFinite(PAYPAL_USD_TO_TTD_RATE) || PAYPAL_USD_TO_TTD_RATE <= 0) {
    const error = new Error('PAYPAL_USD_TO_TTD_RATE must be a positive number.');
    error.statusCode = 500;
    throw error;
  }

  return PAYPAL_USD_TO_TTD_RATE;
}

function assertPayPalCurrency() {
  if (PAYPAL_CURRENCY !== 'USD' || SHOPIFY_CURRENCY !== 'USD' || PAYMENT_CURRENCY !== 'USD') {
    const error = new Error('PayPal checkout is configured for USD only right now.');
    error.statusCode = 500;
    throw error;
  }
}

function normalizeCurrency(value, fallback = 'USD') {
  return safeString(value, fallback).toUpperCase();
}

function toMoneyNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : NaN;
}

function convertUsdToTtd(usdAmount) {
  return safeMoney(Number(usdAmount) * getUsdToTtdRate());
}

function convertTtdToUsd(ttdAmount) {
  return safeMoney(Number(ttdAmount) / getUsdToTtdRate());
}

function getPayPalCheckoutAmounts(body = {}) {
  assertPayPalCurrency();
  const shopifyTotal = assertCheckoutTotalMatches(body);

  if (!isValidPositiveMoney(shopifyTotal)) {
    const error = new Error(
      SHOPIFY_CURRENCY === 'USD'
        ? 'Invalid Shopify checkout total. Minimum is 1.00 USD.'
        : 'Invalid Shopify checkout total. Minimum is 1.00 TTD.'
    );
    error.statusCode = 400;
    throw error;
  }

  if (SHOPIFY_CURRENCY === 'USD') {
    return {
      shopifyTotal,
      shopifyTotalUsd: shopifyTotal,
      shopifyTotalTtd: shopifyTotal,
      paypalTotalUsd: shopifyTotal,
      paypalCurrency: PAYPAL_CURRENCY,
      shopifyCurrency: SHOPIFY_CURRENCY,
      exchangeRate: getUsdToTtdRate(),
    };
  }

  const paypalTotalUsd = convertTtdToUsd(shopifyTotal);
  if (!isValidPositiveMoney(paypalTotalUsd)) {
    const error = new Error('Invalid PayPal USD total after conversion.');
    error.statusCode = 400;
    throw error;
  }

  return {
    shopifyTotal,
    shopifyTotalUsd: paypalTotalUsd,
    shopifyTotalTtd: shopifyTotal,
    paypalTotalUsd,
    paypalCurrency: PAYPAL_CURRENCY,
    shopifyCurrency: SHOPIFY_CURRENCY,
    exchangeRate: getUsdToTtdRate(),
  };
}

function getPayPalCheckoutAmountsFromTtd(body = {}) {
  return getPayPalCheckoutAmounts(body);
}

function getPayPalAmounts(body = {}) {
  const rawCurrency = safeString(body.currency || body.paypalCurrency);
  if (!rawCurrency) {
    const error = new Error('PayPal currency is required and must be USD.');
    error.statusCode = 400;
    throw error;
  }

  const requestedCurrency = normalizeCurrency(rawCurrency, PAYPAL_CURRENCY);

  if (requestedCurrency !== PAYPAL_CURRENCY) {
    const error = new Error(
      `PayPal checkout accepts ${PAYPAL_CURRENCY} only. Send PayPal totals in USD and store/display converted TTD separately.`
    );
    error.statusCode = 400;
    throw error;
  }

  const usdTotal = safeMoney(body.paypalTotalUsd || body.totalUsd || getRequestTotal(body));
  if (!isValidPositiveMoney(usdTotal)) {
    const error = new Error('Invalid PayPal USD total. Minimum is 1.00 USD.');
    error.statusCode = 400;
    throw error;
  }

  return {
    paypalTotalUsd: usdTotal,
    shopifyTotalTtd: usdTotal,
    paypalCurrency: PAYPAL_CURRENCY,
    shopifyCurrency: SHOPIFY_CURRENCY,
    exchangeRate: null,
  };
}

function getWiPayReturnAmount(query = {}) {
  return safeString(
    query.total ||
      query.amount ||
      query.value ||
      query.transaction_total ||
      query.total_amount
  );
}

function getWiPayReturnHash(query = {}) {
  return safeString(
    query.hash ||
      query.signature ||
      query.response_hash ||
      query.transaction_hash ||
      query.responseHash ||
      query.transactionHash
  ).toLowerCase();
}

function getSafeWiPayReturnLog(query = {}) {
  const safeKeys = [
    'order_id',
    'orderId',
    'transaction_id',
    'transactionId',
    'transaction_ref',
    'status',
    'response',
    'payment_status',
    'transaction_status',
    'total',
    'amount',
    'currency',
    'currency_code',
    'hash',
    'signature',
  ];

  return safeKeys.reduce((acc, key) => {
    if (query[key] !== undefined) {
      const value = String(query[key]);
      acc[key] =
        key === 'hash' || key === 'signature'
          ? `${value.slice(0, 8)}...${value.slice(-4)}`
          : value;
    }

    return acc;
  }, {});
}

function verifyWiPayReturn({ query, pending }) {
  const rawStatus = getReturnStatus(query);
  const transactionId = getReturnTransactionId(query);
  const returnedOrderId = getReturnOrderId(query);
  const expectedAmount = safeMoney(pending?.total || pending?.amount);
  const returnedAmount = getWiPayReturnAmount(query);
  const returnedCurrency = normalizeCurrency(query.currency || query.currency_code, 'TTD');
  const returnedHash = getWiPayReturnHash(query);
  const successStatuses = new Set(['success', 'approved', 'paid', '1', 'successful', 'complete', 'completed']);
  const safeLog = getSafeWiPayReturnLog(query);

  console.log('[NOOD order] WiPay return received', safeLog);

  if (!successStatuses.has(rawStatus)) {
    console.warn('[NOOD order] WiPay payment not successful', {
      status: rawStatus,
      transactionId,
    });

    return {
      ok: false,
      reason: `wipay_${rawStatus || 'not_paid'}`,
      transactionId,
    };
  }

  if (!transactionId) {
    console.warn('[NOOD order] WiPay verification missing transaction id', safeLog);

    return {
      ok: false,
      reason: 'missing_wipay_transaction_id',
      transactionId,
    };
  }

  if (returnedOrderId && returnedOrderId !== pending?.orderId) {
    console.error('[NOOD order] WiPay verification order mismatch', {
      returnedOrderId,
      expectedOrderId: pending?.orderId,
      transactionId,
    });

    return {
      ok: false,
      reason: 'wipay_order_id_mismatch',
      transactionId,
    };
  }

  if (returnedAmount && toMoneyNumber(returnedAmount) !== toMoneyNumber(expectedAmount)) {
    console.error('[NOOD order] WiPay verification amount mismatch', {
      returnedAmount,
      expectedAmount,
      transactionId,
    });

    return {
      ok: false,
      reason: 'wipay_amount_mismatch',
      transactionId,
    };
  }

  if (returnedCurrency && returnedCurrency !== 'TTD') {
    console.error('[NOOD order] WiPay verification currency mismatch', {
      returnedCurrency,
      expectedCurrency: 'TTD',
      transactionId,
    });

    return {
      ok: false,
      reason: 'wipay_currency_mismatch',
      transactionId,
    };
  }

  if (!WIPAY_API_KEY) {
    console.warn('[NOOD order] WiPay verification needs review: missing WIPAY_API_KEY', {
      transactionId,
    });

    return {
      ok: false,
      reason: 'missing_wipay_api_key',
      needsReview: true,
      transactionId,
    };
  }

  if (!returnedHash) {
    const isSandboxWebViewSuccessFallback =
      WIPAY_ENVIRONMENT === 'sandbox' && safeString(query.nood_webview_success) === '1';

    console.warn('[NOOD order] WiPay verification needs review: missing hash/signature', {
      transactionId,
      environment: WIPAY_ENVIRONMENT,
      sandboxWebViewSuccessFallback: isSandboxWebViewSuccessFallback,
    });

    return {
      ok: isSandboxWebViewSuccessFallback,
      reason: 'missing_wipay_hash',
      needsReview: !isSandboxWebViewSuccessFallback,
      transactionId,
      amount: expectedAmount,
      currency: 'TTD',
      status: rawStatus,
    };
  }

  const expectedHash = crypto
    .createHash('md5')
    .update(`${transactionId}${expectedAmount}${WIPAY_API_KEY}`)
    .digest('hex');

  if (expectedHash !== returnedHash) {
    console.error('[NOOD order] WiPay verification hash mismatch', {
      transactionId,
      receivedHashPreview: `${returnedHash.slice(0, 8)}...${returnedHash.slice(-4)}`,
    });

    return {
      ok: false,
      reason: 'wipay_hash_mismatch',
      transactionId,
    };
  }

  console.log('[WIPAY SUCCESS]', {
    transactionId,
    amount: expectedAmount,
    currency: 'TTD',
    status: rawStatus,
    orderId: returnedOrderId || pending?.orderId || null,
  });

  return {
    ok: true,
    transactionId,
    amount: expectedAmount,
    currency: 'TTD',
    status: rawStatus,
  };
}

function saveWalletTransaction({ provider, transactionId, pending, rawReturn }) {
  const customerId = safeString(pending?.customerId || pending?.email || pending?.phone, 'guest');
  const walletTransactionId = `${provider}_${transactionId}`;
  const amount = safeMoney(pending?.amount);
  const existing = walletTransactions.get(walletTransactionId);

  if (existing) {
    return existing;
  }

  const record = {
    walletTransactionId,
    provider,
    transactionId,
    orderId: pending?.orderId,
    customerId,
    customer: {
      name: pending?.name || '',
      email: pending?.email || '',
      phone: pending?.phone || '',
    },
    amount,
    currency: pending?.currency || 'TTD',
    status: 'confirmed',
    rawReturn: rawReturn || null,
    trustedCartSnapshot: pending?.trustedCartSnapshot || null,
    createdAt: new Date().toISOString(),
  };

  walletTransactions.set(walletTransactionId, record);
  persistWalletTransactions();
  return record;
}

function getConfirmedWalletBalance(customerId) {
  const normalizedCustomerId = safeString(customerId);
  if (!normalizedCustomerId) return '0.00';

  const balance = Array.from(walletTransactions.values()).reduce((sum, tx) => {
    if (tx?.status !== 'confirmed') return sum;
    if (safeString(tx.customerId) !== normalizedCustomerId) return sum;
    return sum + Number(tx.amount || 0);
  }, 0);

  return safeMoney(balance);
}

async function getConfirmedWalletBalanceUsd(customerId) {
  if (redisWallet) {
    return centsToUsd(await redisWallet.getBalanceCents(customerId));
  }

  return getConfirmedWalletBalance(customerId);
}

function findWalletTransactionByProviderOrderId(provider, orderId) {
  return Array.from(walletTransactions.values()).find(
    (tx) => tx?.provider === provider && safeString(tx?.orderId) === safeString(orderId)
  );
}

async function debitWalletForCheckout({ customerId, amount, checkoutSessionId, transactionId }) {
  const normalizedCustomerId = safeString(customerId);
  const walletTransactionId = `wallet_checkout_${safeString(checkoutSessionId, transactionId)}`;

  if (redisWallet) {
    const amountCents = usdToCents(amount);
    requirePositiveCents(amountCents, 'wallet checkout amount');
    return redisWallet.debit({
      customerId: normalizedCustomerId,
      amountCents,
      idempotencyKey: walletTransactionId,
      source: 'wallet_checkout',
      metadata: {
        checkoutSessionId: safeString(checkoutSessionId),
      },
    });
  }

  const existing = walletTransactions.get(walletTransactionId);

  if (existing) {
    if (existing.status === 'rolled_back') {
      const error = new Error(
        'Previous wallet checkout attempt was rolled back. Start a new checkout session.'
      );
      error.statusCode = 409;
      throw error;
    }

    return existing;
  }

  const balance = Number(getConfirmedWalletBalance(normalizedCustomerId));
  const debitAmount = Number(safeMoney(amount));

  if (!Number.isFinite(debitAmount) || debitAmount <= 0) {
    const error = new Error('Invalid wallet debit amount.');
    error.statusCode = 400;
    throw error;
  }

  if (balance < debitAmount) {
    const error = new Error('Insufficient wallet balance.');
    error.statusCode = 400;
    throw error;
  }

  const record = {
    walletTransactionId,
    provider: 'wallet',
    transactionId: safeString(transactionId, walletTransactionId),
    orderId: safeString(checkoutSessionId),
    customerId: normalizedCustomerId,
    amount: safeMoney(-debitAmount),
    currency: SHOPIFY_CURRENCY,
    status: 'confirmed',
    type: 'checkout_debit',
    createdAt: new Date().toISOString(),
  };

  walletTransactions.set(walletTransactionId, record);
  persistWalletTransactions();
  return record;
}

async function rollbackWalletDebit(walletTransactionId, { customerId = '', amount = '' } = {}) {
  if (redisWallet && customerId && amount) {
    const amountCents = usdToCents(amount);
    requirePositiveCents(amountCents, 'wallet rollback amount');
    return redisWallet.credit({
      customerId,
      amountCents,
      idempotencyKey: `${walletTransactionId}:rollback`,
      source: 'wallet_checkout_rollback',
      metadata: {
        relatedTransactionId: walletTransactionId,
      },
    });
  }

  const record = walletTransactions.get(walletTransactionId);
  if (!record || record.status === 'rolled_back') {
    return;
  }

  const rollbackId = `${walletTransactionId}_rollback`;
  if (!walletTransactions.has(rollbackId)) {
    walletTransactions.set(rollbackId, {
      walletTransactionId: rollbackId,
      provider: 'wallet',
      transactionId: record.transactionId,
      orderId: record.orderId,
      customerId: record.customerId,
      amount: safeMoney(Math.abs(Number(record.amount))),
      currency: record.currency || SHOPIFY_CURRENCY,
      status: 'confirmed',
      type: 'checkout_rollback',
      relatedTransactionId: walletTransactionId,
      createdAt: new Date().toISOString(),
    });
  }

  walletTransactions.set(walletTransactionId, {
    ...record,
    status: 'rolled_back',
  });
  persistWalletTransactions();
}

async function handleWalletCheckout(req, res) {
  try {
    const authenticatedCustomer = req.customer || {};
    const checkoutSessionId = resolveCheckoutSessionId(req.body);
    const trustedSnapshot = await priceCart({
      cache: await getCatalogCache(),
      body: req.body,
      customerId: authenticatedCustomer.id,
    });
    const cartItems = snapshotToCartItems(trustedSnapshot);
    const total = trustedSnapshot.total;
    const shippingAddress = req.body?.shippingAddress || {};
    const customerName = safeString(
      req.body?.name || shippingAddress?.fullName || shippingAddress?.name
    );
    const customerEmail = safeString(authenticatedCustomer.email || req.body?.email || shippingAddress?.email);
    const customerPhone = safeString(authenticatedCustomer.phone || req.body?.phone || shippingAddress?.phone, '');
    const customerId = safeString(authenticatedCustomer.id);

    assertUsdCurrency(SHOPIFY_CURRENCY, 'Shopify currency');

    const validationErrors = validateCheckoutData({
      total,
      cartItems,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      shippingAddress,
      requireEmail: true,
    });

    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: true,
        message: validationErrors[0],
        validationErrors,
      });
    }

    if (checkoutSessionId) {
      const existingPayment = findWalletCheckoutPaymentRecord(checkoutSessionId);
      if (existingPayment?.status === 'shopify_created' && existingPayment.shopifyOrder) {
        return res.json({
          success: true,
          idempotent: true,
          transaction_id: existingPayment.transactionId,
          shopify_order_id: existingPayment.shopifyOrder?.id || '',
          shopify_order_name: existingPayment.shopifyOrder?.name || '',
          wallet_balance: await getConfirmedWalletBalanceUsd(customerId),
          shopifyOrder: existingPayment.shopifyOrder,
        });
      }
    }

    const walletDebitId = `wallet_${safeString(checkoutSessionId, Date.now())}`;
    let debitRecord = null;

    try {
      debitRecord = await debitWalletForCheckout({
        customerId,
        amount: total,
        checkoutSessionId,
        transactionId: walletDebitId,
      });

      const shopifyOrder = await createShopifyOrder({
        email: customerEmail,
        phone: customerPhone,
        name: customerName,
        total,
        cartItems,
        shippingAddress,
        paymentTransactionId: walletDebitId,
        paymentMethod: safeString(req.body?.paymentMethod, 'NOOD Wallet'),
        clientOrderId: checkoutSessionId || walletDebitId,
        currency: SHOPIFY_CURRENCY,
        paymentCurrency: SHOPIFY_CURRENCY,
        paymentAmount: total,
        pending: { currency: trustedSnapshot.currency, cartItems, trustedCartSnapshot: trustedSnapshot },
      });

      savePaymentRecord({
        provider: 'wallet',
        transactionId: walletDebitId,
        orderId: checkoutSessionId || walletDebitId,
        clientOrderId: checkoutSessionId || walletDebitId,
        status: 'shopify_created',
        shopifyOrder,
        amount: total,
        currency: trustedSnapshot.currency,
        trustedCartSnapshot: trustedSnapshot,
      });

      return res.json({
        success: true,
        transaction_id: walletDebitId,
        shopify_order_id: shopifyOrder?.id || '',
        shopify_order_name: shopifyOrder?.name || '',
        wallet_balance: await getConfirmedWalletBalanceUsd(customerId),
        shopifyOrder,
      });
    } catch (shopifyError) {
      if (debitRecord?.walletTransactionId) {
        await rollbackWalletDebit(debitRecord.walletTransactionId, {
          customerId,
          amount: total,
        });
      }

      const shopifyErrorDetails = getShopifyErrorDetails(shopifyError);
      console.error('[NOOD wallet] checkout failed; wallet debit rolled back', shopifyErrorDetails);

      return res.status(shopifyError.statusCode || shopifyError.response?.status || 500).json({
        success: false,
        error: true,
        message: shopifyError.message || 'Shopify order create failed. Wallet was not charged.',
        shopifyError: shopifyErrorDetails,
      });
    }
  } catch (error) {
    console.error('[NOOD wallet] checkout error:', error.message || error);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: true,
      message: error.message || 'Wallet checkout failed.',
    });
  }
}

function validateWalletCustomer({ name, email, phone, customerId }) {
  const normalizedCustomerId = safeString(customerId || email || phone);
  const errors = [];

  if (!safeString(name)) errors.push('Customer name is required.');
  if (!safeString(phone)) errors.push('Customer phone is required.');
  if (!normalizedCustomerId) errors.push('Customer ID is required.');

  return {
    errors,
    customerId: normalizedCustomerId,
  };
}

async function createPayPalWalletTopup(req, res) {
  try {
    if (!hasPayPalCredentials()) {
      return res.status(500).json({
        error: true,
        message: 'Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in backend .env',
      });
    }

    const authenticatedCustomer = req.customer || {};
    const amount = req.body?.amount;
    const name = safeString(
      req.body?.name ||
        `${safeString(authenticatedCustomer.firstName)} ${safeString(authenticatedCustomer.lastName)}`.trim(),
      'NOOD Customer'
    );
    const email = safeString(authenticatedCustomer.email || req.body?.email);
    const phone = safeString(authenticatedCustomer.phone || req.body?.phone);
    const customerId = safeString(authenticatedCustomer.id);
    const payPalAmounts = getPayPalAmounts({
      ...req.body,
      total: amount || req.body?.total,
      currency: 'USD',
    });
    const walletAmountTtd = payPalAmounts.shopifyTotalTtd;
    const walletAmountCents = usdToCents(walletAmountTtd);
    requirePositiveCents(walletAmountCents, 'PayPal wallet top-up amount');

    if (!isValidPositiveMoney(walletAmountTtd)) {
      return res.status(400).json({
        error: true,
        message: 'Invalid wallet top-up amount.',
      });
    }

    if (walletAmountCents < PAYPAL_WALLET_MIN_CENTS || walletAmountCents > PAYPAL_WALLET_MAX_CENTS) {
      return res.status(400).json({
        error: true,
        message: 'PayPal wallet top-up amount is outside the allowed range.',
      });
    }

    const walletCustomer = validateWalletCustomer({ name, email, phone, customerId });

    if (walletCustomer.errors.length) {
      return res.status(400).json({
        success: false,
        error: true,
        message: walletCustomer.errors[0],
        validationErrors: walletCustomer.errors,
      });
    }

    const operationKey = getRequestIdempotencyKey(
      req,
      `paypal:wallet:${walletCustomer.customerId}:${walletAmountCents}`
    );
    const localOrderId = `wallet_paypal_${Date.now()}`;
    const paymentCreate = await paypalPaymentService.createOrder({
      purpose: 'wallet_topup',
      customerId: walletCustomer.customerId,
      expectedAmountCents: usdToCents(payPalAmounts.paypalTotalUsd),
      expectedCurrency: payPalAmounts.paypalCurrency,
      trustedSnapshot: {
        walletAmountCents,
        walletCurrency: payPalAmounts.shopifyCurrency,
      },
      idempotencyKey: `paypal:wallet:create:${operationKey}`,
      referenceId: localOrderId,
      description: 'NOOD wallet top-up',
    });
    const paypalOrder = paymentCreate.order;
    const approvalUrl = getPayPalApprovalUrl(paypalOrder);

    setPendingOrder(paypalOrder.id, {
      type: 'wallet_topup',
      provider: 'paypal',
      orderId: paypalOrder.id,
      clientOrderId: localOrderId,
      paypalOrderId: paypalOrder.id,
      amount: walletAmountTtd,
      amountCents: walletAmountCents,
      currency: payPalAmounts.shopifyCurrency,
      paypalTotalUsd: payPalAmounts.paypalTotalUsd,
      paypalCurrency: payPalAmounts.paypalCurrency,
      exchangeRate: payPalAmounts.exchangeRate,
      customerId: walletCustomer.customerId,
      name: safeString(name),
      email: safeString(email),
      phone: safeString(phone),
      createdAt: Date.now(),
    });

    return res.status(201).json({
      success: true,
      id: paypalOrder.id,
      order_id: paypalOrder.id,
      status: paypalOrder.status,
      approval_url: approvalUrl,
      links: paypalOrder.links || [],
      amount: walletAmountTtd,
      currency: payPalAmounts.shopifyCurrency,
      paypal_amount: payPalAmounts.paypalTotalUsd,
      paypal_currency: payPalAmounts.paypalCurrency,
      paypal: paypalOrder,
      payment: paymentState.publicPayment(paymentCreate.record),
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('PAYPAL WALLET TOPUP CREATE ERROR:', errorData);

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || errorData?.details?.[0]?.description || 'PayPal wallet top-up create failed',
      raw: error.response?.data || null,
    });
  }
}

async function capturePayPalWalletTopup(req, res) {
  const paypalOrderId = safeString(req.params.orderID || req.params.paypalOrderId);

  try {
    if (!hasPayPalCredentials()) {
      return res.status(500).json({
        error: true,
        message: 'Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in backend .env',
      });
    }

    if (!paypalOrderId) {
      return res.status(400).json({
        success: false,
        error: true,
        message: 'Missing PayPal wallet order ID.',
      });
    }

    const pending = pendingOrders.get(paypalOrderId);
    const existingWalletRecord = findWalletTransactionByProviderOrderId('paypal', paypalOrderId);

    if (existingWalletRecord) {
      return res.json({
        success: true,
        idempotent: true,
        status: existingWalletRecord.status,
        transaction_id: existingWalletRecord.transactionId,
        paypal_order_id: paypalOrderId,
        wallet_transaction_id: existingWalletRecord.walletTransactionId,
        amount: existingWalletRecord.amount,
        currency: existingWalletRecord.currency,
        confirmed_balance: getConfirmedWalletBalance(existingWalletRecord.customerId),
        wallet: existingWalletRecord,
      });
    }

    if (!pending || pending.type !== 'wallet_topup' || pending.provider !== 'paypal') {
      return res.status(404).json({
        success: false,
        error: true,
        message: 'PayPal wallet top-up session was not found.',
      });
    }

    if (safeString(req.customer?.id) && safeString(pending.customerId) !== safeString(req.customer.id)) {
      return res.status(403).json({
        success: false,
        error: true,
        message: 'Authenticated customer does not own this wallet top-up.',
      });
    }

    const result = await paypalPaymentService.captureOrder({
      paypalOrderId,
      customerId: pending.customerId,
      purpose: 'wallet_topup',
      onWalletTopupPaid: async ({ captureData, captureId }) =>
        redisWallet
          ? redisWallet.credit({
              customerId: pending.customerId,
              amountCents: pending.amountCents || usdToCents(pending.amount),
              idempotencyKey: `paypal_wallet:${captureId}`,
              source: 'paypal_wallet_topup',
              providerTransactionId: captureId,
              metadata: {
                paypalOrderId,
              },
            })
          : saveWalletTransaction({
              provider: 'paypal',
              transactionId: captureId,
              pending,
              rawReturn: captureData,
            }),
    });

    if (result.recoveryRequired) {
      return res.status(202).json({
        success: false,
        payment_received: true,
        status: 'payment_received_wallet_review',
        message: 'Payment was received but the wallet credit needs review.',
        transaction_id: result.captureId,
        paypal_order_id: paypalOrderId,
        payment: paymentState.publicPayment(result.record),
      });
    }

    const captureId = result.captureId;
    const walletRecord =
      result.walletResult ||
      (result.record?.walletTransactionId
        ? walletTransactions.get(result.record.walletTransactionId)
        : null) ||
      findWalletTransactionByProviderOrderId('paypal', paypalOrderId);
    const walletTransactionId = walletRecord?.walletTransactionId || result.record?.walletTransactionId || '';
    const walletAmount = walletRecord?.amount || pending.amount;
    const walletCurrency = walletRecord?.currency || pending.currency;
    const confirmedBalance = await getConfirmedWalletBalanceUsd(walletRecord?.customerId || pending.customerId);

    savePaymentRecord({
      provider: 'paypal_wallet',
      transactionId: captureId,
      orderId: paypalOrderId,
      status: 'wallet_credited',
      amount: walletAmount,
      currency: walletCurrency,
      paypalOrderId,
      walletTransactionId,
      rawPayment: result.captureData || null,
    });

    removePendingOrder(paypalOrderId);

    return res.json({
      success: true,
      status: result.captureData?.status || 'COMPLETED',
      transaction_id: captureId,
      paypal_order_id: paypalOrderId,
      wallet_transaction_id: walletTransactionId,
      amount: walletAmount,
      currency: walletCurrency,
      confirmed_balance: confirmedBalance,
      wallet: walletRecord || null,
      paypal: result.captureData,
      payment: paymentState.publicPayment(result.record),
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('PAYPAL WALLET TOPUP CAPTURE ERROR:', errorData);

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || errorData?.details?.[0]?.description || 'PayPal wallet top-up capture failed',
      raw: error.response?.data || null,
    });
  }
}

function saveFailedPaidOrder({
  provider,
  orderId,
  transactionId,
  pending,
  shopifyError,
  rawReturn,
}) {
  const recoveryId = `${provider || 'payment'}_${orderId || Date.now()}_${Date.now()}`;
  const record = {
    recoveryId,
    provider,
    paymentMethod: provider,
    status: 'payment_received_order_review',
    orderId,
    backendOrderId: orderId,
    transactionId,
    paypalCaptureId: provider === 'paypal' ? transactionId : '',
    wipayTransactionId: provider === 'wipay' ? transactionId : '',
    cartItems: pending?.cartItems || [],
    shopifyVariantIds: (pending?.cartItems || [])
      .map((item) => safeString(item?.variantId))
      .filter(Boolean),
    customer: {
      name: pending?.name || '',
      email: pending?.email || '',
      phone: pending?.phone || '',
    },
    shippingAddress: pending?.shippingAddress || null,
    amount: pending?.total || '',
    currency: pending?.currency || 'TTD',
    shopifyError: getShopifyErrorDetails(shopifyError),
    rawReturn: rawReturn || null,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    lastRetryAt: null,
    shopifyOrder: null,
  };

  failedPaidOrders.set(recoveryId, record);
  persistFailedPaidOrders();
  console.error('[NOOD recovery] saved paid payment requiring Shopify order recovery', record);
  return record;
}


function findFailedPaidOrderByPayment(provider, transactionId) {
  const normalizedProvider = safeString(provider).toLowerCase();
  const normalizedTransactionId = safeString(transactionId);

  if (!normalizedProvider || !normalizedTransactionId) return null;

  return Array.from(failedPaidOrders.values()).find((record) => {
    return (
      safeString(record?.provider).toLowerCase() === normalizedProvider &&
      safeString(record?.transactionId) === normalizedTransactionId
    );
  }) || null;
}
async function createShopifyOrderFromPaidPayment(paymentData) {
  const {
    method,
    transactionId,
    orderId,
    pending,
    rawReturn,
  } = paymentData;
  const normalizedMethod = safeString(method, 'payment').toLowerCase();

  console.log('[NOOD order] payment success received');
  console.log(`[NOOD order] method=${normalizedMethod}`);
  console.log('[NOOD order] cart items', pending?.cartItems || []);

  const existingRecord = getPaymentRecord(normalizedMethod, transactionId);
  if (existingRecord?.status === 'shopify_created' && existingRecord.shopifyOrder) {
    console.log('[NOOD order] idempotent payment replay; returning existing Shopify order', {
      paymentKey: existingRecord.paymentKey,
      shopifyOrder: existingRecord.shopifyOrder,
    });

    return {
      success: true,
      shopifyOrder: existingRecord.shopifyOrder,
      recovery: null,
      idempotent: true,
    };
  }

  if (existingRecord?.status === 'payment_received_order_review') {
    console.log('[NOOD order] idempotent paid recovery replay', {
      paymentKey: existingRecord.paymentKey,
      recoveryId: existingRecord.recoveryId,
    });

    return {
      success: false,
      shopifyOrder: null,
      recovery: failedPaidOrders.get(existingRecord.recoveryId) || null,
      shopifyError: existingRecord.shopifyError || null,
      idempotent: true,
    };
  }

  try {
    const trustedSnapshot = pending?.trustedCartSnapshot || null;
    if (trustedSnapshot) {
      await revalidateSnapshot({
        cache: await getCatalogCache(),
        snapshot: trustedSnapshot,
      });
    }
    const trustedCartItems = trustedSnapshot ? snapshotToCartItems(trustedSnapshot) : pending.cartItems;
    const trustedTotal = trustedSnapshot ? trustedSnapshot.total : pending.total;
    const trustedCurrency = trustedSnapshot ? trustedSnapshot.currency : null;

    console.log('[ORDER CREATE START]', {
      method: normalizedMethod,
      orderId,
      transactionId,
      lineItemCount: Array.isArray(trustedCartItems) ? trustedCartItems.length : 0,
      total: trustedTotal || pending?.amount || null,
      tokenSource: shopifyOrderAccessState.tokenSource,
    });

    const paymentCurrency = resolveShopifyOrderCurrency({
      pending: trustedSnapshot ? { ...pending, currency: trustedCurrency } : pending,
      cartItems: trustedCartItems,
    });
    const paymentAmount = safeMoney(trustedTotal || pending?.amount);

    const shopifyOrder = await createShopifyOrder({
      email: pending.email,
      phone: pending.phone,
      name: pending.name,
      total: trustedTotal,
      cartItems: trustedCartItems,
      shippingAddress: pending.shippingAddress,
      paymentTransactionId: transactionId,
      paymentMethod: normalizedMethod === 'paypal' ? 'PayPal' : 'WiPay',
      clientOrderId: pending?.clientOrderId || pending?.localOrderId || orderId,
      currency: paymentCurrency,
      paymentCurrency,
      paymentAmount,
      pending: trustedSnapshot ? { ...pending, cartItems: trustedCartItems, total: trustedTotal, currency: trustedCurrency } : pending,
    });

    console.log('[ORDER CREATE SUCCESS]', {
      method: normalizedMethod,
      orderId,
      transactionId,
      shopify_order_id: shopifyOrder?.id || null,
      shopify_order_name: shopifyOrder?.name || null,
    });

    savePaymentRecord({
      provider: normalizedMethod,
      transactionId,
      orderId,
      status: 'shopify_created',
      shopifyOrder,
      amount: trustedTotal || pending?.amount || '',
      currency: trustedCurrency || pending?.currency || SHOPIFY_CURRENCY,
      trustedCartSnapshot: trustedSnapshot || undefined,
      paypalOrderId: pending?.paypalOrderId || '',
      rawPayment: rawReturn || null,
    });

    return {
      success: true,
      shopifyOrder,
      recovery: null,
    };
  } catch (shopifyError) {
    const shopifyErrorDetails = getShopifyErrorDetails(shopifyError);
    console.error('[ORDER CREATE FAILED]', {
      method: normalizedMethod,
      orderId,
      transactionId,
      tokenSource: shopifyOrderAccessState.tokenSource,
      scopes: shopifyOrderAccessState.scopes,
      missingOrderScopes: shopifyOrderAccessState.missingOrderScopes,
      shopifyError: shopifyErrorDetails,
    });

    const recovery = saveFailedPaidOrder({
      provider: normalizedMethod,
      orderId,
      transactionId,
      pending,
      shopifyError,
      rawReturn,
    });

    savePaymentRecord({
      provider: normalizedMethod,
      transactionId,
      orderId,
      status: 'payment_received_order_review',
      recoveryId: recovery.recoveryId,
      amount: trustedTotal || pending?.amount || '',
      currency: trustedCurrency || pending?.currency || SHOPIFY_CURRENCY,
      trustedCartSnapshot: trustedSnapshot || undefined,
      shopifyError: shopifyErrorDetails,
      rawPayment: rawReturn || null,
    });

    return {
      success: false,
      shopifyOrder: null,
      recovery,
      shopifyError: shopifyErrorDetails,
    };
  }
}

function setPendingOrder(orderId, data) {
  pendingOrders.set(orderId, data);
  persistPendingOrders();
}

function removePendingOrder(orderId) {
  if (!pendingOrders.has(orderId)) {
    return;
  }

  pendingOrders.delete(orderId);
  persistPendingOrders();
}

function getReturnToken(query) {
  return String(query.return_token || query.token || '').trim();
}

function cleanupOldPendingOrders() {
  const now = Date.now();
  const ttlMs = 1000 * 60 * 60 * 6;
  let changed = false;

  for (const [key, value] of pendingOrders.entries()) {
    if (!value?.createdAt || now - value.createdAt > ttlMs) {
      pendingOrders.delete(key);
      changed = true;
    }
  }

  if (changed) {
    persistPendingOrders();
  }
}

let pendingOrdersCleanupTimer = null;

function startRecurringJobs() {
  if (pendingOrdersCleanupTimer || process.env.NOOD_DISABLE_BACKGROUND_WORKERS === 'true') {
    return;
  }
  pendingOrdersCleanupTimer = setInterval(cleanupOldPendingOrders, 1000 * 60 * 30);
}

app.get('/', (req, res) => {
  res.send(`Backend is running on ${BACKEND_BASE_URL}`);
});

app.get('/auth/callback', (req, res) => {
  const query = new URLSearchParams();

  Object.entries(req.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.append(key, String(value));
    }
  });

  const querySuffix = query.toString() ? `?${query.toString()}` : '';
  const target = `${SHOPIFY_APP_AUTH_CALLBACK_URI}${querySuffix}`;

  console.log('[AUTH CALLBACK QUERY]', req.query);
  console.log('[AUTH] /auth/callback bridge target', target);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Returning to NOOD</title>
  </head>
  <body>
    <p>Returning to NOOD...</p>
    <script>
      (function () {
        var target = ${JSON.stringify(target)};
        window.location.replace(target);
      })();
    </script>
  </body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    backend_base_url: BACKEND_BASE_URL,
    port: PORT,
    redis_configured: Boolean(safeString(process.env.REDIS_URL)),
    has_wipay_account: Boolean(WIPAY_ACCOUNT_NUMBER),
    wipay_account_suffix: WIPAY_ACCOUNT_NUMBER ? WIPAY_ACCOUNT_NUMBER.slice(-4) : null,
    wipay_environment: WIPAY_ENVIRONMENT,
    wipay_environment_source: WIPAY_ENVIRONMENT_SOURCE,
    wipay_environment_raw: WIPAY_ENVIRONMENT_RAW || null,
    has_wipay_api_key: Boolean(WIPAY_API_KEY),
    has_shopify_domain: Boolean(SHOPIFY_STORE_DOMAIN),
    has_shopify_token: Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN),
    has_shopify_order_admin_token: hasShopifyOrderAdminAccessToken(),
    shopify_order_admin_token_env: 'SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN',
    shopify_order_create_ready: shopifyOrderAccessState.ok,
    missing_order_scopes: shopifyOrderAccessState.missingOrderScopes || [],
    shopify_order_token_source: shopifyOrderAccessState.tokenSource,
    shopify_order_token_fingerprint: shopifyOrderAccessState.tokenFingerprint || null,
    shopify_order_access_scopes: shopifyOrderAccessState.scopes,
    shopify_order_access_message: shopifyOrderAccessState.message,
    storage_driver: storage.storageDriver || 'json',
    payment_storage_driver: storage.paymentStorageDriver || 'json',
    payment_storage_redis_ready: Boolean(storage.paymentStorageRedisReady),
    failed_paid_orders_driver: storage.failedPaidOrdersDriver || 'json',
    payment_records_driver: storage.paymentRecordsDriver || 'json',
  });
});

app.get('/api/discounts', createDiscountsHandler());
app.get('/discounts', createDiscountsHandler());
app.get('/shopify/discounts', createDiscountsHandler());

app.use('/api/notifications', notificationsRouter);
console.log('[NOTIFICATIONS] routes mounted at /api/notifications');

app.get('/ready', async (req, res) => {
  try {
    const readiness = await getBackendReadiness();
    const statusCode = readiness.ready ? 200 : 503;

    return res.status(statusCode).json({
      status: readiness.ready ? 'ready' : 'not_ready',
      ...readiness,
    });
  } catch (error) {
    return res.status(503).json({
      status: 'not_ready',
      message: error.message || 'Readiness check failed.',
    });
  }
});

async function getBackendReadiness() {
  const checks = [];

  function addCheck(name, ok, detail = {}) {
    checks.push({ name, ok: Boolean(ok), ...detail });
  }

  addCheck('currency_usd', SHOPIFY_CURRENCY === 'USD' && WALLET_CURRENCY === 'USD' && PAYMENT_CURRENCY === 'USD', {
    shopifyCurrency: SHOPIFY_CURRENCY,
    walletCurrency: WALLET_CURRENCY,
    paymentCurrency: PAYMENT_CURRENCY,
  });

  addCheck('customer_auth_config', Boolean(safeString(process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN)));
  addCheck('shopify_order_access', Boolean(shopifyOrderAccessState.ok), {
    missingOrderScopes: shopifyOrderAccessState.missingOrderScopes || [],
    message: shopifyOrderAccessState.message,
  });

  if (storage.redis) {
    try {
      await storage.redis.ping();
      const probeKey = `${redisNamespace}:ready:${process.pid}`;
      await storage.redis.set(probeKey, '1', 'EX', 30);
      const probe = await storage.redis.get(probeKey);
      addCheck('redis_read_write', probe === '1');
    } catch (error) {
      addCheck('redis_read_write', false, { message: error.message });
    }
  } else {
    addCheck('redis_read_write', false, { message: 'Redis is not configured.' });
  }

  addCheck('critical_storage_redis', storage.storageDriver === 'redis' && Boolean(storage.redis));
  addCheck('wallet_atomic_support', Boolean(redisWallet));
  addCheck('payment_state_storage', Boolean(paymentState));
  try {
    const webhookReadiness = await getWebhookReadiness();
    addCheck('shopify_webhook_secret', Boolean(webhookReadiness.webhookSecretConfigured));
    addCheck('webhook_queue_storage', Boolean(webhookReadiness.redisConfigured), {
      message: webhookReadiness.redisConfigured ? 'redis_configured' : 'Redis is required for persistent webhook jobs.',
    });
    if (IS_PRODUCTION && webhookReadiness.required) {
      addCheck('webhook_worker', Boolean(webhookReadiness.worker?.running && !webhookReadiness.worker?.stale), {
        message: webhookReadiness.worker?.stale ? 'worker_heartbeat_stale' : 'worker_required',
      });
    }
  } catch (error) {
    addCheck('webhook_readiness', false, { message: error.message });
  }

  const payPalEnabled = ['1', 'true', 'yes'].includes(
    safeString(process.env.PAYPAL_ENABLED, 'true').toLowerCase()
  );
  if (payPalEnabled) {
    addCheck('paypal_config', hasPayPalCredentials() && PAYPAL_CURRENCY === 'USD');
    addCheck('paypal_payment_state', Boolean(paymentState), {
      message: paymentState ? 'persistent_payment_state_ready' : 'Redis payment state is required for PayPal.',
    });
    addCheck('paypal_payment_locking', Boolean(lockService), {
      message: lockService ? 'payment_locks_ready' : 'Redis payment locking is required for PayPal.',
    });
    addCheck('paypal_hosted_sdk_state_machine', Boolean(paymentState && lockService), {
      message: 'Hosted PayPal SDK routes require persistent payment state and locks.',
    });
    const reconciliationEnabled = ['1', 'true', 'yes'].includes(
      safeString(process.env.PAYPAL_RECONCILIATION_ENABLED, 'true').toLowerCase()
    );
    if (reconciliationEnabled) {
      addCheck('paypal_reconciliation_adapter', typeof verifyPayPalPayment === 'function');
      addCheck('paypal_reconciliation_state', Boolean(storage.redis && reconciliationRecords), {
        message: storage.redis ? 'redis_reconciliation_state_ready' : 'Redis is required for PayPal reconciliation.',
      });
      addCheck('paypal_reconciliation_locks', Boolean(lockService), {
        message: lockService ? 'reconciliation_locks_ready' : 'Redis locks are required for reconciliation.',
      });
      addCheck('paypal_reconciliation_shopify_access', Boolean(shopifyOrderAccessState.ok), {
        message: shopifyOrderAccessState.message,
      });
      addCheck('paypal_reconciliation_service', Boolean(payPalReconciliationService));
    }
  }

  const refundsEnabled = ['1', 'true', 'yes'].includes(
    safeString(process.env.REFUNDS_ENABLED, 'true').toLowerCase()
  );
  if (refundsEnabled) {
    addCheck('refund_persistent_storage', storage.storageDriver === 'redis' && Boolean(storage.redis), {
      message: storage.redis ? 'refund_storage_redis_ready' : 'Redis refund storage is required for production refunds.',
    });
    addCheck('refund_locking', Boolean(lockService), {
      message: lockService ? 'refund_locks_ready' : 'Redis refund locks are required for money movement.',
    });
    addCheck('refund_shopify_order_lookup', hasShopifyOrderAdminAccessToken(), {
      tokenSource: getShopifyOrderTokenSource(),
      message: 'Shopify order lookup is required for refund ownership and amount verification.',
    });
    addCheck('wallet_refund_atomic_support', Boolean(redisWallet), {
      message: redisWallet ? 'wallet_refund_atomic_ready' : 'Redis wallet service is required for wallet refunds.',
    });
    const payPalRefundsEnabled = ['1', 'true', 'yes'].includes(
      safeString(process.env.PAYPAL_REFUNDS_ENABLED, 'false').toLowerCase()
    );
    if (payPalRefundsEnabled) {
      addCheck('paypal_refund_config', hasPayPalCredentials() && PAYPAL_CURRENCY === 'USD');
    }
  }

  const wiPayEnabled = ['1', 'true', 'yes'].includes(
    safeString(process.env.WIPAY_ENABLED, 'false').toLowerCase()
  );
  if (wiPayEnabled) {
    addCheck('wipay_config', Boolean(WIPAY_ACCOUNT_NUMBER && WIPAY_API_KEY && WIPAY_ENVIRONMENT));
    addCheck('wipay_currency_mode', safeString(process.env.WIPAY_TRANSACTION_CURRENCY).toUpperCase() === 'USD', {
      message: 'WiPay must be confirmed for USD before live checkout.',
    });
  }

  try {
    assertTrustedPricingSelfTest();
    addCheck('trusted_cart_pricing', true, {
      source: 'active_catalog',
      shippingMode: safeString(process.env.CHECKOUT_SHIPPING_MODE, 'fixed'),
      taxPolicy: 'no_additional_tax',
    });
  } catch (error) {
    addCheck('trusted_cart_pricing', false, { message: error.message });
  }
  addCheck('checkout_snapshot_storage', Boolean(paymentState), {
    message: paymentState ? 'payment_state_metadata_ready' : 'Payment state is required for immutable cart snapshots.',
  });

  try {
    const catalog = await getCatalogReadiness();
    addCheck('catalog', catalog.ready, catalog);
  } catch (error) {
    addCheck('catalog', false, { message: error.message });
  }

  const ready = checks.every((check) => check.ok);
  return {
    ready,
    status: ready ? 'ready' : 'not_ready',
    checks,
  };
}

app.post('/api/orders', requireCustomerAuth, async (req, res) => {
  try {
    if (!hasPayPalCredentials()) {
      return res.status(500).json({
        error: true,
        message: 'Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in backend .env',
      });
    }

    const checkoutSessionId = resolveCheckoutSessionId(req.body);
    const customer = req.customer || {};
    const catalogCache = await getCatalogCache();
    const baseSnapshot = await priceCart({
      cache: catalogCache,
      body: req.body,
      customerId: customer.id,
    });
    const total = baseSnapshot.total;
    const cartItems = snapshotToCartItems(baseSnapshot);
    const operationKey = getRequestIdempotencyKey(
      req,
      checkoutSessionId || baseSnapshot.cartFingerprint
    );

    if (checkoutSessionId) {
      const existingPending = findPendingByCheckoutSessionId(checkoutSessionId);
      if (existingPending?.pending?.paypalOrderId) {
        if (safeString(existingPending.pending.customerId) !== safeString(customer.id)) {
          return res.status(403).json({
            error: true,
            message: 'Authenticated customer does not own this checkout.',
          });
        }
        return res.status(201).json({
          id: existingPending.pending.paypalOrderId,
          status: 'CREATED',
          idempotent: true,
          links: [],
        });
      }
    }

    const orderId = safeString(
      req.body?.order_id || req.body?.reference_id || checkoutSessionId,
      `paypal_${Date.now()}`
    );
    const trustedSnapshot = {
      ...baseSnapshot,
      checkoutSessionId: checkoutSessionId || orderId,
    };
    trustedSnapshot.snapshotHash = hashSnapshot(trustedSnapshot);
    const shippingAddress = req.body?.shippingAddress || {};
    const customerName = safeString(
      req.body?.name || shippingAddress?.fullName || shippingAddress?.name,
      `${safeString(customer.firstName)} ${safeString(customer.lastName)}`.trim() || 'NOOD Customer'
    );
    const customerEmail = safeString(customer.email || req.body?.email || shippingAddress?.email);
    const customerPhone = safeString(customer.phone || req.body?.phone || shippingAddress?.phone, '');

    const validationErrors = validateCheckoutData({
      total,
      cartItems,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      shippingAddress,
      requireEmail: true,
    });

    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: true,
        message: validationErrors[0],
        validationErrors,
      });
    }

    console.log('[NOOD backend] PayPal create order request', {
      total,
      lineCount: trustedSnapshot.lines.length,
      shippingAddress,
    });

    const paymentCreate = await paypalPaymentService.createOrder({
      purpose: 'checkout',
      customerId: customer.id,
      expectedAmountCents: trustedSnapshot.totalCents,
      expectedCurrency: trustedSnapshot.currency,
      trustedSnapshot,
      idempotencyKey: `paypal:create:${operationKey}`,
      referenceId: orderId,
      description: safeString(req.body?.description, 'NOOD order'),
    });
    const order = paymentCreate.order;

    console.log('[NOOD backend] PayPal create order response', {
      id: order?.id,
      status: order?.status,
      links: order?.links?.map((link) => ({ rel: link?.rel, href: link?.href })),
    });

    setPendingOrder(order.id, {
      type: 'checkout',
      provider: 'paypal',
      orderId: order.id,
      clientOrderId: checkoutSessionId || orderId,
      localOrderId: safeString(req.body?.localOrderId || req.body?.pendingCheckoutId || checkoutSessionId || orderId),
      pendingCheckoutId: safeString(req.body?.pendingCheckoutId || req.body?.localOrderId || checkoutSessionId || orderId),
      checkoutSessionId: checkoutSessionId || orderId,
      paypalOrderId: order.id,
      customerId: customer.id,
      total,
      currency: trustedSnapshot.currency,
      paypalTotalUsd: trustedSnapshot.total,
      paypalCurrency: trustedSnapshot.currency,
      exchangeRate: 1,
      cartItems,
      trustedCartSnapshot: trustedSnapshot,
      shippingAddress,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      createdAt: Date.now(),
    });

    return res.status(201).json({
      id: order.id,
      status: order.status,
      links: order.links || [],
      paypal: order,
      trustedCart: {
        total,
        currency: trustedSnapshot.currency,
        subtotal: trustedSnapshot.subtotal,
        shipping: trustedSnapshot.shipping,
        tax: trustedSnapshot.tax,
        discounts: trustedSnapshot.discounts,
        lines: trustedSnapshot.lines,
      },
      payment: paymentState.publicPayment(paymentCreate.record),
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('PAYPAL CREATE ORDER ERROR:', errorData);

    return res.status(error.statusCode || error.response?.status || 500).json({
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || errorData?.details?.[0]?.description || 'PayPal create order failed',
      paypal: error.response?.data || null,
    });
  }
});

app.post('/api/orders/:orderID/capture', requireCustomerAuth, async (req, res) => {
  try {
    if (!hasPayPalCredentials()) {
      return res.status(500).json({
        error: true,
        message: 'Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in backend .env',
      });
    }

    const orderId = safeString(req.params.orderID);
    const customer = req.customer || {};

    if (!orderId) {
      return res.status(400).json({
        error: true,
        message: 'Missing PayPal order ID.',
      });
    }

    const pending = pendingOrders.get(orderId);
    const replayPayment = paymentState
      ? await paymentState.getByProviderTransaction('paypal', orderId)
      : null;

    if (!pending) {
      if (replayPayment && safeString(replayPayment.customerId) === safeString(customer.id)) {
        if (replayPayment.state === 'completed') {
          return res.json({
            success: true,
            idempotent: true,
            status: 'COMPLETED',
            transaction_id: replayPayment.providerTransactionId,
            shopify_order_id: replayPayment.shopifyOrderId || '',
            shopify_order_name: replayPayment.shopifyOrderName || '',
            payment: paymentState.publicPayment(replayPayment),
          });
        }
        if (replayPayment.state === 'recovery_required') {
          return res.status(202).json({
            success: false,
            idempotent: true,
            payment_received: true,
            status: 'payment_received_order_review',
            transaction_id: replayPayment.providerTransactionId || orderId,
            reason: replayPayment.lastSafeErrorCode || 'recovery_required',
            payment: paymentState.publicPayment(replayPayment),
          });
        }
      }
      return res.status(404).json({
        success: false,
        error: true,
        message: 'PayPal checkout session was not found.',
      });
    }

    if (safeString(pending.customerId) !== safeString(customer.id)) {
      return res.status(403).json({
        success: false,
        error: true,
        message: 'Authenticated customer does not own this PayPal checkout.',
      });
    }

    const result = await paypalPaymentService.captureOrder({
      paypalOrderId: orderId,
      customerId: customer.id,
      purpose: 'checkout',
      onCheckoutPaid: ({ captureData, captureId }) =>
        createShopifyOrderFromPaidPayment({
          method: 'paypal',
          transactionId: captureId,
          orderId,
          pending,
          rawReturn: captureData,
        }),
    });

    if (result.duplicate && result.record?.state === 'completed') {
      return res.json({
        success: true,
        idempotent: true,
        status: 'COMPLETED',
        transaction_id: result.record.providerTransactionId,
        shopify_order_id: result.record.shopifyOrderId || '',
        shopify_order_name: result.record.shopifyOrderName || '',
        payment: paymentState.publicPayment(result.record),
      });
    }

    if (result.recoveryRequired) {
      return res.status(202).json({
        success: false,
        payment_received: true,
        status: 'payment_received_order_review',
        message:
          'Payment Received - Order Processing Issue. Your payment was successful, but your order needs review.',
        reason: result.record?.lastSafeErrorCode || 'shopify_order_create_failed',
        transaction_id: result.captureId,
        recovery_id: result.shopifyResult?.recovery?.recoveryId || '',
        paypal: result.captureData || null,
        shopifyError: result.shopifyResult?.shopifyError || null,
        payment: paymentState.publicPayment(result.record),
      });
    }

    const shopifyOrder = result.shopifyResult?.shopifyOrder;
    removePendingOrder(orderId);

    return res.json({
      success: true,
      status: result.captureData?.status || 'COMPLETED',
      transaction_id: result.captureId,
      shopify_order_id: shopifyOrder?.id || result.record?.shopifyOrderId || '',
      shopify_order_name: shopifyOrder?.name || result.record?.shopifyOrderName || '',
      shopifyOrder,
      paypal: result.captureData,
      payment: paymentState.publicPayment(result.record),
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('PAYPAL CAPTURE ORDER ERROR:', errorData);

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || errorData?.details?.[0]?.description || 'PayPal capture order failed',
      paypal: error.response?.data || null,
    });
  }
});

app.post('/api/shopify/orders', requireAdminApiKey, async (req, res) => {
  const recoveryId = safeString(req.body?.recoveryId || req.body?.recovery_id);
  if (!recoveryId) {
    return res.status(410).json({
      success: false,
      error: true,
      message: 'Direct Shopify order creation is retired. Use a verified failed-paid-order recovery ID.',
    });
  }
  const paymentMethod = safeString(req.body?.paymentMethod, 'NOOD Wallet');
  const provider = paymentMethod.toLowerCase().includes('paypal')
    ? 'paypal'
    : paymentMethod.toLowerCase().includes('wipay')
      ? 'wipay'
      : paymentMethod.toLowerCase().replace(/\s+/g, '_') || 'wallet';
  const transactionId = safeString(
    req.body?.transactionId || req.body?.paymentTransactionId || req.body?.payment_transaction_id,
    `${provider}_${Date.now()}`
  );
  const existingPaymentRecord = getPaymentRecord(provider, transactionId);

  if (existingPaymentRecord?.status === 'shopify_created' && existingPaymentRecord.shopifyOrder) {
    console.log('[NOOD order] direct Shopify create idempotent replay', {
      provider,
      transactionId,
      shopifyOrder: existingPaymentRecord.shopifyOrder,
    });

    return res.json({
      success: true,
      idempotent: true,
      transaction_id: transactionId,
      shopify_order_id: existingPaymentRecord.shopifyOrder?.id || '',
      shopify_order_name: existingPaymentRecord.shopifyOrder?.name || '',
      shopifyOrder: existingPaymentRecord.shopifyOrder,
    });
  }

  const recoveryRecord = recoveryId
    ? failedPaidOrders.get(recoveryId)
    : findFailedPaidOrderByPayment(provider, transactionId);

  try {
    if (!recoveryRecord) {
      return res.status(404).json({
        success: false,
        error: true,
        message: 'Recovery record not found.',
      });
    }
    if (provider !== 'paypal') {
      return res.status(409).json({
        success: false,
        error: true,
        message: 'Only PayPal recovery can be reconciled automatically. WiPay remains disabled for launch.',
      });
    }
    const result = await payPalReconciliationService.reconcileRecovery({
      recoveryRecord,
      apply: true,
      actor: 'admin_shopify_order_route',
    });
    return res.status(result.status === 'recovered' || result.status === 'already_completed' ? 200 : 202).json({
      success: result.status === 'recovered' || result.status === 'already_completed',
      ...result,
    });

    let trustedSnapshot = recoveryRecord?.trustedCartSnapshot || null;
    if (trustedSnapshot) {
      verifySnapshotHash(trustedSnapshot);
    } else {
      trustedSnapshot = await priceCart({
        cache: await getCatalogCache(),
        body: req.body,
        customerId: safeString(req.body?.customerId || req.body?.customer_id || 'admin_recovery'),
      });
    }
    const total = trustedSnapshot.total;
    const cartItems = snapshotToCartItems(trustedSnapshot);

    const shippingAddress = req.body?.shippingAddress || recoveryRecord?.shippingAddress || {};
    const customerName = safeString(
      req.body?.name || recoveryRecord?.customer?.name || shippingAddress?.fullName || shippingAddress?.name
    );
    const customerEmail = safeString(req.body?.email || recoveryRecord?.customer?.email || shippingAddress?.email);
    const customerPhone = safeString(req.body?.phone || recoveryRecord?.customer?.phone || shippingAddress?.phone, '');

    const validationErrors = validateCheckoutData({
      total,
      cartItems,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      shippingAddress,
      requireEmail: true,
    });

    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: true,
        message: validationErrors[0],
        validationErrors,
      });
    }

    console.log('[NOOD order] direct/retry Shopify order create request', {
      provider,
      paymentMethod,
      transactionId,
      recoveryId: recoveryRecord?.recoveryId || recoveryId || '',
      total,
      cartItems,
      shippingAddress,
    });

    const retryCurrency = safeString(
      trustedSnapshot.currency || recoveryRecord?.currency,
      SHOPIFY_CURRENCY
    ).toUpperCase();

    const shopifyOrder = await createShopifyOrder({
      email: customerEmail,
      phone: customerPhone,
      name: customerName,
      total,
      cartItems,
      shippingAddress,
      paymentTransactionId: transactionId,
      paymentMethod,
      clientOrderId: safeString(
        req.body?.clientOrderId || req.body?.localOrderId || req.body?.pendingCheckoutId || req.body?.order_id,
        transactionId
      ),
      currency: retryCurrency,
      paymentCurrency: retryCurrency,
      paymentAmount: total,
      pending: { currency: retryCurrency, cartItems },
    });

    savePaymentRecord({
      provider,
      transactionId,
      orderId: safeString(req.body?.order_id || req.body?.localOrderId || req.body?.pendingCheckoutId, transactionId),
      status: 'shopify_created',
      shopifyOrder,
      amount: total,
      currency: trustedSnapshot.currency,
      trustedCartSnapshot: trustedSnapshot,
      recoveryId: recoveryRecord?.recoveryId || recoveryId || '',
    });

    if (recoveryRecord?.recoveryId) {
      const updatedRecovery = {
        ...recoveryRecord,
        status: 'recovered',
        retryCount: Number(recoveryRecord.retryCount || 0) + 1,
        lastRetryAt: new Date().toISOString(),
        recoveredAt: new Date().toISOString(),
        shopifyOrder,
      };
      failedPaidOrders.set(recoveryRecord.recoveryId, updatedRecovery);
      persistFailedPaidOrders();
    }

    return res.json({
      success: true,
      transaction_id: transactionId,
      shopify_order_id: shopifyOrder?.id || '',
      shopify_order_name: shopifyOrder?.name || '',
      shopifyOrder,
    });
  } catch (error) {
    const shopifyError = getShopifyErrorDetails(error);
    console.error('SHOPIFY DIRECT ORDER CREATE ERROR:', shopifyError);

    if (req.body?.retry || req.body?.paymentReceived || recoveryId) {
      const currentRecovery = recoveryRecord || {
        recoveryId: recoveryId || `${provider}_${transactionId}_${Date.now()}`,
        provider,
        paymentMethod,
        status: 'payment_received_order_review',
        orderId: safeString(req.body?.order_id || req.body?.localOrderId || req.body?.pendingCheckoutId, transactionId),
        backendOrderId: safeString(req.body?.order_id, ''),
        transactionId,
        cartItems: Array.isArray(req.body?.cartItems) ? req.body.cartItems : [],
        customer: {
          name: safeString(req.body?.name || req.body?.shippingAddress?.fullName || req.body?.shippingAddress?.name),
          email: safeString(req.body?.email || req.body?.shippingAddress?.email),
          phone: safeString(req.body?.phone || req.body?.shippingAddress?.phone),
        },
        shippingAddress: req.body?.shippingAddress || null,
        amount: getRequestTotal(req.body),
        currency: safeString(req.body?.currency, SHOPIFY_CURRENCY),
        createdAt: new Date().toISOString(),
        retryCount: 0,
        shopifyOrder: null,
      };

      const updatedRecovery = {
        ...currentRecovery,
        status: 'payment_received_order_review',
        retryCount: Number(currentRecovery.retryCount || 0) + 1,
        lastRetryAt: new Date().toISOString(),
        shopifyError,
      };

      failedPaidOrders.set(updatedRecovery.recoveryId, updatedRecovery);
      persistFailedPaidOrders();

      savePaymentRecord({
        provider,
        transactionId,
        orderId: updatedRecovery.orderId,
        status: 'payment_received_order_review',
        recoveryId: updatedRecovery.recoveryId,
        amount: updatedRecovery.amount,
        currency: updatedRecovery.currency || SHOPIFY_CURRENCY,
        shopifyError,
      });
    }

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: true,
      message: error.message || 'Shopify order create failed',
      shopifyError,
    });
  }
});
app.get('/api/customer/orders', requireCustomerAuth, async (req, res) => {
  const email = safeString(req.customer?.email).toLowerCase();
  const customerId = safeString(req.customer?.id || req.customer?.numericId);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 50);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      ok: false,
      success: false,
      message: 'A valid customer email is required.',
      orders: [],
    });
  }

  try {
    const orders = await fetchShopifyCustomerOrders({
      email,
      customerId,
      limit,
    });

    return res.json({
      ok: true,
      success: true,
      orders,
      count: orders.length,
    });
  } catch (error) {
    console.error('[NOOD orders] customer order sync failed:', error.message);
    return res.status(error.statusCode || 500).json({
      ok: false,
      success: false,
      message: error.message || 'Could not load Shopify customer orders.',
      orders: [],
    });
  }
});

app.post('/api/refunds/requests', requireCustomerAuth, returnRequestHandlers.createRequest);
app.get('/api/refunds/requests', requireCustomerAuth, returnRequestHandlers.listRequests);
app.get('/api/refunds/requests/:id/status', requireCustomerAuth, returnRequestHandlers.getRequestStatus);
app.patch('/api/refunds/requests/:id', requireAdminApiKey, returnRequestHandlers.patchRequest);
console.log('[NOOD refunds] routes registered', {
  create: 'POST /api/refunds/requests',
  list: 'GET /api/refunds/requests',
  status: 'GET /api/refunds/requests/:id/status',
  patch: 'PATCH /api/refunds/requests/:id',
});

app.get('/api/failed-paid-orders', requireAdminApiKey, (req, res) => {
  res.json({
    success: true,
    orders: Array.from(failedPaidOrders.values()),
  });
});

app.post('/api/failed-paid-orders/:recoveryId/retry', requireAdminApiKey, async (req, res) => {
  const recoveryId = safeString(req.params.recoveryId);
  const record = failedPaidOrders.get(recoveryId);

  if (!record) {
    return res.status(404).json({
      success: false,
      error: true,
      message: 'Failed paid order recovery record not found.',
    });
  }

  try {
    if (safeString(record.provider).toLowerCase() !== 'paypal') {
      return res.status(409).json({
        success: false,
        error: true,
        recoveryId,
        message: 'Only PayPal recovery can be reconciled automatically. WiPay remains disabled for launch.',
      });
    }
    const result = await payPalReconciliationService.reconcileRecovery({
      recoveryRecord: record,
      apply: true,
      actor: 'admin_failed_paid_order_retry',
    });
    return res.status(result.status === 'recovered' || result.status === 'already_completed' ? 200 : 202).json({
      success: result.status === 'recovered' || result.status === 'already_completed',
      recoveryId,
      ...result,
    });

    const trustedSnapshot = record?.trustedCartSnapshot || null;
    if (trustedSnapshot) {
      await revalidateSnapshot({
        cache: await getCatalogCache(),
        snapshot: trustedSnapshot,
      });
    }
    const recoveryCurrency = safeString(trustedSnapshot?.currency || record?.currency, SHOPIFY_CURRENCY).toUpperCase();
    const recoveryCartItems = trustedSnapshot ? snapshotToCartItems(trustedSnapshot) : record.cartItems;
    const recoveryAmount = trustedSnapshot ? trustedSnapshot.total : record.amount;

    const shopifyOrder = await createShopifyOrder({
      email: record.customer?.email,
      phone: record.customer?.phone,
      name: record.customer?.name,
      total: recoveryAmount,
      cartItems: recoveryCartItems,
      shippingAddress: record.shippingAddress,
      paymentTransactionId: record.transactionId,
      paymentMethod: record.provider === 'paypal' ? 'PayPal' : 'WiPay',
      clientOrderId: record.orderId,
      currency: recoveryCurrency,
      paymentCurrency: recoveryCurrency,
      paymentAmount: recoveryAmount,
      pending: { currency: recoveryCurrency, cartItems: recoveryCartItems, trustedCartSnapshot: trustedSnapshot },
    });

    const updated = {
      ...record,
      status: 'recovered',
      retryCount: Number(record.retryCount || 0) + 1,
      lastRetryAt: new Date().toISOString(),
      shopifyOrder,
      recoveredAt: new Date().toISOString(),
    };

    failedPaidOrders.set(recoveryId, updated);
    persistFailedPaidOrders();
    savePaymentRecord({
      provider: record.provider,
      transactionId: record.transactionId,
      orderId: record.orderId,
      status: 'shopify_created',
      shopifyOrder,
      amount: recoveryAmount,
      currency: record.currency || SHOPIFY_CURRENCY,
      trustedCartSnapshot: trustedSnapshot || undefined,
      recoveryId,
    });

    return res.json({
      success: true,
      recoveryId,
      shopify_order_id: shopifyOrder?.id || '',
      shopify_order_name: shopifyOrder?.name || '',
      shopifyOrder,
    });
  } catch (error) {
    const updated = {
      ...record,
      status: 'payment_received_order_review',
      retryCount: Number(record.retryCount || 0) + 1,
      lastRetryAt: new Date().toISOString(),
      shopifyError: getShopifyErrorDetails(error),
    };

    failedPaidOrders.set(recoveryId, updated);
    persistFailedPaidOrders();

    console.error('[NOOD recovery] retry Shopify order failed', updated.shopifyError);

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: true,
      recoveryId,
      message: 'Retry failed. Shopify still rejected the order.',
      shopifyError: updated.shopifyError,
    });
  }
});

app.post('/create-wipay-payment', requireCustomerAuth, async (req, res) => {
  try {
    const wiPayEnabled = ['1', 'true', 'yes'].includes(
      safeString(process.env.WIPAY_ENABLED, 'false').toLowerCase()
    );
    if (!wiPayEnabled) {
      return res.status(503).json({
        success: false,
        error: true,
        message: 'WiPay checkout is disabled until provider verification and USD currency support are confirmed.',
      });
    }
    const { name, email, phone, shippingAddress = {} } = req.body;
    const cartItems = getCartItemsFromBody(req.body);
    const checkoutSessionId = resolveCheckoutSessionId(req.body);

    if (!WIPAY_ACCOUNT_NUMBER) {
      return res.status(500).json({
        error: true,
        message: 'Missing WIPAY_ACCOUNT_NUMBER in .env',
      });
    }

    if (!WIPAY_API_KEY) {
      return res.status(500).json({
        error: true,
        message: 'Missing WIPAY_API_KEY in backend .env. WiPay returns cannot be verified.',
      });
    }

    const parsedTotalUsd = assertCheckoutTotalMatches(req.body);
    const wipayTotalTtd =
      SHOPIFY_CURRENCY === 'USD' ? convertUsdToTtd(parsedTotalUsd) : parsedTotalUsd;
    const customerName = safeString(name);
    const customerEmail = safeString(email);
    const customerPhone = safeString(phone);

    const validationErrors = validateCheckoutData({
      total: parsedTotalUsd,
      cartItems,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      shippingAddress,
      requireEmail: true,
    });

    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: true,
        message: validationErrors[0],
        validationErrors,
      });
    }

    if (checkoutSessionId) {
      const existingPending = findPendingByCheckoutSessionId(checkoutSessionId);
      if (existingPending?.pending?.paymentUrl) {
        const existingReturnUrl = `${BACKEND_BASE_URL}/payment-return?order_id=${encodeURIComponent(existingPending.orderId)}&return_token=${encodeURIComponent(existingPending.pending.returnToken || '')}&status=success&transaction_id=${encodeURIComponent(existingPending.pending.wipayTransactionId || '')}&nood_webview_success=1&return_json=1`;

        return res.json({
          success: true,
          idempotent: true,
          url: existingPending.pending.paymentUrl,
          payment_url: existingPending.pending.paymentUrl,
          return_url: existingReturnUrl,
          order_id: existingPending.orderId,
        });
      }
    }

    const orderId = safeString(
      req.body?.order_id || req.body?.backendOrderId || checkoutSessionId,
      `order_${Date.now()}`
    );
    const clientOrderId = safeString(checkoutSessionId || req.body?.localOrderId || req.body?.pendingCheckoutId || orderId);

    const returnToken = generateReturnToken();

    console.log('[NOOD backend] WiPay create payment request', {
      totalUsd: parsedTotalUsd,
      totalTtd: wipayTotalTtd,
      cartItems,
      shippingAddress,
    });

    setPendingOrder(orderId, {
      type: 'checkout',
      provider: 'wipay',
      orderId,
      clientOrderId,
      localOrderId: clientOrderId,
      pendingCheckoutId: clientOrderId,
      checkoutSessionId: checkoutSessionId || clientOrderId,
      returnToken,
      total: parsedTotalUsd,
      wipayTotalTtd,
      currency: SHOPIFY_CURRENCY,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      cartItems,
      shippingAddress,
      createdAt: Date.now(),
    });

    const responseUrl = `${BACKEND_BASE_URL}/payment-return?order_id=${encodeURIComponent(orderId)}&return_token=${encodeURIComponent(returnToken)}`;

    const payload = new URLSearchParams({
      account_number: WIPAY_ACCOUNT_NUMBER,
      country_code: 'TT',
      currency: 'TTD',
      environment: WIPAY_ENVIRONMENT,
      fee_structure: 'customer_pay',
      method: 'credit_card',
      order_id: orderId,
      origin: 'nood_app',
      response_url: responseUrl,
      total: wipayTotalTtd,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
    });

    logWiPayCreatePaymentRequest(payload);

    const response = await axios.post(
      'https://tt.wipayfinancial.com/plugins/payments/request',
      payload.toString(),
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );

    const paymentUrl = getWiPayPaymentUrl(response.data);
    logWiPayCreatePaymentRequest(payload, safeString(paymentUrl));
    console.log('[NOOD backend] WiPay create payment response', {
      status: response.data?.status,
      message: response.data?.message,
      transaction_id: response.data?.transaction_id || response.data?.transactionId || null,
    });

    if (!isHttpsPaymentUrl(paymentUrl)) {
      return res.status(500).json({
        success: false,
        error: true,
        message: 'Payment link could not be created. Please try again.',
      });
    }

    const wipayTransactionId = response.data?.transaction_id || response.data?.transactionId || null;
    const appFallbackReturnUrl = `${responseUrl}&status=success&transaction_id=${encodeURIComponent(wipayTransactionId || '')}&nood_webview_success=1&return_json=1`;
    const pendingRecord = pendingOrders.get(orderId) || {};
    setPendingOrder(orderId, {
      ...pendingRecord,
      paymentUrl: safeString(paymentUrl),
      wipayTransactionId,
    });

    return res.json({
      success: true,
      url: safeString(paymentUrl),
      payment_url: safeString(paymentUrl),
      return_url: appFallbackReturnUrl,
      message: response.data?.message || 'OK',
      transaction_id: wipayTransactionId,
      order_id: orderId,
      checkoutSessionId: checkoutSessionId || clientOrderId,
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('WiPay CHECKOUT ERROR:', errorData);

    return res.status(error.statusCode || error.response?.status || 500).json({
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || 'WiPay request failed',
      raw: errorData,
    });
  }
});

app.post('/create-paypal-payment', requireCustomerAuth, async (req, res) => {
  return res.status(410).json({
    success: false,
    error: true,
    message: 'Legacy PayPal checkout creation is retired. Use POST /api/orders.',
  });

  try {
    const { shippingAddress = {} } = req.body;
    const customer = req.customer || {};
    const name = safeString(
      req.body?.name || shippingAddress?.fullName || shippingAddress?.name,
      `${safeString(customer.firstName)} ${safeString(customer.lastName)}`.trim() || 'NOOD Customer'
    );
    const email = safeString(customer.email || req.body?.email || shippingAddress?.email);
    const phone = safeString(customer.phone || req.body?.phone || shippingAddress?.phone);

    if (!hasPayPalCredentials()) {
      return res.status(500).json({
        error: true,
        message: 'Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in backend .env',
      });
    }

    const cartItems = getCartItemsFromBody(req.body);
    const checkoutSessionId = resolveCheckoutSessionId(req.body);
    const parsedTotal = assertCheckoutTotalMatches(req.body);

    const validationErrors = validateCheckoutData({
      total: parsedTotal,
      cartItems,
      name,
      email,
      phone,
      shippingAddress,
      requireEmail: true,
    });

    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: true,
        message: validationErrors[0],
        validationErrors,
      });
    }

    const payPalAmounts = getPayPalCheckoutAmountsFromTtd({
      ...req.body,
      total: parsedTotal,
      currency: SHOPIFY_CURRENCY,
    });
    const customerName = safeString(name);
    const customerEmail = safeString(email);
    const customerPhone = safeString(phone);
    if (checkoutSessionId) {
      const existingPending = findPendingByCheckoutSessionId(checkoutSessionId);
      if (existingPending?.pending?.returnToken) {
        const checkoutUrl = `${BACKEND_BASE_URL}/paypal-checkout?order_id=${encodeURIComponent(existingPending.orderId)}&return_token=${encodeURIComponent(existingPending.pending.returnToken)}`;

        return res.json({
          success: true,
          idempotent: true,
          url: checkoutUrl,
          payment_url: checkoutUrl,
          order_id: existingPending.orderId,
        });
      }
    }

    const orderId = safeString(checkoutSessionId, `paypal_${Date.now()}`);
    const returnToken = generateReturnToken();

    setPendingOrder(orderId, {
      type: 'paypal_checkout',
      orderId,
      clientOrderId: checkoutSessionId || orderId,
      checkoutSessionId: checkoutSessionId || orderId,
      returnToken,
      total: parsedTotal,
      currency: payPalAmounts.shopifyCurrency,
      paypalTotalUsd: payPalAmounts.paypalTotalUsd,
      paypalCurrency: payPalAmounts.paypalCurrency,
      exchangeRate: payPalAmounts.exchangeRate,
      customerId: customer.id,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      cartItems,
      shippingAddress,
      createdAt: Date.now(),
    });

    const checkoutUrl = `${BACKEND_BASE_URL}/paypal-checkout?order_id=${encodeURIComponent(orderId)}&return_token=${encodeURIComponent(returnToken)}`;

    return res.json({
      success: true,
      url: checkoutUrl,
      payment_url: checkoutUrl,
      order_id: orderId,
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('PAYPAL CHECKOUT ERROR:', errorData);

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || errorData?.details?.[0]?.description || 'PayPal request failed',
      raw: errorData,
    });
  }
});

app.get('/paypal-checkout', (req, res) => {
  return res.status(410).send('Legacy PayPal checkout page is retired. Use hosted PayPal SDK checkout.');

  const orderId = getReturnOrderId(req.query);
  const returnToken = getReturnToken(req.query);
  const pending = pendingOrders.get(orderId);

  if (!pending || !returnToken || returnToken !== pending.returnToken) {
    return res.status(400).send('Invalid PayPal checkout session.');
  }

  if (!hasPayPalCredentials()) {
    return res.status(500).send('Missing PayPal credentials in backend .env.');
  }

  const paypalClientId = encodeURIComponent(getPayPalConfig().clientId);
  const checkoutPayload = JSON.stringify({
    orderId,
    returnToken,
    total: pending.total,
  });
  const cancelRedirectUrl = buildAppRedirect('payment-result', {
    status: 'cancelled',
    type: 'checkout',
    method: 'paypal',
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <title>PayPal Checkout</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        background: #050505;
        color: #111;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .card {
        width: 100%;
        max-width: 430px;
        background: #fff;
        border-radius: 22px;
        padding: 22px;
        box-sizing: border-box;
      }
      .title {
        font-size: 22px;
        font-weight: 800;
        margin: 0 0 6px;
      }
      .subtitle {
        color: #5d6675;
        font-size: 14px;
        margin: 0 0 18px;
      }
      #message {
        color: #b42318;
        font-size: 14px;
        margin-top: 14px;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="title">Pay with PayPal</p>
      <p class="subtitle">Complete your NOOD checkout securely.</p>
      <div id="paypal-button-container"></div>
      <div id="message"></div>
    </main>
    <script>
      window.NOOD_CHECKOUT = ${checkoutPayload};
      function showMessage(message) {
        document.getElementById('message').textContent = message || '';
      }
    </script>
    <script src="https://www.paypal.com/sdk/js?client-id=${paypalClientId}&currency=USD&components=buttons&enable-funding=venmo,paylater,card"></script>
    <script>
      paypal.Buttons({
        style: {
          shape: 'rect',
          layout: 'vertical',
          color: 'gold',
          label: 'paypal'
        },
        async createOrder() {
          const response = await fetch('/paypal-sdk/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.NOOD_CHECKOUT)
          });
          const data = await response.json();
          if (!response.ok || !data.id) {
            throw new Error(data.message || 'Could not start PayPal checkout.');
          }
          return data.id;
        },
        async onApprove(data) {
          const response = await fetch('/paypal-sdk/orders/' + encodeURIComponent(data.orderID) + '/capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.NOOD_CHECKOUT)
          });
          const result = await response.json();
          if (!response.ok || !result.redirect_url) {
            throw new Error(result.message || 'Could not capture PayPal payment.');
          }
          window.location.href = result.redirect_url;
        },
        onCancel() {
          window.location.href = ${JSON.stringify(cancelRedirectUrl)};
        },
        onError(error) {
          showMessage(error && error.message ? error.message : 'PayPal checkout failed.');
        }
      }).render('#paypal-button-container');
    </script>
  </body>
</html>`);
});

app.post('/paypal-sdk/orders', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: true,
    message: 'Legacy PayPal SDK order route is retired. Use POST /api/orders.',
  });

  try {
    const orderId = safeString(req.body?.orderId || req.body?.order_id);
    const returnToken = safeString(req.body?.returnToken || req.body?.return_token);
    const pending = pendingOrders.get(orderId);

    if (!pending || !returnToken || returnToken !== pending.returnToken) {
      return res.status(400).json({
        error: true,
        message: 'Invalid PayPal checkout session.',
      });
    }

    const paymentCreate = await paypalPaymentService.createOrder({
      purpose: 'checkout',
      customerId: pending.customerId,
      expectedAmountCents: usdToCents(safeMoney(pending.paypalTotalUsd)),
      expectedCurrency: pending.paypalCurrency || PAYPAL_CURRENCY,
      trustedSnapshot: {
        checkoutSessionId: pending.checkoutSessionId || orderId,
        cartFingerprint: getCartFingerprint(pending.cartItems),
        cartItems: pending.cartItems || [],
        total: pending.total,
        currency: pending.currency,
      },
      idempotencyKey: `paypal:hosted:create:${orderId}`,
      referenceId: orderId,
      description: 'NOOD order',
    });
    const paypalOrder = paymentCreate.order;

    pending.paypalOrderId = paypalOrder?.id;
    pending.paymentId = paymentCreate.record?.paymentId;
    setPendingOrder(orderId, pending);

    return res.json({
      ...paypalOrder,
      payment: paymentState.publicPayment(paymentCreate.record),
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('PAYPAL SDK CREATE ORDER ERROR:', errorData);

    return res.status(error.statusCode || error.response?.status || 500).json({
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || errorData?.details?.[0]?.description || 'PayPal order create failed',
      raw: errorData,
    });
  }
});

app.post('/paypal-sdk/orders/:paypalOrderId/capture', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: true,
    message: 'Legacy PayPal SDK capture route is retired. Use POST /api/orders/:orderID/capture.',
  });

  const paypalOrderId = safeString(req.params.paypalOrderId);
  const orderId = safeString(req.body?.orderId || req.body?.order_id);
  const returnToken = safeString(req.body?.returnToken || req.body?.return_token);
  const pending = pendingOrders.get(orderId);

  try {
    if (!pending || !returnToken || returnToken !== pending.returnToken) {
      return res.status(400).json({
        error: true,
        message: 'Invalid PayPal checkout session.',
      });
    }

    if (pending.paypalOrderId && pending.paypalOrderId !== paypalOrderId) {
      return res.status(400).json({
        error: true,
        message: 'PayPal order does not match this checkout session.',
      });
    }

    const result = await paypalPaymentService.captureOrder({
      paypalOrderId,
      customerId: pending.customerId,
      purpose: 'checkout',
      onCheckoutPaid: ({ captureData, captureId }) =>
        createShopifyOrderFromPaidPayment({
          method: 'paypal',
          transactionId: captureId,
          orderId,
          pending,
          rawReturn: captureData,
        }),
    });
    const captureId = result.captureId || paypalOrderId;

    if (result.recoveryRequired) {
      return res.status(202).json({
        success: false,
        payment_received: true,
        status: 'payment_received_order_review',
        message:
          'Payment Received - Order Processing Issue. Your payment was successful, but your order needs review.',
        redirect_url: buildAppRedirect('payment-result', {
          status: 'payment_received_order_review',
          type: 'checkout',
          order_id: orderId,
          transaction_id: captureId,
          reason: result.record?.lastSafeErrorCode || 'shopify_order_create_failed',
          recovery_id: result.shopifyResult?.recovery?.recoveryId || '',
          amount: pending.total,
          method: 'paypal',
        }),
        recovery_id: result.shopifyResult?.recovery?.recoveryId || '',
        shopifyError: result.shopifyResult?.shopifyError || null,
        payment: paymentState.publicPayment(result.record),
      });
    }

    const shopifyOrder = result.shopifyResult?.shopifyOrder;

    removePendingOrder(orderId);

    return res.json({
      success: true,
      redirect_url: buildAppRedirect('payment-result', {
        status: 'success',
        type: 'checkout',
        order_id: orderId,
        transaction_id: captureId,
        shopify_order_id: shopifyOrder?.id || '',
        shopify_order_name: shopifyOrder?.name || '',
        amount: pending.total,
        method: 'paypal',
      }),
      capture: result.captureData,
      payment: paymentState.publicPayment(result.record),
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('PAYPAL SDK CAPTURE ERROR:', errorData);

    return res.status(500).json({
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || errorData?.details?.[0]?.description || 'PayPal capture failed',
      redirect_url: buildAppRedirect('payment-result', {
        status: 'failed',
        type: 'checkout',
        order_id: orderId,
        transaction_id: paypalOrderId,
        reason: 'paypal_capture_failed',
        method: 'paypal',
      }),
      raw: errorData,
    });
  }
});

const createWalletTopup = async (req, res) => {
  try {
    const { amount } = req.body;
    const authenticatedCustomer = req.customer || {};
    const name = safeString(
      req.body?.name ||
        `${safeString(authenticatedCustomer.firstName)} ${safeString(authenticatedCustomer.lastName)}`.trim(),
      'NOOD Customer'
    );
    const email = safeString(authenticatedCustomer.email || req.body?.email);
    const phone = safeString(authenticatedCustomer.phone || req.body?.phone);
    const customerId = safeString(authenticatedCustomer.id);

    if (!WIPAY_ACCOUNT_NUMBER) {
      return res.status(500).json({
        error: true,
        message: 'Missing WIPAY_ACCOUNT_NUMBER in .env',
      });
    }

    if (!WIPAY_API_KEY) {
      return res.status(500).json({
        error: true,
        message: 'Missing WIPAY_API_KEY in backend .env. WiPay wallet top-ups cannot be verified.',
      });
    }

    assertUsdCurrency(req.body?.currency || 'USD', 'wallet top-up currency');

    if (!isValidPositiveMoney(amount)) {
      return res.status(400).json({
        error: true,
        message: 'Invalid amount. Minimum is 1.00.',
      });
    }

    const parsedAmount = safeMoney(amount);
    const amountCents = usdToCents(parsedAmount);
    requirePositiveCents(amountCents, 'wallet top-up amount');
    const customerName = safeString(name);
    const customerEmail = safeString(email);
    const customerPhone = safeString(phone);
    const normalizedCustomerId = safeString(customerId);

    const missingFields = [];
    if (!customerName) missingFields.push('Customer name is required.');
    if (!customerPhone) missingFields.push('Customer phone is required.');
    if (!normalizedCustomerId) missingFields.push('Customer ID is required.');

    if (missingFields.length) {
      return res.status(400).json({
        success: false,
        error: true,
        message: missingFields[0],
        validationErrors: missingFields,
      });
    }

    const orderId = `wallet_${Date.now()}`;

    const returnToken = generateReturnToken();

    setPendingOrder(orderId, {
      type: 'wallet_topup',
      provider: 'wipay',
      orderId,
      returnToken,
      amount: parsedAmount,
      amountCents,
      currency: 'USD',
      providerAmount: parsedAmount,
      providerCurrency: 'USD',
      customerId: normalizedCustomerId,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      createdAt: Date.now(),
    });

    const responseUrl = `${BACKEND_BASE_URL}/payment-return?order_id=${encodeURIComponent(orderId)}&return_token=${encodeURIComponent(returnToken)}`;

    const payload = new URLSearchParams({
      account_number: WIPAY_ACCOUNT_NUMBER,
      country_code: 'TT',
      currency: 'USD',
      environment: WIPAY_ENVIRONMENT,
      fee_structure: 'customer_pay',
      method: 'credit_card',
      order_id: orderId,
      origin: 'nood_app',
      response_url: responseUrl,
      total: parsedAmount,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
    });

    logWiPayCreatePaymentRequest(payload);

    const response = await axios.post(
      'https://tt.wipayfinancial.com/plugins/payments/request',
      payload.toString(),
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );

    const paymentUrl = getWiPayPaymentUrl(response.data);
    logWiPayCreatePaymentRequest(payload, safeString(paymentUrl));

    if (!isHttpsPaymentUrl(paymentUrl)) {
      return res.status(500).json({
        success: false,
        error: true,
        message: 'Payment link could not be created. Please try again.',
      });
    }

    const wipayTransactionId = response.data?.transaction_id || response.data?.transactionId || null;
    const appFallbackReturnUrl = `${responseUrl}&status=success&transaction_id=${encodeURIComponent(wipayTransactionId || '')}&nood_webview_success=1&return_json=1`;

    return res.json({
      success: true,
      url: safeString(paymentUrl),
      payment_url: safeString(paymentUrl),
      return_url: appFallbackReturnUrl,
      message: response.data?.message || 'OK',
      transaction_id: wipayTransactionId,
      order_id: orderId,
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('WiPay WALLET TOPUP ERROR:', errorData);

    return res.status(500).json({
      success: false,
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || 'Top-up failed',
      raw: errorData,
    });
  }
};

app.post('/create-wallet-topup', requireCustomerAuth, createWalletTopup);

app.get('/api/wallet/balance', requireCustomerAuth, async (req, res) => {
  const customerId = safeString(req.customer?.id);

  if (!customerId) {
    return res.status(400).json({
      success: false,
      error: true,
      message: 'customerId is required.',
    });
  }

  return res.json({
    success: true,
    customerId,
    balance: await getConfirmedWalletBalanceUsd(customerId),
    currency: 'USD',
  });
});

app.post('/api/wallet/checkout', requireCustomerAuth, handleWalletCheckout);

app.post('/api/wallet/paypal/orders', requireCustomerAuth, createPayPalWalletTopup);
app.post('/api/wallet/paypal/orders/:orderID/capture', requireCustomerAuth, capturePayPalWalletTopup);
app.post('/wallet/topup/paypal/:orderID/capture', requireCustomerAuth, capturePayPalWalletTopup);

app.post('/wallet/topup', requireCustomerAuth, (req, res) => {
  const provider = safeString(req.body?.provider || req.body?.paymentMethod, 'wipay').toLowerCase();

  if (provider === 'paypal') {
    return createPayPalWalletTopup(req, res);
  }

  return createWalletTopup(req, res);
});

app.get('/paypal-return', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: true,
    message: 'Legacy PayPal return capture route is retired. Use hosted PayPal SDK capture.',
  });

  const orderId = getReturnOrderId(req.query);
  const returnToken = getReturnToken(req.query);
  const paypalOrderId = safeString(req.query.token);
  const rawStatus = getReturnStatus(req.query);
  const pending = pendingOrders.get(orderId);

  try {
    if (!pending || !returnToken || returnToken !== pending.returnToken) {
      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'failed',
          order_id: orderId,
          transaction_id: paypalOrderId,
          reason: 'invalid_return_token',
          method: 'paypal',
        })
      );
    }

    if (rawStatus === 'cancelled' || rawStatus === 'canceled') {
      removePendingOrder(orderId);

      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'cancelled',
          type: 'checkout',
          order_id: orderId,
          transaction_id: paypalOrderId,
          method: 'paypal',
        })
      );
    }

    if (!paypalOrderId) {
      removePendingOrder(orderId);

      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'failed',
          type: 'checkout',
          order_id: orderId,
          reason: 'missing_paypal_order_id',
          method: 'paypal',
        })
      );
    }

    const captureData = await capturePayPalOrder(paypalOrderId);
    const captureId =
      captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      paypalOrderId;

    if (captureData?.status !== 'COMPLETED') {
      removePendingOrder(orderId);

      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'failed',
          type: 'checkout',
          order_id: orderId,
          transaction_id: captureId,
          reason: `paypal_${String(captureData?.status || 'not_completed').toLowerCase()}`,
          method: 'paypal',
        })
      );
    }

    const shopifyResult = await createShopifyOrderFromPaidPayment({
      method: 'paypal',
      transactionId: captureId,
      orderId,
      pending,
      rawReturn: req.query,
    });

    if (!shopifyResult.success) {
      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'payment_received_order_review',
          type: 'checkout',
          order_id: orderId,
          transaction_id: captureId,
          reason: 'shopify_order_create_failed',
          recovery_id: shopifyResult.recovery?.recoveryId || '',
          amount: pending.total,
          method: 'paypal',
        })
      );
    }

    const shopifyOrder = shopifyResult.shopifyOrder;

    removePendingOrder(orderId);

    return res.redirect(
      buildAppRedirect('payment-result', {
        status: 'success',
        type: 'checkout',
        order_id: orderId,
        transaction_id: captureId,
        shopify_order_id: shopifyOrder?.id || '',
        shopify_order_name: shopifyOrder?.name || '',
        amount: pending.total,
        method: 'paypal',
      })
    );
  } catch (error) {
    console.error('PAYPAL RETURN ERROR:', error.response?.data || error.message);

    return res.redirect(
      buildAppRedirect('payment-result', {
        status: 'failed',
        type: 'checkout',
        order_id: orderId,
        transaction_id: paypalOrderId,
        reason: 'paypal_capture_failed',
        method: 'paypal',
      })
    );
  }
});

app.get('/payment-return', async (req, res) => {
  try {
    const rawStatus = getReturnStatus(req.query);
    const orderId = getReturnOrderId(req.query);
    const transactionId = getReturnTransactionId(req.query);
    const returnToken = getReturnToken(req.query);

    console.log('[WIPAY SUCCESS] payment-return callback received', {
      rawStatus,
      orderId,
      transactionId,
      hasReturnToken: Boolean(returnToken),
      query: getSafeWiPayReturnLog(req.query),
    });

    const isSuccess =
      rawStatus === 'success' ||
      rawStatus === 'approved' ||
      rawStatus === 'paid' ||
      rawStatus === '1';

    const isCancelled =
      rawStatus === 'cancelled' ||
      rawStatus === 'canceled';

    const pending = pendingOrders.get(orderId);

    if (!pending || !returnToken || returnToken !== pending.returnToken) {
      return sendPaymentResult(req, res, {
          status: 'failed',
          order_id: orderId,
          transaction_id: transactionId,
          reason: 'invalid_return_token',
          method: 'wipay',
      });
    }

    if (!isSuccess) {
      const failStatus = isCancelled ? 'cancelled' : 'failed';

      removePendingOrder(orderId);

      return sendPaymentResult(req, res, {
          status: failStatus,
          order_id: orderId,
          transaction_id: transactionId,
          method: 'wipay',
      });
    }

    const wipayVerification = verifyWiPayReturn({
      query: req.query,
      pending,
    });

    if (!wipayVerification.ok) {
      console.error('[NOOD order] WiPay verification failed', {
        reason: wipayVerification.reason,
        orderId,
        transactionId,
        query: req.query,
      });

      return sendPaymentResult(req, res, {
          status: 'failed',
          order_id: orderId,
          transaction_id: transactionId,
          reason: wipayVerification.reason,
          method: 'wipay',
      });
    }

    if (wipayVerification.needsReview) {
      console.warn('[NOOD order] WiPay payment needs manual review before fulfillment', {
        reason: wipayVerification.reason,
        orderId,
        transactionId,
        type: pending.type || 'checkout',
      });

      return sendPaymentResult(req, res, {
          status: 'payment_received_order_review',
          type: pending.type === 'wallet_topup' ? 'wallet_topup' : 'checkout',
          order_id: orderId,
          transaction_id: transactionId,
          reason: wipayVerification.reason,
          amount: pending.amount || pending.total,
          method: 'wipay',
      });
    }

    if (pending.type === 'wallet_topup') {
      const walletRecord = saveWalletTransaction({
        provider: 'wipay',
        transactionId,
        pending,
        rawReturn: req.query,
      });
      const confirmedBalance = getConfirmedWalletBalance(walletRecord.customerId);

      removePendingOrder(orderId);

      return sendPaymentResult(req, res, {
          status: 'success',
          type: 'wallet_topup',
          order_id: orderId,
          transaction_id: transactionId,
          amount: pending.amount,
          wallet_transaction_id: walletRecord.walletTransactionId,
          confirmed_balance: confirmedBalance,
          method: 'wipay',
      });
    }

    const shopifyResult = await createShopifyOrderFromPaidPayment({
      method: 'wipay',
      transactionId,
      orderId,
      pending,
      rawReturn: req.query,
    });

    if (!shopifyResult.success) {
      console.error('[ORDER CREATE FAILED] payment-return could not create Shopify order', {
        orderId,
        transactionId,
        reason: 'shopify_order_create_failed',
        recoveryId: shopifyResult.recovery?.recoveryId || '',
        shopifyError: shopifyResult.shopifyError || null,
      });

      return sendPaymentResult(req, res, {
          status: 'payment_received_order_review',
          type: 'checkout',
          order_id: orderId,
          transaction_id: transactionId,
          reason: shopifyResult.shopifyError?.shopifyDetails?.firstGraphQLError
            ? 'shopify_order_create_failed'
            : shopifyResult.shopifyError?.message || 'shopify_order_create_failed',
          recovery_id: shopifyResult.recovery?.recoveryId || '',
          amount: pending.total,
          method: 'wipay',
      });
    }

    const shopifyOrder = shopifyResult.shopifyOrder;

    console.log('[ORDER CREATE SUCCESS] payment-return fulfilled checkout', {
      orderId,
      transactionId,
      shopify_order_id: shopifyOrder?.id || null,
      shopify_order_name: shopifyOrder?.name || null,
    });

    removePendingOrder(orderId);

    return sendPaymentResult(req, res, {
        status: 'success',
        type: 'checkout',
        order_id: orderId,
        transaction_id: transactionId,
        shopify_order_id: shopifyOrder?.id || '',
        shopify_order_name: shopifyOrder?.name || '',
        amount: pending.total,
        method: 'wipay',
    });
  } catch (error) {
    console.error('PAYMENT RETURN ERROR:', error.response?.data || error.message);

    return sendPaymentResult(req, res, {
        status: 'failed',
        reason: 'server_error',
        method: 'wipay',
    });
  }
});

let cachedShopCurrencyCode = '';

function getCartCurrency(cartItems) {
  const items = Array.isArray(cartItems) ? cartItems : [];

  for (const item of items) {
    const code = safeString(item?.currency).toUpperCase();
    if (code) {
      return code;
    }
  }

  return '';
}

function resolveShopifyOrderCurrency({ pending = null, cartItems = [], explicitCurrency = '' } = {}) {
  const explicit = safeString(explicitCurrency).toUpperCase();
  const pendingCurrency = safeString(pending?.currency).toUpperCase();
  const cartCurrency = getCartCurrency(cartItems);

  return explicit || pendingCurrency || cartCurrency || SHOPIFY_CURRENCY || 'TTD';
}

async function fetchShopCurrencyCode(accessToken) {
  if (cachedShopCurrencyCode) {
    return cachedShopCurrencyCode;
  }

  try {
    const payload = await adminGraphql(
      `query NoodShopCurrency { shop { currencyCode } }`,
      {},
      { accessToken, requestedQueryCost: 1 }
    );
    cachedShopCurrencyCode =
      safeString(payload?.data?.shop?.currencyCode, '').toUpperCase() || 'UNKNOWN';
  } catch (error) {
    console.warn('[SHOP CURRENCY] failed to fetch shop currencyCode', error?.message || error);
    cachedShopCurrencyCode = 'UNKNOWN';
  }

  return cachedShopCurrencyCode;
}

function logShopifyOrderCurrencyDiagnostics({
  paymentCurrency,
  paymentAmount,
  pendingOrderCurrency,
  cartCurrency,
  shopCurrency,
  orderCurrency,
  orderPayloadCurrency,
}) {
  console.log('[PAYMENT CURRENCY]', paymentCurrency || 'n/a');
  if (paymentAmount !== undefined && paymentAmount !== null && paymentAmount !== '') {
    console.log('[PAYMENT AMOUNT]', paymentAmount);
  }
  console.log('[ORDER CURRENCY]', orderCurrency || 'n/a');
  console.log('[SHOP CURRENCY]', shopCurrency || 'n/a');
  console.log('[SHOPIFY ORDER PAYLOAD CURRENCY]', orderPayloadCurrency || 'n/a');
  console.log('[NOOD order] currency diagnostics before Shopify orderCreate', {
    paymentCurrency: paymentCurrency || null,
    paymentAmount: paymentAmount ?? null,
    pendingOrderCurrency: pendingOrderCurrency || null,
    cartCurrency: cartCurrency || null,
    shopCurrency: shopCurrency || null,
    configuredShopifyCurrency: SHOPIFY_CURRENCY,
    orderCurrency: orderCurrency || null,
    orderPayloadCurrency: orderPayloadCurrency || null,
  });
}

async function findExistingShopifyOrderForRecovery({
  payment = {},
  recoveryId = '',
  paypalOrderId = '',
  paypalCaptureId = '',
} = {}) {
  const terms = [
    safeString(payment.paymentId),
    safeString(recoveryId),
    safeString(paypalOrderId || payment.providerOrderId),
    safeString(paypalCaptureId || payment.providerTransactionId),
  ].filter(Boolean);

  if (!terms.length || !hasShopifyOrderAdminAccessToken()) {
    return { found: false, searched: terms.length };
  }

  const query = `
    query findRecoveryOrder($query: String!) {
      orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            tags
            note
          }
        }
      }
    }
  `;
  const accessToken = getShopifyOrderAccessToken();

  for (const term of terms) {
    try {
      const payload = await adminGraphql(query, { query: term }, {
        accessToken,
        requestedQueryCost: 20,
      });
      const order = payload?.data?.orders?.edges?.[0]?.node;
      if (order?.id) {
        return {
          found: true,
          shopifyOrderId: order.id,
          shopifyOrderName: order.name || '',
          matchedTerm: term === paypalCaptureId ? 'paypal_capture_id' : 'stable_identifier',
        };
      }
    } catch (error) {
      return { found: false, error: 'shopify_lookup_unavailable', message: error.message };
    }
  }

  return { found: false, searched: terms.length };
}

async function createShopifyOrder({
  email,
  phone,
  name,
  total,
  cartItems,
  shippingAddress,
  paymentTransactionId,
  paymentMethod = 'WiPay',
  clientOrderId,
  currency: explicitCurrency = '',
  paymentCurrency = '',
  paymentAmount = null,
  pending = null,
}) {
  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN in .env');
  }

  const orderAccessToken = getShopifyOrderAccessToken();
  if (!orderAccessToken) {
    throw new Error(
      'Missing SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN. Set a dedicated Shopify Admin API token with write_orders scope for order creation.'
    );
  }

  assertShopifyOrderCreateAccess(shopifyOrderAccessState);

  const pendingOrderCurrency = safeString(pending?.currency).toUpperCase();
  const cartCurrency = getCartCurrency(cartItems);
  const orderCurrency = resolveShopifyOrderCurrency({
    pending,
    cartItems,
    explicitCurrency,
  });
  const shopCurrency = await fetchShopCurrencyCode(orderAccessToken);
  const resolvedPaymentCurrency =
    safeString(paymentCurrency).toUpperCase() || pendingOrderCurrency || orderCurrency;

  logShopifyOrderCurrencyDiagnostics({
    paymentCurrency: resolvedPaymentCurrency,
    paymentAmount: paymentAmount ?? safeMoney(total),
    pendingOrderCurrency: pendingOrderCurrency || null,
    cartCurrency: cartCurrency || null,
    shopCurrency,
    orderCurrency,
    orderPayloadCurrency: orderCurrency,
  });

  const [firstName, ...rest] = safeString(name, 'NOOD Customer').split(' ');
  const lastName = rest.join(' ') || 'Customer';
  const normalizedCustomerPhone = normalizeTrinidadPhoneForShopify(phone, 'customer');
  const normalizedShippingAddress = buildShopifyAddress(
    shippingAddress,
    safeString(name, 'NOOD Customer'),
    normalizedCustomerPhone || phone
  );

  const lineItems = (Array.isArray(cartItems) ? cartItems : []).map((item) => {
    const quantity = Number(item?.quantity || 1);
    const price = safeMoney(item?.price || 0);
    const variantGid = normalizeShopifyVariantGid(item?.variantId);

    if (!variantGid) {
      throw new Error(`Missing Shopify variant ID for ${safeString(item?.title, 'Product')}`);
    }

    const baseItem = {
      title: safeString(item?.title, 'Product'),
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      priceSet: {
        shopMoney: {
          amount: price,
          currencyCode: orderCurrency,
        },
      },
    };

    return {
      ...baseItem,
      variantId: variantGid,
    };
  });

  const query = `
    mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order {
          id
          name
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    options: {
      inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
    },
    order: {
      currency: orderCurrency,
      email: email || undefined,
      phone: normalizedCustomerPhone || undefined,
      tags: ['NOOD App', paymentMethod, pending?.paymentId, pending?.paypalOrderId, pending?.recoveryId].filter(Boolean),
      note: `${paymentMethod} transaction: ${paymentTransactionId} | Client order: ${clientOrderId} | Payment ID: ${safeString(pending?.paymentId)} | PayPal order: ${safeString(pending?.paypalOrderId)} | Recovery ID: ${safeString(pending?.recoveryId)}`,
      billingAddress: {
        firstName: firstName || 'NOOD',
        lastName: lastName || 'Customer',
        phone: normalizedCustomerPhone || undefined,
      },
      shippingAddress: normalizedShippingAddress || undefined,
      lineItems,
      transactions: [
        {
          kind: 'SALE',
          status: 'SUCCESS',
          gateway: paymentMethod,
          amountSet: {
            shopMoney: {
              amount: safeMoney(total),
              currencyCode: orderCurrency,
            },
          },
        },
      ],
    },
  };

  console.log('[ORDER CREATE START] Shopify orderCreate request', {
    storeDomain: SHOPIFY_STORE_DOMAIN,
    tokenSource: shopifyOrderAccessState.tokenSource,
    lineItemCount: variables.order?.lineItems?.length || 0,
    total: safeMoney(total),
    paymentMethod,
    clientOrderId,
    email: email || null,
    phone: normalizedCustomerPhone || null,
    lineItems: lineItems.map((item) => ({
      title: item.title,
      quantity: item.quantity,
      variantId: item.variantId,
      amount: item.priceSet?.shopMoney?.amount || null,
      currencyCode: item.priceSet?.shopMoney?.currencyCode || null,
    })),
    shippingAddress: normalizedShippingAddress,
    paymentCurrency: resolvedPaymentCurrency,
    pendingOrderCurrency: pendingOrderCurrency || null,
    cartCurrency: cartCurrency || null,
    shopCurrency,
    orderCurrency,
    orderPayloadCurrency: variables.order?.currency || null,
    transactionCurrency:
      variables.order?.transactions?.[0]?.amountSet?.shopMoney?.currencyCode || null,
  });

  console.log('[SHOPIFY ORDER PAYLOAD CURRENCY]', variables.order?.currency || 'n/a');
  console.log('[ORDER CREATE] Shopify payload preview (non-secret)', {
    currency: variables.order?.currency || null,
    lineItemCurrencies: lineItems.map((item) => item.priceSet?.shopMoney?.currencyCode || null),
    transactionAmount: variables.order?.transactions?.[0]?.amountSet?.shopMoney?.amount || null,
    transactionCurrency:
      variables.order?.transactions?.[0]?.amountSet?.shopMoney?.currencyCode || null,
    shopCurrency,
    orderCurrency,
  });

  let payload;
  try {
    payload = await adminGraphql(query, variables, {
      accessToken: orderAccessToken,
      requestedQueryCost: 20,
    });
  } catch (error) {
    const shopifyDetails = {
      statusCode: error?.response?.status || error?.statusCode || null,
      graphQLErrorCount: Array.isArray(error?.shopifyErrors) ? error.shopifyErrors.length : 0,
      firstGraphQLError:
        error?.shopifyErrors?.[0]?.message ||
        error?.response?.data?.errors?.[0]?.message ||
        error?.message ||
        null,
      responseBody: error?.response?.data || null,
    };
    console.error('[ORDER CREATE FAILED] Shopify orderCreate transport error', shopifyDetails);
    const wrapped = new Error(shopifyDetails.firstGraphQLError || 'Shopify order creation failed');
    wrapped.shopifyDetails = shopifyDetails;
    throw wrapped;
  }

  const result = payload?.data?.orderCreate;
  const errors = result?.userErrors || [];

  if (!result?.order || errors.length > 0) {
    const error = new Error(errors[0]?.message || 'Failed to create Shopify order');
    error.shopifyDetails = {
      userErrorCount: errors.length,
      firstUserError: errors[0]?.message || null,
      userErrors: errors,
    };
    console.error('[ORDER CREATE FAILED] Shopify orderCreate userErrors', error.shopifyDetails);
    throw error;
  }

  console.log('[ORDER CREATE SUCCESS] Shopify orderCreate response', {
    orderId: result?.order?.id || null,
    orderName: result?.order?.name || null,
  });

  return result.order;
}

async function startServer() {
  let cache = null;

  try {
    await storage.ready;
  } catch (error) {
    console.error('[NOOD storage] failed to initialize payment recovery storage:', error.message);
    throw error;
  }

  if (NODE_ENV === 'test') {
    shopifyOrderAccessState = {
      ok: false,
      message: 'Shopify order access validation skipped in test mode.',
      scopes: [],
      tokenSource: 'test',
      missingOrderScopes: [],
      hasShopifyOrderAdminAccessToken: false,
    };
  } else {
    try {
      shopifyOrderAccessState = await validateShopifyOrderCreateAccess();
    } catch (error) {
      shopifyOrderAccessState = {
        ok: false,
        message: error?.message || 'Shopify order access validation failed.',
        scopes: [],
        tokenSource: getShopifyOrderTokenSource(),
        missingOrderScopes: ['write_orders'],
        hasShopifyOrderAdminAccessToken: hasShopifyOrderAdminAccessToken(),
      };
      console.error('[ORDER CREATE FAILED] startup validation threw', shopifyOrderAccessState);
    }
  }

  try {
    cache = await mountCatalog(app, { requireAdminApiKey });
  } catch (error) {
    console.error('[NOOD catalog] failed to mount catalog routes:', error.message);
    try {
      cache = await getCatalogCache();
    } catch (cacheError) {
      console.error('[NOOD catalog] failed to initialize cache:', cacheError.message);
    }
  }

  if (!cache) {
    console.error('[NOOD catalog] sync routes not mounted because cache is unavailable');
  }

  startRecurringJobs();

  const server = app.listen(PORT, '0.0.0.0', () => {
    const localUrl = `http://localhost:${PORT}`;
    const loopbackUrl = `http://127.0.0.1:${PORT}`;
    const networkUrl = `http://${LOCAL_IP}:${PORT}`;

    console.log('[NOOD backend] listening on 0.0.0.0:' + PORT);
    console.log('[NOOD backend] Local:    ' + localUrl);
    console.log('[NOOD backend] Loopback: ' + loopbackUrl);
    console.log('[NOOD backend] Network:  ' + networkUrl);
    console.log('[NOOD backend] Base URL: ' + BACKEND_BASE_URL);
    console.log(
      '[NOOD backend] WiPay account configured suffix=' +
        (WIPAY_ACCOUNT_NUMBER ? WIPAY_ACCOUNT_NUMBER.slice(-4) : 'missing')
    );
    console.log('[WIPAY ENV]', WIPAY_ENVIRONMENT);
    console.log('[WIPAY ENV] source=' + WIPAY_ENVIRONMENT_SOURCE + (WIPAY_ENVIRONMENT_RAW ? ` raw=${WIPAY_ENVIRONMENT_RAW}` : ''));
    if (WIPAY_ENVIRONMENT === 'live') {
      console.warn('[WIPAY ENV] live mode active; sandbox test cards will not work');
    }
    if (shopifyOrderAccessState.ok) {
      console.log('[NOOD backend] Shopify order creation ready', {
        tokenSource: shopifyOrderAccessState.tokenSource,
        tokenFingerprint: shopifyOrderAccessState.tokenFingerprint || null,
      });
    } else {
      console.error('[NOOD backend] Shopify order creation not ready', {
        message: shopifyOrderAccessState.message,
        tokenSource: shopifyOrderAccessState.tokenSource || null,
        missingOrderScopes: shopifyOrderAccessState.missingOrderScopes || [],
      });
    }
  });

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[NOOD backend] failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  getBackendReadiness,
  startRecurringJobs,
  startServer,
};


