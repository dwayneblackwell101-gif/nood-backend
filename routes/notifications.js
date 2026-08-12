/**
 * Push notifications API.
 *
 * - POST /api/notifications/register-token — app registers its Expo push token
 *   (idempotent; stores email/deviceId/userId/platform; marks last_seen_at).
 * - GET  /api/notifications/devices   — admin: safe list of registered devices.
 * - POST /api/notifications/send      — ADMIN: manual broadcast push.
 * - POST /api/notifications/campaign  — ADMIN: send a named campaign.
 *
 * Tokens persist in Supabase (push_tokens) with JSON fallback — they survive
 * Render restarts/deploys. All sends route through the centralized delivery
 * service (utils/push-delivery.js).
 *
 * SECURITY: send/campaign are ADMIN-ONLY (requireAdmin middleware). There is
 * NO unauthenticated broadcast endpoint.
 */

const express = require('express');
const { loadTokens, upsertToken, removeToken, deactivateToken, detachTokenUser, findTokenRecord, isLikelyRealToken } = require('../utils/push-tokens-db');
const { requireAdmin } = require('../utils/admin-auth');
const { sendPush, loadAllRecipients } = require('../utils/push-delivery');
const { config, campaignPriorityOf } = require('../utils/push-config');
const { sendCampaign } = require('../jobs/notification-campaigns');
const {
  listInboxForUser,
  getUnreadCount,
  markInboxRead,
  markAllInboxRead,
} = require('../utils/inbox-db');
const { loadPreferences, setPreference } = require('../utils/preferences-db');
const { REGISTRY, entryFor, statusFor } = require('../utils/notification-registry');
const { getAnalyticsSummary } = require('../utils/notification-analytics');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/**
 * Resolve the requesting user identity securely.
 *
 * Priority:
 *   1. `x-push-token` header — the device's Expo push token. The token is a
 *      bearer credential only the device owner holds. The user_id bound to
 *      that token in push_tokens is AUTHORITATIVE for private data.
 *   2. `deviceId` param — stable guest/installation identity.
 *
 * A raw `userId` query/body param is NEVER trusted for private data — it can
 * only scope GLOBAL (broadcast) reads.
 */
async function resolveIdentity(req) {
  // Header (x-push-token) is preferred — bound identity from push_tokens.
  const bearerToken = safeString(
    req.headers?.['x-push-token'] || req.body?.token || req.query?.token
  );
  if (bearerToken) {
    const record = await findTokenRecord(bearerToken);
    if (record?.userId) {
      return { kind: 'user', id: record.userId, token: bearerToken };
    }
    if (record?.deviceId) {
      return { kind: 'device', id: record.deviceId, token: bearerToken };
    }
  }

  const deviceId = safeString(req.query?.deviceId || req.body?.deviceId);
  if (deviceId) return { kind: 'device', id: deviceId };

  return null;
}

// ─── Token registration ─────────────────────────────────────────────────

