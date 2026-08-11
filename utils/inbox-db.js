/**
 * Notification inbox persistence — the in-app NOOD Inbox history.
 *
 * Every push campaign persisted here appears in the app's NOOD Inbox.
 *
 * Supabase-backed (survives Render restarts/deploys) with JSON fallback for
 * local/dev and tests.
 *
 * Storage model:
 *   notification_inbox          — one row per notification. user_id is NULL
 *                                 for broadcasts (visible to everyone);
 *                                 user-specific rows for targeted sends.
 *   notification_inbox_reads    — per-user read state (user_id, notification_id).
 *
 * Dedupe: campaign_id is UNIQUE in notification_inbox. Retrying the same
 * campaign cannot create a duplicate inbox row.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('./supabase-admin');

const INBOX_FILE =
  process.env.PUSH_INBOX_FILE || path.join(__dirname, '..', 'push-inbox-state.json');
const READS_FILE =
  process.env.PUSH_INBOX_READS_FILE || path.join(__dirname, '..', 'push-inbox-reads-state.json');

// ─── JSON fallbacks ─────────────────────────────────────────────────────

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // non-fatal
  }
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Deterministic campaign_id fallback so inbox rows are always dedupe-able
 * even when the caller did not supply a campaign id.
 */
function makeInboxCampaignId(entry) {
  const type = String(entry.type || 'general');
  const data = entry.data && typeof entry.data === 'object' ? entry.data : {};
  const key = [
    type,
    data.route || '',
    data.productHandle || '',
    data.orderId || '',
    entry.userId || '',
  ].join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `inbox_${type}_${hash}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(item) {
  if (!item?.expiresAt) return false;
  try {
    return new Date(item.expiresAt).getTime() < Date.now();
  } catch {
    return false;
  }
}

function serializeItem(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id || row.campaignId || null,
    type: row.type || 'general',
    title: row.title || '',
    body: row.body || '',
    route: row.route || null,
    productHandle: row.product_handle || row.productHandle || null,
    orderId: row.order_id || row.orderId || null,
    campaign: row.campaign || null,
    data: row.data && typeof row.data === 'object' ? row.data : {},
    userId: row.user_id || row.userId || null,
    createdAt: row.created_at || row.createdAt || nowIso(),
    expiresAt: row.expires_at || row.expiresAt || null,
  };
}

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * Persist an inbox item. Idempotent by campaign_id.
 *
 * @param {Object} entry
 * @param {string} [entry.campaignId]
 * @param {string} entry.type        campaign type (new_product, price-drop, ...)
 * @param {string} entry.title
 * @param {string} entry.body
 * @param {Object} [entry.data]      deep-link payload (must match the push payload)
 * @param {string} [entry.userId]    null/omitted = broadcast (visible to all)
 * @param {string} [entry.expiresAt]
 * @returns {Promise<{ created: boolean, item?: object }>}
 */
async function createInboxItem(entry) {
  const campaignId = String(entry.campaignId || '').trim() || makeInboxCampaignId(entry);
  const item = {
    campaignId,
    type: String(entry.type || 'general'),
    title: String(entry.title || 'NOOD'),
    body: String(entry.body || ''),
    route: entry.route || null,
    productHandle: entry.productHandle || null,
    orderId: entry.orderId || null,
    campaign: entry.campaign || null,
    data: entry.data && typeof entry.data === 'object' ? entry.data : {},
    userId: entry.userId || null,
    createdAt: nowIso(),
    expiresAt: entry.expiresAt || null,
  };

  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('notification_inbox')
        .insert({
          campaign_id: campaignId,
          type: item.type,
          title: item.title,
          body: item.body,
          route: item.route,
          product_handle: item.productHandle,
          order_id: item.orderId,
          campaign: item.campaign,
          data: item.data,
          user_id: item.userId,
          created_at: item.createdAt,
          expires_at: item.expiresAt,
        })
        .select('id, campaign_id, type, title, body, route, product_handle, order_id, campaign, data, user_id, created_at, expires_at')
        .maybeSingle();

      if (error) {
        // Unique violation on campaign_id → duplicate, not an error.
        if (String(error.message || '').includes('duplicate key')) {
          return { created: false };
        }
        throw error;
      }
      return { created: true, item: serializeItem(data) };
    } catch (error) {
      // Infra hiccup → fall back to JSON so dev/test still works.
      return createInboxItemJson(item);
    }
  }

  return createInboxItemJson(item);
}

function createInboxItemJson(item) {
  const store = loadJson(INBOX_FILE, { items: [] });
  const existing = store.items.find((i) => i.campaignId === item.campaignId);
  if (existing) {
    return { created: false };
  }

  const record = { ...item, id: generateId() };
  store.items.push(record);
  saveJson(INBOX_FILE, store);
  return { created: true, item: serializeItem(record) };
}

// ─── Read ───────────────────────────────────────────────────────────────

/**
 * List inbox items visible to a user (broadcasts + their own), newest first,
 * each annotated with `read`.
 */
async function listInboxForUser({ userId, limit }) {
  let items;
  if (supabaseAdmin) {
    try {
      const [broadcastResult, personalResult] = await Promise.all([
        supabaseAdmin.from('notification_inbox').select('*').is('user_id', null),
        userId
          ? supabaseAdmin.from('notification_inbox').select('*').eq('user_id', userId)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (broadcastResult.error) throw broadcastResult.error;
      if (personalResult.error) throw personalResult.error;

      const rows = [...(broadcastResult.data || []), ...(personalResult.data || [])];
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      items = rows.map(serializeItem);
    } catch (error) {
      console.error('[INBOX] Supabase list failed, using JSON fallback:', error.message);
      items = listInboxJson(userId);
    }
  } else {
    items = listInboxJson(userId);
  }

  const visible = items.filter((i) => !isExpired(i));
  const reads = await loadReadsForUser(userId);
  const annotated = visible.map((item) => ({
    ...item,
    read: Boolean(reads[item.id]),
  }));

  if (limit && Number(limit) > 0) {
    return annotated.slice(0, Number(limit));
  }
  return annotated;
}

function listInboxJson(userId) {
  const store = loadJson(INBOX_FILE, { items: [] });
  return store.items
    .filter((i) => !i.userId || i.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(serializeItem);
}

async function loadReadsForUser(userId) {
  if (!userId) return {};
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('notification_inbox_reads')
        .select('notification_id')
        .eq('user_id', userId);
      if (error) throw error;
      const map = {};
      for (const row of data || []) map[row.notification_id] = true;
      return map;
    } catch (error) {
      console.error('[INBOX] reads load failed, using JSON fallback:', error.message);
    }
  }
  const reads = loadJson(READS_FILE, {});
  return reads[userId] || {};
}

async function getUnreadCount({ userId }) {
  const items = await listInboxForUser({ userId });
  return items.filter((i) => !i.read).length;
}

// ─── Read state ─────────────────────────────────────────────────────────

async function markInboxRead({ userId, notificationId }) {
  if (!userId || !notificationId) return { success: false };
  const readAt = nowIso();

  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin.from('notification_inbox_reads').upsert(
        {
          user_id: userId,
          notification_id: notificationId,
          read_at: readAt,
        },
        { onConflict: 'user_id,notification_id' }
      );
      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('[INBOX] mark read failed, using JSON fallback:', error.message);
    }
  }

  const reads = loadJson(READS_FILE, {});
  reads[userId] = reads[userId] || {};
  reads[userId][notificationId] = readAt;
  saveJson(READS_FILE, reads);
  return { success: true };
}

async function markAllInboxRead({ userId }) {
  if (!userId) return { success: false, marked: 0 };
  const items = await listInboxForUser({ userId });
  const unread = items.filter((i) => !i.read);
  let marked = 0;
  for (const item of unread) {
    await markInboxRead({ userId, notificationId: item.id });
    marked += 1;
  }
  return { success: true, marked };
}

module.exports = {
  createInboxItem,
  listInboxForUser,
  getUnreadCount,
  markInboxRead,
  markAllInboxRead,
  makeInboxCampaignId,
};
