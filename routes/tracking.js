/**
 * Order tracking API — normalized tracking state consumed by the app.
 */

const express = require('express');
const { getOrderTracking, listTrackingForUser, TRACKER_STEPS } = require('../utils/tracking');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
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
 */
router.get('/api/tracking/:orderId', async (req, res) => {
  const orderId = safeString(req.params?.orderId);
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'orderId is required' });
  }
  const tracking = await getOrderTracking(orderId);
  if (!tracking) {
    return res.status(404).json({ success: false, message: 'No tracking for this order' });
  }
  return res.json({ success: true, tracking: serialize(tracking), trackerSteps: TRACKER_STEPS });
});

/**
 * GET /api/tracking?userId=... — all of a user's orders with tracking.
 */
router.get('/api/tracking', async (req, res) => {
  const userId = safeString(req.query?.userId);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId is required' });
  }
  const list = await listTrackingForUser(userId);
  return res.json({ success: true, items: list.map(serialize) });
});

module.exports = { router };
