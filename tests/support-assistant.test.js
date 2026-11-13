const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { deterministicProvider, recognizeIntent } = require('../services/support-assistant/providers/deterministic');
const { createSupportAssistantProvider } = require('../services/support-assistant/provider');
const { createCustomerSupportTools } = require('../services/support-assistant/tools');
const { createSupportAssistantRouter } = require('../routes/support-assistant');

const tests = [];
function test(name, run) { tests.push({ name, run }); }

function fakeTools(overrides = {}) {
  return {
    listRecentOrders: async () => [{ shopify_order_id: 'order-a', name: '#1001', status: 'paid', fulfillment_status: 'fulfilled' }],
    getOwnedOrder: async () => ({ shopify_order_id: 'order-a', name: '#1001', status: 'paid', fulfillment_status: 'fulfilled' }),
    getOwnedTracking: async () => ({ status: 'in_transit', friendly_status: 'In transit', carrier: 'NOOD Carrier', latest_event_description: 'Departed hub' }),
    listRefundRequests: async () => [{ request_id: 'refund-a', order_number: '#1001', status: 'approved' }],
    getWalletSummary: async () => ({ balance: 12.5, currency: 'USD', recentTransactions: [] }),
    listSupportCases: async () => [],
    getOwnedSupportCase: async () => null,
    createHumanHandoff: async () => ({ supportCase: { id: 'case-a', ticket_id: 'NOOD-2026-ABC' }, reused: false }),
    ...overrides,
  };
}

async function responseFor(message, overrides, context = {}) {
  const provider = deterministicProvider({ tools: fakeTools(overrides) });
  return provider.respond({ message, context, conversationId: 'conversation-a', store: {} });
}

test('intent recognition covers required support categories', () => {
  assert.equal(recognizeIntent('Where is my order?'), 'tracking');
  assert.equal(recognizeIntent('My package says delivered but I do not have it'), 'delivery_problem');
  assert.equal(recognizeIntent('I want to return something'), 'return');
  assert.equal(recognizeIntent('Where is my refund?'), 'refund');
  assert.equal(recognizeIntent('I was charged twice'), 'payment');
  assert.equal(recognizeIntent('What is my wallet balance?'), 'wallet');
  assert.equal(recognizeIntent('I have a login security issue'), 'account');
  assert.equal(recognizeIntent('I need an agent'), 'handoff');
});

test('order and tracking answers use verified tool data', async () => {
  const answer = await responseFor('Track my package');
  assert.equal(answer.intent, 'tracking');
  assert.match(answer.message, /#1001/);
  assert.match(answer.message, /In transit/);
  assert.equal(answer.data.tracking.carrier, 'NOOD Carrier');
});

test('refund answer uses owned refund status', async () => {
  const answer = await responseFor('Where is my refund?');
  assert.equal(answer.intent, 'refund');
  assert.match(answer.message, /approved/);
});

test('wallet answer uses authoritative wallet summary', async () => {
  const answer = await responseFor('What is my balance?');
  assert.equal(answer.intent, 'wallet');
  assert.match(answer.message, /USD 12\.50/);
});

test('payment and account help avoid unverifiable claims', async () => {
  assert.match((await responseFor('My payment failed')).message, /cannot confirm/i);
  assert.match((await responseFor('Account security issue')).message, /Never share/i);
});

test('unsupported questions return bounded fallback actions', async () => {
  const answer = await responseFor('What color should I wear?');
  assert.equal(answer.intent, 'unknown');
  assert(answer.suggestedActions.some((action) => action.type === 'handoff'));
});

test('human handoff requires confirmation then returns real ticket route', async () => {
  const first = await responseFor('Talk to a person');
  assert.equal(first.handoff.requiresConfirmation, true);
  const confirmed = await responseFor('Talk to a person', {}, { confirmHandoff: true });
  assert.equal(confirmed.state, 'handoff');
  assert.equal(confirmed.handoff.ticketId, 'NOOD-2026-ABC');
  assert.equal(confirmed.handoff.route, '/account/support/NOOD-2026-ABC');
});

test('provider failure is explicit and deterministic remains default', () => {
  assert.equal(createSupportAssistantProvider({ tools: fakeTools() }).name, 'deterministic');
  assert.throws(() => createSupportAssistantProvider({ name: 'ai', tools: fakeTools() }), /not configured/i);
});

test('tool failures propagate instead of fabricating data', async () => {
  await assert.rejects(
    responseFor('Track my package', { listRecentOrders: async () => { throw new Error('tool offline'); } }),
    /tool offline/
  );
});

test('all private tools scope database reads to authenticated user', async () => {
  const calls = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; calls.push(this); }
    select() { return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { return Promise.resolve({ data: null, error: null }); }
    then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); }
  }
  const db = { from: (table) => new Query(table) };
  const walletUsers = [];
  const tools = createCustomerSupportTools({
    supabase: db,
    customer: { userId: 'customer-A', email: 'a@example.com' },
    wallet: {
      getWalletBalance: async (userId) => { walletUsers.push(userId); return 0; },
      listWalletTxns: async (userId) => { walletUsers.push(userId); return []; },
    },
  });
  await tools.listRecentOrders();
  await tools.getOwnedOrder('customer-B-order');
  await tools.getOwnedTracking('customer-B-order');
  await tools.listRefundRequests();
  await tools.listSupportCases();
  await tools.getOwnedSupportCase('customer-B-case');
  await tools.getWalletSummary();
  assert(calls.length >= 6);
  for (const call of calls) assert(call.filters.some(([field, value]) => field === 'user_id' && value === 'customer-A'), `${call.table} was not user-scoped`);
  assert.deepEqual(walletUsers, ['customer-A', 'customer-A']);
});

