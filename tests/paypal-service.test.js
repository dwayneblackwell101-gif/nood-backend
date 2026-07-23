const assert = require('node:assert/strict');
const test = require('node:test');

const { createPaymentStateService } = require('../payments/payment-state');
const { createPayPalPaymentService } = require('../payments/paypal-service');

function createFakeRedis() {
  const data = new Map();
  const redis = {
    async get(key) {
      return data.get(key) || null;
    },
    async set(key, value, mode) {
      if (mode === 'NX' && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    multi() {
      const commands = [];
      return {
        set(...args) {
          commands.push(args);
          return this;
        },
        async exec() {
          for (const args of commands) {
            await redis.set(...args);
          }
          return commands.map(() => [null, 'OK']);
        },
      };
    },
  };
  return redis;
}

function createLockService() {
  return {
    async withLock(_key, _ttl, fn) {
      return fn();
    },
  };
}

function completedCapture({ id = 'CAPTURE-1', amount = '10.00', currency = 'USD' } = {}) {
  return {
    id: 'ORDER-CAPTURE-RESPONSE',
    status: 'COMPLETED',
    purchase_units: [
      {
        amount: { value: amount, currency_code: currency },
        payments: {
          captures: [
            {
              id,
              status: 'COMPLETED',
              amount: { value: amount, currency_code: currency },
            },
          ],
        },
      },
    ],
  };
}

function createHarness({ captureData = completedCapture(), captureError = null, getOrderData = null } = {}) {
  const paymentState = createPaymentStateService({ redis: createFakeRedis(), namespace: 'test' });
  let createCalls = 0;
  let captureCalls = 0;
  const paypalClient = {
    async createOrder() {
      createCalls += 1;
      return { id: `ORDER-${createCalls}`, status: 'CREATED', links: [] };
    },
    async captureOrder() {
      captureCalls += 1;
      if (captureError) throw captureError;
      return captureData;
    },
    async getOrder() {
      return getOrderData;
    },
  };
  const service = createPayPalPaymentService({
    paymentState,
    lockService: createLockService(),
    paypalClient,
  });

  return {
    paymentState,
    paypalClient,
    service,
    get createCalls() {
      return createCalls;
    },
    get captureCalls() {
      return captureCalls;
    },
  };
}

async function createCheckout(service, overrides = {}) {
  return service.createOrder({
    purpose: 'checkout',
    customerId: 'gid://shopify/Customer/1',
    expectedAmountCents: 1000,
    expectedCurrency: 'USD',
    trustedSnapshot: { cartFingerprint: 'cart-1', total: '10.00' },
    idempotencyKey: 'paypal:hosted:create:session-1',
    referenceId: 'session-1',
    description: 'NOOD order',
    ...overrides,
  });
}

test('PayPal service creates one provider order for duplicate hosted checkout request', async () => {
  const harness = createHarness();

  const first = await createCheckout(harness.service);
  const second = await createCheckout(harness.service);

  assert.equal(first.order.id, 'ORDER-1');
  assert.equal(second.order.id, 'ORDER-1');
  assert.equal(second.duplicate, true);
  assert.equal(harness.createCalls, 1);
});

test('PayPal service rejects idempotency key reuse with different amount or customer', async () => {
  const harness = createHarness();
  await createCheckout(harness.service);

  await assert.rejects(
    () => createCheckout(harness.service, { expectedAmountCents: 1100 }),
    /idempotency key/
  );
  await assert.rejects(
    () => createCheckout(harness.service, { customerId: 'gid://shopify/Customer/2' }),
    /idempotency key/
  );
});

test('PayPal service captures checkout once and returns completed replay without recapture', async () => {
  const harness = createHarness();
  const created = await createCheckout(harness.service);
  let shopifyCalls = 0;

  const first = await harness.service.captureOrder({
    paypalOrderId: created.order.id,
    customerId: 'gid://shopify/Customer/1',
    purpose: 'checkout',
    onCheckoutPaid: async () => {
      shopifyCalls += 1;
      return { success: true, shopifyOrder: { id: 'SHOPIFY-1', name: '#1001' } };
    },
  });
  const replay = await harness.service.captureOrder({
    paypalOrderId: created.order.id,
    customerId: 'gid://shopify/Customer/1',
    purpose: 'checkout',
    onCheckoutPaid: async () => {
      throw new Error('should not create Shopify order again');
    },
  });

  assert.equal(first.completed, true);
  assert.equal(replay.duplicate, true);
  assert.equal(harness.captureCalls, 1);
  assert.equal(shopifyCalls, 1);
});

test('PayPal service rejects amount and currency mismatch', async () => {
  const amountHarness = createHarness({ captureData: completedCapture({ amount: '9.99' }) });
  const amountCreated = await createCheckout(amountHarness.service);
  await assert.rejects(
    () =>
      amountHarness.service.captureOrder({
        paypalOrderId: amountCreated.order.id,
        customerId: 'gid://shopify/Customer/1',
        purpose: 'checkout',
        onCheckoutPaid: async () => ({ success: true }),
      }),
    /amount mismatch/
  );

  const currencyHarness = createHarness({ captureData: completedCapture({ currency: 'TTD' }) });
  const currencyCreated = await createCheckout(currencyHarness.service);
  await assert.rejects(
    () =>
      currencyHarness.service.captureOrder({
        paypalOrderId: currencyCreated.order.id,
        customerId: 'gid://shopify/Customer/1',
        purpose: 'checkout',
        onCheckoutPaid: async () => ({ success: true }),
      }),
    /currency mismatch/
  );
});

test('PayPal service sends timeout with unknown provider status to recovery', async () => {
  const timeout = new Error('timeout');
  timeout.code = 'ETIMEDOUT';
  const harness = createHarness({ captureError: timeout, getOrderData: { status: 'APPROVED' } });
  const created = await createCheckout(harness.service);

  const result = await harness.service.captureOrder({
    paypalOrderId: created.order.id,
    customerId: 'gid://shopify/Customer/1',
    purpose: 'checkout',
    onCheckoutPaid: async () => {
      throw new Error('should not create Shopify order after unknown timeout');
    },
  });

  assert.equal(result.recoveryRequired, true);
  assert.equal(result.record.state, 'recovery_required');
  assert.equal(result.record.lastSafeErrorCode, 'paypal_capture_timeout_unknown');
});

test('PayPal wallet top-up credits once on duplicate capture', async () => {
  const harness = createHarness({ captureData: completedCapture({ amount: '25.00' }) });
  const created = await harness.service.createOrder({
    purpose: 'wallet_topup',
    customerId: 'gid://shopify/Customer/1',
    expectedAmountCents: 2500,
    expectedCurrency: 'USD',
    trustedSnapshot: { walletAmountCents: 2500 },
    idempotencyKey: 'paypal:wallet:create:1',
    referenceId: 'wallet-1',
    description: 'NOOD wallet top-up',
  });
  let creditCalls = 0;

  const first = await harness.service.captureOrder({
    paypalOrderId: created.order.id,
    customerId: 'gid://shopify/Customer/1',
    purpose: 'wallet_topup',
    onWalletTopupPaid: async () => {
      creditCalls += 1;
      return { walletTransactionId: 'WALLET-1' };
    },
  });
  const replay = await harness.service.captureOrder({
    paypalOrderId: created.order.id,
    customerId: 'gid://shopify/Customer/1',
    purpose: 'wallet_topup',
    onWalletTopupPaid: async () => {
      throw new Error('should not credit twice');
    },
  });

  assert.equal(first.completed, true);
  assert.equal(replay.duplicate, true);
  assert.equal(creditCalls, 1);
});

test('PayPal service rejects one customer capturing another customer payment', async () => {
  const harness = createHarness();
  const created = await createCheckout(harness.service);

  await assert.rejects(
    () =>
      harness.service.captureOrder({
        paypalOrderId: created.order.id,
        customerId: 'gid://shopify/Customer/2',
        purpose: 'checkout',
        onCheckoutPaid: async () => ({ success: true }),
      }),
    /does not own/
  );
});
