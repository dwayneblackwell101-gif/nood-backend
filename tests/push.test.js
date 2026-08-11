/**
 * NOOD push notification system tests.
 *
 * Run: node tests/push.test.js
 *
 * Hermetic: uses temp JSON state files (PUSH_TOKENS_FILE /
 * PUSH_CAMPAIGN_STATE_FILE / PUSH_FREQUENCY_STATE_FILE) and mocks the Expo
 * push HTTP endpoint via axios.post. Supabase is NOT configured in tests, so
 * every module uses its JSON fallback. No real device tokens are contacted.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ─── Hermetic test environment ─────────────────────────────────────────
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nood-push-test-'));
process.env.PUSH_TOKENS_FILE = path.join(tmpDir, 'push-tokens.json');
process.env.PUSH_CAMPAIGN_STATE_FILE = path.join(tmpDir, 'push-campaign-state.json');
process.env.PUSH_FREQUENCY_STATE_FILE = path.join(tmpDir, 'push-frequency-state.json');
process.env.PUSH_QUIET_HOURS_ENABLED = 'false'; // tests must not be quiet-hour dependent
process.env.PUSH_MAX_PROMO_PER_DAY = '100'; // per-test override
process.env.PUSH_MIN_INTERVAL_MINUTES = '0';
process.env.PUSH_NEW_PRODUCT_BATCH_THRESHOLD = '3';
process.env.NOOD_ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

// ─── Mock Expo HTTP endpoint ───────────────────────────────────────────
const axios = require('axios');

const sentBatches = [];
let mockedError = null; // 'ok' | 'DeviceNotRegistered' | 'network'
let mockStatusMode = 'ok';

axios.post = async (url, payload, opts) => {
  if (url.includes('exp.host/--/api/v2/push/send')) {
    const messages = Array.isArray(payload) ? payload : [payload];
    sentBatches.push({ url, messages });
    const data = messages.map((m) => {
      if (mockedError === 'network') {
        throw new Error('mock network failure');
      }
      if (mockedError === 'DeviceNotRegistered') {
        return { status: 'error', details: { error: 'DeviceNotRegistered' } };
      }
      if (mockStatusMode === 'all-ok') {
        return { status: 'ok', id: `ticket-${m.to.slice(-8)}` };
      }
      return { status: 'ok', id: `ticket-${m.to.slice(-8)}` };
    });
    return { data: { data } };
  }
  throw new Error(`Unexpected HTTP POST in test: ${url}`);
};
axios.get = async () => ({ data: { data: {} } });

// ─── Load modules AFTER env is set ─────────────────────────────────────
const {
  loadTokens,
  upsertToken,
  deactivateToken,
  isLikelyRealToken,
} = require('../utils/push-tokens-db');
const {
  createCampaignEvent,
  campaignExists,
  checkAndIncrementFrequency,
  allowCartNudge,
} = require('../utils/push-state-db');
const { sendPush, loadAllRecipients } = require('../utils/push-delivery');
const { detectNewProducts } = require('../utils/inventory');
const { sendNewProductCampaign, sendCampaign, templateFor } = require('../jobs/notification-campaigns');
const { requireAdmin, isAdminConfigured } = require('../utils/admin-auth');
const {
  isSupabaseServiceRoleKey,
  describeSupabaseKeyType,
} = require('../utils/supabase-credential');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      console.error(err.stack ? err.stack.split('\n').slice(1, 4).join('\n') : '');
    });
}

function freshTokens(tokens) {
  fs.writeFileSync(process.env.PUSH_TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function clearStateFiles() {
  for (const f of [
    process.env.PUSH_TOKENS_FILE,
    process.env.PUSH_CAMPAIGN_STATE_FILE,
    process.env.PUSH_FREQUENCY_STATE_FILE,
  ]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

// ─── Fake Supabase db for detectNewProducts ────────────────────────────
function makeFakeDb() {
  const store = new Map(); // shopify_product_id -> row
  return {
    _store: store,
    from() {
      return {
        select() {
          const filter = {};
          return {
            in: async (col, values) => {
              const data = [];
              for (const id of values) {
                if (store.has(id)) {
                  data.push({ shopify_product_id: id });
                }
              }
              return { data, error: null };
            },
          };
        },
        insert: async (rows) => {
          for (const row of rows) {
            if (!store.has(row.shopify_product_id)) {
              store.set(row.shopify_product_id, { ...row, created_at: new Date().toISOString() });
            }
          }
          return { data: null, error: null };
        },
      };
    },
  };
}

// ═══ 1. Token registration ═════════════════════════════════════════════
async function testTokenRegistration() {
  clearStateFiles();
  const token = 'ExponentPushToken[test-token-aaa]';
  await upsertToken({ token, platform: 'android', userId: 'user1', email: 'a@b.com', deviceId: 'dev1' });
  const tokens = await loadTokens();
  assert.strictEqual(Object.keys(tokens).length, 1, 'one token after first registration');
  assert.strictEqual(tokens[token].email, 'a@b.com');
  assert.strictEqual(tokens[token].active, true);
}

// ═══ 2. Duplicate token registration (idempotent) ═════════════════════
async function testDuplicateTokenRegistration() {
  clearStateFiles();
  const token = 'ExponentPushToken[test-token-bbb]';
  await upsertToken({ token, userId: 'u1' });
  await upsertToken({ token, userId: 'u2' }); // re-register with different user → upsert, not duplicate
  const tokens = await loadTokens();
  assert.strictEqual(Object.keys(tokens).length, 1, 'still exactly one row for the same token');
  assert.strictEqual(tokens[token].userId, 'u2');
}

// ═══ 3. New-product detection (genuinely new only) ═════════════════════
async function testNewProductDetection() {
  const db = makeFakeDb();
  const products = [
    { id: '111', title: 'Air Max Plus', handle: 'air-max-plus', variants: [] },
    { id: '222', title: 'Nike Dunk', handle: 'nike-dunk', variants: [] },
  ];
  const first = await detectNewProducts(products, db);
  assert.strictEqual(first.length, 2, 'first sync detects 2 new products');

  // Re-sync the SAME products → no new products.
  const second = await detectNewProducts(products, db);
  assert.strictEqual(second.length, 0, 'repeated sync detects 0 new products');

  // New product added later → only that one is new.
  const third = await detectNewProducts(
    [...products, { id: '333', title: 'Air Force 1', handle: 'air-force-1', variants: [] }],
    db
  );
  assert.strictEqual(third.length, 1, 'third sync detects only the truly new product');
  assert.strictEqual(third[0].handle, 'air-force-1');
}

// ═══ 4. Repeated sync does not generate another new-product campaign ══
async function testRepeatedSyncNoDuplicateCampaign() {
  clearStateFiles();
  freshTokens({
    'ExponentPushToken[test-token-ccc]': {
      token: 'ExponentPushToken[test-token-ccc]',
      userId: 'u1',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  sentBatches.length = 0;

  const products = [
    { shopifyProductId: '111', title: 'Air Max Plus', handle: 'air-max-plus' },
    { shopifyProductId: '222', title: 'Nike Dunk', handle: 'nike-dunk' },
  ];

  // Run 1 (individual pushes — 2 products < batch threshold of 3).
  await sendNewProductCampaign({ products });
  const afterFirst = sentBatches.length;

  // Run 2 (same products) → all deduped (product dedupe keys already recorded).
  await sendNewProductCampaign({ products });
  const afterSecond = sentBatches.length;

  assert.strictEqual(afterSecond, afterFirst, 'second run must not send additional pushes');
}

// ═══ 5. Product batch notification ═════════════════════════════════════
async function testProductBatchNotification() {
  clearStateFiles();
  freshTokens({
    'ExponentPushToken[test-token-ddd]': {
      token: 'ExponentPushToken[test-token-ddd]',
      userId: 'u1',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  sentBatches.length = 0;

  // 5 products >= threshold 3 → ONE batched push.
  const products = [1, 2, 3, 4, 5].map((i) => ({
    shopifyProductId: `${i}000`,
    title: `Product ${i}`,
    handle: `product-${i}`,
  }));
  await sendNewProductCampaign({ products });
  assert.strictEqual(sentBatches.length, 1, 'batch mode sends exactly one Expo request');
  const body = sentBatches[0].messages[0].body;
  assert.ok(body.includes('5 new styles'), 'batch body mentions product count');
  assert.ok(sentBatches[0].messages[0].data.route === '/collection/new-arrivals', 'batch deep-links to New Arrivals');
}

// ═══ 6. Manual broadcast via sendCampaign ══════════════════════════════
async function testManualBroadcast() {
  clearStateFiles();
  freshTokens({
    'ExponentPushToken[test-token-eee]': {
      token: 'ExponentPushToken[test-token-eee]',
      userId: 'u1',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  sentBatches.length = 0;

  const result = await sendCampaign({
    campaignType: 'broadcast',
    title: 'Flash weekend',
    body: 'Up to 50% off everything.',
    data: { route: '/(tabs)/deals' },
  });
  assert.strictEqual(result.sent, 1, 'broadcast reaches the one active device');
  const msg = sentBatches[0].messages[0];
  assert.strictEqual(msg.title, 'Flash weekend');
  assert.strictEqual(msg.data.type, 'broadcast');
}

// ═══ 7. Campaign frequency cap ═════════════════════════════════════════
async function testFrequencyCap() {
  clearStateFiles();
  freshTokens({
    'ExponentPushToken[test-token-fff]': {
      token: 'ExponentPushToken[test-token-fff]',
      userId: 'u1',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  sentBatches.length = 0;

  // 2 campaigns in a row — second must be skipped by the daily cap (max 1).
  process.env.PUSH_MAX_PROMO_PER_DAY = '1';

  const r1 = await sendPush({
    recipients: await loadAllRecipients(),
    title: 'A',
    body: 'first',
    data: { type: 'general' },
    campaignId: 'freq_campaign_1',
    campaignType: 'general',
    frequency: { check: true },
  });
  assert.strictEqual(r1.sent, 1, 'first campaign sends');

  const r2 = await sendPush({
    recipients: await loadAllRecipients(),
    title: 'B',
    body: 'second',
    data: { type: 'general' },
    campaignId: 'freq_campaign_2',
    campaignType: 'general',
    frequency: { check: true },
  });
  assert.strictEqual(r2.sent, 0, 'second campaign blocked');
  assert.ok(r2.skipped >= 1, 'second campaign records a skip');

  // Transactional bypasses the cap.
  const r3 = await sendPush({
    recipients: await loadAllRecipients(),
    title: 'Order',
    body: 'Your order shipped',
    data: { type: 'order-update' },
    campaignId: 'freq_campaign_3',
    campaignType: 'order-update',
    frequency: { check: true },
  });
  assert.strictEqual(r3.sent, 1, 'transactional order-update bypasses promo cap');

  process.env.PUSH_MAX_PROMO_PER_DAY = '100';
}

// ═══ 8. Cart notification cooldown ═════════════════════════════════════
async function testCartNudgeCooldown() {
  clearStateFiles();
  const first = await allowCartNudge('cart@email.com', 48);
  assert.strictEqual(first, true, 'first nudge allowed');
  const second = await allowCartNudge('cart@email.com', 48);
  assert.strictEqual(second, false, 'second nudge within cooldown blocked');
}

// ═══ 9. Invalid Expo token handling (DeviceNotRegistered) ══════════════
async function testInvalidTokenHandling() {
  clearStateFiles();
  freshTokens({
    'ExponentPushToken[test-token-ggg]': {
      token: 'ExponentPushToken[test-token-ggg]',
      userId: 'u1',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  sentBatches.length = 0;
  mockedError = 'DeviceNotRegistered';

  const result = await sendPush({
    recipients: await loadAllRecipients(),
    title: 'X',
    body: 'test invalid token',
    data: { type: 'general' },
    campaignId: 'invalid_token_campaign',
    campaignType: 'general',
  });
  assert.strictEqual(result.failed, 1, 'invalid token reported as failed');

  mockedError = 'ok';
  const tokens = await loadTokens({ includeInactive: true });
  const remaining = Object.values(tokens).filter((t) => t.token === 'ExponentPushToken[test-token-ggg]');
  const deactivated = remaining.length === 0 || remaining[0]?.active === false;
  assert.strictEqual(deactivated, true, 'DeviceNotRegistered token deactivated');
}

// ═══ 10. Deep-link payload generation (template + route) ═══════════════
async function testDeepLinkPayloads() {
  const cases = [
    {
      type: 'new_product',
      ctx: { productTitle: 'Air Max', productHandle: 'air-max' },
      check: (t, d) => d.route === '/product/air-max' && d.productHandle === 'air-max',
    },
    {
      type: 'price-drop',
      ctx: { productTitle: 'Dunk', productHandle: 'nike-dunk', oldPrice: '120', newPrice: '90' },
      check: (t, d) => t.includes('Price Drop') && d.route === '/product/nike-dunk',
    },
    {
      type: 'hot-product',
      ctx: { productTitle: 'Yeezy', productHandle: 'yeezy' },
      check: (t, d) => d.type === 'hot-product' && d.route === '/product/yeezy',
    },
    {
      type: 'cart-nudge',
      ctx: {},
      check: (t, d) => d.route === '/(tabs)/cart' && d.type === 'cart-nudge',
    },
    {
      type: 'daily-reward',
      ctx: {},
      check: (t, d) => d.route === '/account/rewards',
    },
    {
      type: 'order-update',
      ctx: { orderId: '12345' },
      check: (t, d) => d.type === 'order-update' && d.orderId === '12345' && d.route === '/account/orders',
    },
    {
      type: 'flash-live',
      ctx: {},
      check: (t, d) => d.route === '/modal',
    },
  ];

  for (const c of cases) {
    const { title, body, data } = templateFor(c.type, c.ctx);
    assert.ok(c.check(title, data), `template for ${c.type} produces correct deep-link payload`);
  }
}

// ═══ 11. Admin auth ════════════════════════════════════════════════════
function testAdminAuth() {
  assert.strictEqual(isAdminConfigured(), true, 'admin token configured in tests');

  // Middleware accepts a valid token.
  let called = false;
  const okRes = { status: () => okRes, json: () => okRes };
  requireAdmin({ headers: { 'x-admin-token': 'test-admin-token-0123456789abcdef' } }, okRes, () => {
    called = true;
  });
  assert.strictEqual(called, true, 'valid admin token passes middleware');

  // Middleware rejects a bad token.
  let rejected = false;
  const badRes = {
    status: (code) => {
      assert.strictEqual(code, 401);
      return badRes;
    },
    json: () => {
      rejected = true;
    },
  };
  requireAdmin({ headers: { 'x-admin-token': 'wrong-token' } }, badRes, () => {});
  assert.strictEqual(rejected, true, 'invalid admin token rejected with 401');
}

// ═══ 13. Supabase credential validation ═════════════════════════════════
function makeLegacyJwt(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64url');
  return `${header}.${payload}.signature`;
}

async function testSupabaseCredentialValidation() {
  // Modern sb_secret_ keys accepted.
  assert.strictEqual(
    isSupabaseServiceRoleKey('sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890'),
    true,
    'sb_secret_ key accepted'
  );
  assert.strictEqual(
    describeSupabaseKeyType('sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890'),
    'modern-secret',
    'modern key typed as modern-secret'
  );

  // Legacy service_role JWT accepted.
  const legacy = makeLegacyJwt('service_role');
  assert.strictEqual(isSupabaseServiceRoleKey(legacy), true, 'legacy service_role JWT accepted');
  assert.strictEqual(
    describeSupabaseKeyType(legacy),
    'legacy-service-role',
    'legacy key typed as legacy-service-role'
  );

  // sb_publishable_ rejected.
  assert.strictEqual(
    isSupabaseServiceRoleKey('sb_publishable_AbCdEfGhIjKlMnOpQrStUvWxYz'),
    false,
    'sb_publishable_ key rejected'
  );
  assert.strictEqual(
    describeSupabaseKeyType('sb_publishable_AbCdEfGhIjKlMnOpQrStUvWxYz'),
    'publishable-rejected',
    'publishable key typed as publishable-rejected'
  );

  // Legacy anon JWT rejected.
  assert.strictEqual(isSupabaseServiceRoleKey(makeLegacyJwt('anon')), false, 'anon JWT rejected');

  // Missing / empty / malformed rejected.
  assert.strictEqual(isSupabaseServiceRoleKey(''), false, 'empty key rejected');
  assert.strictEqual(isSupabaseServiceRoleKey(undefined), false, 'missing key rejected');
  assert.strictEqual(isSupabaseServiceRoleKey('eyJ.not-a-valid-jwt'), false, 'malformed JWT rejected');
  assert.strictEqual(isSupabaseServiceRoleKey('sb_unknown_xyz'), false, 'unknown sb_ key rejected');
}

// ═══ 12. Frontend deep-link routing (compiled TS) ══════════════════════
async function testFrontendRouteMapping() {
  const appDir = path.resolve(__dirname, '..', '..', 'nood-app');
  const outDir = path.join(tmpDir, 'nht');
  fs.mkdirSync(outDir, { recursive: true });
  execSync(
    `npx tsc ${path.join(appDir, 'utils', 'notification-handling.ts')} --outDir ${outDir} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
    { cwd: appDir, stdio: 'pipe' }
  );
  const mod = require(path.join(outDir, 'notification-handling.js'));

  const product = mod.notificationToRoute({ type: 'new_product', productHandle: 'air-max-plus' });
  assert.deepStrictEqual(product, { pathname: '/product/[handle]', params: { handle: 'air-max-plus' } });

  const cart = mod.notificationToRoute({ type: 'cart-nudge' });
  assert.deepStrictEqual(cart, { pathname: '/(tabs)/cart' });

  const order = mod.notificationToRoute({ type: 'order-update', orderId: '42' });
  assert.deepStrictEqual(order, { pathname: '/account/orders', params: { orderId: '42' } });

  // Unsafe external route is rejected.
  const unsafe = mod.notificationToRoute({ type: 'general', route: 'https://evil.example.com' });
  assert.strictEqual(unsafe.pathname, '/(tabs)', 'external URL route falls back to tabs');

  // Valid explicit route is honored.
  const safe = mod.notificationToRoute({ type: 'general', route: '/account/rewards' });
  assert.deepStrictEqual(safe, { pathname: '/account/rewards' });

  // Invalid route falls back to typed routing.
  const invalidRoute = mod.notificationToRoute({ type: 'cart-nudge', route: '/../etc/passwd' });
  assert.deepStrictEqual(invalidRoute, { pathname: '/(tabs)/cart' });
}

// ═══ Run ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('\nNOOD push notification tests\n');
  await test('token registration stores token + metadata', testTokenRegistration);
  await test('duplicate token registration is idempotent', testDuplicateTokenRegistration);
  await test('new-product detection returns only genuinely new products', testNewProductDetection);
  await test('repeated sync does not generate another new-product campaign', testRepeatedSyncNoDuplicateCampaign);
  await test('product batch notification sends one batched push', testProductBatchNotification);
  await test('manual broadcast reaches all active devices', testManualBroadcast);
  await test('campaign frequency cap blocks promo but not transactional', testFrequencyCap);
  await test('cart notification cooldown blocks repeated nudges', testCartNudgeCooldown);
  await test('invalid Expo token (DeviceNotRegistered) is deactivated', testInvalidTokenHandling);
  await test('deep-link payload generation for all campaign types', testDeepLinkPayloads);
  await test('admin auth rejects invalid tokens', testAdminAuth);
  await test('frontend deep-link routing validates routes', testFrontendRouteMapping);
  await test('supabase credential validation accepts secret + service_role, rejects publishable/anon/missing', testSupabaseCredentialValidation);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}

main();
