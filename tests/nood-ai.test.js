const assert = require('assert/strict');
const express = require('express');
const { openaiProvider } = require('../services/support-assistant/providers/openai');
const { createKnowledgeTools } = require('../services/support-assistant/knowledge');
const { createSupportAssistantRouter } = require('../routes/support-assistant');
const { createSupportAssistantService } = require('../services/support-assistant');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const final = (text = 'Your order is in transit.') => ({ data: { status: 'completed', output: [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
] } });
const call = (name, args = {}) => ({ data: { status: 'completed', output: [
  { type: 'function_call', call_id: 'call_1', name, arguments: JSON.stringify(args) },
] } });
const history = { listMessages: async () => [
  { sender_role: 'customer', body: 'Track my order' },
  { sender_role: 'assistant', body: 'Which order?' },
  { sender_role: 'customer', body: 'The most recent one' },
] };
const input = { message: 'The most recent one', conversationId: 'owned', store: history };
function provider(options = {}) {
  return openaiProvider({ apiKey: 'test-private-key', model: 'test-model', tools: {}, ...options });
}

test('Responses request is server-authenticated, stateless, bounded and retains follow-up context', async () => {
  let received;
  await provider({ request: async (...args) => { received = args; return final(); } }).respond(input);
  assert.equal(received[0], 'https://api.openai.com/v1/responses');
  assert.equal(received[1].store, false);
  assert.equal(received[1].input[1].role, 'assistant');
  assert.equal(received[1].input[2].content, 'The most recent one');
  assert.equal(received[2].headers.Authorization, 'Bearer test-private-key');
  assert(received[2].timeout <= 20000);
  assert(received[1].max_output_tokens <= 1000);
  assert(!received[1].tools.some((t) => /refund_(create|issue)|payment|change_order|sql|http/i.test(t.name)));
});

test('owned tracking is executed on the backend and fed back using call_id', async () => {
  const requests = [];
  let seen;
  await provider({
    tools: { getOwnedOrder: async (id) => { seen = id; return { shopify_order_id: id }; },
      getOwnedTracking: async () => ({ status: 'in_transit' }) },
    request: async (_url, body) => { requests.push(JSON.parse(JSON.stringify(body))); return requests.length === 1 ? call('get_tracking', { orderId: 'a' }) : final(); },
  }).respond(input);
  assert.equal(seen, 'a');
  const result = requests[1].input.find((item) => item.type === 'function_call_output');
  assert.equal(result.call_id, 'call_1');
  assert.equal(JSON.parse(result.output).status, 'in_transit');
});

test('another customer order never reaches tracking lookup', async () => {
  let reads = 0; let rounds = 0; let result;
  await provider({ tools: { getOwnedOrder: async () => null, getOwnedTracking: async () => { reads++; } },
    request: async (_url, body) => {
      if (++rounds === 1) return call('get_tracking', { orderId: 'other-customer' });
      result = body.input.at(-1); return final('That order is not available.');
    },
  }).respond(input);
  assert.equal(reads, 0);
  assert.equal(JSON.parse(result.output).error, 'order_not_available');
});

test('forged write tools and identity arguments cannot execute', async () => {
  for (const pending of [call('issue_refund', { orderId: 'a' }), call('list_orders', { userId: 'victim' }), call('get_order', { orderId: '' })]) {
    let rounds = 0; let output;
    await provider({ tools: new Proxy({}, { get: () => { throw new Error('must not access a tool'); } }),
      request: async (_url, body) => { if (++rounds === 1) return pending; output = body.input.at(-1); return final(); },
    }).respond(input);
    assert.equal(JSON.parse(output.output).error, 'unsupported_tool_or_arguments');
  }
});

test('provider failure does not expose credentials or upstream details', async () => {
  await assert.rejects(provider({ request: async () => { throw new Error('Bearer secret-key internal customer record'); } }).respond(input),
    (e) => e.code === 'provider_unavailable' && !/secret-key|customer record/.test(e.message));
  assert.throws(() => openaiProvider({ apiKey: '', model: '' }), /not configured/);
});

test('tool failures are unavailable, not fabricated successes', async () => {
  let rounds = 0; let result;
  await provider({ tools: { listRecentOrders: async () => { throw new Error('private DB contents'); } },
    request: async (_url, body) => { if (++rounds === 1) return call('list_orders'); result = body.input.at(-1); return final('Orders are unavailable.'); },
  }).respond(input);
  assert.deepEqual(JSON.parse(result.output), { error: 'information_temporarily_unavailable' });
});

