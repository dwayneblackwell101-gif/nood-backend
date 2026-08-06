require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');

// Ensure raw body parsing for Shopify webhook verification
const rawBodyMiddleware = (req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
};

const app = express();

app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/webhooks', rawBodyMiddleware); // Raw body only for webhooks

const pendingOrders = new Map();
const PENDING_ORDERS_FILE = path.join(__dirname, 'pending-orders.json');

const PORT = Number(process.env.PORT || 3000);
const LOCAL_IP = process.env.LOCAL_IP || '192.168.100.238';
const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL || `http://${LOCAL_IP}:${PORT}`;

const WIPAY_ACCOUNT_NUMBER = process.env.WIPAY_ACCOUNT_NUMBER;
const WIPAY_ENVIRONMENT = process.env.WIPAY_ENVIRONMENT || 'sandbox';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

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

// ─── Reward / referral routes ────────────────────────────────────────────

app.get('/api/rewards/status', (req, res) => {
  const customerId = safeString(req.query.customerId, '');
  if (!customerId) {
    return res.status(400).json({ success: false, message: 'customerId is required' });
  }

  const code = getOrCreateReferralCode(customerId);
  const entry = getReferralEntry(customerId);
  const invites = entry?.invites || [];

  const rewardedCount = invites.filter((i) => i.rewarded).length;
  const invitedCount = invites.length;
  const goal = 5;
  const now = Date.now();
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;

  return res.json({
    success: true,
    customerId,
    walletBalance: '0.00',
    currency: 'USD',
    challenges: [
      {
        id: 'invite_5_friends_7_days',
        title: 'Invite 5 friends in 7 days',
        subtitle: 'Earn $10 NOOD Balance',
        rewardAmount: 10,
        rewardCurrency: 'USD',
        rewardLabel: '$10 USD',
        inviteGoal: goal,
        invitedCount,
        daysLeft: 7,
        expiresAt: new Date(expiresAt).toISOString(),
        startedAt: new Date(entry?.createdAt || now).toISOString(),
        shareCount: invitedCount,
        referralCode: code,
        referralLink: `https://noodcaribbean.com/invite?code=${code}`,
        claimed: rewardedCount >= goal,
        eligibleToClaim: invitedCount >= goal,
        claimReason: invitedCount >= goal ? 'eligible' : 'complete_challenge_first',
      },
    ],
  });
});

app.post('/api/rewards/referral/share', (req, res) => {
  const customerId = safeString(req.body?.customerId, '');
  if (!customerId) {
    return res.status(400).json({ success: false, message: 'customerId is required' });
  }

  const code = getOrCreateReferralCode(customerId);
  const entry = getReferralEntry(customerId);
  const invitedCount = entry?.invites?.length || 0;

  return res.json({
    success: true,
    referralCode: code,
    referralLink: `https://noodcaribbean.com/invite?code=${code}`,
    shareMessage: `Join me on NOOD and we both earn $10 in store credit! Use my code ${code}`,
    invitedCount,
  });
});

app.post('/api/rewards/referral/attributed', (req, res) => {
  const referralCode = safeString(req.body?.referralCode, '').toUpperCase();
  const referredCustomerId = safeString(req.body?.referredCustomerId, '');

  if (!referralCode || !referredCustomerId) {
    return res.status(400).json({ success: false, message: 'referralCode and referredCustomerId are required' });
  }

  const entry = referralStore.byCode.get(referralCode);
  if (!entry) {
    return res.status(404).json({ success: false, message: 'Invalid referral code' });
  }

  if (entry.ownerCustomerId === referredCustomerId) {
    return res.status(400).json({ success: false, message: 'Cannot refer yourself' });
  }

  const invites = entry.invites || [];
  if (!invites.some((i) => i.referredCustomerId === referredCustomerId)) {
    invites.push({
      referredCustomerId,
      createdAt: Date.now(),
      rewarded: false,
    });
    entry.invites = invites;
    persistReferralStore();
  }

  return res.json({
    success: true,
    message: 'Referral attributed',
    referralCode,
    invitedCount: invites.length,
  });
});

app.post('/api/rewards/claim', (req, res) => {
  const customerId = safeString(req.body?.customerId, '');
  const challengeId = safeString(req.body?.challengeId, 'invite_5_friends_7_days');
  if (!customerId) {
    return res.status(400).json({ success: false, message: 'customerId is required' });
  }

  const entry = getReferralEntry(customerId);
  const invites = entry?.invites || [];

  if (invites.length < 5) {
    return res.status(400).json({
      success: false,
      message: 'Invite 5 friends before claiming',
      invitedCount: invites.length,
    });
  }

  const alreadyClaimed = invites.length >= 5 && invites.slice(0, 5).every((i) => i.rewarded);
  if (alreadyClaimed) {
    return res.status(400).json({
      success: false,
      message: 'Reward already claimed',
      code: 'already_claimed',
    });
  }

  // Mark first 5 invites as rewarded
  let marked = 0;
  for (const invite of invites) {
    if (marked >= 5) break;
    if (!invite.rewarded) {
      invite.rewarded = true;
      marked += 1;
    }
  }
  persistReferralStore();

  return res.json({
    success: true,
    message: 'Reward claimed — $10 NOOD Balance added',
    rewardAmount: 10,
    rewardCurrency: 'USD',
    walletBalance: '10.00',
    challengeId,
  });
});

