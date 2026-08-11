/**
 * Push token persistence — Supabase-backed (survives Render restarts).
 * Falls back to the local JSON file only when Supabase is not configured.
 *
 * Each installation/token stores:
 *   token, platform, device_id, user_id, email, app_version,
 *   is_test, is_active, last_seen_at, created_at, updated_at
 */

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('./supabase-admin');

const TOKENS_FILE =
  process.env.PUSH_TOKENS_FILE || path.join(__dirname, '..', 'push-tokens.json');

function loadJsonFallback() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveJsonFallback(tokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch {
    // non-fatal
  }
}

function isLikelyRealToken(token) {
  return /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/.test(token);
}

/** Load all tokens as a map keyed by token (only active tokens by default). */
async function loadTokens({ includeInactive = false } = {}) {
  if (!supabaseAdmin) {
    const map = loadJsonFallback();
    if (includeInactive) return map;
    const filtered = {};
    for (const [key, value] of Object.entries(map)) {
      if (value?.active !== false) filtered[key] = value;
    }
    return filtered;
  }

  try {
    let query = supabaseAdmin
      .from('push_tokens')
      .select('token, platform, device_id, user_id, email, app_version, created_at, updated_at, last_seen_at, is_test, is_active');

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    const map = {};
    for (const row of data || []) {
      map[row.token] = {
        token: row.token,
        platform: row.platform,
        deviceId: row.device_id,
        userId: row.user_id,
        email: row.email,
        appVersion: row.app_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastSeenAt: row.last_seen_at,
        test: row.is_test,
        active: row.is_active !== false,
      };
    }
    return map;
  } catch (error) {
    console.error('[PUSH-DB] load failed, using JSON fallback:', error.message);
    return loadJsonFallback();
  }
}

/** Upsert a token. Idempotent — repeated registration never duplicates. */
async function upsertToken(entry) {
  const token = entry.token;
  if (!token) return;

  const now = new Date().toISOString();

  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from('push_tokens').upsert(
      {
        token,
        platform: entry.platform || 'android',
        device_id: entry.deviceId || null,
        user_id: entry.userId || null,
        email: entry.email || null,
        app_version: entry.appVersion || null,
        is_test: !isLikelyRealToken(token),
        is_active: true,
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: 'token' }
    );
    if (error) {
      // Supabase is configured but the write failed — do NOT silently fall
      // back to JSON. Let the caller know the DB write failed.
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }
    return;
  }

  // Supabase not configured — JSON fallback for local/dev.
  const map = loadJsonFallback();
  map[token] = {
    token,
    platform: entry.platform || 'android',
    deviceId: entry.deviceId || '',
    userId: entry.userId || '',
    email: entry.email || '',
    appVersion: entry.appVersion || '',
    createdAt: map[token]?.createdAt || entry.createdAt || now,
    updatedAt: now,
    lastSeenAt: now,
    test: !isLikelyRealToken(token),
    active: true,
  };
  saveJsonFallback(map);
}

/**
 * Deactivate a token (e.g. DeviceNotRegistered). Keeps the row for audit,
 * but stops it from being targeted.
 */
async function deactivateToken(token) {
  if (!token) return;
  if (supabaseAdmin) {
    try {
      await supabaseAdmin
        .from('push_tokens')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('token', token);
      return;
    } catch (error) {
      console.error('[PUSH-DB] deactivate failed:', error.message);
    }
  }
  const map = loadJsonFallback();
  if (map[token]) {
    map[token].active = false;
    map[token].updatedAt = new Date().toISOString();
    saveJsonFallback(map);
  }
}

/**
 * Look up the identity bound to an Expo push token.
 * The token acts as a bearer credential — only the device that owns the
 * token can present it, so the bound user_id is authoritative for private
 * inbox/tracking data.
 * @returns {Promise<{userId, deviceId, email} | null>}
 */
async function findTokenRecord(token) {
  if (!token) return null;
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('push_tokens')
        .select('user_id, device_id, email, is_active')
        .eq('token', token)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        userId: data.user_id || null,
        deviceId: data.device_id || null,
        email: data.email || null,
        active: data.is_active !== false,
      };
    } catch (error) {
      console.error('[PUSH-DB] findTokenRecord failed:', error.message);
      return null;
    }
  }
  const map = loadJsonFallback();
  const row = map[token];
  if (!row) return null;
  return {
    userId: row.userId || null,
    deviceId: row.deviceId || null,
    email: row.email || null,
    active: row.active !== false,
  };
}

/**
 * Detach a device token from its user (called on LOGOUT).
 * Nulls user_id + email so private notifications (orders, cart, tracking,
 * rewards) can never leak to the next person using the device. The token
 * stays active so the device can still receive global broadcasts as a guest.
 */
async function detachTokenUser(token) {
  if (!token) return;
  if (supabaseAdmin) {
    try {
      await supabaseAdmin
        .from('push_tokens')
        .update({
          user_id: null,
          email: null,
          updated_at: new Date().toISOString(),
        })
        .eq('token', token);
      return;
    } catch (error) {
      console.error('[PUSH-DB] detach failed:', error.message);
    }
  }
  const map = loadJsonFallback();
  if (map[token]) {
    map[token].userId = '';
    map[token].email = '';
    map[token].updatedAt = new Date().toISOString();
    saveJsonFallback(map);
  }
}

/** Remove a token completely. */
async function removeToken(token) {
  if (!token) return;
  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('push_tokens').delete().eq('token', token);
      return;
    } catch (error) {
      console.error('[PUSH-DB] remove failed:', error.message);
    }
  }
  const map = loadJsonFallback();
  delete map[token];
  saveJsonFallback(map);
}

module.exports = { loadTokens, upsertToken, removeToken, deactivateToken, detachTokenUser, findTokenRecord, isLikelyRealToken };
