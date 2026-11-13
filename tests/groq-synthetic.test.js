const assert = require('assert/strict');
const express = require('express');
const { groqProvider } = require('../services/support-assistant/providers/groq');
const { getScenario, createSyntheticTools } = require('../services/support-assistant/synthetic');
const { createSyntheticRouter, syntheticEnabled, syntheticGuestEnabled } = require('../routes/nood-ai-synthetic');
const { createSupportAssistantProvider } = require('../services/support-assistant/provider');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const final = (content = 'Fictional demo only: your demo order is in transit.') => ({ data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] } });
const call = (name, args = {}) => ({ data: { choices: [{ finish_reason: 'tool_calls', message: {
  role: 'assistant', content: null, tool_calls: [{ id: 'demo-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
} }] } });
const provider = (options = {}) => groqProvider({ syntheticOnly: true, apiKey: 'fake-groq-key', ...options });

test('test mode is disabled by default and cannot run in production', () => {
  assert.equal(syntheticEnabled({}), false);
  const env = { NOOD_AI_TEST_PROVIDER: 'groq', NOOD_AI_SYNTHETIC_ONLY: 'true', GROQ_FREE_TIER_CONFIRMED: 'true' };
  assert.equal(syntheticEnabled({ ...env, NODE_ENV: 'development' }), true);
  assert.equal(syntheticEnabled({ ...env, NODE_ENV: 'production' }), false);
  assert.equal(syntheticEnabled({ ...env, GROQ_FREE_TIER_CONFIRMED: 'false' }), false);
});

test('Groq cannot be selected for a live customer provider context', () => {
  assert.throws(() => createSupportAssistantProvider({ name: 'groq', tools: {} }), (e) => e.code === 'synthetic_only_required');
  assert.throws(() => groqProvider({ syntheticOnly: true, apiKey: 'test', model: 'unapproved-model' }), /unavailable/);
  assert.throws(() => groqProvider({ syntheticOnly: true, apiKey: '' }), /unavailable/);
});

test('Groq receives only static synthetic prompts and a Groq key, with no live tools', async () => {
  let received;
  const result = await provider({ tools: new Proxy({}, { get: () => { throw new Error('live access attempted'); } }),
    request: async (...args) => { received = args; return final(); },
  }).respond({ scenarioId: 'tracking', turn: 0 });
  assert.equal(received[0], 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(received[2].headers.Authorization, 'Bearer fake-groq-key');
  assert.equal(received[1].parallel_tool_calls, false);
  assert.equal(received[1].max_completion_tokens, 700);
  assert(received[1].tools.every((t) => t.type === 'function'));
  assert(!received[1].tools.some((t) => /payment|issue_refund|sql|web_search|code_execution/.test(t.function.name)));
  assert.equal(result.synthetic, true);
  assert.equal(result.prompt, getScenario('tracking', 0).prompt);
});

test('raw chat, identity and conversation history are rejected before external requests', async () => {
  let sent = 0;
  for (const extra of [{ message: 'REAL CUSTOMER SECRET' }, { customer: { userId: 'real-user' } }, { store: {} }, { messages: [{ content: 'real history' }] }]) {
    await assert.rejects(provider({ request: async () => { sent++; return final(); } }).respond({ scenarioId: 'tracking', ...extra }),
      (e) => e.code === 'invalid_synthetic_request');
  }
  assert.equal(sent, 0);
});

test('tool calling round trip returns fictional results with matching call IDs', async () => {
  const requests = [];
  await provider({ request: async (_url, body) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    return requests.length === 1 ? call('get_tracking', { orderId: 'DEMO-1001' }) : final();
  } }).respond({ scenarioId: 'tracking' });
  const tool = requests[1].messages.at(-1);
  assert.equal(tool.tool_call_id, 'demo-call');
  assert.equal(JSON.parse(tool.content).carrier, 'Demo Carrier');
  assert.equal(JSON.parse(tool.content).fictional, true);
});

test('foreign or live order identifiers never resolve', async () => {
  const fixtures = createSyntheticTools();
  assert.equal((await fixtures.get_order({ orderId: 'real-order' })).error, 'order_not_available');
  assert.equal((await fixtures.get_tracking({ orderId: 'real-order' })).error, 'order_not_available');
});

test('unknown write calls and injected identity arguments never execute', async () => {
  for (const requestCall of [call('issue_refund', { orderId: 'DEMO-1001' }), call('list_orders', { userId: 'victim' }), call('get_order', { orderId: 'DEMO-1001', email: 'real@example.com' })]) {
    let round = 0; let output;
    await provider({ request: async (_url, body) => { if (++round === 1) return requestCall; output = body.messages.at(-1); return final(); } }).respond({ scenarioId: 'refund' });
    assert.equal(JSON.parse(output.content).error, 'unsupported_tool_or_arguments');
  }
});

test('scripted follow-up contains only scripted demo history', async () => {
  let body;
  await provider({ request: async (_url, requestBody) => { body = requestBody; return final(); } }).respond({ scenarioId: 'tracking', turn: 1 });
  assert.equal(body.messages.length, 4);
  assert.equal(body.messages.at(-1).content, getScenario('tracking', 1).prompt);
  assert.match(body.messages[2].content, /Fictional order/);
});

test('rate limit and network failures stop without fallback or retries', async () => {
  let requests = 0;
  await assert.rejects(provider({ request: async () => { requests++; const error = new Error('secret'); error.response = { status: 429 }; throw error; } }).respond({ scenarioId: 'tracking' }),
    (e) => e.code === 'provider_rate_limited' && !e.message.includes('secret'));
  assert.equal(requests, 1);
});

test('tool loops, malformed responses and truncated output are bounded', async () => {
  let count = 0;
  await assert.rejects(provider({ request: async () => { count++; return call('list_orders'); } }).respond({ scenarioId: 'tracking' }), /unavailable/);
  assert.equal(count, 4);
  await assert.rejects(provider({ request: async () => ({ data: { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] } }) }).respond({ scenarioId: 'tracking' }), /unavailable/);
});

async function serverTest(options, run) {
  const app = express(); app.use(express.json()); app.use(createSyntheticRouter({ enabled: () => true, ...options }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/api/support/nood-ai/synthetic`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
const post = (base, body) => fetch(`${base}/message`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer REAL-CUSTOMER-TOKEN' }, body: JSON.stringify(body) });

test('guest demo is opt-in, development-only, and requires synthetic mode', () => {
  const env = { NODE_ENV: 'development', NOOD_AI_TEST_PROVIDER: 'groq', NOOD_AI_SYNTHETIC_ONLY: 'true', GROQ_FREE_TIER_CONFIRMED: 'true', NOOD_AI_DEMO_ALLOW_GUEST: 'true' };
  assert.equal(syntheticGuestEnabled(env), true);
  assert.equal(syntheticGuestEnabled({ ...env, NODE_ENV: 'production' }), false);
  assert.equal(syntheticGuestEnabled({ ...env, NOOD_AI_SYNTHETIC_ONLY: 'false' }), false);
  assert.equal(syntheticGuestEnabled({ ...env, NOOD_AI_DEMO_ALLOW_GUEST: 'false' }), false);
});

test('guest demo skips customer lookup and still rejects real message input', async () => {
  await serverTest({ guestAllowed: () => true, authenticate: async () => { throw new Error('Customer lookup must not occur'); },
    providerFactory: () => ({ respond: async () => ({ synthetic: true, message: 'Fictional demo answer' }) }),
  }, async (base) => {
    assert.equal((await fetch(`${base}/scenarios`)).status, 200);
    assert.equal((await post(base, { scenarioId: 'tracking', message: 'private real data' })).status, 400);
    assert.equal((await post(base, { scenarioId: 'tracking', turn: 0 })).status, 200);
    assert.equal((await fetch(`${base}/../conversations/latest`)).status, 404);
  });
});

test('synthetic endpoints retain customer authentication', async () => {
  await serverTest({ authenticate: async () => null }, async (base) => {
    assert.equal((await fetch(`${base}/scenarios`)).status, 401);
    assert.equal((await post(base, { scenarioId: 'tracking', turn: 0 })).status, 401);
  });
});

test('disabled endpoint never authenticates or calls provider', async () => {
  await serverTest({ enabled: () => false, authenticate: async () => { throw new Error('should not run'); } }, async (base) => {
    assert.equal((await post(base, { scenarioId: 'tracking' })).status, 404);
  });
});

test('route passes no real customer fields, authorization headers or supplied history to Groq', async () => {
  let options; let input;
  await serverTest({ authenticate: async () => ({ userId: 'REAL-CUSTOMER-ID', email: 'real-customer@example.com' }),
    providerFactory: (config) => { options = config; return { respond: async (args) => { input = args; return { synthetic: true, message: 'demo' }; } }; },
  }, async (base) => {
    assert.equal((await post(base, { scenarioId: 'tracking', turn: 1 })).status, 200);
  });
  assert.deepEqual(options, { syntheticOnly: true }); assert.deepEqual(input, { scenarioId: 'tracking', turn: 1 });
  assert(!JSON.stringify({ options, input }).includes('REAL-CUSTOMER'));
});

test('route rejects free-form messages, imported history, identity and invalid scenarios', async () => {
  let requests = 0;
  await serverTest({ authenticate: async () => ({ userId: 'test' }), providerFactory: () => { requests++; throw new Error('should not run'); } }, async (base) => {
    for (const body of [{ scenarioId: 'tracking', message: 'private message' }, { scenarioId: 'tracking', conversationId: 'real-chat' },
      { scenarioId: 'tracking', userId: 'victim' }, { scenarioId: '__proto__' }, { scenarioId: 'tracking', turn: 2 }, { scenarioId: 'tracking', turn: '0' }]) {
      assert.equal((await post(base, body)).status, 400);
    }
  });
  assert.equal(requests, 0);
});

test('shared demo limiter stops at two requests per minute', async () => {
  let requests = 0;
  await serverTest({ authenticate: async () => ({ userId: 'test' }), providerFactory: () => ({ respond: async () => { requests++; return { synthetic: true, message: 'demo' }; } }) }, async (base) => {
    assert.equal((await post(base, { scenarioId: 'tracking' })).status, 200);
    assert.equal((await post(base, { scenarioId: 'tracking' })).status, 200);
    assert.equal((await post(base, { scenarioId: 'tracking' })).status, 429);
  });
  assert.equal(requests, 2);
});

test('selecting Groq demo mode blocks normal paid chat before it reaches OpenAI', async () => {
  const app = express(); app.use(express.json());
  app.use(createSyntheticRouter({ testProviderSelected: () => true }));
  let paidCalls = 0;
  app.post('/api/support/nood-ai/message', (_req, res) => { paidCalls++; res.json({ success: true }); });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/support/nood-ai/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'private customer text' }),
    });
    assert.equal(response.status, 409); assert.equal(paidCalls, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) { try { await run(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.error(`  ✗ ${name}`, error); } }
  if (failed) process.exitCode = 1; else console.log(`\n${tests.length} synthetic Groq tests passed. No external API calls or customer records used.`);
})();
