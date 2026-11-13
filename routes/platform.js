const crypto = require('crypto');
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase-admin');
const { authenticateCustomer } = require('../services/customer-auth');
const { requireAdmin } = require('../utils/admin-auth');
const { loadTokens } = require('../utils/push-tokens-db');
const { sendPush } = require('../utils/push-delivery');
const { createInboxItem } = require('../utils/inbox-db');

const router = express.Router();
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);
const SUPPORT_CATEGORIES = new Set(['order', 'delivery', 'return', 'payment', 'product', 'account', 'rewards', 'other']);
const ANALYTICS_EVENTS = new Set([
  'app_open', 'home_view', 'search', 'search_click', 'product_view', 'variant_select',
  'add_to_cart', 'wishlist', 'checkout', 'payment', 'order', 'push_received',
  'push_opened', 'inbox_opened', 'deal', 'video', 'return', 'refund',
]);

function unavailable(res) {
  return res.status(503).json({ success: false, message: 'This service is not configured yet.' });
}

function supportRecipientRecords(tokenStore, userId) {
  return Object.values(tokenStore || {}).filter(
    (token) => token.userId === userId || token.user_id === userId
  );
}

async function requireCustomer(req, res) {
  const customer = await authenticateCustomer(req);
  if (!customer) {
    res.status(401).json({ success: false, message: 'Signed-in identity required' });
    return null;
  }
  return customer;
}

router.get('/api/support/cases', async (req, res) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return;
    if (!supabaseAdmin) return unavailable(res);
    const { data, error } = await supabaseAdmin.from('support_cases')
      .select('id, ticket_id, category, subject, order_id, priority, status, sla_due_at, created_at, updated_at, support_messages(id, sender_role, body, created_at)')
      .eq('user_id', customer.userId).order('updated_at', { ascending: false }).limit(100);
    if (error) throw error;
    return res.json({ success: true, cases: data || [] });
  } catch (error) {
    console.error('[SUPPORT] list failed:', error.message);
    return res.status(500).json({ success: false, message: 'Support cases could not be loaded.' });
  }
});

router.get('/api/support/cases/:ticketId', async (req, res) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return;
    if (!supabaseAdmin) return unavailable(res);
    const { data, error } = await supabaseAdmin.from('support_cases')
      .select('id, ticket_id, category, subject, order_id, priority, status, sla_due_at, created_at, updated_at, support_messages(id, sender_role, body, created_at)')
      .eq('ticket_id', clean(req.params.ticketId, 80)).eq('user_id', customer.userId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Support case not found.' });
    data.support_messages = (data.support_messages || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return res.json({ success: true, case: data });
  } catch (error) {
    console.error('[SUPPORT] detail failed:', error.message);
    return res.status(500).json({ success: false, message: 'Support case could not be loaded.' });
  }
});

