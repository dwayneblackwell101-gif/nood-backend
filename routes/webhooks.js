/**
 * Shopify webhook handlers — keeps order tracking in sync.
 * Receives fulfillment updates from Shopify and updates local order data.
 */

const express = require('express');
const crypto = require('crypto');
const { updateOrderFromFulfillment, updateOrderStatus } = require('../utils/order-sync');
const {
  upsertOrderTracking,
  notifyTrackingChange,
  normalizeStatus,
} = require('../utils/tracking');

const router = express.Router();

// Verify Shopify webhook signature
function verifyShopifyWebhook(req, res, next) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic');
  const shop = req.get('X-Shopify-Shop-Domain');

  if (!hmac || !topic) {
    return res.status(400).json({ error: 'Missing Shopify headers' });
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[WEBHOOK] SHOPIFY_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const generatedHmac = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(generatedHmac))) {
    console.warn('[WEBHOOK] Invalid signature from', shop);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  req.shopifyTopic = topic;
  req.shopifyShop = shop;
  next();
}

// Fulfillment update webhook
router.post('/webhooks/fulfillments/update', verifyShopifyWebhook, async (req, res) => {
  const fulfillment = req.body;

  try {
    console.log('[WEBHOOK] Fulfillment update for order', fulfillment.order_id);

    // Update local order tracking from fulfillment data
    await updateOrderFromFulfillment(fulfillment);

    // Normalize + persist tracking; only notify on meaningful changes.
    const tracking = await upsertOrderTracking({
      shopifyOrderId: String(fulfillment.order_id || ''),
      orderName: String(fulfillment.name || ''),
      email: fulfillment.email || null,
      carrier:
        fulfillment.tracking_company ||
        fulfillment.fulfillments?.[0]?.tracking_company ||
        null,
      trackingNumber:
        fulfillment.tracking_number ||
        fulfillment.fulfillments?.[0]?.tracking_number ||
        null,
      trackingUrl:
        fulfillment.tracking_url ||
        fulfillment.fulfillments?.[0]?.tracking_url ||
        null,
      rawStatus:
        fulfillment.status ||
        fulfillment.fulfillment_status ||
        'confirmed',
      latestEvent: {
        title: fulfillment.message || null,
        description: fulfillment.message || null,
        location: null,
        at: fulfillment.updated_at || null,
      },
    });

    console.log(
      `[WEBHOOK] tracking normalized | order: ${fulfillment.order_id} | status: ${tracking.status} | changed: ${tracking.changed}`
    );

    if (tracking.changed) {
      notifyTrackingChange(
        String(fulfillment.order_id),
        null,
        { userId: null }
      ).catch((error) => {
        console.error('[WEBHOOK] tracking notify failed:', error.message);
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[WEBHOOK] Fulfillment update error:', error.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Order fulfilled webhook (legacy)
router.post('/webhooks/orders/fulfilled', verifyShopifyWebhook, async (req, res) => {
  const order = req.body;

  try {
    console.log('[WEBHOOK] Order fulfilled', order.id);

    await updateOrderStatus(order.id, {
      fulfillmentStatus: 'fulfilled',
      trackingNumber: order.fulfillments?.[0]?.tracking_number,
      trackingUrl: order.fulfillments?.[0]?.tracking_url,
      trackingCompany: order.fulfillments?.[0]?.tracking_company,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[WEBHOOK] Order fulfilled error:', error.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Order cancelled webhook
router.post('/webhooks/orders/cancelled', verifyShopifyWebhook, async (req, res) => {
  const order = req.body;

  try {
    console.log('[WEBHOOK] Order cancelled', order.id);
    await updateOrderStatus(order.id, { status: 'cancelled' });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[WEBHOOK] Order cancelled error:', error.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Order refunded webhook
router.post('/webhooks/orders/refunded', verifyShopifyWebhook, async (req, res) => {
  const order = req.body;

  try {
    console.log('[WEBHOOK] Order refunded', order.id);
    await updateOrderStatus(order.id, { status: 'refunded' });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[WEBHOOK] Order refunded error:', error.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

module.exports = { router, verifyShopifyWebhook };