test('assistant persistence is separate, service-role-only, and ownership scoped', () => {
  const root = path.resolve(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'supabase-support-assistant-migration.sql'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'services/support-assistant/store.js'), 'utf8');
  const tools = fs.readFileSync(path.join(root, 'services/support-assistant/tools.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS assistant_conversations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS assistant_messages/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /TO service_role USING \(TRUE\) WITH CHECK \(TRUE\)/);
  assert.match(store, /\.eq\('id', conversationId\)\.eq\('user_id', userId\)/);
  assert.match(tools, /getOwnedOrder\(safeOrderId\)/);
  assert.match(tools, /\.eq\('user_id', userId\)\.eq\('category', safeCategory\)/);
  assert.match(tools, /store\.getOwned\(conversationId, userId\)/);
});

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('unauthenticated assistant access is rejected', async () => {
  const router = createSupportAssistantRouter({ db: {}, authenticate: async () => null });
  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/support/assistant/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'help' }),
    });
    assert.equal(response.status, 401);
  });
});

test('malformed and client-supplied identity requests are rejected', async () => {
  const router = createSupportAssistantRouter({ db: {}, authenticate: async () => ({ userId: 'customer-A' }) });
  await withServer(router, async (base) => {
    const malformed = await fetch(`${base}/api/support/assistant/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '' }),
    });
    assert.equal(malformed.status, 400);
    const forged = await fetch(`${base}/api/support/assistant/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'help', customerId: 'customer-B' }),
    });
    assert.equal(forged.status, 400);
    const nestedForgery = await fetch(`${base}/api/support/assistant/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'help', context: { userId: 'customer-B' } }),
    });
    assert.equal(nestedForgery.status, 400);
  });
});

test('authorized route passes server-authenticated identity only', async () => {
  let received;
  const router = createSupportAssistantRouter({
    db: {},
    authenticate: async () => ({ userId: 'customer-A', email: 'a@example.com' }),
    serviceFactory: () => ({ sendMessage: async (input) => {
      received = input;
      return { conversationId: 'conversation-a', message: 'ok', state: 'talking', suggestedActions: [], handoff: null, data: {}, messages: [] };
    } }),
  });
  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/support/assistant/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'help', context: { selectedOrderId: 'order-a' } }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(received.customer.userId, 'customer-A');
  assert.equal(received.context.selectedOrderId, 'order-a');
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${entry.name}`);
      console.error(error);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`\n${tests.length} support assistant tests passed`);
})();
