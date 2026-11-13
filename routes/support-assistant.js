const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { supabaseAdmin } = require('../utils/supabase-admin');
const { authenticateCustomer } = require('../services/customer-auth');
const { createSupportAssistantService } = require('../services/support-assistant');

const IDENTITY_FIELDS = ['userId', 'customerId', 'email', 'customerEmail', 'shopifyCustomerId', 'supabaseUserId'];
const DEVELOPMENT_TEST_IDENTITY = 'nood-development-ai-test-session';
const isDevelopmentTestCustomer = (customer) => process.env.NODE_ENV !== 'production' && customer?.developmentTestSession === true && customer.userId === DEVELOPMENT_TEST_IDENTITY;



function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function safeContext(value) {
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    selectedOrderId: clean(context.selectedOrderId, 120) || undefined,
    confirmHandoff: context.confirmHandoff === true,
    category: clean(context.category, 30).toLowerCase() || undefined,
    subject: clean(context.subject, 120) || undefined,
  };
}

function errorStatus(error) {
  if (error?.code === 'conversation_not_found') return 404;
  if (error?.code === 'forbidden_order') return 403;
  if (error?.code === 'provider_unavailable' || error?.code === 'assistant_storage_unavailable') return 503;
  return 500;
}

function createSupportAssistantRouter({
  db = supabaseAdmin,
  authenticate = authenticateCustomer,
  serviceFactory = createSupportAssistantService,
  providerName,
  basePath = '/api/support/assistant',
} = {}) {
  const router = express.Router();
  const busy = new Set();
  const messageLimit = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (req) => req.supportCustomer.userId,
    message: { success: false, message: 'Please wait a moment before sending more messages.' } });

  async function customerFor(req, res) {
    const customer = req.supportCustomer || await authenticate(req);
    if (!customer?.userId) {
      res.status(401).json({ success: false, message: 'Signed-in identity required' });
      return null;
    }
    return customer;
  }

  router.use(basePath, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const customer = await customerFor(req, res);
      if (!customer) return;
      req.supportCustomer = customer;
      next();
    } catch { res.status(401).json({ success: false, message: 'Sign in again to use NOOD AI.' }); }
  });

  router.get(`${basePath}/conversations/latest`, async (req, res) => {
    try {
      const customer = await customerFor(req, res);
      if (!customer) return;
      if (!db && !isDevelopmentTestCustomer(customer)) return res.status(503).json({ success: false, message: 'Support assistant storage is not configured.' });
      const service = serviceFactory({ supabase: db, providerName });
      const result = await service.getConversation({ customer, latest: true });
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('[SUPPORT ASSISTANT] latest conversation failed:', error.message);
      return res.status(errorStatus(error)).json({ success: false, message: 'Assistant conversation could not be loaded.' });
    }
  });

  router.get(`${basePath}/conversations/:conversationId`, async (req, res) => {
    try {
      const customer = await customerFor(req, res);
      if (!customer) return;
      if (!db && !isDevelopmentTestCustomer(customer)) return res.status(503).json({ success: false, message: 'Support assistant storage is not configured.' });
      const service = serviceFactory({ supabase: db, providerName });
      const result = await service.getConversation({
        customer,
        conversationId: clean(req.params.conversationId, 80),
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('[SUPPORT ASSISTANT] conversation failed:', error.message);
      return res.status(errorStatus(error)).json({ success: false, message: error?.code === 'conversation_not_found' ? error.message : 'Assistant conversation could not be loaded.' });
    }
  });

  router.post(`${basePath}/message`, messageLimit, async (req, res) => {
    let busyUser;
    try {
      const customer = await customerFor(req, res);
      if (!customer) return;
      if (busy.has(customer.userId)) return res.status(409).json({ success: false, message: 'Please wait for your current reply.' });
      if (!db && !isDevelopmentTestCustomer(customer)) return res.status(503).json({ success: false, message: 'Support assistant storage is not configured.' });

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const rawContext = body.context && typeof body.context === 'object' ? body.context : {};
      const suppliedIdentity = IDENTITY_FIELDS.find((field) =>
        Object.prototype.hasOwnProperty.call(body, field) || Object.prototype.hasOwnProperty.call(rawContext, field)
      );
      if (suppliedIdentity) {
        return res.status(400).json({ success: false, message: 'Customer identity must not be supplied in the request body.' });
      }
      if (typeof body.message !== 'string' || body.message.length > 2000 ||
        (body.conversationId !== undefined && (typeof body.conversationId !== 'string' || body.conversationId.length > 80))) {
        return res.status(400).json({ success: false, message: 'Enter a message up to 2,000 characters.' });
      }
      const message = clean(body.message, 2000);
      if (!message) return res.status(400).json({ success: false, message: 'A support message is required.' });

      busyUser = customer.userId;
      busy.add(busyUser);
      const service = serviceFactory({ supabase: db, providerName });
      const result = await service.sendMessage({
        customer,
        message,
        conversationId: clean(body.conversationId, 80) || undefined,
        context: safeContext(body.context),
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      const status = errorStatus(error);
      console.error('[SUPPORT ASSISTANT] message failed:', error.code || 'assistant_error');
      return res.status(status).json({
        success: false,
        code: error?.code || 'assistant_error',
        message: status === 503
          ? 'NOOD AI is temporarily unavailable. You can still contact human support.'
          : error?.code === 'conversation_not_found' || error?.code === 'forbidden_order'
            ? error.message
            : 'NOOD AI could not answer right now.',
      });
    } finally {
      if (busyUser) busy.delete(busyUser);
    }
  });

  return router;
}

const router = createSupportAssistantRouter();
router.use(require('./nood-ai-practice').createPracticeRouter());
router.use(require('./nood-ai-synthetic').createSyntheticRouter());
// Separate opt-in AI endpoints preserve the existing deterministic assistant.
router.use(createSupportAssistantRouter({ basePath: '/api/support/nood-ai', providerName: 'openai' }));

module.exports = { router, createSupportAssistantRouter, safeContext, IDENTITY_FIELDS };
