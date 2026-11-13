require('dotenv').config({ quiet: true });
const axios = require('axios');
const { syntheticEnabled } = require('../routes/nood-ai-synthetic');
const { nineRouterProvider } = require('../services/support-assistant/providers/nine-router');
let reason = 'configuration or unexpected response';

(async () => {
  if (!syntheticEnabled() || process.env.NINE_ROUTER_LIVE_TEST !== '1') {
    throw new Error('Explicit synthetic route opt-in is required.');
  }
  const model = process.env.NINE_ROUTER_MODEL;
  if (!process.env.NINE_ROUTER_API_KEY) throw new Error('Private 9Router key is missing.');
  let toolRoundObserved = false;
  const request = async (method, url, ...args) => {
    try { return await axios[method](url, ...args); }
    catch (error) { reason = error.response?.status ? `HTTP ${Number(error.response.status)}` : 'network failure'; throw error; }
  };
  const { data } = await request('get', `${process.env.NINE_ROUTER_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${process.env.NINE_ROUTER_API_KEY}` }, timeout: 15000, maxRedirects: 0, proxy: false,
  });
  if (!data?.data?.some((item) => item.id === model)) { reason = 'configured model is not available to this account'; throw new Error(); }
  const provider = nineRouterProvider({ syntheticOnly: true, request: (...args) => {
    if (args[1]?.messages?.some((message) => message.role === 'tool')) toolRoundObserved = true;
    return request('post', ...args);
  } });
  const result = await provider.respond({ scenarioId: 'tracking', turn: 0 });
  if (!result.synthetic || !result.message) throw new Error();
  if (!toolRoundObserved) { reason = 'model did not complete a tool-calling round trip'; throw new Error(); }
  console.log('9Router model availability and synthetic tool-chat smoke test passed. Only fictional data used; no backend provider fallback.');
})().catch(() => { console.error(`9Router synthetic smoke test did not complete: ${reason}. No paid fallback or secret values logged.`); process.exitCode = 1; });
