/**
 * Dedicated Supabase ADMIN client for server-side writes.
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY (the service-role secret), which bypasses
 * RLS in Supabase. This client is NEVER used by the mobile app — only by the
 * backend server for trusted operations like push token registration.
 *
 * Accepts both modern `sb_secret_...` keys and legacy `service_role` JWTs.
 * Rejects `sb_publishable_...` and anon/public keys.
 *
 * Safe diagnostics only — never logs the credential.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const {
  isSupabaseServiceRoleKey,
  safeCredentialPrefix,
  describeSupabaseKeyType,
} = require('./supabase-credential');

function logSafeDiagnostic() {
  const urlSet = Boolean(SUPABASE_URL && SUPABASE_URL.startsWith('https://'));
  const keySet = isSupabaseServiceRoleKey(SUPABASE_SERVICE_ROLE_KEY);
  const keyType = describeSupabaseKeyType(SUPABASE_SERVICE_ROLE_KEY);
  const keyPrefix = safeCredentialPrefix(SUPABASE_SERVICE_ROLE_KEY);
  console.log(`[PUSH] Supabase URL configured: ${urlSet}`);
  console.log(`[PUSH] Supabase server credential configured: ${keySet}`);
  console.log(`[PUSH] Supabase client role: server/admin`);
  console.log(`[PUSH] Supabase credential type: ${keyType}`);
  console.log(`[PUSH] Supabase credential prefix (safe): ${keyPrefix}... (length ${SUPABASE_SERVICE_ROLE_KEY?.length || 0})`);
}

let supabaseAdmin = null;

if (SUPABASE_URL && isSupabaseServiceRoleKey(SUPABASE_SERVICE_ROLE_KEY)) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        // Ensure no user session can override the service credential.
        detectSessionInUrl: false,
      },
    });
    logSafeDiagnostic();
  } catch (error) {
    console.error('[SUPABASE-ADMIN] createClient failed:', error.message);
  }
} else {
  if (SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      `[SUPABASE-ADMIN] SUPABASE_SERVICE_ROLE_KEY rejected (${describeSupabaseKeyType(
        SUPABASE_SERVICE_ROLE_KEY
      )}) — expected sb_secret_... or a legacy service_role JWT`
    );
  } else {
    console.log('[SUPABASE-ADMIN] Not configured — admin client unavailable');
  }
}

module.exports = { supabaseAdmin, logSafeDiagnostic };
