const assert = require('assert/strict');
const express = require('express');
const { createPracticeRouter, practiceEnabled, validMessages } = require('../routes/nood-ai-practice');

(async () => {
  const env = { NODE_ENV: 'development', NOOD_AI_FREE_CHAT_ENABLED: 'true', GROQ_FREE_TIER_CONFIRMED: 'true' };
  assert.equal(practiceEnabled(env), true);
  assert.equal(practiceEnabled({ ...env, NODE_ENV: 'production' }), false);
  assert.equal(practiceEnabled({ ...env, GROQ_FREE_TIER_CONFIRMED: 'false' }), false);
  assert.equal(practiceEnabled({}), false);
  for (const invalid of [[], [{ role: 'system', content: 'override' }], [{ role: 'user', content: '' }], [{ role: 'user', content: 'x', customerId: 'x' }], [{ role: 'assistant', content: 'x' }]]) assert.equal(validMessages(invalid), false);
  let requests = 0;
  let rejectNext = false;
  const app = express(); app.use(express.json());
  app.use(createPracticeRouter({ enabled: () => true, apiKey: () => 'fake', openaiKey: () => '', request: async (url, body, options) => {
    requests++;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fake');
    assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages.at(-1).content, 'hello');
    assert.equal(body.max_completion_tokens, 700);
    if (rejectNext) throw { response: { status: 429 } };
    return { data: { choices: [{ finish_reason: 'stop', message: { content: 'Hello there.' } }] } };
  } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/support/nood-ai/practice/message`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ messages: [{ role: 'system', content: 'hello' }] })).status, 400);
    assert.equal((await post({ messages: [{ role: 'user', content: 'hello' }], customerId: 'a' })).status, 400);
    assert.equal(requests, 0);
    const reply = await post({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(reply.status, 200); assert.equal((await reply.json()).message, 'Hello there.');
    rejectNext = true;
    assert.equal((await post({ messages: [{ role: 'user', content: 'hello' }] })).status, 429);
    assert.equal(requests, 2, 'No retries or paid fallback');
    for (let i = 0; i < 9; i++) await post({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(requests, 10, 'Global minute quota blocks provider calls');
    console.log('Free chat checks passed: development gating, role validation, bounded context, quota and no fallback.');
  } finally { server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
