const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { authenticateCustomer } = require('../services/customer-auth');
const { listScenarios, getScenario } = require('../services/support-assistant/synthetic');
const { nineRouterProvider } = require('../services/support-assistant/providers/nine-router');
const { groqProvider } = require('../services/support-assistant/providers/groq');

function syntheticEnabled(env = process.env) {
  const providerApproved = (env.NOOD_AI_TEST_PROVIDER === 'groq' && env.GROQ_FREE_TIER_CONFIRMED === 'true') ||
    (env.NOOD_AI_TEST_PROVIDER === '9router' && env.NINE_ROUTER_ROUTE_CONFIRMED === 'true');
  return env.NODE_ENV !== 'production' && env.NOOD_AI_SYNTHETIC_ONLY === 'true' && providerApproved;
}

function syntheticGuestEnabled(env = process.env) {
  return env.NODE_ENV === 'development' && syntheticEnabled(env) && env.NOOD_AI_DEMO_ALLOW_GUEST === 'true';
}

function createSyntheticRouter({ authenticate = authenticateCustomer, enabled = syntheticEnabled,
  guestAllowed = syntheticGuestEnabled,
  testProviderSelected = () => ['groq', '9router'].includes(process.env.NOOD_AI_TEST_PROVIDER),
  providerFactory = (options) => process.env.NOOD_AI_TEST_PROVIDER === '9router' ? nineRouterProvider(options) : groqProvider(options) } = {}) {
  const router = express.Router();
  let busy = false;
  const minuteLimit = rateLimit({ windowMs: 60000, limit: 2, keyGenerator: () => 'synthetic-demo',
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { success: false, message: 'Demo limit reached. Please wait a minute.' } });
  const dailyLimit = rateLimit({ windowMs: 86400000, limit: 50, keyGenerator: () => 'synthetic-demo',
    message: { success: false, message: 'Daily demo limit reached.' } });
  const base = '/api/support/nood-ai/synthetic';
  // Selecting demo mode also blocks accidental use of the normal paid chat endpoint.
  router.post('/api/support/nood-ai/message', (_req, res, next) => {
    if (!testProviderSelected()) return next();
    return res.status(409).json({ success: false, message: 'Synthetic test mode is selected. Use the demo screen; paid chat is disabled.' });
  });
  router.use(base, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled()) return res.status(404).json({ success: false, message: 'Synthetic demo is disabled.' });
    if (guestAllowed()) return next();
    try {
      if (!(await authenticate(req))?.userId) return res.status(401).json({ success: false, message: 'Sign in to use the demo.' });
      // The authenticated identity is deliberately never passed to the provider.
      next();
    } catch { return res.status(401).json({ success: false, message: 'Sign in to use the demo.' }); }
  });
  router.get(`${base}/scenarios`, (_req, res) => {
    res.json({ success: true, synthetic: true, scenarios: listScenarios() });
  });
  router.post(`${base}/message`, (req, res, next) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['scenarioId', 'turn'].includes(key)) ||
      typeof body.scenarioId !== 'string' || !getScenario(body.scenarioId, body.turn)) {
      return res.status(400).json({ success: false, message: 'Choose a fixed demo scenario. Free-form customer messages are not accepted.' });
    }
    next();
  }, minuteLimit, dailyLimit, async (req, res) => {
    if (busy) return res.status(409).json({ success: false, message: 'Please wait for the current demo reply.' });
    busy = true;
    try {
      const provider = providerFactory({ syntheticOnly: true });
      const result = await provider.respond({ scenarioId: req.body.scenarioId, turn: req.body.turn ?? 0 });
      return res.json({ success: true, ...result });
    } catch (error) {
      return res.status(error.code === 'provider_rate_limited' ? 429 : 503).json({ success: false,
        message: 'The selected demo provider is unavailable or has reached its limits. No backend provider fallback was attempted.' });
    } finally { busy = false; }
  });
  return router;
}
module.exports = { createSyntheticRouter, syntheticEnabled, syntheticGuestEnabled };
