require('dotenv').config({ quiet: true });
const axios = require('axios');
const { syntheticEnabled } = require('../routes/nood-ai-synthetic');
const { groqProvider } = require('../services/support-assistant/providers/groq');
let reason = 'configuration or unexpected response';

(async () => {
  if (!syntheticEnabled() || process.env.GROQ_LIVE_TEST !== '1') {
    throw new Error('Explicit synthetic free-tier opt-in is required.');
  }
  const model = process.env.GROQ_TEST_MODEL || 'openai/gpt-oss-20b';
  if (!process.env.GROQ_API_KEY) throw new Error('Private Groq key is missing.');
  let toolRoundObserved = false;
  const request = async (method, url, ...args) => {
    try { return await axios[method](url, ...args); }
    catch (error) { reason = error.response?.status ? `HTTP ${Number(error.response.status)}` : 'network failure'; throw error; }
  };
  const { data } = await request('get', 'https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 15000,
  });
  if (!data?.data?.some((item) => item.id === model)) { reason = 'configured model is not available to this account'; throw new Error(); }
  const provider = groqProvider({ syntheticOnly: true, request: (...args) => {
    if (args[1]?.messages?.some((message) => message.role === 'tool')) toolRoundObserved = true;
    return request('post', ...args);
  } });
  const result = await provider.respond({ scenarioId: 'tracking', turn: 0 });
  if (!result.synthetic || !result.message) throw new Error();
  if (!toolRoundObserved) { reason = 'model did not complete a tool-calling round trip'; throw new Error(); }
  console.log('Groq model availability and synthetic tool-chat smoke test passed. No customer data or OpenAI requests used.');
})().catch(() => { console.error(`Groq synthetic smoke test did not complete: ${reason}. No paid fallback or secret values logged.`); process.exitCode = 1; });
