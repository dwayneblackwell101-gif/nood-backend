/**
 * NOOD — Notification Analytics
 *
 * Lightweight event tracking for the notification pipeline. No invasive
 * personal tracking — events record type, category, and aggregate counters.
 *
 * Events:
 *   notification_created    — a notification object was normalized
 *   push_attempted         — delivery attempt started
 *   push_sent              — Expo returned ok for a message
 *   push_failed            — Expo returned an error for a message
 *   push_opened            — user tapped a push (reported by the app)
 *   inbox_viewed           — user opened the Inbox (reported by the app)
 *   notification_opened    — user tapped an inbox item (reported by the app)
 *   notification_marked_read — inbox item marked read (reported by the app)
 *   campaign_created       — a campaign was created (idempotent)
 *   campaign_sent          — a campaign finished delivery
 *
 * Persistence: Supabase (notification_analytics) with JSON file fallback so
 * the rest of the pipeline keeps working when the DB is unavailable.
 */

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('./supabase-admin');

/** Resolve the analytics file path at call time so tests can redirect it. */
function analyticsFile() {
  return process.env.PUSH_ANALYTICS_FILE || path.join(__dirname, '..', 'push-analytics-state.json');
}

function loadJson() {
  try {
    const file = analyticsFile();
    if (!fs.existsSync(file)) return { events: [] };
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { events: [] };
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.events) ? parsed : { events: [] };
  } catch {
    return { events: [] };
  }
}

function saveJson(data) {
  try {
    // Keep at most the last 2000 events (cheap cap).
    const trimmed = { events: data.events.slice(-2000) };
    fs.writeFileSync(analyticsFile(), JSON.stringify(trimmed, null, 2));
  } catch {
    // non-fatal
  }
}

/**
 * Record a notification analytics event.
 *
 * @param {string} event   event name (see list above)
 * @param {Object} meta    { type?, category?, campaignId?, tokenSuffix?, count? }
 */
async function trackNotificationEvent(event, meta = {}) {
  const record = {
    event: String(event || ''),
    type: meta.type ? String(meta.type) : null,
    category: meta.category ? String(meta.category) : null,
    campaign_id: meta.campaignId ? String(meta.campaignId) : null,
    token_suffix: meta.tokenSuffix ? String(meta.tokenSuffix) : null,
    count: Number.isFinite(meta.count) ? meta.count : 1,
    created_at: new Date().toISOString(),
  };

  if (!record.event) return;

  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin.from('notification_analytics').insert(record);
      if (error) throw error;
      return;
    } catch (error) {
      console.error('[ANALYTICS] Supabase insert failed:', error.message);
    }
  }

  const store = loadJson();
  store.events.push(record);
  saveJson(store);
}

/** Aggregate analytics summary (used by the Campaign Center dashboard). */
async function getAnalyticsSummary() {
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('notification_analytics')
        .select('event, count, created_at')
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) throw error;
      return summarizeEvents(data || []);
    } catch (error) {
      console.error('[ANALYTICS] Summary fetch failed:', error.message);
    }
  }
  return summarizeEvents(loadJson().events);
}

function summarizeEvents(rows) {
  const totals = {};
  const byType = {};
  const recent = [];

  for (const row of rows || []) {
    const event = String(row.event || row.event_name || '');
    const count = Number(row.count || 1);
    totals[event] = (totals[event] || 0) + count;

    const type = String(row.type || '');
    if (type) {
      byType[type] = byType[type] || {};
      byType[type][event] = (byType[type][event] || 0) + count;
    }

    recent.push({
      event,
      type: type || null,
      category: row.category || null,
      at: row.created_at || null,
    });
  }

  return {
    totals,
    byType,
    recent: recent.slice(0, 50),
  };
}

module.exports = {
  trackNotificationEvent,
  getAnalyticsSummary,
  summarizeEvents,
};