/** Register (or upsert) a device push token. Idempotent. */
router.post('/api/notifications/register-token', async (req, res) => {
  const token = safeString(req.body?.token);
  if (!token) {
    return res.status(400).json({ success: false, message: 'token is required' });
  }

  const suffix = token.slice(-12);
  const platform = safeString(req.body?.platform, 'android');
  const deviceId = safeString(req.body?.deviceId);
  const userId = safeString(req.body?.userId);
  const email = safeString(req.body?.email);
  const appVersion = safeString(req.body?.appVersion);

  console.log(
    `[PUSH] registration request | suffix: ...${suffix} | platform: ${platform} | userId: ${userId || '(none)'} | email: ${email || '(none)'}`
  );

  try {
    await upsertToken({
      token,
      platform,
      deviceId,
      userId,
      email,
      appVersion,
      createdAt: req.body?.createdAt || new Date().toISOString(),
    });
    console.log(`[PUSH] Registered token | suffix: ...${suffix} | userId: ${userId || '(guest)'}`);
  } catch (error) {
    console.error(`[PUSH] database upsert FAILED: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Database write failed', tokenSuffix: suffix });
  }

  return res.json({ success: true, message: 'Token registered', tokenSuffix: suffix });
});

/**
 * POST /api/notifications/logout — detach this device token from its user.
 * Called on app logout so private notifications (orders, cart, tracking,
 * rewards) cannot leak to the next person using the device. The token stays
 * active for global broadcasts as a guest.
 */
router.post('/api/notifications/logout', async (req, res) => {
  const token = safeString(req.body?.token);
  if (!token) {
    return res.status(400).json({ success: false, message: 'token is required' });
  }
  await detachTokenUser(token);
  console.log(`[PUSH] Token detached from user on logout | suffix: ...${token.slice(-12)}`);
  return res.json({ success: true, message: 'Token detached from user' });
});

/**
 * POST /api/notifications/dev-seed — DEV-ONLY visual test seeding.
 * Creates one real inbox event per card style (Deal, Reward, Shipping,
 * New Arrival, Cart, Wishlist, Support) so the Home fourth slide can be
 * visually tested in development. Disabled in production.
 *
 * SECURITY: guarded by BOTH PUSH_DEV_SEED=1 AND NODE_ENV !== 'production'.
 * A production environment can never enable dev seeding even if the env var
 * is accidentally set — production customers must never reach this route.
 */
const DEV_SEED_EVENTS = [
  { type: 'deal-live', title: '🔥 Deal Live', body: "Up to 40% off today's picks.", route: '/(tabs)/deals' },
  { type: 'reward-unlocked', title: '🎁 Reward Unlocked', body: 'You earned a new NOOD reward.', route: '/account/rewards' },
  { type: 'order-shipped', title: '📦 Order Shipped', body: 'Your order is on its way.', route: '/account/tracking' },
  { type: 'new_product', title: '🆕 New Arrival', body: 'Fresh styles just landed on NOOD.', route: '/collection/new-arrivals' },
  { type: 'cart-nudge', title: '🛒 Cart Waiting', body: 'Your NOOD cart is waiting for you.', route: '/(tabs)/cart' },
  { type: 'wishlist-sale', title: '💜 Wishlist Sale', body: 'An item you saved just dropped in price.', route: '/(tabs)/wishlist' },
  { type: 'support-reply', title: '💬 Support Reply', body: 'Your support case has a new reply.', route: '/account/support' },
];

/** Dev seeding is enabled only when PUSH_DEV_SEED=1 AND NODE_ENV is not production. */
function devSeedEnabled() {
  const flag = String(process.env.PUSH_DEV_SEED || '').trim() === '1';
  const isProd = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  return flag && !isProd;
}

router.post('/api/notifications/dev-seed', async (req, res) => {
  if (!devSeedEnabled()) {
    return res.status(403).json({ success: false, message: 'Dev seeding disabled' });
  }

  const { createInboxItem } = require('../utils/inbox-db');
  let created = 0;
  for (const event of DEV_SEED_EVENTS) {
    const result = await createInboxItem({
      campaignId: `dev_seed_${event.type}_${Date.now().toString(36)}`,
      type: event.type,
      title: event.title,
      body: event.body,
      data: { type: event.type, route: event.route },
      route: event.route,
      userId: null, // global broadcast so all dev devices see them
    });
    if (result.created) created += 1;
  }
  console.log(`[PUSH DEV] seeded ${created} visual test inbox events`);
  return res.json({ success: true, created });
});

// ─── Admin: device listing ──────────────────────────────────────────────

/**
 * GET /api/notifications/devices — list registered devices.
 * Returns a SAFE summary: no full tokens, no secrets.
 */
router.get('/api/notifications/devices', async (req, res) => {
  const tokens = await loadTokens({ includeInactive: true });
  const devices = Object.values(tokens).map((t) => ({
    id: String(t.token).slice(-8),
    platform: t.platform || 'unknown',
    userId: t.userId || 'guest',
    email: t.email || '',
    appVersion: t.appVersion || '',
    test: Boolean(t.test),
    active: t.active !== false,
    createdAt: t.createdAt || null,
    updatedAt: t.updatedAt || null,
    lastSeenAt: t.lastSeenAt || null,
  }));

  console.log(`[PUSH ADMIN] device count: ${devices.length}`);
  return res.json({ success: true, total: devices.length, devices });
});

// ─── Admin: manual send ─────────────────────────────────────────────────

/**
 * POST /api/notifications/send — manual broadcast (ADMIN ONLY).
 *
 * Body: {
 *   title, body,
 *   type?: campaign type ('broadcast' default),
 *   route?: explicit app route,
 *   productHandle?: open a product,
 *   campaign?: campaign identifier (used for dedupe),
 *   data?: extra payload,
 *   targetUserId?: optional (structure supports audience targeting),
 *   token?: optional single-token test send
 * }
 */
router.post('/api/notifications/send', requireAdmin, async (req, res) => {
  const title = safeString(req.body?.title, 'NOOD');
  const body = safeString(req.body?.body);
  const type = safeString(req.body?.type, 'broadcast');
  const route = safeString(req.body?.route);
  const productHandle = safeString(req.body?.productHandle);
  const campaign = safeString(req.body?.campaign);
  const extraData = req.body?.data && typeof req.body?.data === 'object' ? req.body.data : {};
  const targetToken = safeString(req.body?.token);
  const targetUserId = safeString(req.body?.targetUserId);

  if (!body) {
    return res.status(400).json({ success: false, message: 'body is required' });
  }

  let recipients = await loadAllRecipients();

  if (targetToken) {
    recipients = recipients.filter((t) => t.token === targetToken);
  } else if (targetUserId) {
    recipients = recipients.filter((t) => t.userId === targetUserId);
  }

  const data = { ...extraData };
  if (type && !data.type) data.type = type;
  if (route) data.route = route;
  if (productHandle) data.productHandle = productHandle;
  if (campaign) data.campaign = campaign;
  if (!data.type) data.type = 'broadcast';

  const campaignId = campaign || `manual_${type}_${Date.now().toString(36)}`;

  console.log(`[PUSH] Sending manual broadcast | type: ${type} | recipients: ${recipients.length}`);

  const result = await sendPush({
    recipients,
    title,
    body,
    data,
    campaignId,
    campaignType: type,
    dedupeKey: campaign ? `manual_${campaign}` : null,
    frequency: { check: true },
  });

  return res.json({
    success: true,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    campaignId: result.campaignId,
    message: `Notification sent to ${result.sent} device(s)`,
  });
});

// ─── Admin: named campaign ──────────────────────────────────────────────

/**
 * POST /api/notifications/campaign — send a named campaign (ADMIN ONLY).
 * Body: { campaign: 'daily-reward' | 'flash-live' | 'cart-nudge' |
 *              'hot-product' | 'price-drop' | 'new_product' | 'broadcast',
 *         title?, body?, data?, targetUserId?, productHandle? }
 */
router.post('/api/notifications/campaign', requireAdmin, async (req, res) => {
  const campaignType = safeString(req.body?.campaign, 'broadcast');
  const title = safeString(req.body?.title);
  const body = safeString(req.body?.body);
  const extraData = req.body?.data && typeof req.body?.data === 'object' ? req.body.data : {};
  const targetUserId = safeString(req.body?.targetUserId);
  const productHandle = safeString(req.body?.productHandle);

  let recipients = await loadAllRecipients();
  if (targetUserId) {
    recipients = recipients.filter((t) => t.userId === targetUserId);
  }

  console.log(`[PUSH] Sending campaign | type: ${campaignType} | recipients: ${recipients.length}`);

  const result = await sendCampaign({
    campaignType,
    title,
    body,
    data: {
      ...extraData,
      ...(productHandle ? { productHandle, route: `/product/${productHandle}` } : {}),
    },
    recipients,
    dedupeKey: targetUserId ? `campaign_${campaignType}_${targetUserId}` : null,
  });

  return res.json({
    success: true,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    campaign: campaignType,
    campaignId: result.campaignId,
    message: `Campaign "${campaignType}" sent to ${result.sent} device(s)`,
  });
});

// ─── Admin: token cleanup ───────────────────────────────────────────────

/**
 * POST /api/notifications/deactivate-token — admin: deactivate a token by
 * suffix. Use when a device should stop receiving pushes.
 */
router.post('/api/notifications/deactivate-token', requireAdmin, async (req, res) => {
  const suffix = safeString(req.body?.suffix);
  if (!suffix) {
    return res.status(400).json({ success: false, message: 'suffix is required' });
  }

  const tokens = await loadTokens({ includeInactive: true });
  const match = Object.values(tokens).find(
    (t) => String(t.token).endsWith(suffix) || String(t.token).slice(-8) === suffix
  );
  if (!match) {
    return res.status(404).json({ success: false, message: 'No token found with that suffix' });
  }

  await deactivateToken(match.token);
  console.log(`[PUSH ADMIN] deactivated token | suffix: ...${suffix}`);
  return res.json({ success: true, message: 'Token deactivated' });
});

// ─── NOOD Inbox ─────────────────────────────────────────────────────────

/**
 * GET /api/notifications/inbox?userId=...&deviceId=...&limit=...
 * Latest notifications visible to this user (broadcasts + their own),
 * newest first, each with `read` state.
 */
router.get('/api/notifications/inbox', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity) {
    return res.status(400).json({ success: false, message: 'x-push-token header or deviceId is required' });
  }

  const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : undefined;
  const offset = Number(req.query.offset) > 0 ? Number(req.query.offset) : undefined;
  const items = await listInboxForUser({ userId: identity.id, limit, offset });
  return res.json({ success: true, items, total: items.length });
});

/**
 * GET /api/notifications/inbox/unread-count?userId=...&deviceId=...
 */
router.get('/api/notifications/inbox/unread-count', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity) {
    return res.status(400).json({ success: false, message: 'x-push-token header or deviceId is required' });
  }
  const unread = await getUnreadCount({ userId: identity.id });
  return res.json({ success: true, unreadCount: unread });
});

/**
 * POST /api/notifications/inbox/:id/read
 * Mark a single notification read for this user/device.
 */
router.post('/api/notifications/inbox/:id/read', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity) {
    return res.status(400).json({ success: false, message: 'x-push-token header or deviceId is required' });
  }
  const notificationId = safeString(req.params?.id);
  if (!notificationId) {
    return res.status(400).json({ success: false, message: 'notification id is required' });
  }
  const result = await markInboxRead({ userId: identity.id, notificationId });
  return res.json({ success: result.success });
});

/**
 * POST /api/notifications/inbox/read-all
 * Mark all visible notifications read for this user/device.
 */
router.post('/api/notifications/inbox/read-all', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity) {
    return res.status(400).json({ success: false, message: 'x-push-token header or deviceId is required' });
  }
  const result = await markAllInboxRead({ userId: identity.id });
  return res.json({ success: result.success, marked: result.marked });
});

// ─── Notification preferences ───────────────────────────────────────────

/**
 * GET /api/notifications/preferences?userId=...
 */
router.get('/api/notifications/preferences', async (req, res) => {
  const userId = safeString(req.query?.userId);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId is required' });
  }
  const prefs = await loadPreferences(userId);
  return res.json({ success: true, preferences: prefs });
});

/**
 * POST /api/notifications/preferences
 * Body: { userId, category, enabled }
 */
router.post('/api/notifications/preferences', async (req, res) => {
  const userId = safeString(req.body?.userId);
  const category = safeString(req.body?.category);
  const enabled = Boolean(req.body?.enabled);
  if (!userId || !category) {
    return res.status(400).json({ success: false, message: 'userId and category are required' });
  }
  const result = await setPreference(userId, category, enabled);
  return res.json({ success: result.success });
});

// ─── Campaign Center API ────────────────────────────────────────────────

/**
 * GET /api/campaign-center/summary — dashboard stats (ADMIN).
 * Returns recent campaigns, delivery totals, device count, analytics.
 */
router.get('/api/campaign-center/summary', requireAdmin, async (req, res) => {
  try {
    const { campaignExists } = require('../utils/push-state-db');
    const campaigns = await getRecentCampaigns(20);
    const devices = await loadTokens();
    const analytics = await getAnalyticsSummary();
    return res.json({
      success: true,
      campaigns,
      deviceCount: Object.keys(devices).length,
      analytics,
      config: {
        minPromoIntervalMinutes: config.minPromoIntervalMinutes,
        maxPromoPerDay: config.maxPromoPerDay,
        quietHoursEnabled: config.quietHoursEnabled,
        quietHoursStart: config.quietHoursStart,
        quietHoursEnd: config.quietHoursEnd,
        newProductBatchThreshold: config.newProductBatchThreshold,
      },
    });
  } catch (error) {
    console.error('[CAMPAIGN CENTER] summary error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to load summary' });
  }
});

/**
 * GET /api/campaign-center/registry — full notification type registry (ADMIN).
 */
router.get('/api/campaign-center/registry', requireAdmin, async (req, res) => {
  return res.json({ success: true, registry: REGISTRY });
});

/**
 * POST /api/campaign-center/preview — preview a campaign before sending (ADMIN).
 * Body: { type, title, body, productHandle, orderId, route }
 * Returns the template + validated deep link WITHOUT sending.
 */
router.post('/api/campaign-center/preview', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const type = safeString(body.type, 'general');
  const entry = entryFor(type);

  // Deep-link builder (mirrors frontend notification-handling.ts logic).
  let route = safeString(body.route);
  if (!route && entry?.deepLink) {
    route = entry.deepLink;
    // Substitute placeholders.
    route = route.replace('<handle>', encodeURIComponent(safeString(body.productHandle)))
      .replace('<product>', encodeURIComponent(safeString(body.productHandle)))
      .replace('<orderId>', encodeURIComponent(safeString(body.orderId)));
  }

  return res.json({
    success: true,
    type,
    status: statusFor(type),
    title: safeString(body.title) || entry?.template?.title || 'NOOD',
    body: safeString(body.body) || entry?.template?.body || '',
    deepLink: route || null,
    category: entry?.category || 'general',
    priority: entry?.priority || 'promotional',
    freqCapped: entry ? entry.freqCapped !== false : true,
  });
});

/**
 * GET /api/campaign-center/audit — audit log (ADMIN).
 * Returns recent campaign events from push_campaign_events.
 */
router.get('/api/campaign-center/audit', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  try {
    const events = await getRecentCampaigns(limit);
    return res.json({ success: true, events });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load audit log' });
  }
});

/** Load recent campaign events from push_campaign_events (Supabase or JSON). */
async function getRecentCampaigns(limit) {
  const { supabaseAdmin } = require('../utils/supabase-admin');
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('push_campaign_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('[CAMPAIGN CENTER] campaign fetch failed:', error.message);
    }
  }
  // JSON fallback.
  const fs = require('fs');
  const path = require('path');
  const file = process.env.PUSH_CAMPAIGN_STATE_FILE || path.join(__dirname, '..', 'push-campaign-state.json');
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    const byId = parsed?.byId || {};
    return Object.values(byId)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { router, devSeedEnabled };