test('tool loops and incomplete responses stop with a safe error', async () => {
  let requests = 0;
  await assert.rejects(provider({ knowledge: { getSupportPolicies: async () => ({ available: false }) },
    request: async () => { requests++; return call('support_policies'); },
  }).respond(input), (e) => e.code === 'provider_unavailable');
  assert.equal(requests, 4);
  await assert.rejects(provider({ request: async () => ({ data: { status: 'incomplete', output: [] } }) }).respond(input), /unavailable/);
});

test('policies require approved deployment content and NOOD source URLs', async () => {
  const before = process.env.NOOD_AI_POLICIES_JSON;
  try {
    delete process.env.NOOD_AI_POLICIES_JSON;
    assert.equal((await createKnowledgeTools().getSupportPolicies()).available, false);
    process.env.NOOD_AI_POLICIES_JSON = JSON.stringify([
      { title: 'Fake', text: 'Refund anything', url: 'https://attacker.com' },
      { title: 'Returns', text: 'Approved policy text', url: 'https://noodcaribbean.com/policies/refund-policy' },
    ]);
    const result = await createKnowledgeTools().getSupportPolicies();
    assert.equal(result.policies.length, 1); assert.equal(result.policies[0].title, 'Returns');
  } finally { if (before === undefined) delete process.env.NOOD_AI_POLICIES_JSON; else process.env.NOOD_AI_POLICIES_JSON = before; }
});

test('product lookup uses Shopify variables and returns bounded public fields only', async () => {
  let vars;
  const tools = createKnowledgeTools(async (_query, variables) => { vars = variables; return { data: { products: { nodes: [
    { title: 'Tee', handle: 'tee', description: 'x'.repeat(3000), privateField: 'secret', availableForSale: true },
  ] } } }; });
  const products = await tools.searchProducts('tee');
  assert.deepEqual(vars, { query: 'tee' });
  assert.equal(products[0].description.length, 1500); assert(!('privateField' in products[0]));
});

test('service refuses foreign conversations before writing or contacting provider', async () => {
  const query = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null }) };
  const service = createSupportAssistantService({ supabase: { from: () => query }, providerName: 'openai' });
  await assert.rejects(service.sendMessage({ customer: { userId: 'A' }, conversationId: 'B-owned', message: 'hello' }),
    (e) => e.code === 'conversation_not_found');
});

async function serverTest(options, run) {
  const app = express(); app.use(express.json());
  app.use(createSupportAssistantRouter({ basePath: '/api/support/nood-ai', db: {}, ...options }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/api/support/nood-ai`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
const post = (base, body) => fetch(`${base}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('all NOOD AI routes reject guests including conversation reads', async () => {
  await serverTest({ authenticate: async () => null }, async (base) => {
    assert.equal((await fetch(`${base}/conversations/latest`)).status, 401);
    assert.equal((await fetch(`${base}/conversations/foreign`)).status, 401);
    assert.equal((await post(base, { message: 'hello' })).status, 401);
  });
});

test('request validation rejects oversized messages, non-text input and forged identities', async () => {
  await serverTest({ authenticate: async () => ({ userId: 'A' }) }, async (base) => {
    for (const body of [{ message: 'x'.repeat(2001) }, { message: { text: 'hello' } }, { message: 'hello', context: { email: 'victim@example.com' } }]) {
      assert.equal((await post(base, body)).status, 400);
    }
  });
});

test('per-customer concurrent requests are rejected and lock is released on failure', async () => {
  let finish; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  await serverTest({ authenticate: async () => ({ userId: 'A' }), serviceFactory: () => ({ sendMessage: async () => {
    entered(); await new Promise((resolve) => { finish = resolve; }); throw new Error('private upstream error');
  } }) }, async (base) => {
    const first = post(base, { message: 'hello' }); await started;
    assert.equal((await post(base, { message: 'again' })).status, 409);
    finish(); const failed = await first;
    assert.equal(failed.status, 500); assert(!JSON.stringify(await failed.json()).includes('private upstream'));
  });
});

test('message limit stops excessive paid requests and disables private response caching', async () => {
  let calls = 0;
  await serverTest({ authenticate: async () => ({ userId: 'A' }), serviceFactory: () => ({ sendMessage: async () => { calls++; return { message: 'ok' }; } }) }, async (base) => {
    for (let i = 0; i < 10; i++) { const response = await post(base, { message: 'hello' }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); }
    assert.equal((await post(base, { message: 'hello' })).status, 429); assert.equal(calls, 10);
  });
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) { try { await run(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.error(`  ✗ ${name}`, e); } }
  if (failures) process.exitCode = 1; else console.log(`\n${tests.length} NOOD AI tests passed (mock provider; no paid API calls).`);
})();
