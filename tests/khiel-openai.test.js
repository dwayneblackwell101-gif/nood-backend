const assert = require('assert/strict');
const express = require('express');
const { khielKey, khielOpenAIReply } = require('../services/khiel-openai');
const { practiceEnabled, createPracticeRouter } = require('../routes/nood-ai-practice');

(async () => {
  assert.equal(khielKey({ OPENAI_API_KEY: 'old-unrelated-key' }), '');
  assert.equal(practiceEnabled({ NODE_ENV: 'production', KHIEL_OPENAI_API_KEY: 'future-key' }), true);
  assert.equal(practiceEnabled({ NODE_ENV: 'production', OPENAI_API_KEY: 'old-key' }), false);
  let captured;
  const reply = await khielOpenAIReply({ req: { headers: {} }, messages: [{ role: 'user', content: 'my orders' }], apiKey: 'future-key',
    authenticate: async () => { throw new Error('Guest must not authenticate'); },
    providerFactory: (options) => { captured = options; return { respond: async ({ store }) => {
      assert.equal((await store.listMessages())[0].body, 'my orders');
      assert.equal((await options.tools.listRecentOrders(5)).error, 'sign_in_required');
      return { message: 'Sign in to see your orders.' };
    } }; },
  });
  assert.equal(reply, 'Sign in to see your orders.');
  assert.equal(captured.apiKey, 'future-key');
  assert(captured.instructions.includes('Your name is Khiel'));
  const app = express(); app.use(express.json());
  let providerCalls = 0;
  app.use(createPracticeRouter({ enabled: () => true, openaiKey: () => 'future-key', apiKey: () => 'unused-groq',
    openaiReply: async ({ apiKey }) => { assert.equal(apiKey, 'future-key'); providerCalls++; return 'Prepared OpenAI reply.'; },
    request: async (url, body, options) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/speech');
      assert.equal(body.model, 'gpt-4o-mini-tts');
      assert.equal(options.headers.Authorization, 'Bearer future-key');
      return { data: Buffer.from('mock-mp3') };
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/support/khiel`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const status = await (await fetch(base + '/status')).json();
    assert.equal(status.provider, 'openai'); assert.equal(status.voice, 'openai');
    const result = await (await post('/message', { messages: [{ role: 'user', content: 'hello' }] })).json();
    assert.equal(result.message, 'Prepared OpenAI reply.'); assert.equal(providerCalls, 1);
    assert.equal((await post('/message', { messages: [{ role: 'user', content: 'hello' }], customerId: 'forged' })).status, 400);
    const speech = await (await post('/speech', { text: 'Hello.' })).json();
    assert.equal(Buffer.from(speech.audioBase64, 'base64').toString(), 'mock-mp3');
    assert.equal((await post('/speech', { text: 'x'.repeat(2001) })).status, 400);
    console.log('Khiel OpenAI preparation checks passed: explicit key activation, guest isolation, provider selection, validated voice proxy. No external requests.');
  } finally { server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
