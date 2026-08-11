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
process.env.PUSH_INBOX_FILE = path.join(tmpDir, 'push-inbox-state.json');
process.env.PUSH_INBOX_READS_FILE = path.join(tmpDir, 'push-inbox-reads-state.json');
process.env.PUSH_PREFERENCES_FILE = path.join(tmpDir, 'push-preferences-state.json');
// Catalog router reads Shopify env at module load — set a mock so the routes
// return JSON (not 503) in tests.
process.env.SHOPIFY_STORE_DOMAIN = 'mock-store.myshopify.com';
process.env.SHOPIFY_STOREFRONT_TOKEN = 'mock-token';
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
  detachTokenUser,
  findTokenRecord,
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
const {
  createInboxItem,
  listInboxForUser,
  getUnreadCount,
  markInboxRead,
  markAllInboxRead,
} = require('../utils/inbox-db');
const {
  normalizeStatus,
  upsertOrderTracking,
  progressIndexFor,
  typeForStatus,
} = require('../utils/tracking');
const catalogRouterModule = require('../routes/catalog');

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
    process.env.PUSH_INBOX_FILE,
    process.env.PUSH_INBOX_READS_FILE,
    process.env.PUSH_PREFERENCES_FILE,
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
  assert.deepStrictEqual(order, { pathname: '/account/tracking', params: { orderId: '42' } });

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

// ═══ 14. Inbox persistence + read state ═════════════════════════════════

async function testInboxPersistence() {
  clearStateFiles();
  const created = await createInboxItem({
    campaignId: 'inbox_camp_1',
    type: 'price-drop',
    title: '⬇️ Price Drop',
    body: 'Air Max dropped from $450 to $399.',
    data: { type: 'price-drop', route: '/product/air-max', productHandle: 'air-max' },
    productHandle: 'air-max',
    userId: null, // broadcast
  });
  assert.strictEqual(created.created, true, 'first inbox item created');

  // Retry same campaign → duplicate, NOT a second row.
  const retry = await createInboxItem({
    campaignId: 'inbox_camp_1',
    type: 'price-drop',
    title: '⬇️ Price Drop',
    body: 'Air Max dropped.',
    data: { type: 'price-drop' },
  });
  assert.strictEqual(retry.created, false, 'retry does not duplicate inbox item');

  // User-specific inbox item.
  const personal = await createInboxItem({
    campaignId: 'inbox_camp_2',
    type: 'daily-reward',
    title: '🎁 Your NOOD reward is ready',
    body: 'Open NOOD to claim it.',
    data: { type: 'daily-reward', route: '/account/rewards' },
    userId: 'user-123',
  });
  assert.strictEqual(personal.created, true, 'user-specific item created');

  // Broadcast visible to everyone.
  const forUserA = await listInboxForUser({ userId: 'user-123' });
  const broadcastVisible = forUserA.some((i) => i.campaignId === 'inbox_camp_1');
  assert.strictEqual(broadcastVisible, true, 'broadcast inbox item visible to user');
  assert.ok(
    forUserA.some((i) => i.campaignId === 'inbox_camp_2'),
    'user-specific item visible to that user'
  );

  // User B sees broadcast but NOT user A's personal item.
  const forUserB = await listInboxForUser({ userId: 'user-456' });
  assert.ok(
    forUserB.some((i) => i.campaignId === 'inbox_camp_1'),
    'broadcast visible to another user'
  );
  assert.ok(
    !forUserB.some((i) => i.campaignId === 'inbox_camp_2'),
    'user-specific item NOT visible to another user'
  );
}

async function testInboxUnreadAndMarkRead() {
  clearStateFiles();
  await createInboxItem({
    campaignId: 'inbox_unread_1',
    type: 'flash-live',
    title: '⚡ Flash Deal',
    body: 'Your deal is live now.',
    data: { type: 'flash-live', route: '/modal' },
    userId: null,
  });
  await createInboxItem({
    campaignId: 'inbox_unread_2',
    type: 'cart-nudge',
    title: '👀 Still thinking about it?',
    body: 'Your NOOD cart is waiting.',
    data: { type: 'cart-nudge', route: '/(tabs)/cart' },
    userId: 'user-x',
  });

  const before = await getUnreadCount({ userId: 'user-x' });
  assert.strictEqual(before, 2, 'unread count is 2 before marking');

  const items = await listInboxForUser({ userId: 'user-x' });
  const broadcast = items.find((i) => i.campaignId === 'inbox_unread_1');
  assert.ok(broadcast, 'broadcast found');
  assert.strictEqual(broadcast.read, false, 'broadcast initially unread');

  await markInboxRead({ userId: 'user-x', notificationId: broadcast.id });
  const afterOne = await getUnreadCount({ userId: 'user-x' });
  assert.strictEqual(afterOne, 1, 'unread count drops to 1 after marking one read');

  await markAllInboxRead({ userId: 'user-x' });
  const afterAll = await getUnreadCount({ userId: 'user-x' });
  assert.strictEqual(afterAll, 0, 'unread count drops to 0 after mark all read');
}

