const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { priceCart } = require('../checkout/cart-pricing');
const { createPayPalReconciliationService } = require('../payments/reconciliation-service');
const { verifyPayPalPayment } = require('../payments/paypal-verification');

function paypalOrder({ status = 'COMPLETED', amount = '12.34', currency = 'USD', merchant = 'MERCHANT1', refunds = [] } = {}) {
  return {
    id: 'PAYPAL-ORDER-1',
    status: 'COMPLETED',
    purchase_units: [{
      amount: { value: amount, currency_code: currency },
      payee: { merchant_id: merchant },
      payments: {
        captures: [{
          id: 'CAPTURE-1',
          status,
          amount: { value: amount, currency_code: currency },
          payee: { merchant_id: merchant },
        }],
        refunds,
      },
    }],
  };
}

function catalogProduct(overrides = {}) {
  return {
    id: 'gid://shopify/Product/1',
    handle: 'shirt',
    title: 'Shirt',
    status: 'ACTIVE',
    availableForSale: true,
    variants: { edges: [{ node: {
      id: 'gid://shopify/ProductVariant/11',
      title: 'Default',
      availableForSale: true,
      quantityAvailable: 5,
      price: { amount: '12.34', currencyCode: 'USD' },
      ...overrides.variant,
    } }] },
  };
}

async function trustedSnapshot() {
  return priceCart({
    cache: { getAllProducts: async () => [catalogProduct()] },
    customerId: 'cust-1',
    body: { cartItems: [{ variantId: '11', quantity: 1 }] },
    now: new Date(),
  });
}

