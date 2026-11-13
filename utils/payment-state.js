const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('./supabase-admin');

const fallbackFile = () => process.env.PAYMENT_STATE_FILE || path.join(__dirname, '..', 'payment-state.json');

function loadFallback() {
  try { return JSON.parse(fs.readFileSync(fallbackFile(), 'utf8')) || {}; } catch { return {}; }
}
function saveFallback(state) {
  fs.writeFileSync(fallbackFile(), JSON.stringify(state, null, 2));
}

async function savePayment(payment) {
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from('payment_sessions').upsert(payment, { onConflict: 'provider_order_id' });
    if (error) throw error;
    return;
  }
  const state = loadFallback();
  state[payment.provider_order_id] = payment;
  saveFallback(state);
}

async function getPayment(providerOrderId) {
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.from('payment_sessions').select('*').eq('provider_order_id', providerOrderId).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  return loadFallback()[providerOrderId] || null;
}

module.exports = { savePayment, getPayment };

// Claim fulfillment once across backend workers before any external side effect.
async function claimPayment(providerOrderId, captureId) {
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.from('payment_sessions')
      .update({ status: 'captured', capture_id: captureId, updated_at: new Date().toISOString() })
      .eq('provider_order_id', providerOrderId).eq('status', 'created').select('provider_order_id');
    if (error) throw error;
    return Boolean(data?.length);
  }
  const state = loadFallback();
  const session = state[providerOrderId];
  if (!session || session.status !== 'created') return false;
  state[providerOrderId] = { ...session, status: 'captured', capture_id: captureId };
  saveFallback(state);
  return true;
}
module.exports.claimPayment = claimPayment;

async function getPaymentByCapture(captureId) {
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.from('payment_sessions').select('*').eq('capture_id', captureId).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  return Object.values(loadFallback()).find(payment => payment.capture_id === captureId) || null;
}
module.exports.getPaymentByCapture = getPaymentByCapture;
