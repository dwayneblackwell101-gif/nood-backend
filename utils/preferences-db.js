/**
 * Server-side notification preferences.
 *
 * Users control which notification CATEGORIES they receive. Preferences are
 * persisted server-side (notification_preferences table) with JSON fallback.
 * Security/account-critical categories are always allowed (see push-config).
 *
 * When no preference row exists for a user, defaults to ALL categories
 * enabled (do not break existing users).
 */

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('./supabase-admin');
const { PREFERENCE_CATEGORIES } = require('./push-config');

const PREFERENCES_FILE =
  process.env.PUSH_PREFERENCES_FILE || path.join(__dirname, '..', 'push-preferences-state.json');

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

/** Categories that cannot be disabled by marketing opt-outs. */
const ALWAYS_ALLOWED = new Set(['orders', 'tracking', 'returns', 'security', 'support']);

/** Load a user's preference map (category → enabled). Missing → enabled. */
async function loadPreferences(userId) {
  const defaults = {};
  for (const cat of PREFERENCE_CATEGORIES) defaults[cat] = true;

  if (!userId) return defaults;

  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('notification_preferences')
        .select('category, enabled')
        .eq('user_id', userId);
      if (error) throw error;
      const map = { ...defaults };
      for (const row of data || []) {
        if (PREFERENCE_CATEGORIES.includes(row.category)) {
          map[row.category] = row.enabled !== false;
        }
      }
      return map;
    } catch (error) {
      console.error('[PREFERENCES] load failed, using JSON fallback:', error.message);
    }
  }

  const store = loadJson(PREFERENCES_FILE, {});
  return { ...defaults, ...(store[userId] || {}) };
}

/** Set a single preference for a user. */
async function setPreference(userId, category, enabled) {
  if (!userId || !PREFERENCE_CATEGORIES.includes(category)) {
    return { success: false };
  }
  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin.from('notification_preferences').upsert(
        {
          user_id: userId,
          category,
          enabled: Boolean(enabled),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,category' }
      );
      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('[PREFERENCES] set failed, using JSON fallback:', error.message);
    }
  }
  const store = loadJson(PREFERENCES_FILE, {});
  store[userId] = store[userId] || {};
  store[userId][category] = Boolean(enabled);
  saveJson(PREFERENCES_FILE, store);
  return { success: true };
}

/**
 * Is this category currently allowed for a user?
 * Security-critical categories are always allowed.
 */
async function isCategoryEnabledForUser(userId, category) {
  if (ALWAYS_ALLOWED.has(category)) return true;
  const prefs = await loadPreferences(userId);
  return prefs[category] !== false;
}

module.exports = {
  loadPreferences,
  setPreference,
  isCategoryEnabledForUser,
  ALWAYS_ALLOWED,
};