router.post('/api/support/cases', async (req, res) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return;
    if (!supabaseAdmin) return unavailable(res);
    const category = clean(req.body?.category, 30).toLowerCase();
    const subject = clean(req.body?.subject, 120);
    const message = clean(req.body?.message, 4000);
    const orderId = clean(req.body?.orderId, 120) || null;
    if (!SUPPORT_CATEGORIES.has(category) || subject.length < 3 || message.length < 10) {
      return res.status(400).json({ success: false, message: 'Choose a category and enter a subject and message.' });
    }
    if (orderId) {
      const { data: owned } = await supabaseAdmin.from('orders').select('shopify_order_id')
        .eq('user_id', customer.userId).eq('shopify_order_id', orderId).maybeSingle();
      if (!owned) return res.status(403).json({ success: false, message: 'That order is not available for this account.' });
    }
    const ticketId = `NOOD-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const now = new Date();
    const slaDue = new Date(now.getTime() + (category === 'payment' ? 4 : 24) * 3600000).toISOString();
    const { data: supportCase, error } = await supabaseAdmin.from('support_cases').insert({
      ticket_id: ticketId, user_id: customer.userId, customer_email: customer.email || null,
      category, subject, order_id: orderId, priority: category === 'payment' ? 'high' : 'normal',
      status: 'open', sla_due_at: slaDue,
    }).select().single();
    if (error) throw error;
    const { error: messageError } = await supabaseAdmin.from('support_messages').insert({
      case_id: supportCase.id, sender_user_id: customer.userId, sender_role: 'customer', body: message,
    });
    if (messageError) throw messageError;
    return res.status(201).json({ success: true, case: { ...supportCase, support_messages: [] } });
  } catch (error) {
    console.error('[SUPPORT] create failed:', error.message);
    return res.status(500).json({ success: false, message: 'Support case could not be created.' });
  }
});

router.post('/api/support/cases/:ticketId/messages', async (req, res) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return;
    if (!supabaseAdmin) return unavailable(res);
    const body = clean(req.body?.message, 4000);
    if (body.length < 2) return res.status(400).json({ success: false, message: 'Enter a message.' });
    const { data: supportCase } = await supabaseAdmin.from('support_cases').select('id, status')
      .eq('ticket_id', clean(req.params.ticketId, 80)).eq('user_id', customer.userId).maybeSingle();
    if (!supportCase) return res.status(404).json({ success: false, message: 'Support case not found.' });
    if (supportCase.status === 'closed') return res.status(409).json({ success: false, message: 'This case is closed.' });
    const { data, error } = await supabaseAdmin.from('support_messages').insert({
      case_id: supportCase.id, sender_user_id: customer.userId, sender_role: 'customer', body,
    }).select().single();
    if (error) throw error;
    await supabaseAdmin.from('support_cases').update({ status: 'customer_reply', updated_at: new Date().toISOString() }).eq('id', supportCase.id);
    return res.status(201).json({ success: true, message: data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Message could not be sent.' });
  }
});

router.post('/api/admin/support/cases/:ticketId/reply', requireAdmin, async (req, res) => {
  try {
    if (!supabaseAdmin) return unavailable(res);
    const body = clean(req.body?.message, 4000);
    const nextStatus = clean(req.body?.status || 'agent_reply', 30).toLowerCase();
    if (body.length < 2 || !['agent_reply', 'waiting', 'resolved', 'closed', 'escalated'].includes(nextStatus)) {
      return res.status(400).json({ success: false, message: 'A valid reply and status are required.' });
    }
    const { data: supportCase } = await supabaseAdmin.from('support_cases').select('*')
      .eq('ticket_id', clean(req.params.ticketId, 80)).maybeSingle();
    if (!supportCase) return res.status(404).json({ success: false, message: 'Support case not found.' });
    const { data, error } = await supabaseAdmin.from('support_messages').insert({
      case_id: supportCase.id, sender_role: 'agent', body,
    }).select().single();
    if (error) throw error;
    await supabaseAdmin.from('support_cases').update({ status: nextStatus, updated_at: new Date().toISOString() }).eq('id', supportCase.id);
    const notificationData = { type: 'support-reply', route: `/account/support/${supportCase.ticket_id}`, caseId: supportCase.ticket_id };
    const campaignId = `support_${supportCase.ticket_id}_${data.id}`;
    await createInboxItem({
      campaignId, type: 'support-reply', title: '💬 Support reply',
      body: `Case ${supportCase.ticket_id} has a new reply`, data: notificationData,
      route: notificationData.route, userId: supportCase.user_id,
    });
    const tokenStore = await loadTokens();
    const recipients = supportRecipientRecords(tokenStore, supportCase.user_id);
    await sendPush({ recipients, title: '💬 Support reply', body: `Case ${supportCase.ticket_id} has a new reply`,
      data: notificationData,
      campaignId, campaignType: 'support-reply', dedupeKey: campaignId, saveInbox: false });
    return res.json({ success: true, message: data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Support reply could not be sent.' });
  }
});

router.get('/api/admin/support/cases', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const status = clean(req.query?.status, 30).toLowerCase();
  let query = supabaseAdmin.from('support_cases')
    .select('*, support_messages(id, sender_role, body, created_at)')
    .order('updated_at', { ascending: false }).limit(250);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, message: 'Support queue could not be loaded.' });
  return res.json({ success: true, cases: data || [] });
});

router.get('/api/reviews/product/:handle', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const handle = clean(req.params.handle, 180).toLowerCase();
  const rating = Number(req.query?.rating || 0);
  const sort = clean(req.query?.sort || 'recent', 20).toLowerCase();
  let query = supabaseAdmin.from('product_reviews')
    .select('id, product_handle, rating, title, body, photo_urls, verified_purchase, helpful_count, created_at')
    .eq('product_handle', handle).eq('status', 'published').limit(100);
  if (Number.isInteger(rating) && rating >= 1 && rating <= 5) query = query.eq('rating', rating);
  query = sort === 'helpful' ? query.order('helpful_count', { ascending: false }) : query.order('created_at', { ascending: false });
  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, message: 'Reviews could not be loaded.' });
  const reviews = data || [];
  const average = reviews.length ? reviews.reduce((sum, review) => sum + Number(review.rating), 0) / reviews.length : 0;
  return res.json({ success: true, count: reviews.length, averageRating: Number(average.toFixed(2)), reviews });
});

router.post('/api/reviews/:id/helpful', async (req, res) => {
  const customer = await requireCustomer(req, res);
  if (!customer) return;
  if (!supabaseAdmin) return unavailable(res);
  const reviewId = clean(req.params.id, 80);
  const { error } = await supabaseAdmin.from('review_votes').upsert({ review_id: reviewId, user_id: customer.userId, helpful: true }, { onConflict: 'review_id,user_id', ignoreDuplicates: true });
  if (error) return res.status(409).json({ success: false, message: 'Helpful vote could not be recorded.' });
  const { count } = await supabaseAdmin.from('review_votes').select('*', { count: 'exact', head: true }).eq('review_id', reviewId).eq('helpful', true);
  await supabaseAdmin.from('product_reviews').update({ helpful_count: count || 0 }).eq('id', reviewId);
  return res.json({ success: true, helpfulCount: count || 0 });
});

router.post('/api/reviews/:id/report', async (req, res) => {
  const customer = await requireCustomer(req, res);
  if (!customer) return;
  if (!supabaseAdmin) return unavailable(res);
  const reviewId = clean(req.params.id, 80);
  const reason = clean(req.body?.reason, 240);
  if (reason.length < 3) return res.status(400).json({ success: false, message: 'Report reason is required.' });
  const { error } = await supabaseAdmin.from('review_reports').upsert({ review_id: reviewId, user_id: customer.userId, reason }, { onConflict: 'review_id,user_id', ignoreDuplicates: true });
  if (error) return res.status(409).json({ success: false, message: 'Review report could not be recorded.' });
  const { count } = await supabaseAdmin.from('review_reports').select('*', { count: 'exact', head: true }).eq('review_id', reviewId);
  await supabaseAdmin.from('product_reviews').update({ report_count: count || 0 }).eq('id', reviewId);
  return res.status(201).json({ success: true });
});

router.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const status = clean(req.body?.status, 30).toLowerCase();
  if (!['published', 'rejected', 'hidden'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid moderation status.' });
  const { data, error } = await supabaseAdmin.from('product_reviews').update({
    status, moderation_note: clean(req.body?.note, 1000) || null, updated_at: new Date().toISOString(),
  }).eq('id', clean(req.params.id, 80)).select().maybeSingle();
  if (error) return res.status(500).json({ success: false, message: 'Review could not be moderated.' });
  if (!data) return res.status(404).json({ success: false, message: 'Review not found.' });
  return res.json({ success: true, review: data });
});

router.get('/api/reviews/mine', async (req, res) => {
  const customer = await requireCustomer(req, res);
  if (!customer) return;
  if (!supabaseAdmin) return unavailable(res);
  const { data, error } = await supabaseAdmin.from('product_reviews').select('*')
    .eq('user_id', customer.userId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ success: false, message: 'Reviews could not be loaded.' });
  return res.json({ success: true, reviews: data || [] });
});

router.post('/api/reviews', async (req, res) => {
  try {
    const customer = await requireCustomer(req, res);
    if (!customer) return;
    if (!supabaseAdmin) return unavailable(res);
    const orderId = clean(req.body?.orderId, 120);
    const orderItemId = clean(req.body?.orderItemId, 180);
    const productHandle = clean(req.body?.handle, 180).toLowerCase();
    const rating = Number(req.body?.rating);
    const title = clean(req.body?.reviewTitle, 100);
    const body = clean(req.body?.comment, 3000);
    if (!orderId || !orderItemId || !productHandle || !Number.isInteger(rating) || rating < 1 || rating > 5 || body.length < 3) {
      return res.status(400).json({ success: false, message: 'Review details are invalid.' });
    }
    const { data: order } = await supabaseAdmin.from('orders').select('items, status')
      .eq('user_id', customer.userId).eq('shopify_order_id', orderId).maybeSingle();
    const verified = Boolean(order && !/cancel|refund|failed/i.test(String(order.status)) &&
      (order.items || []).some((item) => String(item.handle || '').toLowerCase() === productHandle));
    if (!verified) return res.status(403).json({ success: false, message: 'Only verified purchases can be reviewed.' });
    const { data, error } = await supabaseAdmin.from('product_reviews').upsert({
      user_id: customer.userId, order_id: orderId, order_item_id: orderItemId,
      product_handle: productHandle, rating, title: title || null, body,
      verified_purchase: true, status: 'pending', updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,order_item_id' }).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, review: data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Review could not be submitted.' });
  }
});

router.post('/api/analytics/events', async (req, res) => {
  if (req.body?.consent !== true) return res.status(204).end();
  if (!supabaseAdmin) return res.status(202).json({ success: true, stored: false });
  const event = clean(req.body?.event, 60).toLowerCase();
  if (!ANALYTICS_EVENTS.has(event)) return res.status(400).json({ success: false, message: 'Unknown analytics event.' });
  const customer = await authenticateCustomer(req);
  const session = clean(req.body?.sessionId, 100);
  const sessionHash = session ? crypto.createHash('sha256').update(session).digest('hex') : null;
  const properties = req.body?.properties && typeof req.body.properties === 'object' ? req.body.properties : {};
  const safeProperties = Object.fromEntries(Object.entries(properties).slice(0, 30).map(([key, value]) => [clean(key, 60), typeof value === 'string' ? clean(value, 300) : value]));
  const { error } = await supabaseAdmin.from('product_analytics').insert({ event, user_id: customer?.userId || null, session_hash: sessionHash, properties: safeProperties });
  if (error) return res.status(500).json({ success: false, message: 'Event could not be recorded.' });
  return res.status(202).json({ success: true, stored: true });
});

router.post('/api/security/events/login', async (req, res) => {
  const customer = await requireCustomer(req, res);
  if (!customer) return;
  if (!supabaseAdmin) return res.status(202).json({ success: true, stored: false });
  const deviceId = clean(req.body?.deviceId, 160);
  const fingerprint = crypto.createHmac('sha256', process.env.SECURITY_EVENT_SECRET || process.env.NOOD_ADMIN_TOKEN || 'nood-unconfigured')
    .update(`${deviceId}|${clean(req.headers['user-agent'], 300)}`).digest('hex');
  const { data: known } = await supabaseAdmin.from('security_events').select('id').eq('user_id', customer.userId).eq('device_fingerprint', fingerprint).limit(1);
  const eventType = known?.length ? 'login' : 'new_login';
  const { error } = await supabaseAdmin.from('security_events').insert({ user_id: customer.userId, event_type: eventType, device_fingerprint: fingerprint, metadata: { platform: clean(req.body?.platform, 30) } });
  if (error) return res.status(500).json({ success: false, message: 'Security event could not be recorded.' });
  return res.status(202).json({ success: true, eventType });
});

module.exports = { router, ANALYTICS_EVENTS, SUPPORT_CATEGORIES, supportRecipientRecords };
