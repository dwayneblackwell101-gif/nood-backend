const crypto = require('crypto');

const TERMINAL_STATES = new Set(['completed', 'failed', 'refunded']);
const VALID_TRANSITIONS = new Map([
  ['created', new Set(['provider_pending', 'provider_approved', 'provider_verified', 'failed', 'recovery_required'])],
  ['provider_pending', new Set(['provider_approved', 'provider_verified', 'failed', 'recovery_required'])],
  ['provider_approved', new Set(['provider_verified', 'failed', 'recovery_required'])],
  ['provider_verified', new Set(['order_creating', 'wallet_crediting', 'completed', 'failed', 'recovery_required'])],
  ['wallet_crediting', new Set(['completed', 'recovery_required', 'failed'])],
  ['order_creating', new Set(['completed', 'recovery_required', 'failed'])],
  ['recovery_required', new Set(['order_creating', 'completed', 'failed'])],
  ['completed', new Set(['partially_refunded', 'refunded'])],
  ['partially_refunded', new Set(['refunded'])],
  ['failed', new Set([])],
  ['refunded', new Set([])],
]);

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createPaymentId(provider = 'payment') {
  return `${safeString(provider, 'payment')}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function publicPayment(record) {
  if (!record) return null;
  const { rawProviderPayload, ...safeRecord } = record;
  return safeRecord;
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function assertTransition(fromState, toState) {
  if (!fromState || fromState === toState) return;
  const allowed = VALID_TRANSITIONS.get(fromState);
  if (!allowed || !allowed.has(toState)) {
    const error = new Error(`Invalid payment state transition ${fromState} -> ${toState}.`);
    error.statusCode = 409;
    throw error;
  }
}

function createPaymentStateService({ redis, namespace = 'nood' } = {}) {
  if (!redis) return null;

  const paymentKey = (paymentId) => `${namespace}:payment:${safeString(paymentId)}`;
  const providerKey = (provider, providerTransactionId) =>
    `${namespace}:payment:provider:${safeString(provider).toLowerCase()}:${safeString(providerTransactionId)}`;
  const idempotencyKey = (operationKey) => `${namespace}:payment:idempotency:${safeString(operationKey)}`;

  async function getPayment(paymentId) {
    return parseJson(await redis.get(paymentKey(paymentId)));
  }

  async function getByProviderTransaction(provider, providerTransactionId) {
    const paymentId = await redis.get(providerKey(provider, providerTransactionId));
    return paymentId ? getPayment(paymentId) : null;
  }

  async function getByIdempotency(operationKey) {
    const paymentId = await redis.get(idempotencyKey(operationKey));
    return paymentId ? getPayment(paymentId) : null;
  }

  async function createPayment(input = {}) {
    const now = new Date().toISOString();
    const paymentId = safeString(input.paymentId) || createPaymentId(input.provider);
    const operationKey = safeString(input.idempotencyKey || input.operationKey || paymentId);
    const existing = await getByIdempotency(operationKey);
    if (existing) return { record: existing, duplicate: true };

    const record = {
      paymentId,
      provider: safeString(input.provider),
      providerOrderId: safeString(input.providerOrderId) || null,
      providerTransactionId: safeString(input.providerTransactionId) || null,
      purpose: safeString(input.purpose || input.paymentPurpose) || null,
      expectedAmountCents: Number(input.expectedAmountCents || 0),
      expectedCurrency: safeString(input.expectedCurrency, 'USD').toUpperCase(),
      providerAmountCents: Number(input.providerAmountCents || input.expectedAmountCents || 0),
      providerCurrency: safeString(input.providerCurrency || input.expectedCurrency, 'USD').toUpperCase(),
      customerId: safeString(input.customerId),
      cartFingerprint: safeString(input.cartFingerprint) || null,
      state: safeString(input.state, 'created'),
      shopifyOrderId: null,
      shopifyOrderName: null,
      walletTransactionId: null,
      walletCredited: false,
      walletDebited: false,
      refundTotalCents: 0,
      idempotencyKey: operationKey,
      createdAt: now,
      updatedAt: now,
      transitions: [{ state: safeString(input.state, 'created'), at: now }],
      lastSafeErrorCode: null,
      metadata: input.metadata || {},
    };

    const multi = redis.multi().set(paymentKey(paymentId), JSON.stringify(record)).set(idempotencyKey(operationKey), paymentId);
    if (record.providerTransactionId) {
      multi.set(providerKey(record.provider, record.providerTransactionId), paymentId, 'NX');
    }
    if (record.providerOrderId) {
      multi.set(providerKey(record.provider, record.providerOrderId), paymentId, 'NX');
    }
    await multi.exec();
    return { record, duplicate: false };
  }

  async function transitionPayment(paymentId, nextState, patch = {}) {
    const existing = await getPayment(paymentId);
    if (!existing) {
      const error = new Error('Payment record not found.');
      error.statusCode = 404;
      throw error;
    }

    if (TERMINAL_STATES.has(existing.state) && existing.state !== nextState) {
      const error = new Error('Terminal payment state cannot be overwritten.');
      error.statusCode = 409;
      throw error;
    }

    assertTransition(existing.state, nextState);
    const now = new Date().toISOString();
    const record = {
      ...existing,
      ...patch,
      state: nextState,
      updatedAt: now,
      transitions: [...(existing.transitions || []), { state: nextState, at: now }],
    };
    await redis.set(paymentKey(paymentId), JSON.stringify(record));

    if (record.providerOrderId) {
      await redis.set(providerKey(record.provider, record.providerOrderId), paymentId, 'NX');
    }
    if (record.providerTransactionId) {
      await redis.set(providerKey(record.provider, record.providerTransactionId), paymentId, 'NX');
    }
    return record;
  }

  return {
    createPayment,
    getByIdempotency,
    getByProviderTransaction,
    getPayment,
    publicPayment,
    transitionPayment,
    keys: { idempotencyKey, paymentKey, providerKey },
  };
}

module.exports = {
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  assertTransition,
  createPaymentStateService,
  publicPayment,
};
