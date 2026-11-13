// Explicit opt-in smoke test. Sends only a synthetic greeting, never customer records.
require('dotenv').config({ quiet: true });
const { openaiProvider } = require('../services/support-assistant/providers/openai');
const axios = require('axios');
let failureReason = 'configuration or unexpected response';

(async () => {
  if (process.env.NOOD_AI_LIVE_TEST !== '1') throw new Error('Set NOOD_AI_LIVE_TEST=1 to authorize a billed synthetic API smoke test.');
  const message = 'Hello, introduce yourself in one short sentence. Do not look up any information.';
  const provider = openaiProvider({ tools: {}, request: async (...args) => {
    try { return await axios.post(...args); }
    catch (error) {
      const allowed = ['invalid_api_key', 'insufficient_quota', 'model_not_found', 'rate_limit_exceeded'];
      const code = error.response?.data?.error?.code;
      failureReason = error.response?.status ? `HTTP ${Number(error.response.status)}${allowed.includes(code) ? ` (${code})` : ''}` : 'network connection failed';
      throw error;
    }
  } });
  const answer = await provider.respond({ message, conversationId: 'synthetic-smoke-test',
    store: { listMessages: async () => [{ sender_role: 'customer', body: message }] } });
  if (!answer.message || answer.state !== 'talking') throw new Error('Unexpected response');
  console.log('NOOD AI live text smoke test passed. Synthetic greeting only; no customer data sent.');
})().catch(() => { console.error(`NOOD AI live smoke test failed: ${failureReason}. No credential values logged.`); process.exitCode = 1; });
