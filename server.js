require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const app = express();

app.set('trust proxy', 1);
const allowedOrigins = new Set(
  [
    'https://noodcaribbean.com',
    'https://www.noodcaribbean.com',
    ...String(process.env.CORS_ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
      .split(',').map((value) => value.trim()).filter(Boolean),
  ]
);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) ||
        (process.env.NODE_ENV !== 'production' && /^https?:\/\/localhost(?::\d+)?$/.test(origin))) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-push-token', 'x-admin-token'],
}));
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false });
const paymentLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api', apiLimiter);
app.use(['/api/orders', '/api/wallet', '/create-wipay-payment', '/create-wallet-topup', '/wallet/topup'], paymentLimiter);
// Capture the exact bytes while parsing JSON. Shopify's HMAC must be checked
// against this unmodified body; adding a second stream reader after
// express.json() can hang because the request stream has already been consumed.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

const pendingOrders = new Map();
const PENDING_ORDERS_FILE = path.join(__dirname, 'pending-orders.json');

const PORT = Number(process.env.PORT || 3000);
const localSyntheticDemo = process.env.NODE_ENV !== 'production' &&
  ['groq', '9router'].includes(process.env.NOOD_AI_TEST_PROVIDER) && process.env.NOOD_AI_DEMO_DISABLE_JOBS === 'true';
// Device inspection needs the real API without sending scheduled campaigns or
// running inventory writes against the configured store in the background.
const backgroundJobsPaused = localSyntheticDemo || (
  process.env.NODE_ENV !== 'production' && process.env.NOOD_DISABLE_BACKGROUND_JOBS === 'true'
);
const LOCAL_IP = process.env.LOCAL_IP || '192.168.100.238';
const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL || `http://${LOCAL_IP}:${PORT}`;

const WIPAY_ACCOUNT_NUMBER = process.env.WIPAY_ACCOUNT_NUMBER;
const WIPAY_ENVIRONMENT = process.env.WIPAY_ENVIRONMENT || 'sandbox';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const { getAdminToken, hasAdminCredentials } = require('./services/shopify-admin-auth');

loadPendingOrders();

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '0.00';
  return num.toFixed(2);
}

function isValidPositiveMoney(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 1;
}

function getWiPayPaymentUrl(data) {
  if (!data || typeof data !== 'object') return null;

  return data.url || data.payment_url || data.redirect_url || data.link || null;
}

function getReturnOrderId(query) {
  return String(
    query.order_id ||
      query.orderid ||
      query.reference ||
      query.ref ||
      ''
  ).trim();
}

function getReturnTransactionId(query) {
  return String(
    query.transaction_id ||
      query.transactionid ||
      query.txn_id ||
      query.txnid ||
      query.transaction_reference ||
      ''
  ).trim();
}

