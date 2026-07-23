/**
 * Reviews + Product Q&A HTTP routes.
 * Public read endpoints are unauthenticated.
 * Mutations require verified customer auth (auth subject only).
 * Moderation / seller replies require admin API key.
 *
 * Route order: static paths before parametric /:reviewId.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { normalizeShopifyCustomerId } = require('../auth/customer-auth');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function getRequestRisk(req) {
  return {
    ip: safeString(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
    deviceId: safeString(req.get('x-nood-device-id') || req.body?.deviceId),
    userAgent: safeString(req.get('user-agent')).slice(0, 200),
  };
}

function getIdempotencyKey(req) {
  return safeString(
    req.get('idempotency-key') || req.get('x-idempotency-key') || req.body?.idempotencyKey
  );
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
          : statusCode === 409
            ? 'conflict'
            : statusCode === 429
              ? 'rate_limited'
              : 'internal_error');

  return res.status(statusCode).json({
    success: false,
    error: true,
    code,
    message: error.message || 'Reviews request failed.',
  });
}

function createReviewsRouter({
  reviewsService,
  mediaService = null,
  requireCustomerAuth,
  requireAdminApiKey,
  isProduction = false,
} = {}) {
  if (!reviewsService) {
    throw new Error('reviewsService is required');
  }
  if (!requireCustomerAuth) {
    throw new Error('requireCustomerAuth is required');
  }
  if (!requireAdminApiKey) {
    throw new Error('requireAdminApiKey is required');
  }

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
      message: 'Too many review requests. Please try again shortly.',
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
      message: 'Too many review actions. Please try again shortly.',
    },
  });

  function authenticatedCustomerId(req) {
    const id = normalizeShopifyCustomerId(req.customer?.id) || safeString(req.customer?.id);
    if (!id) {
      const error = new Error('Customer authentication required.');
      error.statusCode = 401;
      error.code = 'unauthenticated';
      throw error;
    }
    return id;
  }

  function productKeyParams(req) {
    const raw = safeString(req.params.productKey);
    const isHandle = !raw.startsWith('gid://') && !/^\d+$/.test(raw);
    return {
      productHandle: isHandle ? raw : safeString(req.query.handle),
      productId: isHandle ? safeString(req.query.productId) : raw,
    };
  }

  // ——— Public product reviews ———

  router.get('/products/:productKey/summary', readLimiter, async (req, res) => {
    try {
      const keys = productKeyParams(req);
      const payload = await reviewsService.listProductReviews({
        ...keys,
        page: 1,
        pageSize: 1,
      });
      return res.json({
        success: true,
        productKey: payload.productKey,
        aggregate: payload.aggregate,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/products/:productKey', readLimiter, async (req, res) => {
    try {
      const keys = productKeyParams(req);
      const payload = await reviewsService.listProductReviews({
        ...keys,
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit,
        sort: req.query.sort,
        rating: req.query.rating,
        verified: req.query.verified,
        withMedia: req.query.withMedia,
        q: req.query.q || req.query.search,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/', readLimiter, async (req, res) => {
    try {
      const payload = await reviewsService.listProductReviews({
        productHandle: req.query.productHandle || req.query.handle,
        productId: req.query.productId,
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit,
        sort: req.query.sort,
        rating: req.query.rating,
        verified: req.query.verified,
        withMedia: req.query.withMedia,
        q: req.query.q || req.query.search,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  // ——— Customer "my reviews" ———

  router.get('/me/reviews', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await reviewsService.listMyReviews(customerId, {
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  // ——— Metrics & moderation (admin) — before /:reviewId ———

  router.get('/metrics/summary', readLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const payload = await reviewsService.getMetrics();
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/moderation/queue', readLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const payload = await reviewsService.listModerationQueue({
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  // ——— Product Q&A ———

  router.get('/questions', readLimiter, async (req, res) => {
    try {
      const payload = await reviewsService.listQuestions({
        productHandle: req.query.productHandle || req.query.handle,
        productId: req.query.productId,
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit,
        q: req.query.q || req.query.search,
        sort: req.query.sort,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/questions', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await reviewsService.createQuestion(
        customerId,
        req.body || {},
        getRequestRisk(req)
      );
      return res.status(201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post(
    '/questions/:questionId/vote',
    mutateLimiter,
    requireCustomerAuth,
    async (req, res) => {
      try {
        const customerId = authenticatedCustomerId(req);
        const payload = await reviewsService.voteQuestionHelpful(
          customerId,
          req.params.questionId
        );
        return res.json(payload);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    '/questions/:questionId/answers',
    mutateLimiter,
    requireAdminApiKey,
    async (req, res) => {
      try {
        const adminId = safeString(req.get('x-admin-id') || req.body?.adminId, 'admin');
        const authorType = safeString(req.body?.authorType, 'seller');
        const payload = await reviewsService.answerQuestion(
          adminId,
          req.params.questionId,
          req.body || {},
          authorType
        );
        return res.status(201).json(payload);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    '/questions/:questionId/moderate',
    mutateLimiter,
    requireAdminApiKey,
    async (req, res) => {
      try {
        const adminId = safeString(req.get('x-admin-id') || req.body?.adminId, 'admin');
        const payload = await reviewsService.moderateQuestion(adminId, req.params.questionId, {
          action: req.body?.action,
          note: req.body?.note,
        });
        return res.json(payload);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  // ——— Media staging (auth) ———

  router.post('/media', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      if (!mediaService) {
        const err = new Error('Media service unavailable.');
        err.statusCode = 503;
        err.code = 'media_unavailable';
        throw err;
      }
      let record;
      if (req.body?.url) {
        record = await mediaService.storeRemoteUrlMedia({
          url: req.body.url,
          mime: req.body.mime || req.body.contentType,
          sizeBytes: req.body.sizeBytes || req.body.size || 0,
          customerId,
        });
      } else {
        record = await mediaService.storeBase64Media({
          data: req.body?.data,
          mime: req.body?.mime || req.body?.contentType,
          customerId,
        });
      }
      return res.status(201).json({
        success: true,
        media: {
          id: record.id,
          type: record.type,
          url: record.url,
          mime: record.mime,
          sizeBytes: record.sizeBytes,
          storageKey: record.storageKey,
          storageDriver: record.storageDriver,
        },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // ——— Create review ———

  router.post('/', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await reviewsService.createReview(
        customerId,
        req.body || {},
        getRequestRisk(req),
        getIdempotencyKey(req)
      );
      return res.status(payload.idempotentReplay ? 200 : 201).json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  // ——— Parametric review routes (after static paths) ———

  router.get('/:reviewId', readLimiter, async (req, res) => {
    try {
      const payload = await reviewsService.getReviewById(req.params.reviewId);
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch('/:reviewId', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await reviewsService.updateReview(
        customerId,
        req.params.reviewId,
        req.body || {},
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete('/:reviewId', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await reviewsService.deleteReview(customerId, req.params.reviewId);
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:reviewId/vote', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const vote = req.body?.vote || req.body?.value || req.body?.helpful;
      const normalized =
        vote === true || vote === 'true' || vote === 1
          ? 'helpful'
          : vote === false || vote === 'false'
            ? 'not_helpful'
            : vote;
      const payload = await reviewsService.voteHelpful(
        customerId,
        req.params.reviewId,
        normalized,
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:reviewId/report', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await reviewsService.reportReview(
        customerId,
        req.params.reviewId,
        req.body || {},
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:reviewId/moderate', mutateLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const adminId = safeString(req.get('x-admin-id') || req.body?.adminId, 'admin');
      const payload = await reviewsService.moderateReview(adminId, req.params.reviewId, {
        action: req.body?.action,
        note: req.body?.note,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/:reviewId/reply', mutateLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const adminId = safeString(req.get('x-admin-id') || req.body?.adminId, 'admin');
      const authorType = safeString(req.body?.authorType, 'seller');
      const payload = await reviewsService.replyToReview(
        adminId,
        req.params.reviewId,
        req.body || {},
        authorType
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = {
  createReviewsRouter,
};
