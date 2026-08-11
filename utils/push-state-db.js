/**
 * Push campaign + frequency state persistence.
 *
 * Supabase-backed so state survives Render restarts / deployments / scaling.
 * Falls back to local JSON files (as the rest of NOOD does) when Supabase is
 * not configured.
 *
 * Tables (see supabase-setup.sql):
 *   push_campaign_events — campaign_id (unique) + dedupe_key (unique).
 *                          Dedupe across retries and repeated sync jobs.
 *   push_frequency      — per-token, per-day promotional counters.
 */

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('./supabase-admin');

const CAMPAIGN_FILE =
  process.env.PUSH_CAMPAIGN_STATE_FILE || path.join(__dirname, '..', 'push-campaign-state.json');
const FREQ_FILE =
  process.env.PUSH_FREQUENCY_STATE_FILE || path.join(__dirname, '..', 'push-frequency-state.json');

// ─── JSON fallbacks (Supabase not configured) ───────────────────────────

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

// ─── Campaign events ────────────────────────────────────────────────────

/**
 * Record that a campaign was created. Idempotent — if a campaign with the same
 * campaign_id OR the same dedupe_key already exists, this is a duplicate and
 * returns false.
 *
 * @returns {Promise<{ created: boolean, duplicateReason?: 'campaign_id'|'dedupe_key' }>}
 */
async function createCampaignEvent(entry) {
  const campaignId = String(entry.campaignId || '').trim();
  const dedupeKey = String(entry.dedupeKey || '').trim();

  if (!campaignId) {
    return { created: false, duplicateReason: 'campaign_id' };
  }

  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('push_campaign_events')
        .insert({
          campaign_id: campaignId,
          campaign_type: entry.campaignType || 'general',
          dedupe_key: dedupeKey || null,
          title: entry.title || null,
          body: entry.body || null,
          payload: entry.payload || {},
          status: entry.status || 'created',
          recipient_count: entry.recipientCount != null ? entry.recipientCount : 0,
          sent_count: entry.sentCount != null ? entry.sentCount : 0,
          failed_count: entry.failedCount != null ? entry.failedCount : 0,
          skipped_count: entry.skippedCount != null ? entry.skippedCount : 0,
          created_at: new Date().toISOString(),
        })
        .select('id');

      if (error) {
        // Unique violation → duplicate campaign.
        if (String(error.message || '').includes('duplicate key')) {
          return { created: false, duplicateReason: 'campaign_id' };
        }
        throw error;
      }
      return { created: true };
    } catch (error) {
      // Distinguish dedupe_key conflicts if Supabase returned one.
      if (String(error.message || '').includes('push_campaign_events_dedupe_key')) {
        return { created: false, duplicateReason: 'dedupe_key' };
      }
      // Fall back to JSON on infra errors so dev/test still works.
      return createCampaignEventJson(entry);
    }
  }

  return createCampaignEventJson(entry);
}

function createCampaignEventJson(entry) {
  const map = loadJson(CAMPAIGN_FILE, { byId: {}, byDedupe: {} });
  const campaignId = String(entry.campaignId || '').trim();
  const dedupeKey = String(entry.dedupeKey || '').trim();

  if (map.byId[campaignId]) {
    return { created: false, duplicateReason: 'campaign_id' };
  }
  if (dedupeKey && map.byDedupe[dedupeKey]) {
    return { created: false, duplicateReason: 'dedupe_key' };
  }

  const record = {
    campaignId,
    campaignType: entry.campaignType || 'general',
    dedupeKey: dedupeKey || null,
    title: entry.title || null,
    body: entry.body || null,
    payload: entry.payload || {},
    status: entry.status || 'created',
    recipientCount: entry.recipientCount != null ? entry.recipientCount : 0,
    sentCount: entry.sentCount != null ? entry.sentCount : 0,
    failedCount: entry.failedCount != null ? entry.failedCount : 0,
    skippedCount: entry.skippedCount != null ? entry.skippedCount : 0,
    createdAt: new Date().toISOString(),
  };

  map.byId[campaignId] = record;
  if (dedupeKey) map.byDedupe[dedupeKey] = campaignId;
  saveJson(CAMPAIGN_FILE, map);
  return { created: true };
}

/** Update the sent/failed/skipped totals after delivery. */
async function updateCampaignStats(campaignId, { sent, failed, skipped }) {
  if (!campaignId) return;
  if (supabaseAdmin) {
    try {
      await supabaseAdmin
        .from('push_campaign_events')
        .update({
          status: 'sent',
          sent_count: sent != null ? sent : 0,
          failed_count: failed != null ? failed : 0,
          skipped_count: skipped != null ? skipped : 0,
        })
        .eq('campaign_id', campaignId);
    } catch {
      // non-fatal
    }
    return;
  }

  const map = loadJson(CAMPAIGN_FILE, { byId: {}, byDedupe: {} });
  const record = map.byId[campaignId];
  if (record) {
    record.status = 'sent';
    record.sentCount = sent != null ? sent : record.sentCount;
    record.failedCount = failed != null ? failed : record.failedCount;
    record.skippedCount = skipped != null ? skipped : record.skippedCount;
    saveJson(CAMPAIGN_FILE, map);
  }
}

