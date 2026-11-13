const assert = require('assert/strict');
const { nineRouterProvider } = require('../services/support-assistant/providers/nine-router');
const { syntheticEnabled, syntheticGuestEnabled } = require('../routes/nood-ai-synthetic');
const options = { syntheticOnly: true, apiKey: 'fictional-proxy-key', model: 'Codex-Free', baseUrl: 'http://localhost:20128/v1' };
(async () => {
  assert.throws(() => nineRouterProvider({ ...options, syntheticOnly: false }));
  for (const baseUrl of ['https://example.com/v1', 'http://localhost:20128/v1@evil.test', 'http://localhost:20128/v1/']) {
    assert.throws(() => nineRouterProvider({ ...options, baseUrl }));
  }
  let count = 0;
  const provider = nineRouterProvider({ ...options, request: async (url, body, config) => {
    assert.equal(url, 'http://localhost:20128/v1/chat/completions');
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.proxy, false);
    assert.equal(config.headers.Authorization, 'Bearer fictional-proxy-key');
    assert(!body.tools.some(t => /payment|issue_refund|modify/.test(t.function.name)));
    count++;
    if (count === 1) return { data: { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'fictional-call', type: 'function', function: { name: 'get_tracking', arguments: '{"orderId":"DEMO-1001"}' } }] } }] } };
    assert.equal(JSON.parse(body.messages.at(-1).content).fictional, true);
    return { data: { choices: [{ finish_reason: 'stop', message: { content: 'Fictional demo tracking.' } }] } };
  } });
  await assert.rejects(provider.respond({ scenarioId: 'tracking', message: 'customer data' }));
  assert.equal(count, 0);
  const reply = await provider.respond({ scenarioId: 'tracking', turn: 0 });
  assert.equal(reply.provider, '9router');
  assert.equal(count, 2);
  const env = { NODE_ENV: 'development', NOOD_AI_TEST_PROVIDER: '9router', NOOD_AI_SYNTHETIC_ONLY: 'true', NINE_ROUTER_ROUTE_CONFIRMED: 'true', NOOD_AI_DEMO_ALLOW_GUEST: 'true' };
  assert(syntheticEnabled(env));
  assert(syntheticGuestEnabled(env));
  assert(!syntheticEnabled({ ...env, NODE_ENV: 'production' }));
  assert(!syntheticEnabled({ ...env, NINE_ROUTER_ROUTE_CONFIRMED: 'false' }));
  let attempts = 0;
  await assert.rejects(nineRouterProvider({ ...options, request: async () => { attempts++; throw new Error('upstream failed'); } }).respond({ scenarioId: 'tracking' }));
  assert.equal(attempts, 1);
  console.log('9Router synthetic tests passed: local-only credentials, fictional tools, opt-in, no retries or backend fallback. No external requests.');
})().catch(() => { console.error('9Router synthetic test failed.'); process.exitCode = 1; });