// ═══ 15. Tracking normalization ═════════════════════════════════════════

async function testTrackingNormalization() {
  assert.strictEqual(normalizeStatus('fulfilled'), 'shipped');
  assert.strictEqual(normalizeStatus('out_for_delivery'), 'out_for_delivery');
  assert.strictEqual(normalizeStatus('Out for delivery'), 'out_for_delivery');
  assert.strictEqual(normalizeStatus('delivered'), 'delivered');
  assert.strictEqual(normalizeStatus('in_transit'), 'in_transit');
  assert.strictEqual(normalizeStatus('delayed'), 'delayed');
  assert.strictEqual(normalizeStatus('exception'), 'exception');
  assert.strictEqual(normalizeStatus(''), 'confirmed');

  assert.strictEqual(progressIndexFor('packed'), 1);
  assert.strictEqual(progressIndexFor('out_for_delivery'), 4);
  assert.strictEqual(progressIndexFor('delivered'), 5);
  assert.strictEqual(progressIndexFor('exception'), -1);

  assert.strictEqual(typeForStatus('out_for_delivery'), 'order-out-for-delivery');
  assert.strictEqual(typeForStatus('delivered'), 'order-delivered');
  assert.strictEqual(typeForStatus('exception'), 'order-exception');
}

// ═══ 16. Deep-link payload consistency (push ↔ inbox) ═══════════════════

async function testDeepLinkConsistency() {
  clearStateFiles();
  const { templateFor } = require('../jobs/notification-campaigns');
  const t = templateFor('price-drop', {
    productTitle: 'Air Max',
    productHandle: 'air-max',
    oldPrice: '450',
    newPrice: '399',
  });

  const inboxItem = await createInboxItem({
    campaignId: 'inbox_deeplink_1',
    type: 'price-drop',
    title: t.title,
    body: t.body,
    data: t.data,
    productHandle: t.data.productHandle,
    route: t.data.route,
    userId: null,
  });
  assert.strictEqual(inboxItem.created, true);

  // The inbox item must carry the SAME deep-link target as the push.
  const items = await listInboxForUser({ userId: 'any-user' });
  const item = items.find((i) => i.campaignId === 'inbox_deeplink_1');
  assert.ok(item, 'inbox item exists');
  assert.strictEqual(item.title, t.title, 'same title as push');
  assert.strictEqual(item.body, t.body, 'same body as push');
  assert.strictEqual(item.route, t.data.route, 'same route as push');
  assert.strictEqual(item.productHandle, t.data.productHandle, 'same productHandle as push');
  assert.strictEqual(item.type, 'price-drop', 'same type as push');
}

// ═══ 17. Push → inbox integration ══════════════════════════════════════

