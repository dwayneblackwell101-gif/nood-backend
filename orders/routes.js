/**
 * Orders & shipment tracking HTTP routes.
 * Customer routes require Bearer auth + ownership.
 * Admin routes require admin API key.
 * Existing /api/refunds/* routes are not replaced.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { normalizeShopifyCustomerId } = require('../auth/customer-auth');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  const code =
    error.code ||
    (statusCode === 401
      ? 'unauthenticated'
      : statusCode === 403
        ? 'forbidden'
        : statusCode === 404
          ? 'not_found'
          : statusCode === 429
            ? 'rate_limited'
            : 'internal_error');
  return res.status(statusCode).json({
    success: false,
    error: true,
    code,
    message: error.message || 'Orders request failed.',
  });
}

function createOrdersRouter({
  ordersService,
  requireCustomerAuth,
  requireAdminApiKey,
  isProduction = false,
} = {}) {
  if (!ordersService) throw new Error('ordersService is required');
  if (!requireCustomerAuth) throw new Error('requireCustomerAuth is required');
  if (!requireAdminApiKey) throw new Error('requireAdminApiKey is required');

  const router = express.Router();

  const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isProduction ? 120 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: true,
      code: 'rate_limited',
      message: 'Too many order requests.',
    },
  });

  const mutateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isProduction ? 40 : 400,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: true,
      code: 'rate_limited',
      message: 'Too many order actions.',
    },
  });

  function customerId(req) {
    const id = normalizeShopifyCustomerId(req.customer?.id) || safeString(req.customer?.id);
    if (!id) {
      const err = new Error('Customer authentication required.');
      err.statusCode = 401;
      err.code = 'unauthenticated';
      throw err;
    }
    return id;
  }

  // ——— Customer ———

  router.get('/me', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.listCustomerOrders(customerId(req), {
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/me/sync', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.syncFromShopify(customerId(req));
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/me/push-preferences', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.registerPushPreferences(customerId(req), req.body || {});
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/tracking/:trackingNumber', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.trackingLookup(
        customerId(req),
        req.params.trackingNumber
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:orderId/timeline', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.getTimeline(customerId(req), req.params.orderId, {
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit || req.query.eventsPageSize,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:orderId/shipments', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.getTimeline(customerId(req), req.params.orderId, {
        page: 1,
        pageSize: 1,
      });
      return res.json({
        success: true,
        orderId: payload.order?.id,
        shipments: payload.shipments || [],
        estimatedDelivery: payload.order?.estimatedDelivery,
        deliveryWindow: payload.order?.deliveryWindow,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:orderId/estimated-delivery', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.getTimeline(customerId(req), req.params.orderId, {
        page: 1,
        pageSize: 1,
      });
      return res.json({
        success: true,
        orderId: payload.order?.id,
        estimatedDelivery: payload.order?.estimatedDelivery,
        deliveryWindow: payload.order?.deliveryWindow,
        status: payload.order?.status,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:orderId/refund-status', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.getTimeline(customerId(req), req.params.orderId, {
        page: 1,
        pageSize: 1,
      });
      return res.json({
        success: true,
        orderId: payload.order?.id,
        refundStatus: payload.refundStatus,
        refunded: payload.order?.refunded,
        refundedAmount: payload.order?.refundedAmount,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:orderId/cancel', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.requestCancellation(
        customerId(req),
        req.params.orderId,
        req.body || {}
      );
      return res.status(payload.duplicate ? 200 : 201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:orderId/returns', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.requestReturn(
        customerId(req),
        req.params.orderId,
        req.body || {}
      );
      return res.status(201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:orderId/notes', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const payload = await ordersService.addOrderNote(
        req.params.orderId,
        req.body || {},
        { asAdmin: false, customerId: customerId(req) }
      );
      return res.status(201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  // ——— Admin ———

  router.post('/admin/register', mutateLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const payload = await ordersService.adminRegisterOrder(req.body || {});
      return res.status(201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/admin/:orderId/shipments', mutateLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const payload = await ordersService.createShipment(
        'admin',
        req.params.orderId,
        req.body || {},
        { asAdmin: true, actor: safeString(req.get('x-admin-id'), 'admin') }
      );
      return res.status(201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/admin/:orderId/events', mutateLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const payload = await ordersService.addShipmentEvent(req.params.orderId, req.body || {}, {
        asAdmin: true,
        actor: safeString(req.get('x-admin-id'), 'admin'),
      });
      return res.status(payload.duplicate ? 200 : 201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post(
    '/admin/:orderId/cancel/resolve',
    mutateLimiter,
    requireAdminApiKey,
    async (req, res) => {
      try {
        const payload = await ordersService.resolveCancellation(req.params.orderId, {
          action: req.body?.action,
          note: req.body?.note,
          adminId: safeString(req.get('x-admin-id') || req.body?.adminId, 'admin'),
        });
        return res.json(payload);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    '/admin/:orderId/refund-status',
    mutateLimiter,
    requireAdminApiKey,
    async (req, res) => {
      try {
        const payload = await ordersService.updateRefundStatus(
          req.params.orderId,
          req.body || {},
          { adminId: safeString(req.get('x-admin-id'), 'admin') }
        );
        return res.json(payload);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post('/admin/:orderId/notes', mutateLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const payload = await ordersService.addOrderNote(
        req.params.orderId,
        { ...req.body, adminId: safeString(req.get('x-admin-id'), 'admin') },
        { asAdmin: true }
      );
      return res.status(201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/admin/:orderId/timeline', readLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const payload = await ordersService.getTimeline('admin', req.params.orderId, {
        page: req.query.page,
        pageSize: req.query.pageSize,
        asAdmin: true,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/metrics/summary', readLimiter, requireAdminApiKey, async (req, res) => {
    try {
      return res.json(await ordersService.getMetrics());
    } catch (error) {
      return sendError(res, error);
    }
  });

  // Carrier webhook (shared secret optional)
  router.post('/webhooks/carrier', mutateLimiter, async (req, res) => {
    try {
      const secret =
        req.get('x-carrier-webhook-secret') ||
        req.get('x-nood-carrier-secret') ||
        req.body?.secret;
      const payload = await ordersService.ingestCarrierWebhook(req.body || {}, { secret });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = {
  createOrdersRouter,
};