app.get('/api/rewards/scratch/status', (req, res) => {
  const customerId = safeString(req.query.customerId, '');
  return res.json({
    success: true,
    customerId,
    canPlay: false,
    scratchTokens: 0,
    nextAvailableAt: null,
    completedAt: null,
    cooldownDaysRemaining: 0,
    alreadyClaimed: false,
    popupEligible: false,
  });
});

app.get('/api/rewards/lucky-spin/status', (req, res) => {
  const customerId = safeString(req.query.customerId, '');
  return res.json({
    success: true,
    customerId,
    canSpin: false,
    used: false,
    luckySpinUsedAt: null,
    luckySpinRewardAmountUsd: null,
    alreadyClaimed: false,
    demoOnly: true,
  });
});

app.post('/api/rewards/lucky-spin/spin', (req, res) => {
  const customerId = safeString(req.body?.customerId, '');
  return res.json({
    success: true,
    message: 'Lucky spin recorded (demo)',
    customerId,
  });
});

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
    has_shopify_token: Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN),
  });
});

app.post('/create-wipay-payment', async (req, res) => {
  try {
    const { total, name, email, phone, cartItems = [] } = req.body;

    if (!WIPAY_ACCOUNT_NUMBER) {
      return res.status(500).json({
        error: true,
        message: 'Missing WIPAY_ACCOUNT_NUMBER in .env',
      });
    }

    if (!isValidPositiveMoney(total)) {
      return res.status(400).json({
        error: true,
        message: 'Invalid total. Minimum is 1.00.',
      });
    }

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({
        error: true,
        message: 'Cart is empty.',
      });
    }

    const parsedTotal = safeMoney(total);
    const customerName = safeString(name, 'NOOD Customer');
    const customerEmail = safeString(email, 'test@example.com');
    const customerPhone = safeString(phone, '8680000000');

    const orderId = `order_${Date.now()}`;

    const returnToken = generateReturnToken();

    setPendingOrder(orderId, {
      type: 'checkout',
      orderId,
      returnToken,
      total: parsedTotal,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      cartItems,
      createdAt: Date.now(),
    });

    const payload = new URLSearchParams({
      account_number: WIPAY_ACCOUNT_NUMBER,
      country_code: 'TT',
      currency: 'TTD',
      environment: WIPAY_ENVIRONMENT,
      fee_structure: 'customer_pay',
      method: 'credit_card',
      order_id: orderId,
      origin: 'nood_app',
      response_url: `${BACKEND_BASE_URL}/payment-return?order_id=${encodeURIComponent(orderId)}&return_token=${encodeURIComponent(returnToken)}`,
      total: parsedTotal,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
    });

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

    if (!paymentUrl) {
      return res.status(500).json({
        error: true,
        message: 'WiPay did not return a payment URL.',
        raw: response.data,
      });
    }

    return res.json({
      success: true,
      url: paymentUrl,
      payment_url: paymentUrl,
      message: response.data?.message || 'OK',
      transaction_id: response.data?.transaction_id || null,
      order_id: orderId,
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('WiPay CHECKOUT ERROR:', errorData);

    return res.status(500).json({
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || 'WiPay request failed',
      raw: errorData,
    });
  }
});

app.post('/create-wallet-topup', async (req, res) => {
  try {
    const { amount, name, email, phone } = req.body;

    if (!WIPAY_ACCOUNT_NUMBER) {
      return res.status(500).json({
        error: true,
        message: 'Missing WIPAY_ACCOUNT_NUMBER in .env',
      });
    }

    if (!isValidPositiveMoney(amount)) {
      return res.status(400).json({
        error: true,
        message: 'Invalid amount. Minimum is 1.00.',
      });
    }

    const parsedAmount = safeMoney(amount);
    const customerName = safeString(name, 'NOOD Customer');
    const customerEmail = safeString(email, 'test@example.com');
    const customerPhone = safeString(phone, '8680000000');

    const orderId = `wallet_${Date.now()}`;

    const returnToken = generateReturnToken();

    setPendingOrder(orderId, {
      type: 'wallet_topup',
      orderId,
      returnToken,
      amount: parsedAmount,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      createdAt: Date.now(),
    });

    const payload = new URLSearchParams({
      account_number: WIPAY_ACCOUNT_NUMBER,
      country_code: 'TT',
      currency: 'TTD',
      environment: WIPAY_ENVIRONMENT,
      fee_structure: 'customer_pay',
      method: 'credit_card',
      order_id: orderId,
      origin: 'nood_app',
      response_url: `${BACKEND_BASE_URL}/payment-return?order_id=${encodeURIComponent(orderId)}&return_token=${encodeURIComponent(returnToken)}`,
      total: parsedAmount,
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
    });

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

    if (!paymentUrl) {
      return res.status(500).json({
        error: true,
        message: 'WiPay did not return a payment URL.',
        raw: response.data,
      });
    }

    return res.json({
      success: true,
      url: paymentUrl,
      payment_url: paymentUrl,
      message: response.data?.message || 'OK',
      transaction_id: response.data?.transaction_id || null,
      order_id: orderId,
    });
  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('WiPay WALLET TOPUP ERROR:', errorData);

    return res.status(500).json({
      error: true,
      message:
        typeof errorData === 'string'
          ? errorData
          : errorData?.message || 'Top-up failed',
      raw: errorData,
    });
  }
});

app.get('/payment-return', async (req, res) => {
  try {
    const rawStatus = getReturnStatus(req.query);
    const orderId = getReturnOrderId(req.query);
    const transactionId = getReturnTransactionId(req.query);
    const returnToken = getReturnToken(req.query);

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
      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'failed',
          order_id: orderId,
          transaction_id: transactionId,
          reason: 'invalid_return_token',
          method: 'wipay',
        })
      );
    }

    if (!isSuccess) {
      const failStatus = isCancelled ? 'cancelled' : 'failed';

      removePendingOrder(orderId);

      return res.redirect(
        buildAppRedirect('payment-result', {
          status: failStatus,
          order_id: orderId,
          transaction_id: transactionId,
          method: 'wipay',
        })
      );
    }

    if (pending.type === 'wallet_topup') {
      removePendingOrder(orderId);

      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'success',
          type: 'wallet_topup',
          order_id: orderId,
          transaction_id: transactionId,
          amount: pending.amount,
          method: 'wipay',
        })
      );
    }

    let shopifyOrder = null;

    try {
      shopifyOrder = await createShopifyOrder({
        email: pending.email,
        phone: pending.phone,
        name: pending.name,
        total: pending.total,
        cartItems: pending.cartItems,
        wipayTransactionId: transactionId,
        clientOrderId: orderId,
      });
    } catch (shopifyError) {
      console.error(
        'SHOPIFY ORDER CREATE FAILED AFTER PAYMENT:',
        shopifyError.response?.data || shopifyError.message
      );

      return res.redirect(
        buildAppRedirect('payment-result', {
          status: 'failed',
          type: 'checkout',
          order_id: orderId,
          transaction_id: transactionId,
          reason: 'shopify_order_create_failed',
          amount: pending.total,
          method: 'wipay',
        })
      );
    }

    removePendingOrder(orderId);

    return res.redirect(
      buildAppRedirect('payment-result', {
        status: 'success',
        type: 'checkout',
        order_id: orderId,
        transaction_id: transactionId,
        shopify_order_id: shopifyOrder?.id || '',
        shopify_order_name: shopifyOrder?.name || '',
        amount: pending.total,
        method: 'wipay',
      })
    );
  } catch (error) {
    console.error('PAYMENT RETURN ERROR:', error.response?.data || error.message);

    return res.redirect(
      buildAppRedirect('payment-result', {
        status: 'failed',
        reason: 'server_error',
        method: 'wipay',
      })
    );
  }
});

