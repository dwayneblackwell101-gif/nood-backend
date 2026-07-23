const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertTransition,
  createPaymentStateService,
} = require('../payments/payment-state');

function createWorkingFakeRedis() {
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
          commands.push(['set', args]);
          return this;
        },
        async exec() {
          for (const args of commands.map((entry) => entry[1])) {
            await redis.set(...args);
          }
          return commands.map(() => [null, 'OK']);
        },
      };
    },
  };
  return redis;
}

test('payment state accepts valid transitions', async () => {
  const service = createPaymentStateService({ redis: createWorkingFakeRedis(), namespace: 'test' });
  const { record } = await service.createPayment({
    provider: 'paypal',
    providerOrderId: 'ORDER-1',
    expectedAmountCents: 1050,
    expectedCurrency: 'USD',
    customerId: 'gid://shopify/Customer/1',
    idempotencyKey: 'checkout-1',
  });

  const verified = await service.transitionPayment(record.paymentId, 'provider_pending');
  const orderCreating = await service.transitionPayment(verified.paymentId, 'provider_verified');
  const completed = await service.transitionPayment(orderCreating.paymentId, 'order_creating');
  const final = await service.transitionPayment(completed.paymentId, 'completed', {
    shopifyOrderId: 'gid://shopify/Order/1',
  });

  assert.equal(final.state, 'completed');
  assert.equal(final.shopifyOrderId, 'gid://shopify/Order/1');
});

test('payment state rejects invalid transition', () => {
  assert.throws(() => assertTransition('created', 'completed'), /Invalid payment state transition/);
});

test('payment state idempotency returns existing record', async () => {
  const service = createPaymentStateService({ redis: createWorkingFakeRedis(), namespace: 'test' });
  const first = await service.createPayment({
    provider: 'paypal',
    expectedAmountCents: 1050,
    expectedCurrency: 'USD',
    customerId: 'gid://shopify/Customer/1',
    idempotencyKey: 'same-operation',
  });
  const second = await service.createPayment({
    provider: 'paypal',
    expectedAmountCents: 2050,
    expectedCurrency: 'USD',
    customerId: 'gid://shopify/Customer/1',
    idempotencyKey: 'same-operation',
  });

  assert.equal(second.duplicate, true);
  assert.equal(second.record.paymentId, first.record.paymentId);
  assert.equal(second.record.expectedAmountCents, 1050);
});

test('payment state rejects terminal overwrite', async () => {
  const service = createPaymentStateService({ redis: createWorkingFakeRedis(), namespace: 'test' });
  const { record } = await service.createPayment({
    provider: 'paypal',
    expectedAmountCents: 1050,
    expectedCurrency: 'USD',
    customerId: 'gid://shopify/Customer/1',
  });

  let current = await service.transitionPayment(record.paymentId, 'provider_pending');
  current = await service.transitionPayment(current.paymentId, 'provider_verified');
  current = await service.transitionPayment(current.paymentId, 'order_creating');
  await service.transitionPayment(current.paymentId, 'completed');

  await assert.rejects(
    () => service.transitionPayment(record.paymentId, 'failed'),
    /Terminal payment state/
  );
});
