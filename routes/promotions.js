const express = require('express');
const { authenticateCustomer } = require('../services/customer-auth');
const { listActiveCoupons, quoteCart } = require('../services/promotions');
const { supabaseAdmin } = require('../utils/supabase-admin');
const { requireAdmin } = require('../utils/admin-auth');

const router = express.Router();

router.get('/api/promotions/coupons', async (req, res) => {
  try {
    return res.json({ success: true, coupons: await listActiveCoupons() });
  } catch (error) {
    console.error('[PROMOTIONS] list failed:', error.message);
    return res.status(503).json({ success: false, coupons: [], message: 'Coupons are temporarily unavailable' });
  }
});

router.post('/api/promotions/quote', async (req, res) => {
  try {
    const customer = await authenticateCustomer(req);
    const quote = await quoteCart(req.body?.cartItems || [], req.body?.couponCode, customer?.userId);
    return res.json({ success: true, quote });
  } catch (error) {
    return res.status(Number(error.statusCode || 500)).json({ success: false, message: error.message });
  }
});

router.get('/api/admin/promotions', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ success: false, message: 'Database unavailable' });
  const { data, error } = await supabaseAdmin.from('coupon_campaigns').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.json({ success: true, campaigns: data || [] });
});

router.post('/api/admin/promotions', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ success: false, message: 'Database unavailable' });
  const body = req.body || {};
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
  const discountType = String(body.discountType || '').toLowerCase();
  const discountValue = Number(body.discountValue);
  const minSubtotal = Number(body.minSubtotal || 0);
  const maxDiscount = body.maxDiscount == null ? null : Number(body.maxDiscount);
  const maxRedemptions = body.maxRedemptions == null ? null : Number(body.maxRedemptions);
  const perUserLimit = Number(body.perUserLimit || 1);
  const startsAt = new Date(body.startsAt || Date.now());
  const endsAt = new Date(body.endsAt);
  if (!code || !['percent', 'fixed'].includes(discountType) || !Number.isFinite(discountValue) || discountValue <= 0 ||
      (discountType === 'percent' && discountValue > 100) || !Number.isFinite(minSubtotal) || minSubtotal < 0 ||
      !Number.isInteger(perUserLimit) || perUserLimit < 1 || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt ||
      (maxDiscount != null && (!Number.isFinite(maxDiscount) || maxDiscount < 0)) ||
      (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1))) {
    return res.status(400).json({ success: false, message: 'Campaign settings are invalid' });
  }
  const { data, error } = await supabaseAdmin.from('coupon_campaigns').insert({
    code, title: String(body.title || code).trim().slice(0, 120), description: String(body.description || '').trim().slice(0, 500),
    discount_type: discountType, discount_value: discountValue, min_subtotal: minSubtotal,
    max_discount: maxDiscount, max_redemptions: maxRedemptions, per_user_limit: perUserLimit,
    currency: String(body.currency || 'USD').trim().toUpperCase(), starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(), emoji: String(body.emoji || '🏷️').slice(0, 8), active: body.active !== false,
  }).select().single();
  if (error) return res.status(409).json({ success: false, message: error.message });
  return res.status(201).json({ success: true, campaign: data });
});

router.patch('/api/admin/promotions/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ success: false, message: 'Database unavailable' });
  const updates = {};
  if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
  if (req.body?.endsAt) {
    const end = new Date(req.body.endsAt);
    if (Number.isNaN(end.getTime())) return res.status(400).json({ success: false, message: 'Invalid end date' });
    updates.ends_at = end.toISOString();
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'No supported changes supplied' });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('coupon_campaigns').update(updates).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ success: false, message: error.message });
  if (!data) return res.status(404).json({ success: false, message: 'Campaign not found' });
  return res.json({ success: true, campaign: data });
});

module.exports = { router };
