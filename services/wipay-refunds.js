const { supabaseAdmin: db } = require('../utils/supabase-admin');
const { getPaymentByCapture } = require('../utils/payment-state');
const { moneyToCents } = require('./catalog-pricing');
const api = require('./wipay-refund-api');
const { recordExternalRefund } = require('./shopify-refunds');

function conflict(message) { return Object.assign(Error(message), { statusCode: 409 }); }
function checked(result) { if (result.error) throw result.error; return result.data; }
async function receipt(transaction) {
  return checked(await db.from('wipay_refunds').select('*').eq('transaction_id', transaction).maybeSingle());
}
function validateFullRefund(refund, payment) {
  const orderId = value => String(value || '').match(/(\d+)$/)?.[1];
  if (!payment || !['wipay', 'wipay_test'].includes(payment.provider) || payment.status !== 'completed' ||
      payment.capture_id !== refund.payment_transaction_id || !orderId(payment.shopify_order?.id) ||
      orderId(payment.shopify_order?.id) !== orderId(refund.shopify_order_id) ||
      refund.refund_method !== 'original_payment' || refund.currency !== payment.currency ||
      !moneyToCents(refund.amount) || moneyToCents(refund.amount) !== moneyToCents(payment.amount)) {
    throw conflict('WiPay supports full original-payment refunds only; the completed payment and order must match.');
  }
  const quantities = items => new Map((items || []).map(i => [String(i.variantId || i.variant_id || i.id).split('/').pop(), Number(i.quantity)]));
  const purchased = quantities(payment.cart), selected = quantities(refund.items);
  if (!purchased.size || purchased.size !== selected.size || selected.size !== refund.items?.length ||
      [...purchased].some(([id, qty]) => !Number.isInteger(qty) || qty < 1 || selected.get(id) !== qty)) {
    throw conflict('Select every purchased item for a full WiPay refund. Partial refunds require manual review.');
  }
}
async function saveProviderStatus(refund, status) {
  checked(await db.from('refund_requests').update({ provider_refund_id: `wipay:${refund.payment_transaction_id}`,
    provider_refund_status: status, updated_at: new Date().toISOString(),
  }).eq('request_id', refund.request_id));
}
async function finish(refund, entry) {
  if (['refunded_to_original', 'partially_refunded'].includes(refund.status)) return { status: refund.status, replay: true };
  if (entry.state === 'SYNCING' && Date.parse(entry.sync_started_at) < Date.now() - 10 * 60_000) {
    checked(await db.from('wipay_refunds').update({ state: 'REFUNDED' }).eq('transaction_id', entry.transaction_id)
      .eq('state', 'SYNCING').lt('sync_started_at', new Date(Date.now() - 10 * 60_000).toISOString()));
  }
  const claimed = checked(await db.from('wipay_refunds').update({ state: 'SYNCING', sync_started_at: new Date().toISOString() })
    .eq('transaction_id', entry.transaction_id).eq('state', 'REFUNDED').select('transaction_id'));
  if (!claimed?.length) return { status: 'approved', processing: true };
  try {
    const recorded = await recordExternalRefund({ orderId: refund.shopify_order_id, amount: refund.amount,
      currency: refund.currency, items: refund.items, reference: `wipay:${entry.transaction_id}` });
    checked(await db.from('orders').update({ status: 'refunded', updated_at: new Date().toISOString() })
      .eq('shopify_order_id', refund.shopify_order_id));
    checked(await db.from('refund_requests').update({ status: 'refunded_to_original',
      provider_refund_id: `wipay:${entry.transaction_id}`, provider_refund_status: 'REFUNDED',
      shopify_refund_id: recorded.id, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('request_id', refund.request_id));
    checked(await db.from('wipay_refunds').update({ state: 'COMPLETED', updated_at: new Date().toISOString() })
      .eq('transaction_id', entry.transaction_id));
    return { status: 'refunded_to_original', processing: false };
  } catch (error) {
    await db.from('wipay_refunds').update({ state: 'REFUNDED' }).eq('transaction_id', entry.transaction_id).eq('state', 'SYNCING');
    throw error;
  }
}
async function requestRefund(refund) {
  if (!db) throw Object.assign(Error('Refund database unavailable'), { statusCode: 503 });
  const payment = await getPaymentByCapture(refund.payment_transaction_id);
  validateFullRefund(refund, payment);
  const environment = payment.provider === 'wipay_test' ? 'sandbox' : 'live';
  let entry = await receipt(refund.payment_transaction_id);
  if (entry) {
    if (entry.request_id !== refund.request_id || entry.environment !== environment) throw conflict('This WiPay payment already has a refund request.');
    if (['REFUNDED', 'SYNCING', 'COMPLETED'].includes(entry.state)) return finish(refund, entry);
    // Never automatically POST again after a timeout, crash, or rejection.
    return { status: entry.state === 'REJECTED' ? 'manual_refund_required' : 'approved', processing: true, replay: true };
  }
  if (!process.env[environment === 'sandbox' ? 'WIPAY_SANDBOX_WEBHOOK_SECRET' : 'WIPAY_WEBHOOK_SECRET']) {
    throw Object.assign(Error('WiPay refund confirmation is not configured'), { statusCode: 503 });
  }
  const snapshot = await api.retrieve(refund.payment_transaction_id, environment);
  if (snapshot.order_id !== payment.provider_order_id || snapshot.currency !== payment.currency ||
      snapshot.status !== 'success' || snapshot.status_desc !== 'Normal') throw conflict('WiPay payment is not eligible for a new refund request.');
  const inserted = await db.from('wipay_refunds').insert({ transaction_id: refund.payment_transaction_id,
    request_id: refund.request_id, environment, state: 'SUBMITTING' });
  if (inserted.error?.code === '23505') return requestRefund(refund);
  checked(inserted);
  await saveProviderStatus(refund, 'SUBMITTING');
  let state;
  try { await api.request(refund.payment_transaction_id, environment); state = 'REQUESTED'; }
  catch (error) {
    state = [400, 401, 403, 404, 422].includes(error.response?.status) ? 'REJECTED' : 'UNKNOWN';
    console.warn('[WiPay refund] request outcome:', state); // Never log Axios credentials.
  }
  // A completion webhook may have arrived while POST was in flight.
  const changed = checked(await db.from('wipay_refunds').update({ state, updated_at: new Date().toISOString() })
    .eq('transaction_id', refund.payment_transaction_id).eq('state', 'SUBMITTING').select('transaction_id'));
  if (changed?.length) await saveProviderStatus(refund, state);
  entry = await receipt(refund.payment_transaction_id);
  if (['REFUNDED', 'SYNCING', 'COMPLETED'].includes(entry.state)) return finish(refund, entry);
  return { status: entry.state === 'REJECTED' ? 'manual_refund_required' : 'approved', processing: true };
}
async function acceptRefundEvent(event, environment) {
  const transaction = event.data?.transaction_id;
  const entry = transaction ? await receipt(transaction) : null;
  // Refunds outside the app are retained in the event ledger for reconciliation,
  // but cannot complete an unrelated app request.
  if (!entry || entry.environment !== environment) return;
  const refund = checked(await db.from('refund_requests').select('*').eq('request_id', entry.request_id).maybeSingle());
  if (!refund) throw Error('WiPay refund request missing');
  const payment = await getPaymentByCapture(transaction);
  validateFullRefund(refund, payment);
  if (event.data.order_id !== payment.provider_order_id || event.data.currency !== payment.currency) throw Error('WiPay refund event does not match payment');
  if (['REFUNDED', 'SYNCING', 'COMPLETED'].includes(entry.state)) return finish(refund, entry);
  const state = event.event === 'payment.refunded' ? 'REFUNDED' : event.event === 'payment.refund_rejected' ? 'REJECTED' : null;
  if (!state) return; // A requested event never downgrades a terminal state.
  const changed = checked(await db.from('wipay_refunds').update({ state, updated_at: new Date().toISOString() })
    .eq('transaction_id', transaction).in('state', state === 'REFUNDED' ?
      ['SUBMITTING', 'REQUESTED', 'UNKNOWN', 'REJECTED'] : ['SUBMITTING', 'REQUESTED', 'UNKNOWN']).select('transaction_id'));
  if (!changed?.length) return;
  await saveProviderStatus(refund, state);
  if (state === 'REFUNDED') return finish(refund, { ...entry, state });
  checked(await db.from('refund_requests').update({ status: 'manual_refund_required', updated_at: new Date().toISOString() })
    .eq('request_id', refund.request_id));
}
module.exports = { requestRefund, acceptRefundEvent, validateFullRefund };