async function testPushCreatesInboxItem() {
  clearStateFiles();
  freshTokens({
    'ExponentPushToken[test-token-hhh]': {
      token: 'ExponentPushToken[test-token-hhh]',
      userId: 'user-push',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  sentBatches.length = 0;

  // sendPush with a single-user recipient → inbox item should be created
  // for that user.
  const { sendPush, loadAllRecipients } = require('../utils/push-delivery');
  const result = await sendPush({
    recipients: await loadAllRecipients(),
    title: '🔥 New Drop',
    body: 'Air Max Plus just landed.',
    data: { type: 'new_product', route: '/product/air-max-plus', productHandle: 'air-max-plus' },
    campaignId: 'push_inbox_camp_1',
    campaignType: 'new_product',
    frequency: { check: false },
  });
  assert.strictEqual(result.sent, 1, 'push sent');

  const items = await listInboxForUser({ userId: 'user-push' });
  const item = items.find((i) => i.campaignId === 'push_inbox_camp_1');
  assert.ok(item, 'push created an inbox item');
  assert.strictEqual(item.title, '🔥 New Drop', 'inbox title matches push title');
  assert.strictEqual(item.type, 'new_product', 'inbox type matches push type');
  assert.strictEqual(item.productHandle, 'air-max-plus', 'inbox productHandle matches push');
  assert.strictEqual(item.route, '/product/air-max-plus', 'inbox route matches push route');
}

// ═══ 18. Broadcast inbox visibility (all users see it) ═════════════════

async function testBroadcastInboxVisibility() {
  clearStateFiles();
  // Two users registered.
  freshTokens({
    'ExponentPushToken[test-token-iii]': {
      token: 'ExponentPushToken[test-token-iii]',
      userId: 'user-a',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    'ExponentPushToken[test-token-jjj]': {
      token: 'ExponentPushToken[test-token-jjj]',
      userId: 'user-b',
      active: true,
      test: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  sentBatches.length = 0;

  const { sendPush, loadAllRecipients } = require('../utils/push-delivery');
  await sendPush({
    recipients: await loadAllRecipients(),
    title: '⚡ Flash Deal',
    body: 'Your deal is live now.',
    data: { type: 'flash-live', route: '/modal' },
    campaignId: 'broadcast_inbox_1',
    campaignType: 'flash-live',
    frequency: { check: false },
  });

  // Multi-user recipients → broadcast inbox item (userId null).
  const forA = await listInboxForUser({ userId: 'user-a' });
  const forB = await listInboxForUser({ userId: 'user-b' });
  assert.ok(
    forA.some((i) => i.campaignId === 'broadcast_inbox_1'),
    'user A sees the broadcast inbox item'
  );
  assert.ok(
    forB.some((i) => i.campaignId === 'broadcast_inbox_1'),
    'user B sees the broadcast inbox item'
  );
}

// ═══ 19. Tracking deep-link routes ═════════════════════════════════════

async function testTrackingDeepLink() {
  const appDir = path.resolve(__dirname, '..', '..', 'nood-app');
  const outDir = path.join(tmpDir, 'nht2');
  fs.mkdirSync(outDir, { recursive: true });
  execSync(
    `npx tsc ${path.join(appDir, 'utils', 'notification-handling.ts')} --outDir ${outDir} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
    { cwd: appDir, stdio: 'pipe' }
  );
  const mod = require(path.join(outDir, 'notification-handling.js'));

  // Order tracking → tracking screen.
  const track = mod.notificationToRoute({ type: 'order-out-for-delivery', orderId: 'abc123' });
  assert.deepStrictEqual(track, { pathname: '/account/tracking', params: { orderId: 'abc123' } });

  // Refund → returns screen.
  const refund = mod.notificationToRoute({ type: 'refund-completed', orderId: 'abc123' });
  assert.deepStrictEqual(refund, { pathname: '/account/returns', params: { orderId: 'abc123' } });

  // Wishlist price drop → product.
  const wishlist = mod.notificationToRoute({ type: 'wishlist-sale', productHandle: 'air-force-1' });
  assert.deepStrictEqual(wishlist, { pathname: '/product/[handle]', params: { handle: 'air-force-1' } });

  // Spin ready → rewards with autoSpin.
  const spin = mod.notificationToRoute({ type: 'spin-ready' });
  assert.deepStrictEqual(spin, { pathname: '/account/rewards', params: { autoSpin: '1' } });

  // Deal → deals tab.
  const deal = mod.notificationToRoute({ type: 'deal-ending' });
  assert.deepStrictEqual(deal, { pathname: '/(tabs)/deals' });

  // Support → support screen.
  const support = mod.notificationToRoute({ type: 'support-reply' });
  assert.deepStrictEqual(support, { pathname: '/account/support' });
}

// ═══ 20. Per-user isolation ════════════════════════════════════════════

async function testUserInboxIsolation() {
  clearStateFiles();
  // User A personal notification + a broadcast.
  await createInboxItem({
    campaignId: 'iso_a_1',
    type: 'order-update',
    title: '📦 Order update',
    body: 'Your order shipped.',
    data: { type: 'order-update', route: '/account/tracking', orderId: 'o1' },
    orderId: 'o1',
    userId: 'user-A',
  });
  await createInboxItem({
    campaignId: 'iso_broadcast_1',
    type: 'flash-live',
    title: '⚡ Flash Deal',
    body: 'Live now.',
    data: { type: 'flash-live', route: '/modal' },
    userId: null,
  });

  // User A sees their own + broadcast.
  const forA = await listInboxForUser({ userId: 'user-A' });
  assert.ok(forA.some((i) => i.campaignId === 'iso_a_1'), 'A sees own personal item');
  assert.ok(forA.some((i) => i.campaignId === 'iso_broadcast_1'), 'A sees broadcast');

  // User B must NOT see A's personal item.
  const forB = await listInboxForUser({ userId: 'user-B' });
  assert.ok(
    !forB.some((i) => i.campaignId === 'iso_a_1'),
    'user B cannot read user A inbox (personal item invisible)'
  );
  assert.ok(forB.some((i) => i.campaignId === 'iso_broadcast_1'), 'B still sees broadcast');
}

async function testMarkReadIsolation() {
  clearStateFiles();
  await createInboxItem({
    campaignId: 'iso_mark_1',
    type: 'cart-nudge',
    title: '👀 Cart',
    body: 'Your cart is waiting.',
    data: { type: 'cart-nudge', route: '/(tabs)/cart' },
    userId: 'user-A',
  });

  const forA = await listInboxForUser({ userId: 'user-A' });
  const item = forA.find((i) => i.campaignId === 'iso_mark_1');
  assert.ok(item, 'A has the item');

  // User B cannot mark A's notification read (B can't even see it).
  const forB = await listInboxForUser({ userId: 'user-B' });
  assert.ok(
    !forB.some((i) => i.campaignId === 'iso_mark_1'),
    'user B cannot see (or mark) user A notification'
  );
}

async function testTokenDetachOnLogout() {
  clearStateFiles();
  const token = 'ExponentPushToken[iso-logout-token]';
  await upsertToken({ token, userId: 'user-A', email: 'a@example.com', deviceId: 'dev-a' });

  // Before logout: identity resolves to user-A.
  const before = await findTokenRecord(token);
  assert.strictEqual(before.userId, 'user-A', 'token bound to user-A before logout');

  // Logout detaches.
  await detachTokenUser(token);
  const after = await findTokenRecord(token);
  assert.strictEqual(after.userId, null, 'token detached from user after logout');
  assert.strictEqual(after.email, null, 'email detached after logout');

  // Token still active (device can still receive global broadcasts).
  const tokens = await loadTokens();
  assert.strictEqual(tokens[token].active, true, 'token stays active after logout');
}

async function testMultiDeviceSameUser() {
  clearStateFiles();
  const token1 = 'ExponentPushToken[iso-device-1]';
  const token2 = 'ExponentPushToken[iso-device-2]';
  await upsertToken({ token: token1, userId: 'user-X', deviceId: 'dev-1' });
  await upsertToken({ token: token2, userId: 'user-X', deviceId: 'dev-2' });

  // Both devices resolve to the same user.
  const r1 = await findTokenRecord(token1);
  const r2 = await findTokenRecord(token2);
  assert.strictEqual(r1.userId, 'user-X', 'device 1 bound to user-X');
  assert.strictEqual(r2.userId, 'user-X', 'device 2 bound to user-X');

  // Personal inbox item belongs to user-X once (shared across devices).
  await createInboxItem({
    campaignId: 'iso_multi_1',
    type: 'daily-reward',
    title: '🎁 Reward',
    body: 'Your reward is ready.',
    data: { type: 'daily-reward', route: '/account/rewards' },
    userId: 'user-X',
  });
  const items = await listInboxForUser({ userId: 'user-X' });
  const matches = items.filter((i) => i.campaignId === 'iso_multi_1');
  assert.strictEqual(matches.length, 1, 'one logical inbox item shared across devices');
}

// ═══ 21. Inbox offset pagination (load-more) ═══════════════════════════

async function testInboxPagination() {
  clearStateFiles();
  for (let i = 0; i < 5; i += 1) {
    await createInboxItem({
      campaignId: `page_item_${i}`,
      type: 'broadcast',
      title: `Item ${i}`,
      body: `Body ${i}`,
      data: { type: 'broadcast', route: '/(tabs)' },
      userId: null,
    });
  }

  // Page 1: limit 2 → first 2 items (newest first by createdAt).
  const page1 = await listInboxForUser({ userId: 'any-user', limit: 2 });
  assert.strictEqual(page1.length, 2, 'page 1 has 2 items');
  const allIds = (await listInboxForUser({ userId: 'any-user' })).map((i) => i.campaignId);
  assert.strictEqual(allIds.length, 5, 'all 5 items visible');

  // Newest first: createdAt must be non-increasing across the full list.
  for (let i = 1; i < allIds.length; i += 1) {
    const prev = (await listInboxForUser({ userId: 'any-user' })).find((x) => x.campaignId === allIds[i - 1]);
    const cur = (await listInboxForUser({ userId: 'any-user' })).find((x) => x.campaignId === allIds[i]);
    assert.ok(
      new Date(prev.createdAt).getTime() >= new Date(cur.createdAt).getTime(),
      'newest first ordering by createdAt'
    );
  }

  // Pages are disjoint and cover all 5 items.
  const p1 = (await listInboxForUser({ userId: 'any-user', limit: 2 })).map((i) => i.campaignId);
  const p2 = (await listInboxForUser({ userId: 'any-user', limit: 2, offset: 2 })).map((i) => i.campaignId);
  const p3 = (await listInboxForUser({ userId: 'any-user', limit: 2, offset: 4 })).map((i) => i.campaignId);
  const combined = [...p1, ...p2, ...p3];
  assert.strictEqual(new Set(combined).size, 5, 'pages are disjoint and cover all items');
  assert.deepStrictEqual([...combined].sort(), [...allIds].sort(), 'same item set across pages');
}

// ═══ 22. Catalog routes exist + proxy logic ════════════════════════════

async function testCatalogRoutes() {
  // Mock Shopify Storefront GraphQL.
  const axiosMock = require('axios');
  const originalPost = axiosMock.post;
  axiosMock.post = async (url, { query, variables }) => {
    if (url.includes('/graphql.json')) {
      const isCollection = query.includes('collectionByHandle');
      const isCollectionsList = query.includes('collections(') && !query.includes('collectionByHandle');
      const isProductsList = query.includes('products(') && !query.includes('collectionByHandle') && !query.includes('collections(') && !query.includes('productByHandle');
      const isDetail = query.includes('productByHandle');
      const isSearch = query.includes('Search');
      const fakeEdge = { node: { id: '1', title: 'Shoe', handle: 'shoe', variants: { edges: [] }, collections: { edges: [] }, priceRange: { minVariantPrice: { amount: '10', currencyCode: 'USD' } } } };
      if (isCollection) return { data: { data: { collectionByHandle: { title: variables.handle, handle: variables.handle, products: { edges: [fakeEdge], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      if (isCollectionsList) return { data: { data: { collections: { edges: [{ node: { id: 'c1', title: 'Kids', handle: 'kids', image: null } }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      if (isProductsList) return { data: { data: { products: { edges: [fakeEdge], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      if (isDetail) return { data: { data: { productByHandle: { id: '3', title: 'Detail', handle: variables.handle, images: { edges: [] }, media: { edges: [] }, variants: { edges: [] } } } } };
      if (isSearch) return { data: { data: { products: { edges: [fakeEdge], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    return { data: {} };
  };

  const express = require('express');
  const app = express();
  app.use(catalogRouterModule.router);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  try {
    const tests = [
      ['kids products', '/api/catalog/collections/kids/products?limit=60&first=60', 200],
      ['women products', '/api/catalog/collections/women/products?limit=60&first=60', 200],
      ['collections list', '/api/catalog/collections?limit=250&first=250', 200],
      ['products list', '/api/catalog/products?limit=60&first=60&sort=updated', 200],
      ['product detail', '/api/catalog/products/some-handle', 200],
      ['recommendations', '/api/catalog/products/recommendations?productId=gid://shopify/Product/1', 200],
      ['search', '/api/catalog/search?q=nike&limit=50&first=50', 200],
      ['version', '/api/catalog/version', 200],
    ];

    for (const [label, path, expectedStatus] of tests) {
      const res = await fetch(`${base}${path}`);
      assert.strictEqual(res.status, expectedStatus, `${label} returns ${expectedStatus}`);
      const json = await res.json();
      assert.ok(json, `${label} returns JSON`);
    }

    // Verify pagination params are forwarded (first=60 → the mock receives 60).
    const kidsRes = await fetch(`${base}/api/catalog/collections/kids/products?limit=60&first=60`);
    assert.strictEqual(kidsRes.status, 200, 'kids products 200');
  } finally {
    axiosMock.post = originalPost;
    server.close();
  }
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
  await test('inbox persistence: created on push, retry no duplicate, broadcast + user visibility', testInboxPersistence);
  await test('inbox unread count + mark read + mark all read', testInboxUnreadAndMarkRead);
  await test('tracking normalization maps all statuses', testTrackingNormalization);
  await test('deep-link payload consistency between push and inbox', testDeepLinkConsistency);
  await test('push campaign creates an inbox item with matching payload', testPushCreatesInboxItem);
  await test('broadcast push inbox item visible to all users', testBroadcastInboxVisibility);
  await test('tracking deep-link routes to tracking screen', testTrackingDeepLink);
  await test('user A cannot read user B inbox (personal isolation)', testUserInboxIsolation);
  await test('user B cannot mark user A notification read', testMarkReadIsolation);
  await test('logout detaches token from user (no private leak)', testTokenDetachOnLogout);
  await test('same user on two devices shares one logical inbox item', testMultiDeviceSameUser);
  await test('catalog routes exist and return JSON (kids/women/collections/products/search)', testCatalogRoutes);
  await test('inbox offset pagination (load-more) returns pages correctly', testInboxPagination);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}

main();