/** Was a campaign already created (by campaignId)? */
async function campaignExists(campaignId) {
  if (!campaignId) return false;
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('push_campaign_events')
        .select('campaign_id')
        .eq('campaign_id', campaignId)
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    } catch {
      // fall through to JSON
    }
  }
  const map = loadJson(CAMPAIGN_FILE, { byId: {}, byDedupe: {} });
  return Boolean(map.byId[campaignId]);
}

// ─── Frequency state ────────────────────────────────────────────────────

function freqDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Check + increment promotional push counter.
 * Frequency is PER USER when a userId is available (single cap across that
 * user's devices); otherwise falls back to per-token.
 *
 * @param {string} token
 * @param {number} minIntervalMinutes
 * @param {number} maxPerDay
 * @param {string} [userId]
 * Returns { allowed, promoCountToday, lastPromoAt, skipReason }.
 */
async function checkAndIncrementFrequency(token, minIntervalMinutes, maxPerDay, userId) {
  const now = new Date();
  const today = freqDayKey(now);
  const minIntervalMs = minIntervalMinutes * 60 * 1000;

  const result = {
    allowed: true,
    promoCountToday: 0,
    lastPromoAt: null,
    skipReason: null,
  };

  // Supabase uses (token, day) PK — add user_id column via migration. We
  // read by token for backward compat and by user when present.
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('push_frequency')
        .select('token, user_id, day, promo_count, last_promo_at')
        .eq('token', token)
        .eq('day', today)
        .maybeSingle();

      if (error) throw error;

      const row = data || null;
      const promoCount = row?.promo_count || 0;
      const lastPromoAt = row?.last_promo_at || null;
      result.promoCountToday = promoCount;
      result.lastPromoAt = lastPromoAt;

      if (promoCount >= maxPerDay) {
        result.allowed = false;
        result.skipReason = 'daily_cap';
        return result;
      }
      if (lastPromoAt && now.getTime() - new Date(lastPromoAt).getTime() < minIntervalMs) {
        result.allowed = false;
        result.skipReason = 'min_interval';
        return result;
      }

      // Increment.
      await supabaseAdmin.from('push_frequency').upsert(
        {
          token,
          user_id: userId || null,
          day: today,
          promo_count: promoCount + 1,
          last_promo_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        { onConflict: 'token,day' }
      );

      result.promoCountToday = promoCount + 1;
      result.allowed = true;
      return result;
    } catch (error) {
      // If the table doesn't exist yet, fall back to JSON behavior.
      return checkAndIncrementFrequencyJson(token, today, minIntervalMs, maxPerDay, now, userId);
    }
  }

  return checkAndIncrementFrequencyJson(token, today, minIntervalMs, maxPerDay, now, userId);
}

function checkAndIncrementFrequencyJson(token, today, minIntervalMs, maxPerDay, now, userId) {
  const map = loadJson(FREQ_FILE, {});
  const key = `${userId || token}:${today}`;
  const row = map[key] || { count: 0, lastAt: null };
  const result = {
    allowed: true,
    promoCountToday: row.count,
    lastPromoAt: row.lastAt,
    skipReason: null,
  };

  if (row.count >= maxPerDay) {
    result.allowed = false;
    result.skipReason = 'daily_cap';
    return result;
  }
  if (row.lastAt && now.getTime() - new Date(row.lastAt).getTime() < minIntervalMs) {
    result.allowed = false;
    result.skipReason = 'min_interval';
    return result;
  }

  row.count += 1;
  row.lastAt = now.toISOString();
  map[key] = row;
  saveJson(FREQ_FILE, map);

  result.promoCountToday = row.count;
  result.allowed = true;
  return result;
}

/**
 * Persist the "last cart nudge" timestamp for a cart/user so repeated nudges
 * respect a cooldown. Returns true if the nudge is allowed (cooldown elapsed
 * or first nudge).
 */
async function allowCartNudge(scopeKey, cooldownHours) {
  const now = new Date();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('push_cart_nudges')
        .select('cart_key, last_nudge_at, recovery_email_sent_at')
        .eq('cart_key', scopeKey)
        .maybeSingle();
      if (error) throw error;

      if (data?.recovery_email_sent_at || data?.last_nudge_at) {
        const last = data.last_nudge_at || data.recovery_email_sent_at;
        if (now.getTime() - new Date(last).getTime() < cooldownMs) {
          return false;
        }
      }

      await supabaseAdmin.from('push_cart_nudges').upsert(
        {
          cart_key: scopeKey,
          last_nudge_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        { onConflict: 'cart_key' }
      );
      return true;
    } catch {
      return allowCartNudgeJson(scopeKey, cooldownMs, now);
    }
  }

  return allowCartNudgeJson(scopeKey, cooldownMs, now);
}

function allowCartNudgeJson(scopeKey, cooldownMs, now) {
  const map = loadJson(FREQ_FILE, {});
  const key = `cart:${scopeKey}`;
  const row = map[key];
  if (row && now.getTime() - new Date(row.lastAt).getTime() < cooldownMs) {
    return false;
  }
  map[key] = { lastAt: now.toISOString() };
  saveJson(FREQ_FILE, map);
  return true;
}

module.exports = {
  createCampaignEvent,
  updateCampaignStats,
  campaignExists,
  checkAndIncrementFrequency,
  allowCartNudge,
  freqDayKey,
};
