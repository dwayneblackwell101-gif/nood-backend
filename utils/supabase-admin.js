/**
 * Dedicated Supabase ADMIN client for server-side writes.
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY (the service-role secret), which bypasses
 * RLS in Supabase. This client is NEVER used by the mobile app — only by the
 * backend server for trusted operations like push token registration.
 *
 * Safe diagnostics only — never logs the credential.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function logSafeDiagnostic() {
  const urlSet = Boolean(SUPABASE_URL && SUPABASE_URL.startsWith('https://'));
  const keySet = Boolean(SUPABASE_SERVICE_ROLE_KEY && SUPABASE_SERVICE_ROLE_KEY.length > 50);
  const keyPrefix = SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.slice(0, 4) : '(missing)';
  console.log(`[PUSH] Supabase URL configured: ${urlSet}`);
  console.log(`[PUSH] Supabase server credential configured: ${keySet}`);
  console.log(`[PUSH] Supabase client role: server/admin`);
  console.log(`[PUSH] Supabase credential prefix (safe): ${keyPrefix}... (length ${SUPABASE_SERVICE_ROLE_KEY?.length || 0})`);
}

let supabaseAdmin = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
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
  console.log('[SUPABASE-ADMIN] Not configured — admin client unavailable');
}

module.exports = { supabaseAdmin, logSafeDiagnostic };
