const { supabaseAdmin } = require('../utils/supabase-admin');
const { priceCart, moneyToCents } = require('./catalog-pricing');

function cleanCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
}

function publicCoupon(row) {
  return {
    id: String(row.id),
    code: cleanCode(row.code),
    title: String(row.title || row.code),
    description: String(row.description || ''),
    discountType: row.discount_type,
    discountValue: Number(row.discount_value || 0),
    maxDiscount: row.max_discount == null ? null : Number(row.max_discount),
    minSpend: Number(row.min_subtotal || 0),
    currency: String(row.currency || 'USD').toUpperCase(),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    emoji: String(row.emoji || '🏷️'),
  };
}

async function listActiveCoupons() {
  if (!supabaseAdmin) return [];
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('coupon_campaigns')
    .select('id, code, title, description, discount_type, discount_value, max_discount, min_subtotal, currency, starts_at, ends_at, emoji')
    .eq('active', true)
    .lte('starts_at', now)
    .gt('ends_at', now)
    .order('ends_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data || []).map(publicCoupon);
}

async function findCampaign(code) {
  if (!supabaseAdmin || !code) return null;
  const { data, error } = await supabaseAdmin
    .from('coupon_campaigns')
    .select('*')
    .eq('code', code)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const now = Date.now();
  if (new Date(data.starts_at).getTime() > now || new Date(data.ends_at).getTime() <= now) return null;
  return data;
}

function calculateDiscount(campaign, subtotalCents, currency) {
  if (String(campaign.currency || 'USD').toUpperCase() !== currency) return 0;
  if (subtotalCents < Number(campaign.min_subtotal || 0) * 100) return 0;
  let cents = 0;
  if (campaign.discount_type === 'percent') {
    cents = Math.floor(subtotalCents * Number(campaign.discount_value || 0) / 100);
  } else if (campaign.discount_type === 'fixed') {
    cents = moneyToCents(campaign.discount_value) || 0;
  }
  const maxCents = campaign.max_discount == null ? null : moneyToCents(campaign.max_discount);
  if (maxCents != null) cents = Math.min(cents, maxCents);
  return Math.max(0, Math.min(cents, subtotalCents));
}

async function quoteCart(items, couponCode, userId) {
  const trusted = await priceCart(items);
  const subtotalCents = moneyToCents(trusted.subtotal);
  const code = cleanCode(couponCode);
  if (!code) return { ...trusted, discount: '0.00', total: trusted.subtotal, coupon: null };
  if (!userId) throw Object.assign(new Error('Sign in to use a coupon'), { statusCode: 401 });
  const campaign = await findCampaign(code);
  if (!campaign) throw Object.assign(new Error('Coupon is invalid or expired'), { statusCode: 409 });
  const discountCents = calculateDiscount(campaign, subtotalCents, trusted.currency);
  if (!discountCents) throw Object.assign(new Error('Cart does not meet this coupon’s requirements'), { statusCode: 409 });
  return {
    ...trusted,
    discount: (discountCents / 100).toFixed(2),
    total: ((subtotalCents - discountCents) / 100).toFixed(2),
    coupon: publicCoupon(campaign),
  };
}

async function reserveCoupon({ coupon, userId, reference }) {
  if (!coupon) return null;
  if (!supabaseAdmin) throw Object.assign(new Error('Coupon service is unavailable'), { statusCode: 503 });
  const { data, error } = await supabaseAdmin.rpc('reserve_coupon_atomic', {
    p_campaign_id: coupon.id,
    p_user_id: userId,
    p_checkout_reference: reference,
    p_ttl_minutes: 30,
  });
  if (error) throw error;
  if (!data?.ok) throw Object.assign(new Error(data?.error || 'Coupon is no longer available'), { statusCode: 409 });
  return data;
}

async function finalizeCoupon(reference, orderId) {
  if (!supabaseAdmin) return { ok: false, error: 'database_unavailable' };
  const { data, error } = await supabaseAdmin.rpc('consume_coupon_reservation', {
    p_checkout_reference: reference,
    p_order_id: String(orderId),
  });
  if (error) throw error;
  return data;
}

async function releaseCoupon(reference) {
  if (!supabaseAdmin || !reference) return;
  await supabaseAdmin
    .from('coupon_reservations')
    .update({ status: 'released', updated_at: new Date().toISOString() })
    .eq('checkout_reference', reference)
    .eq('status', 'reserved');
}

module.exports = {
  cleanCode,
  publicCoupon,
  listActiveCoupons,
  calculateDiscount,
  quoteCart,
  reserveCoupon,
  finalizeCoupon,
  releaseCoupon,
  findCampaign,
};
