/**
 * Cart sync API — stores cart state so cart-abandonment recovery can find
 * abandoned carts. Carts are upserted by email.
 */

const express = require('express');
const { supabase } = require('../utils/supabase');
const { authenticateCustomer } = require('../services/customer-auth');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/** POST /api/cart/sync — upsert a cart for a user (by email). */
router.post('/api/cart/sync', async (req, res) => {
  const customer = await authenticateCustomer(req);
  if (!customer?.userId || !customer?.email) {
    return res.status(401).json({ success: false, message: 'Signed-in identity required' });
  }
  const email = customer.email;
  const name = safeString([customer.firstName, customer.lastName].filter(Boolean).join(' '));
  const profileId = customer.userId;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!Array.isArray(req.body?.items) || items.length > 100) {
    return res.status(400).json({ success: false, message: 'Cart must contain 0 to 100 items' });
  }

  if (!supabase) {
    return res.json({ success: false, source: 'unconfigured', message: 'database not configured' });
  }

  try {
    // Upsert cart by email.
    const { data, error } = await supabase
      .from('carts')
      .upsert(
        {
          email,
          name,
          items,
          profile_id: profileId || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'email' }
      )
      .select('id, email');

    if (error) throw error;

    return res.json({ success: true, source: 'supabase', cartId: data?.[0]?.id });
  } catch (error) {
    console.error('[CART SYNC] error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to sync cart' });
  }
});

module.exports = { router };
