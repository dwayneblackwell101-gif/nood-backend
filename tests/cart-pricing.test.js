const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  hashSnapshot,
  normalizeCartIntent,
  priceCart,
  revalidateSnapshot,
  snapshotToCartItems,
  verifySnapshotHash,
} = require('../checkout/cart-pricing');
const { usdToCents } = require('../lib/money');

function product(overrides = {}) {
  return {
    id: 'gid://shopify/Product/1',
    handle: 'trusted-shirt',
    title: 'Trusted Shirt',
    status: 'ACTIVE',
    availableForSale: true,
    variants: {
      edges: [{
        node: {
          id: 'gid://shopify/ProductVariant/11',
          title: 'Medium',
          sku: 'TS-M',
          availableForSale: true,
          quantityAvailable: 5,
          price: { amount: '12.34', currencyCode: 'USD' },
          ...overrides.variant,
        },
      }],
    },
    ...overrides.product,
  };
}

function fakeCache(products = [product()]) {
  return {
    async getActiveVersionId() {
      return 'active-v1';
    },
    async getCatalogVersionMeta() {
      return { versionId: 'active-v1', status: 'active', schemaVersion: '1' };
    },
    async getAllProducts() {
      return products;
    },
  };
}

function resetCheckoutEnv() {
  process.env.SHOPIFY_CURRENCY = 'USD';
  process.env.PAYMENT_CURRENCY = 'USD';
  process.env.CHECKOUT_MAX_QUANTITY_PER_LINE = '10';
  process.env.CHECKOUT_MAX_TOTAL_QUANTITY = '50';
  process.env.CHECKOUT_MAX_LINE_ITEMS = '50';
  process.env.CHECKOUT_PRICING_MAX_AGE_SECONDS = '900';
  process.env.CHECKOUT_SHIPPING_MODE = 'fixed';
  process.env.CHECKOUT_FIXED_SHIPPING_CENTS = '0';
  process.env.CHECKOUT_PRICING_SCHEMA_VERSION = '1';
}

test('cart intent validation rejects malformed carts and merges duplicates', () => {
  resetCheckoutEnv();
  assert.throws(() => normalizeCartIntent({ cartItems: [] }), /Cart is empty/);
  assert.throws(() => normalizeCartIntent({ cartItems: [{ variantId: 'bad', quantity: 1 }] }), /malformed/);
  assert.throws(() => normalizeCartIntent({ cartItems: [{ variantId: '11', quantity: 0 }] }), /positive integer/);
  assert.throws(() => normalizeCartIntent({ cartItems: [{ variantId: '11', quantity: -1 }] }), /positive integer/);
  assert.throws(() => normalizeCartIntent({ cartItems: [{ variantId: '11', quantity: 1.5 }] }), /positive integer/);
  assert.throws(() => normalizeCartIntent({ cartItems: [{ variantId: '11', quantity: 11 }] }), /exceeds/);

  const merged = normalizeCartIntent({
    cartItems: [
      { variantId: 'gid://shopify/ProductVariant/11', quantity: 1, price: '0.01' },
      { variantId: '11', quantity: 2, total: '999.00' },
    ],
  });
  assert.deepEqual(merged, [{ variantId: 'gid://shopify/ProductVariant/11', quantity: 3 }]);
});

test('trusted pricing ignores client price and rejects mismatched client total', async () => {
  resetCheckoutEnv();
  await assert.rejects(
    () => priceCart({
      cache: fakeCache(),
      customerId: 'cust-1',
      body: {
        total: '0.02',
        cartItems: [{ variantId: '11', quantity: 2, price: '0.01', title: 'Client Title' }],
      },
    }),
    /does not match/
  );

  const snapshot = await priceCart({
    cache: fakeCache(),
    customerId: 'cust-1',
    body: {
      total: '24.68',
      currency: 'EUR',
      cartItems: [{ variantId: '11', quantity: 2, price: '0.01', title: 'Client Title' }],
    },
  });

  assert.equal(snapshot.totalCents, 2468);
  assert.equal(snapshot.total, '24.68');
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.lines[0].productTitle, 'Trusted Shirt');
  assert.equal(snapshot.lines[0].unitPrice, '12.34');
  assert.equal(snapshot.activeCatalogVersionId, 'active-v1');
  verifySnapshotHash(snapshot);
});

