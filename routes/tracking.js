/**
 * Order tracking API — normalized tracking state consumed by the app.
 *
 * SECURITY: tracking data is private to the order owner. Identity is
 * resolved from the device's push token (x-push-token header) which is a
 * bearer credential bound to a user_id in push_tokens. A raw userId query
 * param is NEVER trusted for private tracking data.
 */

const express = require('express');
const { getOrderTracking, listTrackingForUser, TRACKER_STEPS } = require('../utils/tracking');
const { findTokenRecord } = require('../utils/push-tokens-db');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/** Resolve authenticated identity from x-push-token (bearer) header. */
async function resolveIdentity(req) {
  const bearerToken = safeString(req.headers?.['x-push-token'] || req.query?.token);
  if (bearerToken) {
    const record = await findTokenRecord(bearerToken);
    if (record?.userId) {
      return { kind: 'user', id: record.userId, token: bearerToken };
    }
    if (record?.deviceId) {
      return { kind: 'device', id: record.deviceId, token: bearerToken };
    }
  }
  return null;
}

function serialize(tracking) {
  return {
    shopifyOrderId: tracking.shopify_order_id,
    orderName: tracking.order_name,
    carrier: tracking.carrier,
    trackingNumber: tracking.tracking_number,
    trackingUrl: tracking.tracking_url,
    status: tracking.status,
    friendlyStatus: tracking.friendly_status,
    latestEventTitle: tracking.latest_event_title,
    latestEventDescription: tracking.latest_event_description,
    latestEventLocation: tracking.latest_event_location,
    latestEventAt: tracking.latest_event_at,
    estimatedDelivery: tracking.estimated_delivery,
    trackingHistory: Array.isArray(tracking.tracking_history) ? tracking.tracking_history : [],
    updatedAt: tracking.updated_at,
  };
}

/**
 * GET /api/tracking/:orderId — one order's tracking.
 * Only the order OWNER (user_id bound to this device's token) may view it.
 */
router.get('/api/tracking/:orderId', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity || identity.kind !== 'user') {
    return res.status(401).json({ success: false, message: 'Authenticated identity required' });
  }

  const orderId = safeString(req.params?.orderId);
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'orderId is required' });
  }
  const tracking = await getOrderTracking(orderId);
  if (!tracking) {
    return res.status(404).json({ success: false, message: 'No tracking for this order' });
  }

  // Authorization: only the order owner (or matching email) may view.
  if (tracking.user_id && tracking.user_id !== identity.id) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  if (tracking.user_id === null && tracking.email) {
    // Fall back to email match if no user_id yet.
    const { loadTokens } = require('../utils/push-tokens-db');
    const tokens = await loadTokens();
    const token = Object.values(tokens).find((t) => t.token === identity.token);
    if (!token || String(token.email || '').toLowerCase() !== String(tracking.email).toLowerCase()) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
  }

  return res.json({ success: true, tracking: serialize(tracking), trackerSteps: TRACKER_STEPS });
});

/**
 * GET /api/tracking?userId=... — all of a user's orders with tracking.
 * Identity comes from the token, not the query param.
 */
router.get('/api/tracking', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity || identity.kind !== 'user') {
    return res.status(401).json({ success: false, message: 'Authenticated identity required' });
  }
  const list = await listTrackingForUser(identity.id);
  return res.json({ success: true, items: list.map(serialize) });
});

module.exports = { router };
