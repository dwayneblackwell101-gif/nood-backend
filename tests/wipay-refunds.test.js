const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const pricing = require('../services/catalog-pricing');
function load(file, mocks, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, Buffer, Date, console,
    process: { env }, require: name => name in mocks ? mocks[name] : require(name) });
  return module.exports;
}
function database() {
  const tables = { wipay_refunds: [], refund_requests: [], orders: [], wipay_webhook_events: [] };
  let failUpdateTable;
  return { tables, failNextUpdate: table => { failUpdateTable = table; }, from(table) {
    const conditions = []; let op = 'select', values, returnRows = false;
    const query = {
      select() { returnRows = true; return query; },
      insert(v) { op = 'insert'; values = v; return query; },
      update(v) { op = 'update'; values = v; return query; },
      eq(k, v) { conditions.push(r => r[k] === v); return query; },
      lt(k, v) { conditions.push(r => r[k] < v); return query; },
      in(k, vs) { conditions.push(r => vs.includes(r[k])); return query; },
      maybeSingle() { return execute(true); }, single() { return execute(true); },
      then(resolve, reject) { return execute(false).then(resolve, reject); },
    };
    async function execute(single) {
      if (op === 'insert') {
        const unique = table === 'wipay_refunds' ? 'transaction_id' : 'event_id';
        if (tables[table].some(r => r[unique] === values[unique])) return { error: { code: '23505' } };
        tables[table].push({ ...values }); return { data: null };
      }
      const rows = tables[table].filter(r => conditions.every(f => f(r)));
      if (op === 'update') {
        if (failUpdateTable === table) { failUpdateTable = null; return { error: Error('database unavailable') }; }
        rows.forEach(r => Object.assign(r, values));
      }
      return { data: single ? rows[0] && { ...rows[0] } : returnRows ? rows.map(r => ({ ...r })) : null };
    }
    return query;
  } };
}
function scenario({ timeout = false, rejected = false, badSnapshot = false, syncFailure = false } = {}) {
  const db = database(); let posts = 0, recorded = 0, shouldFailSync = syncFailure;
  const refund = { request_id: 'r1', shopify_order_id: '100', status: 'approved', refund_method: 'original_payment',
    payment_transaction_id: 'SB-9-Nabc-1', amount: '120.00', currency: 'TTD', items: [{ variantId: '1', quantity: 1 }] };
  db.tables.refund_requests.push(refund);
  const payment = { provider: 'wipay_test', provider_order_id: 'Nabc', capture_id: refund.payment_transaction_id,
    status: 'completed', amount: '120.00', currency: 'TTD', cart: [{ variantId: '1', quantity: 1 }], shopify_order: { id: 100 } };
  const api = { retrieve: async () => ({ transaction_id: payment.capture_id, order_id: badSnapshot ? 'wrong' : 'Nabc',
    currency: 'TTD', status: 'success', status_desc: 'Normal' }),
    request: async () => { posts++; if (timeout) throw Error('timeout'); if (rejected) throw { response: { status: 403 } }; } };
  const service = load('services/wipay-refunds.js', {
    '../utils/supabase-admin': { supabaseAdmin: db }, '../utils/payment-state': { getPaymentByCapture: async () => payment },
    './catalog-pricing': pricing, './wipay-refund-api': api,
    './shopify-refunds': { recordExternalRefund: async () => {
      if (shouldFailSync) { shouldFailSync = false; throw Error('Shopify unavailable'); }
      recorded++; return { id: 'shopify-refund-1' };
    } },
  }, { WIPAY_SANDBOX_WEBHOOK_SECRET: 'test-signing-secret' });
  const event = { id: 'e1', event: 'payment.refunded', data: { transaction_id: payment.capture_id, order_id: 'Nabc', currency: 'TTD' } };
  return { db, refund, payment, service, event, posts: () => posts, recorded: () => recorded };
}
(async () => {
  const calls = [];
  const api = load('services/wipay-refund-api.js', { axios: { create: config => {
    assert.equal(config.baseURL, 'https://ttsb.wipayfinancial.com/wapi');
    assert(!config.headers.Authorization); assert.equal(config.maxRedirects, 0);
    return { get: async path => ({ data: { data: { transaction_id: path.split('/').pop() } } }),
      post: async (...args) => { calls.push(args); return { status: 201 }; } };
  } } }, { WIPAY_WAPI_SANDBOX_KEY: `wapi_test_${'a'.repeat(18)}_${'b'.repeat(64)}` });
  await api.retrieve('SB-test-1', 'sandbox'); await api.request('SB-test-1', 'sandbox');
  assert.equal(calls[0][0], '/transactions/SB-test-1/refund'); assert.equal(calls[0][1], '');
  assert.throws(() => api.configuration('live'), /not configured/);
  await assert.rejects(() => api.retrieve('../auth/tokens', 'sandbox'), /Invalid/);
  const secret = 'test-signing-secret', timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ event: 'payment.refunded' });
  const headers = { 'X-WiPay-Webhook-Timestamp': timestamp, 'X-WiPay-Webhook-Version': 'v1',
    'X-WiPay-Webhook-Signature': 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex') };
  const req = { rawBody: body, get: h => headers[h] };
  assert.equal(api.verifyWebhook(req, secret), true);
  assert.equal(api.verifyWebhook({ ...req, rawBody: body + ' ' }, secret), false);
  assert.equal(api.verifyWebhook(req, secret, Date.now() + 301000), false);
  assert.equal(api.verifyWebhook(req, 'wrong'), false);
  const s = scenario();
  for (const change of [{ amount: '100.00' }, { currency: 'USD' }, { shopify_order_id: '101' }, { items: [{ variantId: '2', quantity: 1 }] }]) {
    assert.throws(() => s.service.validateFullRefund({ ...s.refund, ...change }, s.payment));
  }
  const results = await Promise.all([s.service.requestRefund(s.refund), s.service.requestRefund(s.refund)]);
  assert.equal(s.posts(), 1); assert(results.every(r => r.status === 'approved')); assert.equal(s.recorded(), 0);
  await assert.rejects(() => s.service.requestRefund({ ...s.refund, request_id: 'another' }), /already has/);
  await s.service.acceptRefundEvent(s.event, 'live'); assert.equal(s.recorded(), 0);
  await assert.rejects(() => s.service.acceptRefundEvent({ ...s.event, data: { ...s.event.data, currency: 'USD' } }, 'sandbox'), /does not match/);
  await s.service.acceptRefundEvent(s.event, 'sandbox'); assert.equal(s.refund.status, 'refunded_to_original');
  await s.service.acceptRefundEvent(s.event, 'sandbox'); assert.equal(s.recorded(), 1);
  await s.service.acceptRefundEvent({ ...s.event, event: 'payment.refund_rejected' }, 'sandbox');
  assert.equal(s.refund.status, 'refunded_to_original');
  const unknown = scenario({ timeout: true });
  await unknown.service.requestRefund(unknown.refund); await unknown.service.requestRefund(unknown.refund);
  assert.equal(unknown.posts(), 1); assert.equal(unknown.db.tables.wipay_refunds[0].state, 'UNKNOWN');
  assert.equal(unknown.recorded(), 0);
  const bad = scenario({ badSnapshot: true }); await assert.rejects(() => bad.service.requestRefund(bad.refund)); assert.equal(bad.posts(), 0);
  const rejected = scenario({ rejected: true });
  assert.equal((await rejected.service.requestRefund(rejected.refund)).status, 'manual_refund_required');
  await rejected.service.requestRefund(rejected.refund); assert.equal(rejected.posts(), 1);
  const retry = scenario({ syncFailure: true }); await retry.service.requestRefund(retry.refund);
  await assert.rejects(() => retry.service.acceptRefundEvent(retry.event, 'sandbox'), /Shopify/);
  assert.equal(retry.refund.status, 'approved');
  await retry.service.acceptRefundEvent(retry.event, 'sandbox'); assert.equal(retry.recorded(), 1); assert.equal(retry.posts(), 1);
  const crash = scenario(); crash.db.failNextUpdate('refund_requests');
  await assert.rejects(() => crash.service.requestRefund(crash.refund)); await crash.service.requestRefund(crash.refund);
  assert.equal(crash.posts(), 0); // Claim survives a failure before sending; no unsafe automatic retry.
  const webhookDb = database(); let webhookCalls = 0;
  const webhook = load('routes/wipay-refunds.js', { express: require('express'),
    '../utils/supabase-admin': { supabaseAdmin: webhookDb },
    '../services/wipay-refund-api': api,
    '../services/wipay-refunds': { acceptRefundEvent: async () => { webhookCalls++; } },
  }, { WIPAY_SANDBOX_WEBHOOK_SECRET: secret });
  const handler = webhook.router.stack[0].route.stack[0].handle;
  const envelope = { id: 'delivery-1', event: 'payment.refunded', api_family: 'payments_api', occurred_at: new Date().toISOString(),
    data: { transaction_id: 'SB-test-1' } };
  async function deliver({ tampered = false, badHeader = false, env = 'sandbox' } = {}) {
    const rawBody = JSON.stringify(envelope);
    const h = { ...headers, 'X-WiPay-Webhook-Id': badHeader ? 'different' : envelope.id,
      'X-WiPay-Webhook-Event': envelope.event,
      'X-WiPay-Webhook-Signature': 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex') };
    let status;
    const res = { sendStatus: n => { status = n; }, status(n) { status = n; return res; }, json() {} };
    await handler({ params: { environment: env }, body: envelope,
      rawBody: tampered ? rawBody + ' ' : rawBody, get: key => h[key] }, res);
    return status;
  }
  assert.equal(await deliver({ tampered: true }), 401); assert.equal(webhookCalls, 0);
  assert.equal(await deliver({ badHeader: true }), 400); assert.equal(webhookCalls, 0);
  assert.equal(await deliver({ env: 'live' }), 503); assert.equal(webhookCalls, 0);
  assert.equal(await deliver(), 200); assert.equal(await deliver(), 200); assert.equal(webhookCalls, 1);
  assert.equal(webhookDb.tables.wipay_webhook_events.length, 1);
  console.log('WiPay refund tests passed: full-payment binding, auth isolation, signed callbacks, pending confirmation, concurrency, replay, timeout, rejection and Shopify recovery.');
})().catch(error => { console.error(error); process.exitCode = 1; });
