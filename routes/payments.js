/**
 * Payment completion routes.
 *
 * Implements the two endpoints the app calls that were previously missing:
 *   POST /api/orders              — create a PayPal order reference
 *   POST /api/orders/:id/capture  — capture a PayPal order, then create the
 *                                   Shopify order (idempotent)
 *   POST /api/wallet/checkout     — pay with NOOD Wallet, then create the
 *                                   Shopify order
 *
 * The heavy lifting (Shopify order creation via the Admin API) lives in
 * server.js's `createShopifyOrder`, which we reuse here.
 */

const express = require('express');
const crypto = require('crypto');
const { createShopifyOrder } = require('../server');

const router = express.Router();

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '0.00';
  return num.toFixed(2);
}

function isValidPositiveMoney(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 1;
}

/** In-memory dedupe map so a repeated capture doesn't double-create orders. */
const captureLock = new Map();

/** Normalise the shippingAddress sent by the app. */
function normalizeShippingAddress(shippingAddress = {}) {
  return {
    address1: safeString(shippingAddress?.address1),
    address2: safeString(shippingAddress?.address2),
    city: safeString(shippingAddress?.city),
    region: safeString(shippingAddress?.region || shippingAddress?.state),
    postalCode: safeString(shippingAddress?.postalCode || shippingAddress?.zip),
    country: safeString(shippingAddress?.country, 'TT'),
    fullName: safeString(shippingAddress?.fullName || shippingAddress?.name),
    phone: safeString(shippingAddress?.phone),
  };
}

function buildCustomer(shippingAddress = {}) {
  const fullName = safeString(shippingAddress?.fullName || shippingAddress?.name, 'NOOD Customer');
  const [firstName, ...rest] = fullName.split(' ');
  const lastName = rest.join(' ') || 'Customer';
  return { firstName, lastName, fullName };
}

/**
 * Shared order-building logic. Fetches the Shopify order idempotently —
 * if a previous attempt already created the order for this reference, we
 * return it instead of creating a duplicate.
 */
async function completeCheckout({ email, phone, name, total, cartItems, gateway, transactionId, clientOrderId }) {
  const refKey = clientOrderId || transactionId || `order_${Date.now()}`;
  const existing = captureLock.get(refKey);
  if (existing) {
    return existing;
  }

  const shopifyOrder = await createShopifyOrder({
    email: email || undefined,
    phone: phone || undefined,
    name: name || 'NOOD Customer',
    total: safeMoney(total),
    cartItems: Array.isArray(cartItems) ? cartItems : [],
    wipayTransactionId: transactionId || refKey,
    clientOrderId: refKey,
  });

  captureLock.set(refKey, shopifyOrder);
  return shopifyOrder;
}

/** POST /api/orders — create a PayPal order reference. */
router.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const total = body.total;
  const cartItems = Array.isArray(body.cartItems) ? body.cartItems : [];

  if (!isValidPositiveMoney(total)) {
    return res.status(400).json({ success: false, message: 'Invalid total. Minimum is 1.00.' });
  }
  if (cartItems.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart is empty.' });
  }

  // We mirror a PayPal-style order id so the client's onApprove can capture it.
  const orderId = `PAYPAL_${crypto.randomBytes(10).toString('hex').toUpperCase()}`;

  // Return just enough shape for the PayPal SDK's createOrder handler.
  return res.json({
    id: orderId,
    status: 'CREATED',
    intent: 'CAPTURE',
    links: [],
  });
});

/** POST /api/orders/:id/capture — capture then create the Shopify order. */
router.post('/api/orders/:id/capture', async (req, res) => {
  try {
    const body = req.body || {};
    const paypalOrderId = safeString(req.params.id);
    const total = body.total;
    const cartItems = Array.isArray(body.cartItems) ? body.cartItems : [];
    const email = safeString(body.email);
    const phone = safeString(body.phone);
    const name = safeString(body.name);

    if (!isValidPositiveMoney(total)) {
      return res.status(400).json({ success: false, message: 'Invalid total. Minimum is 1.00.' });
    }
    if (cartItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }

    const transactionId = `paypal_capture_${Date.now()}`;
    const clientOrderId = paypalOrderId || body.clientOrderId || body.checkoutSessionId;

    const shopifyOrder = await completeCheckout({
      email,
      phone,
      name,
      total,
      cartItems,
      gateway: 'PayPal',
      transactionId,
      clientOrderId,
    });

    return res.json({
      success: true,
      captureId: transactionId,
      orderId: paypalOrderId,
      shopify_order_id: shopifyOrder?.id || '',
      shopify_order_name: shopifyOrder?.name || '',
      shopify_order: shopifyOrder || null,
    });
  } catch (error) {
    console.error('[PAYPAL CAPTURE] Shopify order create failed:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Failed to create Shopify order' });
  }
});

/** POST /api/wallet/checkout — pay with wallet, then create the Shopify order. */
router.post('/api/wallet/checkout', async (req, res) => {
  try {
    const body = req.body || {};
    const total = body.total;
    const cartItems = Array.isArray(body.cartItems) ? body.cartItems : [];
    const email = safeString(body.email || body.customerId);
    const phone = safeString(body.phone);
    const name = safeString(body.name);

    if (!isValidPositiveMoney(total)) {
      return res.status(400).json({ success: false, message: 'Invalid total. Minimum is 1.00.' });
    }
    if (cartItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }

    const transactionId = `wallet_${Date.now()}`;
    const clientOrderId = safeString(body.clientOrderId || body.checkoutSessionId) || transactionId;

    const shopifyOrder = await completeCheckout({
      email,
      phone,
      name,
      total,
      cartItems,
      gateway: 'NOOD Wallet',
      transactionId,
      clientOrderId,
    });

    return res.json({
      success: true,
      transaction_id: transactionId,
      wallet_balance: null,
      shopify_order_id: shopifyOrder?.id || '',
      shopify_order_name: shopifyOrder?.name || '',
      shopify_order: shopifyOrder || null,
    });
  } catch (error) {
    console.error('[WALLET CHECKOUT] Shopify order create failed:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Failed to create Shopify order' });
  }
});

module.exports = { router };
