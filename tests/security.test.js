const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  sanitizeNotificationData,
  validateSendRequest,
} = require('../notifications/push-notifications');
const { verifyShopifyWebhook } = require('../catalog/webhooks');

test('notification send validation rejects missing title/body and unknown audience', () => {
  const result = validateSendRequest({
    title: '',
    body: '',
    audience: 'segment-admins',
  });

  assert.equal(result.errors.includes('title is required.'), true);
  assert.equal(result.errors.includes('body is required.'), true);
  assert.equal(result.errors.includes('audience must be "all".'), true);
});

test('notification data sanitizer only allows primitive values with safe keys', () => {
  const sanitized = sanitizeNotificationData({
    'product.handle': 'hellstar',
    count: 8,
    active: true,
    nested: { unsafe: true },
    list: ['unsafe'],
    'bad key': 'removed-key-chars',
  });

  assert.deepEqual(sanitized, {
    'product.handle': 'hellstar',
    count: '8',
    active: 'true',
    badkey: 'removed-key-chars',
  });
});

test('notification send validation enforces message length limits', () => {
  const result = validateSendRequest({
    title: 'a'.repeat(121),
    body: 'b'.repeat(501),
    audience: 'all',
  });

  assert.equal(result.errors.includes('title must be 120 characters or less.'), true);
  assert.equal(result.errors.includes('body must be 500 characters or less.'), true);
});

test('Shopify webhook HMAC validation accepts only matching signatures', () => {
  const secret = 'test-webhook-secret';
  const body = Buffer.from(JSON.stringify({ id: 123, handle: 'test-product' }));
  const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(verifyShopifyWebhook(body, hmac, secret), true);
  assert.equal(verifyShopifyWebhook(body, 'bad-signature', secret), false);
});
