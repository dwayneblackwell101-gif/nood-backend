/**
 * Supabase client for backend services.
 * Used by jobs and webhooks for database operations.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { isSupabaseServiceRoleKey } = require('./supabase-credential');

let supabase = null;

if (SUPABASE_URL && isSupabaseServiceRoleKey(SUPABASE_SERVICE_KEY)) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch (error) {
    console.warn('[SUPABASE] @supabase/supabase-js not installed — database features disabled');
  }
} else {
  console.warn('[SUPABASE] Not configured — database features will not work');
}

module.exports = { supabase };