test('PayPal verification normalizes provider statuses', async () => {
  const payment = {
    paymentId: 'pay-1',
    providerOrderId: 'PAYPAL-ORDER-1',
    providerTransactionId: 'CAPTURE-1',
    expectedAmountCents: 1234,
    expectedCurrency: 'USD',
  };
  const verified = await verifyPayPalPayment({
    paypalClient: { getOrder: async () => paypalOrder() },
    payment,
    expectedMerchantId: 'MERCHANT1',
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.amountCents, 1234);

  assert.equal((await verifyPayPalPayment({ paypalClient: { getOrder: async () => paypalOrder({ status: 'PENDING' }) }, payment })).status, 'not_completed');
  assert.equal((await verifyPayPalPayment({ paypalClient: { getOrder: async () => paypalOrder({ status: 'DENIED' }) }, payment })).status, 'not_completed');
  assert.equal((await verifyPayPalPayment({ paypalClient: { getOrder: async () => paypalOrder({ refunds: [{ status: 'COMPLETED' }] }) }, payment })).status, 'refunded');
  assert.equal((await verifyPayPalPayment({ paypalClient: { getOrder: async () => paypalOrder({ amount: '13.00' }) }, payment })).status, 'amount_mismatch');
  assert.equal((await verifyPayPalPayment({ paypalClient: { getOrder: async () => paypalOrder({ currency: 'EUR' }) }, payment })).status, 'currency_mismatch');
  assert.equal((await verifyPayPalPayment({ paypalClient: { getOrder: async () => paypalOrder({ merchant: 'OTHER' }) }, payment, expectedMerchantId: 'MERCHANT1' })).status, 'merchant_mismatch');
  assert.equal((await verifyPayPalPayment({ paypalClient: { getOrder: async () => { const err = new Error('timeout'); err.code = 'ETIMEDOUT'; throw err; } }, payment })).status, 'provider_unavailable');
});

test('reconciliation dry run verifies provider and snapshot without creating order', async () => {
  const snapshot = await trustedSnapshot();
  let created = 0;
  const payment = {
    paymentId: 'pay-1',
    provider: 'paypal',
    providerOrderId: 'PAYPAL-ORDER-1',
    providerTransactionId: 'CAPTURE-1',
    expectedAmountCents: 1234,
    expectedCurrency: 'USD',
    customerId: 'cust-1',
    state: 'recovery_required',
    metadata: { trustedSnapshot: snapshot },
  };
  const records = new Map();
  const service = createPayPalReconciliationService({
    paymentState: { getByProviderTransaction: async () => payment },
    lockService: { withLock: async (_key, _ttl, fn) => fn() },
    reconciliationRecords: records,
    paypalVerifier: { verify: async () => ({ status: 'verified', verified: true, paypalOrderId: 'PAYPAL-ORDER-1', captureId: 'CAPTURE-1', amountCents: 1234, currency: 'USD' }) },
    shopifyLookup: async () => ({ found: false }),
    createShopifyOrder: async () => { created += 1; return { id: 'gid://shopify/Order/1', name: '#1' }; },
    getCatalogCache: async () => ({ getAllProducts: async () => [catalogProduct()] }),
  });
  const result = await service.reconcilePayment({ payment, apply: false });
  assert.equal(result.status, 'would_create_order');
  assert.equal(created, 0);
});

test('reconciliation apply creates one order and duplicate returns existing result', async () => {
  const snapshot = await trustedSnapshot();
  let created = 0;
  const payment = {
    paymentId: 'pay-1',
    provider: 'paypal',
    providerOrderId: 'PAYPAL-ORDER-1',
    providerTransactionId: 'CAPTURE-1',
    expectedAmountCents: 1234,
    expectedCurrency: 'USD',
    customerId: 'cust-1',
    state: 'recovery_required',
    metadata: { trustedSnapshot: snapshot },
  };
  const records = new Map();
  const paymentState = {
    getByProviderTransaction: async () => payment,
    transitionPayment: async (_id, state, patch) => ({ ...payment, state, ...patch }),
  };
  const service = createPayPalReconciliationService({
    paymentState,
    lockService: { withLock: async (_key, _ttl, fn) => fn() },
    reconciliationRecords: records,
    paypalVerifier: { verify: async () => ({ status: 'verified', verified: true, paypalOrderId: 'PAYPAL-ORDER-1', captureId: 'CAPTURE-1', amountCents: 1234, currency: 'USD' }) },
    shopifyLookup: async () => ({ found: false }),
    createShopifyOrder: async () => { created += 1; return { id: 'gid://shopify/Order/1', name: '#1' }; },
    getCatalogCache: async () => ({ getAllProducts: async () => [catalogProduct()] }),
  });
  const first = await service.reconcilePayment({ payment, apply: true });
  const second = await service.reconcilePayment({ payment, apply: true });
  assert.equal(first.status, 'recovered');
  assert.equal(second.status, 'already_completed');
  assert.equal(created, 1);
});

test('reconciliation fails closed for missing or tampered trusted snapshot', async () => {
  const payment = {
    paymentId: 'pay-1',
    provider: 'paypal',
    providerOrderId: 'PAYPAL-ORDER-1',
    providerTransactionId: 'CAPTURE-1',
    expectedAmountCents: 1234,
    expectedCurrency: 'USD',
    customerId: 'cust-1',
    state: 'recovery_required',
    metadata: {},
  };
  const service = createPayPalReconciliationService({
    paymentState: { getByProviderTransaction: async () => payment },
    lockService: { withLock: async (_key, _ttl, fn) => fn() },
    reconciliationRecords: new Map(),
    paypalVerifier: { verify: async () => ({ status: 'verified', verified: true, paypalOrderId: 'PAYPAL-ORDER-1', captureId: 'CAPTURE-1', amountCents: 1234, currency: 'USD' }) },
    shopifyLookup: async () => ({ found: false }),
    createShopifyOrder: async () => { throw new Error('should_not_create'); },
    getCatalogCache: async () => ({ getAllProducts: async () => [catalogProduct()] }),
  });
  const result = await service.reconcilePayment({ payment, apply: true });
  assert.equal(result.status, 'snapshot_missing');
});

test('reconciliation CLI rejects unsafe apply and supports fixture dry run', () => {
  const fixturePath = path.join(os.tmpdir(), `nood-reconcile-fixture-${Date.now()}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify({ records: [], payments: [] }));
  const dry = spawnSync(process.execPath, ['scripts/reconcile-paid-orders.js', `--fixture=${fixturePath}`], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /"mode": "dry-run"/);

  const apply = spawnSync(process.execPath, ['scripts/reconcile-paid-orders.js', '--apply', `--fixture=${fixturePath}`], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /confirm-production-reconciliation/);
});
