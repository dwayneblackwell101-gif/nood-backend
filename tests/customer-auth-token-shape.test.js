const assert = require('node:assert/strict');
const test = require('node:test');
const { prefersCustomerAccountApi, normalizeShopifyCustomerId } = require('../auth/customer-auth');
const { validateProductionConfig } = require('../config/production-validate');

test('prefersCustomerAccountApi detects JWT-shaped tokens', () => {
  assert.equal(prefersCustomerAccountApi('a.b.c'), true);
  assert.equal(prefersCustomerAccountApi('shcat_abc123very_long_token_value_here_extra'), true);
  assert.equal(prefersCustomerAccountApi('short-storefront-token'), false);
});

test('normalizeShopifyCustomerId canonicalizes numeric ids', () => {
  assert.equal(normalizeShopifyCustomerId('12345'), 'gid://shopify/Customer/12345');
  assert.equal(
    normalizeShopifyCustomerId('gid://shopify/Customer/99'),
    'gid://shopify/Customer/99'
  );
});

test('validateProductionConfig is advisory outside production', () => {
  const result = validateProductionConfig({ NODE_ENV: 'development' });
  assert.equal(result.ok, true);
  assert.equal(result.production, false);
});

test('validateProductionConfig requires redis secrets in production', () => {
  const result = validateProductionConfig({
    NODE_ENV: 'production',
    STORAGE_DRIVER: 'json',
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.key === 'REDIS_URL' || i.key === 'STORAGE_DRIVER'));
});

test('validateProductionConfig accepts NOOD_ADMIN_API_KEY without ADMIN_API_KEY', () => {
  const result = validateProductionConfig({
    NODE_ENV: 'production',
    REDIS_URL: 'redis://localhost:6379',
    STORAGE_DRIVER: 'redis',
    SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'sf',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'ad',
    SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN: 'oa',
    SHOPIFY_WEBHOOK_SECRET: 'wh',
    NOOD_ADMIN_API_KEY: 'only-nood-key',
    PAYPAL_ENABLED: 'false',
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});