function getReturnStatus(query) {
  return String(
    query.status ||
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

  return `noodapp://${path}?${query.toString()}`;
}

function generateReturnToken() {
  return crypto.randomBytes(32).toString('hex');
}

function persistPendingOrders() {
  const data = Array.from(pendingOrders.values());
  fs.writeFileSync(PENDING_ORDERS_FILE, JSON.stringify(data, null, 2));
}

function loadPendingOrders() {
  try {
    if (!fs.existsSync(PENDING_ORDERS_FILE)) {
      return;
    }

    const raw = fs.readFileSync(PENDING_ORDERS_FILE, 'utf8');
    if (!raw.trim()) {
      return;
    }

    const items = JSON.parse(raw);

    if (!Array.isArray(items)) {
      return;
    }

    for (const item of items) {
      if (item?.orderId) {
        pendingOrders.set(item.orderId, item);
      }
    }
  } catch (error) {
    console.error('FAILED TO LOAD PENDING ORDERS:', error.message);
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

setInterval(cleanupOldPendingOrders, 1000 * 60 * 30);

// ─── Referral rewards store ──────────────────────────────────────────────
// Lightweight JSON-backed store so referral codes + attribution survive
// restarts. Each customer gets a 6-char code. Invites are tracked per code.
const REFERRAL_STORE_FILE = path.join(__dirname, 'referral-store.json');
const referralStore = {
  // code -> { code, ownerCustomerId, createdAt, invites: [{ referredCustomerId, createdAt, rewarded }] }
  byCode: new Map(),
  // customerId -> code (reverse lookup)
  ownerByCustomer: new Map(),
};

function loadReferralStore() {
  try {
    if (!fs.existsSync(REFERRAL_STORE_FILE)) return;
    const raw = fs.readFileSync(REFERRAL_STORE_FILE, 'utf8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    const byCode = parsed?.byCode || [];
    for (const entry of byCode) {
      if (entry?.code) {
        referralStore.byCode.set(entry.code, entry);
        if (entry.ownerCustomerId) {
          referralStore.ownerByCustomer.set(entry.ownerCustomerId, entry.code);
        }
      }
    }
  } catch (error) {
    console.error('FAILED TO LOAD REFERRAL STORE:', error.message);
  }
}

function persistReferralStore() {
  const data = Array.from(referralStore.byCode.values());
  fs.writeFileSync(REFERRAL_STORE_FILE, JSON.stringify({ byCode: data }, null, 2));
}

function generateReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function getOrCreateReferralCode(customerId) {
  const existing = referralStore.ownerByCustomer.get(customerId);
  if (existing) return existing;

  let code = generateReferralCode();
  let guard = 0;
  while (referralStore.byCode.has(code) && guard < 20) {
    code = generateReferralCode();
    guard += 1;
  }

  const entry = {
    code,
    ownerCustomerId: customerId,
    createdAt: Date.now(),
    invites: [],
  };
  referralStore.byCode.set(code, entry);
  referralStore.ownerByCustomer.set(customerId, code);
  persistReferralStore();
  return code;
}

function getReferralEntry(customerId) {
  const code = referralStore.ownerByCustomer.get(customerId);
  return code ? referralStore.byCode.get(code) || null : null;
}

loadReferralStore();

// ─── Reward / referral routes (moved to routes/rewards.js — ledger-backed) ─

app.get('/', (req, res) => {
  res.send(`Backend is running on ${BACKEND_BASE_URL}`);
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    backend_base_url: BACKEND_BASE_URL,
    local_ip: LOCAL_IP,
    port: PORT,
    has_wipay_account: Boolean(WIPAY_ACCOUNT_NUMBER),
    has_shopify_domain: Boolean(SHOPIFY_STORE_DOMAIN),
    has_shopify_token: hasAdminCredentials(),
  });
});

// Probe payment schema without retrieving customer or payment records.
app.get('/health/database', apiLimiter, async (_req, res) => {
  const { supabaseAdmin } = require('./utils/supabase-admin');
  if (!supabaseAdmin) return res.status(503).json({ ok: false, configured: false });
  try {
    const { error } = await supabaseAdmin.from('payment_sessions')
      .select('provider_order_id,status,capture_id,quote').limit(0);
    if (error) return res.status(503).json({ ok: false, configured: true, paymentStorageReady: false });
    return res.json({ ok: true, configured: true, paymentStorageReady: true });
  } catch (_error) {
    return res.status(503).json({ ok: false, configured: true, paymentStorageReady: false });
  }
});

// Read-only readiness check: verifies the current store credential and order scope.
app.get('/health/shopify', apiLimiter, async (_req, res) => {
  try {
    const token = await getAdminToken();
    const { data } = await axios.get(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_scopes.json`, {
      headers: { 'X-Shopify-Access-Token': token }, timeout: 15000,
    });
    const canCreateOrders = (data?.access_scopes || []).some(scope => scope.handle === 'write_orders');
    return res.status(canCreateOrders ? 200 : 503).json({ ok: canCreateOrders, store: SHOPIFY_STORE_DOMAIN, canCreateOrders });
  } catch (_error) {
    return res.status(503).json({ ok: false, canCreateOrders: false, error: 'Shopify order connection unavailable' });
  }
});

app.use(require('./routes/wipay')({ createShopifyOrder, buildAppRedirect, baseUrl: BACKEND_BASE_URL }));

async function createShopifyOrder({
  email,
  phone,
  name,
  total,
  currency,
  cartItems,
  pricedCart,
  gateway = 'WiPay',
  paymentTransactionId,
  wipayTransactionId,
  clientOrderId,
  shippingAddress = {},
  userId = null,
  isTestPayment = false,
}) {
  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN in .env');
  }

  if (!hasAdminCredentials()) {
    throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN in .env');
  }

  const [firstName, ...rest] = safeString(name, 'NOOD Customer').split(' ');
  const lastName = rest.join(' ') || 'Customer';

  const trusted = pricedCart || await require('./services/catalog-pricing').priceCart(cartItems);
  const trustedCurrency = safeString(currency || trusted.currency, 'USD').toUpperCase();
  const trustedTotal = safeMoney(trusted.total || trusted.subtotal);
  if (trustedCurrency !== trusted.currency || safeMoney(total) !== trustedTotal) {
    throw new Error('Payment amount does not match the server-authoritative cart price');
  }
  const lineItems = trusted.lines.map((item) => ({
    variantId: item.variantId,
    quantity: item.quantity,
  }));

  const query = `
    mutation orderCreate($order: OrderCreateOrderInput!) {
      orderCreate(order: $order) {
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
    order: {
      test: isTestPayment || (gateway === 'PayPal'
        ? String(process.env.PAYPAL_ENVIRONMENT || 'sandbox').toLowerCase() !== 'live'
        : gateway === 'WiPay' && String(process.env.WIPAY_ENVIRONMENT || 'sandbox').toLowerCase() !== 'live'),
      email: email || undefined,
      phone: phone || undefined,
      tags: ['NOOD App', gateway],
      note: `${gateway} transaction: ${paymentTransactionId || wipayTransactionId} | Client order: ${clientOrderId}`,
      billingAddress: {
        firstName: firstName || 'NOOD',
        lastName: lastName || 'Customer',
        phone: phone || undefined,
      },
      shippingAddress: {
        firstName: safeString(shippingAddress.firstName || shippingAddress.fullName || name, firstName),
        lastName: safeString(shippingAddress.lastName, lastName),
        address1: safeString(shippingAddress.address1) || undefined,
        address2: safeString(shippingAddress.address2) || undefined,
        city: safeString(shippingAddress.city) || undefined,
        provinceCode: /^[A-Z0-9-]{1,6}$/.test(safeString(shippingAddress.region || shippingAddress.state))
          ? safeString(shippingAddress.region || shippingAddress.state) : undefined,
        zip: safeString(shippingAddress.postalCode || shippingAddress.zip) || undefined,
        countryCode: require('./utils/shopify-country').countryCode(shippingAddress.country || 'TT'),
        phone: safeString(shippingAddress.phone || phone) || undefined,
      },
      lineItems,
      ...(Number(trusted.discount || 0) > 0 && trusted.coupon?.code
        ? {
            discountCode: {
              itemFixedDiscountCode: {
                code: trusted.coupon.code,
                amountSet: {
                  shopMoney: {
                    amount: safeMoney(trusted.discount),
                    currencyCode: trustedCurrency,
                  },
                },
              },
            },
          }
        : {}),
      transactions: [
        {
          kind: 'SALE',
          status: 'SUCCESS',
          gateway,
          amountSet: {
            shopMoney: {
              amount: safeMoney(total),
              currencyCode: trustedCurrency,
            },
          },
        },
      ],
    },
  };

  const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

  const response = await axios.post(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    { query, variables },
    {
      headers: {
        'X-Shopify-Access-Token': await getAdminToken(),
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const payload = response.data;
  const result = payload?.data?.orderCreate;
  const errors = result?.userErrors || [];
  const topErrors = payload?.errors || [];

  if (topErrors.length > 0) {
    console.error('SHOPIFY GRAPHQL TOP ERRORS:', topErrors);
    throw new Error(topErrors[0]?.message || 'Shopify GraphQL error');
  }

  if (!result?.order || errors.length > 0) {
    console.error('SHOPIFY ORDER CREATE ERROR:', errors, payload);
    throw new Error(errors[0]?.message || 'Failed to create Shopify order');
  }

  try {
    const { upsertOrder } = require('./utils/order-sync');
    await upsertOrder({
      ...result.order,
      email,
      total: trustedTotal,
      currency: trustedCurrency,
      status: 'paid',
      items: trusted.lines,
      payment_provider: gateway,
      payment_transaction_id: paymentTransactionId || wipayTransactionId,
      created_at: new Date().toISOString(),
    }, userId);
  } catch (error) {
    console.error('[ORDER SYNC] Paid order persistence failed:', error.message);
  }

  return result.order;
}

// Expose helpers for payment router modules (wallet + PayPal order creation).
module.exports = { createShopifyOrder, safeString, safeMoney };

app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================================');
  console.log(`  NOOD Backend running on ${BACKEND_BASE_URL}`);
  console.log('============================================================');

  const missing = [];
  if (!WIPAY_ACCOUNT_NUMBER || WIPAY_ACCOUNT_NUMBER === 'your_wipay_account_number') {
    missing.push('WIPAY_ACCOUNT_NUMBER (real WiPay merchant account number)');
  }
  if (WIPAY_ENVIRONMENT === 'sandbox') {
    console.warn('  ⚠ WIPAY_ENVIRONMENT=sandbox — payments are in TEST mode.');
  }
  if (!SHOPIFY_STORE_DOMAIN || SHOPIFY_STORE_DOMAIN === 'your-store.myshopify.com') {
    missing.push('SHOPIFY_STORE_DOMAIN (e.g. noodcaribbean.myshopify.com)');
  }
  if (!hasAdminCredentials()) {
    missing.push('SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or legacy Admin token)');
  }

  if (missing.length > 0) {
    console.error('');
    console.error('  ❌ LAUNCH BLOCKED: Missing production credentials in .env');
    missing.forEach((item) => console.error(`     - ${item}`));
    console.error('     Checkout / order creation will FAIL until these are set.');
    console.error('');
  } else {
    console.log('  ✅ All production credentials present.');
  }

  // Start background jobs (wrapped so a job failure never crashes the server)
  console.log('[JOBS] Starting background jobs...');
  if (!backgroundJobsPaused) {
  try {
    require('./jobs/cart-abandonment');
  } catch (error) {
    console.error('[JOBS] cart-abandonment failed to start:', error.message);
  }
  try {
    require('./jobs/inventory-sync');
  } catch (error) {
    console.error('[JOBS] inventory-sync failed to start:', error.message);
  }

  // Mount webhook routes
  } else { console.log('[JOBS] Background notification and inventory jobs paused for this local session.'); }

  // Mount webhook routes
  try {
    const { router: webhookRouter } = require('./routes/webhooks');
    app.use('/', webhookRouter);
  } catch (error) {
    console.error('[JOBS] webhooks failed to mount:', error.message);
  }

  // Mount video feed engagement routes
  try {
    const { router: videoFeedRouter } = require('./routes/video-feed');
    app.use('/', videoFeedRouter);
  } catch (error) {
    console.error('[JOBS] video-feed routes failed to mount:', error.message);
  }

  // Mount style challenges routes
  try {
    const { router: challengesRouter } = require('./routes/style-challenges');
    app.use('/', challengesRouter);
  } catch (error) {
    console.error('[JOBS] style-challenges routes failed to mount:', error.message);
  }

  // Mount cart sync routes
  try {
    const { router: cartRouter } = require('./routes/cart');
    app.use('/', cartRouter);
  } catch (error) {
    console.error('[JOBS] cart routes failed to mount:', error.message);
  }

  // Mount payment routes (PayPal order create/capture + wallet checkout)
  try {
    const { router: paymentsRouter } = require('./routes/payments');
    app.use('/', paymentsRouter);
  } catch (error) {
    console.error('[JOBS] payment routes failed to mount:', error.message);
  }

  // Mount server-authoritative promotions and coupon quote routes.
  try {
    const { router: promotionsRouter } = require('./routes/promotions');
    app.use('/', promotionsRouter);
  } catch (error) {
    console.error('[JOBS] promotions routes failed to mount:', error.message);
  }

  // Mount support, verified reviews, consented analytics, and security events.
  try {
    const { router: platformRouter } = require('./routes/platform');
    app.use('/', platformRouter);
  } catch (error) {
    console.error('[JOBS] platform routes failed to mount:', error.message);
  }

  // Authenticated deterministic support assistant. Human support cases remain
  // authoritative and are reused for handoff.
  try {
    const { router: supportAssistantRouter } = require('./routes/support-assistant');
    app.use('/', supportAssistantRouter);
  } catch (error) {
    console.error('[JOBS] support assistant routes failed to mount:', error.message);
  }

  // Mount catalog routes (menus, etc.)
  try {
    const { router: catalogRouter } = require('./routes/catalog');
    app.use('/', catalogRouter);
  } catch (error) {
    console.error('[JOBS] catalog routes failed to mount:', error.message);
  }

  // Mount push notification routes
  try {
    const { router: notificationsRouter } = require('./routes/notifications');
    app.use('/', notificationsRouter);
  } catch (error) {
    console.error('[JOBS] notifications routes failed to mount:', error.message);
  }

  // Mount order tracking routes
  try {
    const { router: trackingRouter } = require('./routes/tracking');
    app.use('/', trackingRouter);
  } catch (error) {
    console.error('[JOBS] tracking routes failed to mount:', error.message);
  }

  // Mount refunds/returns routes
  try {
    const { router: refundsRouter } = require('./routes/refunds');
    app.use('/', refundsRouter);
  } catch (error) {
    console.error('[JOBS] refunds routes failed to mount:', error.message);
  }

  // Mount wishlist sync routes
  try {
    const { router: wishlistRouter } = require('./routes/wishlist');
    app.use('/', wishlistRouter);
  } catch (error) {
    console.error('[JOBS] wishlist routes failed to mount:', error.message);
  }

  // Mount rewards / games / wallet routes (ledger-backed)
  try {
    const { router: rewardsRouter } = require('./routes/rewards');
    app.use('/', rewardsRouter);
  } catch (error) {
    console.error('[JOBS] rewards routes failed to mount:', error.message);
  }

  // Start the real-trigger engine (wishlist / cart / referral scans).
  if (!backgroundJobsPaused) {
  try {
    const { runNotificationTriggers } = require('./jobs/notification-triggers');
    const triggerIntervalMs = Number(process.env.PUSH_TRIGGER_INTERVAL_MINUTES || 15) * 60 * 1000;
    setInterval(() => {
      runNotificationTriggers().catch((error) =>
        console.error('[TRIGGERS] interval error:', error.message)
      );
    }, triggerIntervalMs);
    setTimeout(() => {
      runNotificationTriggers().catch((error) =>
        console.error('[TRIGGERS] startup error:', error.message)
      );
    }, 20000);
    console.log('[TRIGGERS] real-trigger engine started');
  } catch (error) {
    console.error('[TRIGGERS] failed to start:', error.message);
  }

  // Start automated notification campaigns (Temu-style pushes with
  // frequency control + dedupe). Replaces the old new-product-campaign job,
  // which directly hit Expo's API — new-product pushes now fire from
  // inventory-sync via the centralized delivery service.
  try {
    const { runCampaigns } = require('./jobs/notification-campaigns');
    const intervalMs = Number(process.env.PUSH_CAMPAIGN_INTERVAL_MINUTES || 15) * 60 * 1000;
    setInterval(() => {
      runCampaigns().catch((error) =>
        console.error('[JOBS] notification-campaigns interval error:', error.message)
      );
    }, intervalMs);
    setTimeout(() => {
      runCampaigns().catch((error) =>
        console.error('[JOBS] notification-campaigns startup error:', error.message)
      );
    }, 30000);
    console.log('[JOBS] notification-campaigns engine started');
  } catch (error) {
    console.error('[JOBS] notification-campaigns failed to start:', error.message);
  }

  // Serve the push-sender admin page at /push (self-contained copy)
  }

  // Serve the push-sender admin page at /push (self-contained copy)
  const fs2 = require('fs');
  const pushPagePath = path.join(__dirname, 'public-push-sender.html');
  app.get('/push', (req, res) => {
    try {
      if (fs2.existsSync(pushPagePath)) {
        res.set('Content-Type', 'text/html');
        res.send(fs2.readFileSync(pushPagePath, 'utf8'));
        return;
      }
    } catch (error) {
      console.error('[PUSH] failed to serve page:', error.message);
    }
    res.status(404).send('Push sender page not found');
  });

  // Serve the admin Campaign Center page at /campaign-center.
  const campaignCenterPath = path.join(__dirname, 'public-campaign-center.html');
  app.get('/campaign-center', (req, res) => {
    try {
      if (fs2.existsSync(campaignCenterPath)) {
        res.set('Content-Type', 'text/html');
        res.send(fs2.readFileSync(campaignCenterPath, 'utf8'));
        return;
      }
    } catch (error) {
      console.error('[CAMPAIGN CENTER] failed to serve page:', error.message);
    }
    res.status(404).send('Campaign Center page not found');
  });
});