async function createShopifyOrder({
  email,
  phone,
  name,
  total,
  cartItems,
  wipayTransactionId,
  clientOrderId,
}) {
  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN in .env');
  }

  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN in .env');
  }

  const [firstName, ...rest] = safeString(name, 'NOOD Customer').split(' ');
  const lastName = rest.join(' ') || 'Customer';

  const lineItems = (Array.isArray(cartItems) ? cartItems : []).map((item) => {
    const quantity = Number(item?.quantity || 1);
    const price = safeMoney(item?.price || 0);
    const rawVariantId = item?.variantId ? String(item.variantId) : '';

    const baseItem = {
      title: safeString(item?.title, 'Product'),
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      priceSet: {
        shopMoney: {
          amount: price,
          currencyCode: 'TTD',
        },
      },
    };

    if (rawVariantId) {
      return {
        ...baseItem,
        variantId: `gid://shopify/ProductVariant/${rawVariantId}`,
      };
    }

    return baseItem;
  });

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
      email: email || undefined,
      phone: phone || undefined,
      tags: ['NOOD App', 'WiPay'],
      note: `WiPay transaction: ${wipayTransactionId} | Client order: ${clientOrderId}`,
      billingAddress: {
        firstName: firstName || 'NOOD',
        lastName: lastName || 'Customer',
        phone: phone || undefined,
      },
      lineItems,
      transactions: [
        {
          kind: 'SALE',
          status: 'SUCCESS',
          gateway: 'WiPay',
          amountSet: {
            shopMoney: {
              amount: safeMoney(total),
              currencyCode: 'TTD',
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
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
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

  return result.order;
}

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
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN || SHOPIFY_ADMIN_ACCESS_TOKEN === 'your_shopify_admin_access_token') {
    missing.push('SHOPIFY_ADMIN_ACCESS_TOKEN (Admin API access token)');
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

  // Mount catalog routes (menus, etc.)
  try {
    const { router: catalogRouter } = require('./routes/catalog');
    app.use('/', catalogRouter);
  } catch (error) {
    console.error('[JOBS] catalog routes failed to mount:', error.message);
  }
});
