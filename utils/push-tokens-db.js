/**
 * Push token persistence — Supabase-backed (survives Render restarts).
 * Falls back to the local JSON file only when Supabase is not configured.
 */

const fs = require('fs');
const path = require('path');
const { supabase } = require('./supabase');

const TOKENS_FILE = path.join(__dirname, '..', 'push-tokens.json');

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

/** Load all tokens as a map keyed by token. */
async function loadTokens() {
  if (!supabase) return loadJsonFallback();

  try {
    const { data, error } = await supabase
      .from('push_tokens')
      .select('token, platform, device_id, user_id, app_version, created_at, updated_at, is_test');

    if (error) throw error;

    const map = {};
    for (const row of data || []) {
      map[row.token] = {
        token: row.token,
        platform: row.platform,
        deviceId: row.device_id,
        userId: row.user_id,
        appVersion: row.app_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        test: row.is_test,
      };
    }
    return map;
  } catch (error) {
    console.error('[PUSH-DB] load failed, using JSON fallback:', error.message);
    return loadJsonFallback();
  }
}

/** Upsert a token. Returns the updated map. */
async function upsertToken(entry) {
  const token = entry.token;

  if (supabase) {
    const { error } = await supabase.from('push_tokens').upsert(
      {
        token,
        platform: entry.platform || 'android',
        device_id: entry.deviceId || null,
        user_id: entry.userId || null,
        app_version: entry.appVersion || null,
        is_test: !isLikelyRealToken(token),
        updated_at: new Date().toISOString(),
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
    appVersion: entry.appVersion || '',
    createdAt: map[token]?.createdAt || entry.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    test: !isLikelyRealToken(token),
  };
  saveJsonFallback(map);
}

/** Remove a token (e.g. DeviceNotRegistered cleanup). */
async function removeToken(token) {
  if (supabase) {
    try {
      await supabase.from('push_tokens').delete().eq('token', token);
      return;
    } catch (error) {
      console.error('[PUSH-DB] remove failed, using JSON fallback:', error.message);
    }
  }
  const map = loadJsonFallback();
  delete map[token];
  saveJsonFallback(map);
}

module.exports = { loadTokens, upsertToken, removeToken, isLikelyRealToken };
