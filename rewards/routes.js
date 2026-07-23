/**
 * Rewards HTTP routes — all mutations require verified customer auth.
 * customerId query/body is never trusted for authorization.
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
  return safeString(req.get('idempotency-key') || req.get('x-idempotency-key') || req.body?.idempotencyKey);
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  const code =
    error.code ||
    (statusCode === 401
      ? 'unauthenticated'
      : statusCode === 403
        ? 'forbidden'
        : statusCode === 429
          ? 'rate_limited'
          : 'internal_error');

  return res.status(statusCode).json({
    success: false,
    error: true,
    code,
    message: error.message || 'Rewards request failed.',
  });
}

function createRewardsRouter({
  rewardsService,
  requireCustomerAuth,
  isProduction = false,
} = {}) {
  if (!rewardsService) {
    throw new Error('rewardsService is required');
  }
  if (!requireCustomerAuth) {
    throw new Error('requireCustomerAuth is required');
  }

  const router = express.Router();

  const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isProduction ? 90 : 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: true,
      code: 'rate_limited',
      message: 'Too many rewards requests. Please try again shortly.',
    },
  });

  const mutateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isProduction ? 30 : 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: true,
      code: 'rate_limited',
      message: 'Too many reward actions. Please try again shortly.',
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

  router.get('/status', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.getStatus(customerId, getRequestRisk(req));
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/challenges', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.getChallenges(customerId);
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/history', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const limit = Number(req.query.limit || 50);
      const payload = await rewardsService.getHistory(customerId, limit);
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/referral/share', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.recordShare(
        customerId,
        req.body?.channel,
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/referral/attributed', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      // Authenticated subject must be the referred customer.
      const referredCustomerId = authenticatedCustomerId(req);
      const payload = await rewardsService.attributeReferral({
        referralCode: req.body?.referralCode,
        referredCustomerId,
        risk: getRequestRisk(req),
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/claim', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.claimChallenge(
        customerId,
        req.body?.challengeId,
        getIdempotencyKey(req),
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/lucky-spin/status', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.getLuckySpinStatus(customerId);
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/lucky-spin/spin', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.spinLuckySpin(
        customerId,
        getIdempotencyKey(req),
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/scratch/status', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.getScratchStatus(customerId);
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/scratch/claim', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.claimScratch(
        customerId,
        getIdempotencyKey(req),
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/daily/status', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const status = await rewardsService.getStatus(customerId, getRequestRisk(req));
      return res.json({
        success: true,
        customerId,
        daily: status.daily,
        walletBalance: status.walletBalance,
        currency: status.currency,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/daily/check-in', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.dailyCheckIn(
        customerId,
        getIdempotencyKey(req),
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/missions', readLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const status = await rewardsService.getStatus(customerId, getRequestRisk(req));
      return res.json({
        success: true,
        customerId,
        missions: status.missions,
        walletBalance: status.walletBalance,
        currency: status.currency,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/missions/:missionId/claim', mutateLimiter, requireCustomerAuth, async (req, res) => {
    try {
      const customerId = authenticatedCustomerId(req);
      const payload = await rewardsService.claimMission(
        customerId,
        req.params.missionId,
        getIdempotencyKey(req),
        getRequestRisk(req)
      );
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = {
  createRewardsRouter,
};
