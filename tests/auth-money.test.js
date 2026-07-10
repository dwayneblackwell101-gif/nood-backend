const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertBodyIdentityMatches,
  createCustomerAuthMiddleware,
} = require('../auth/customer-auth');
const {
  assertUsdCurrency,
  centsToUsd,
  usdToCents,
} = require('../lib/money');

function mockResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('USD cents conversion is deterministic', () => {
  assert.equal(usdToCents('10.50'), 1050);
  assert.equal(usdToCents('100.00'), 10000);
  assert.equal(centsToUsd(1050), '10.50');
  assert.equal(centsToUsd(-1050), '-10.50');
});

test('money parser rejects floating point numbers and unexpected currency', () => {
  assert.throws(() => usdToCents(10.5), /floating point/);
  assert.throws(() => usdToCents('1.234'), /two decimal/);
  assert.throws(() => assertUsdCurrency('TTD'), /USD/);
});

test('customer auth middleware rejects missing token', async () => {
  const middleware = createCustomerAuthMiddleware({
    verifyToken: async () => ({ id: 'gid://shopify/Customer/1', email: 'a@example.com' }),
  });
  const req = { headers: {}, body: {}, query: {}, get: () => '' };
  const res = mockResponse();

  await middleware(req, res, () => {
    throw new Error('next should not be called');
  });

  assert.equal(res.statusCode, 401);
});

test('customer auth middleware attaches verified customer', async () => {
  const middleware = createCustomerAuthMiddleware({
    verifyToken: async () => ({ id: 'gid://shopify/Customer/1', email: 'a@example.com' }),
  });
  const req = {
    headers: { authorization: 'Bearer valid-token' },
    body: {},
    query: {},
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
  const res = mockResponse();
  let called = false;

  await middleware(req, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(req.customer.id, 'gid://shopify/Customer/1');
});

test('customer identity mismatch is rejected', () => {
  assert.throws(
    () =>
      assertBodyIdentityMatches(
        { body: { customerId: 'gid://shopify/Customer/2' }, query: {} },
        { id: 'gid://shopify/Customer/1', email: 'a@example.com' }
      ),
    /does not match/
  );

  assert.throws(
    () =>
      assertBodyIdentityMatches(
        { body: { email: 'other@example.com' }, query: {} },
        { id: 'gid://shopify/Customer/1', email: 'a@example.com' }
      ),
    /does not match/
  );
});
