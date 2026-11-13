/**
 * Wishlist sync API — persists wishlist items server-side so the backend
 * can compute real wishlist triggers (price-drop / restock / low-stock).
 *
 * Identity comes from a validated Shopify Customer Account access token.
 */

const express = require('express');
const { authenticateCustomer } = require('../services/customer-auth');
const { replaceWishlistForUser } = require('../utils/wishlist-db');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

async function resolveIdentity(req) {
  return authenticateCustomer(req);
}

/**
 * POST /api/wishlist/sync
 * Body: { items: [{ handle, id, variantId, title, price, currency, size, color, image }] }
 * Replaces the user's persisted wishlist (idempotent by user_id+handle).
 */
router.post('/api/wishlist/sync', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity || !identity.userId) {
    return res.status(401).json({ success: false, message: 'Signed-in identity required' });
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const result = await replaceWishlistForUser(
    identity.userId,
    items.map((item) => ({
      ...item,
      email: identity.email || item.email,
      handle: safeString(item.handle || item.id),
    }))
  );

  return res.json({ success: true, synced: result.synced });
});

module.exports = { router };