test('trusted pricing rejects overrides, missing variants, unavailable inventory, and bad catalog state', async () => {
  resetCheckoutEnv();
  await assert.rejects(
    () => priceCart({ cache: fakeCache(), body: { discountCode: 'SAVE', cartItems: [{ variantId: '11', quantity: 1 }] } }),
    /calculated by the server/
  );
  await assert.rejects(
    () => priceCart({ cache: fakeCache([]), body: { cartItems: [{ variantId: '11', quantity: 1 }] } }),
    /variant was not found/
  );
  await assert.rejects(
    () => priceCart({ cache: fakeCache([product({ variant: { availableForSale: false } })]), body: { cartItems: [{ variantId: '11', quantity: 1 }] } }),
    /variant is not available/
  );
  await assert.rejects(
    () => priceCart({ cache: fakeCache([product({ variant: { quantityAvailable: 1 } })]), body: { cartItems: [{ variantId: '11', quantity: 2 }] } }),
    /quantity is not available/
  );
  await assert.rejects(
    () => priceCart({ cache: { getActiveVersionId: async () => '', getAllProducts: async () => [product()] }, body: { cartItems: [{ variantId: '11', quantity: 1 }] } }),
    /Active validated catalog/
  );
});

test('money parsing and currency enforcement fail closed', async () => {
  resetCheckoutEnv();
  assert.equal(usdToCents('10.50'), 1050);
  assert.throws(() => usdToCents('10.999'), /at most two decimal/);
  assert.throws(() => usdToCents(10.5), /integer cents/);
  await assert.rejects(
    () => priceCart({ cache: fakeCache([product({ variant: { price: { amount: '12.34', currencyCode: 'EUR' } } })]), body: { cartItems: [{ variantId: '11', quantity: 1 }] } }),
    /currency is unsupported/
  );
});

test('snapshot hash is deterministic and detects tampering', async () => {
  resetCheckoutEnv();
  const body = { cartItems: [{ variantId: '11', quantity: 1 }] };
  const first = await priceCart({ cache: fakeCache(), body, customerId: 'cust-1', now: new Date('2026-01-01T00:00:00.000Z') });
  const second = await priceCart({ cache: fakeCache(), body, customerId: 'cust-1', now: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(hashSnapshot(first), first.snapshotHash);
  assert.deepEqual(snapshotToCartItems(first), [{
    variantId: 'gid://shopify/ProductVariant/11',
    quantity: 1,
    price: '12.34',
    title: 'Trusted Shirt',
    variantTitle: 'Medium',
    currency: 'USD',
    trusted: true,
  }]);

  const tampered = { ...first, totalCents: 1 };
  assert.throws(() => verifySnapshotHash(tampered), /hash is invalid/);
});

test('capture revalidation rejects expired snapshots and price changes', async () => {
  resetCheckoutEnv();
  process.env.CHECKOUT_PRICING_MAX_AGE_SECONDS = '60';
  const snapshot = await priceCart({
    cache: fakeCache(),
    body: { cartItems: [{ variantId: '11', quantity: 1 }] },
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  await assert.rejects(
    () => revalidateSnapshot({ cache: fakeCache(), snapshot, now: new Date('2026-01-01T00:02:00.000Z') }),
    /expired/
  );
  await assert.rejects(
    () => revalidateSnapshot({ cache: fakeCache([product({ variant: { price: { amount: '13.00', currencyCode: 'USD' } } })]), snapshot, now: new Date('2026-01-01T00:00:30.000Z') }),
    /price changed/
  );
});

test('route coverage retires legacy PayPal checkout routes and active route prices trusted cart', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.post\('\/api\/orders', requireCustomerAuth/);
  assert.match(source, /const baseSnapshot = await priceCart/);
  assert.match(source, /trustedCartSnapshot: trustedSnapshot/);
  assert.match(source, /app\.post\('\/create-paypal-payment'[\s\S]*?return res\.status\(410\)/);
  assert.match(source, /app\.get\('\/paypal-checkout'[\s\S]*?return res\.status\(410\)/);
  assert.match(source, /app\.post\('\/paypal-sdk\/orders'[\s\S]*?return res\.status\(410\)/);
  assert.match(source, /app\.post\('\/paypal-sdk\/orders\/:paypalOrderId\/capture'[\s\S]*?return res\.status\(410\)/);
});
