const axios = require('axios');
const { getAdminToken } = require('./shopify-admin-auth');
const { moneyToCents } = require('./catalog-pricing');

// These transactions were taken outside Shopify. Shopify records the refund;
// the provider refund must already have completed before calling this function.
async function recordExternalRefund({ orderId, amount, currency, items, reference }) {
  const numericId = String(orderId || '').match(/(\d+)$/)?.[1];
  if (!numericId || !reference || !moneyToCents(Number(amount).toFixed(2))) throw Error('Invalid refund record');
  const api = axios.create({
    baseURL: `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04'}`,
    headers: { 'X-Shopify-Access-Token': await getAdminToken() }, timeout: 20000,
  });
  const marker = `NOOD external refund ${reference}`;
  const { data: existing } = await api.get(`/orders/${numericId}/refunds.json`);
  const prior = (existing.refunds || []).find(refund => refund.note === marker);
  if (prior) return { id: String(prior.id), replay: true };
  const { data } = await api.get(`/orders/${numericId}.json?fields=id,currency,line_items`);
  const order = data.order;
  if (order.currency !== currency) throw Error('Shopify refund currency mismatch');
  const lines = (items || []).map(item => {
    const id = String(item.variantId || item.id || '').match(/(\d+)$/)?.[1];
    const line = order.line_items.find(line => String(line.variant_id) === id || String(line.id) === id);
    const quantity = Number(item.quantity);
    if (!line || !Number.isInteger(quantity) || quantity < 1 || quantity > line.quantity) throw Error('Invalid Shopify refund item');
    return { line_item_id: line.id, quantity, restock_type: 'no_restock' };
  });
  if (!lines.length) throw Error('Refund items are required');
  const { data: calculation } = await api.post(`/orders/${numericId}/refunds/calculate.json`, {
    refund: { currency, refund_line_items: lines, shipping: { full_refund: false } },
  });
  const transactions = calculation.refund?.transactions || [];
  if (!transactions.length || transactions.reduce((sum, t) => sum + moneyToCents(Number(t.amount).toFixed(2)), 0) !== moneyToCents(Number(amount).toFixed(2))) {
    throw Error('Shopify refund quote does not match the approved refund');
  }
  const { data: paid } = await api.get(`/orders/${numericId}/transactions.json`);
  for (const transaction of transactions) {
    const parent = paid.transactions.find(t => String(t.id) === String(transaction.parent_id));
    if (!parent?.manual_payment_gateway || parent.status !== 'success') throw Error('External refund requires a manually recorded Shopify payment');
  }
  const { data: result } = await api.post(`/orders/${numericId}/refunds.json`, {
    refund: { currency, notify: false, note: marker, refund_line_items: lines,
      transactions: transactions.map(t => ({ parent_id: t.parent_id, amount: t.amount, kind: 'refund', gateway: t.gateway })) },
  });
  if (!result.refund?.id || !result.refund.transactions?.length || result.refund.transactions.some(t => t.status !== 'success')) {
    throw Error('Shopify has not confirmed the refund record');
  }
  return { id: String(result.refund.id), replay: false };
}
module.exports = { recordExternalRefund };
