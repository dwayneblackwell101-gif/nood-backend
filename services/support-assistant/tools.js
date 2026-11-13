const crypto = require('crypto');
const { getWalletBalance, listWalletTxns } = require('../../utils/reward-ledger');

const ORDER_FIELDS = 'shopify_order_id, name, total, currency, status, fulfillment_status, tracking_number, tracking_url, tracking_company, created_at, updated_at';
const REFUND_FIELDS = 'request_id, order_id, order_number, amount, currency, refund_method, status, refund_destination_label, created_at, updated_at';
const CASE_FIELDS = 'id, ticket_id, category, subject, order_id, priority, status, created_at, updated_at';
const OPEN_CASE_STATUSES = ['open', 'customer_reply', 'agent_reply', 'waiting', 'escalated'];

function clean(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function createCustomerSupportTools({ supabase, customer, wallet = {} }) {
  if (customer?.developmentTestSession === true) {
    return { listRecentOrders: async () => [], getOwnedOrder: async () => null, getOwnedTracking: async () => null, listRefundRequests: async () => [], getWalletSummary: async () => ({ currency: 'TTD', balance: 0, recentTransactions: [] }), createHumanHandoff: async () => { const error = new Error('Human handoff is disabled in development test mode.'); error.code = 'provider_unavailable'; throw error; } };
  }
  if (!supabase) throw new Error('Support assistant data service is not configured.');
  if (!customer?.userId) throw new Error('Authenticated customer identity is required.');
  const userId = customer.userId;

  async function listRecentOrders(limit = 5) {
    const { data, error } = await supabase.from('orders').select(ORDER_FIELDS)
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 10));
    if (error) throw error;
    return data || [];
  }

  async function getOwnedOrder(orderId) {
    const id = clean(orderId, 120);
    if (!id) return null;
    const { data, error } = await supabase.from('orders').select(ORDER_FIELDS)
      .eq('user_id', userId).eq('shopify_order_id', id).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function getOwnedTracking(orderId) {
    const id = clean(orderId, 120);
    if (!id) return null;
    const { data, error } = await supabase.from('order_tracking').select(
      'shopify_order_id, order_name, carrier, tracking_number, tracking_url, status, friendly_status, latest_event_title, latest_event_description, latest_event_location, latest_event_at, estimated_delivery, updated_at'
    ).eq('user_id', userId).eq('shopify_order_id', id).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function listRefundRequests(limit = 10) {
    const { data, error } = await supabase.from('refund_requests').select(REFUND_FIELDS)
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 20));
    if (error) throw error;
    return data || [];
  }

  async function getWalletSummary() {
    const balanceFn = wallet.getWalletBalance || getWalletBalance;
    const listFn = wallet.listWalletTxns || listWalletTxns;
    const [balance, transactions] = await Promise.all([balanceFn(userId), listFn(userId)]);
    return {
      balance: Number(balance || 0),
      currency: String(transactions?.[0]?.currency || 'USD'),
      recentTransactions: (transactions || []).slice(0, 5).map((item) => ({
        type: item.type,
        source: item.source,
        amount: Number(item.amount || 0),
        createdAt: item.created_at,
      })),
    };
  }

  async function listSupportCases(limit = 20) {
    const { data, error } = await supabase.from('support_cases').select(CASE_FIELDS)
      .eq('user_id', userId).order('updated_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 50));
    if (error) throw error;
    return data || [];
  }

  async function getOwnedSupportCase(ticketId) {
    const ticket = clean(ticketId, 80);
    if (!ticket) return null;
    const { data, error } = await supabase.from('support_cases')
      .select(`${CASE_FIELDS}, support_messages(id, sender_role, body, created_at)`)
      .eq('user_id', userId).eq('ticket_id', ticket).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function createHumanHandoff({ category, subject, message, orderId, conversationId, store }) {
    const safeCategory = ['order', 'delivery', 'return', 'payment', 'product', 'account', 'rewards', 'other'].includes(category)
      ? category : 'other';
    const safeOrderId = clean(orderId, 120) || null;
    if (safeOrderId && !(await getOwnedOrder(safeOrderId))) {
      const error = new Error('That order is not available for this account.');
      error.code = 'forbidden_order';
      throw error;
    }

    const conversation = conversationId ? await store.getOwned(conversationId, userId) : null;
    if (conversation?.linked_case_id) {
      const { data: linked } = await supabase.from('support_cases').select(CASE_FIELDS)
        .eq('id', conversation.linked_case_id).eq('user_id', userId).maybeSingle();
      if (linked) return { supportCase: linked, reused: true };
    }

    let existingQuery = supabase.from('support_cases').select(CASE_FIELDS)
      .eq('user_id', userId).eq('category', safeCategory).in('status', OPEN_CASE_STATUSES);
    if (safeOrderId) existingQuery = existingQuery.eq('order_id', safeOrderId);
    existingQuery = existingQuery.order('updated_at', { ascending: false }).limit(1);
    const { data: existingRows, error: existingError } = await existingQuery;
    if (existingError) throw existingError;

    const transcript = conversation ? await store.listMessages(conversation.id) : [];
    const summary = transcript.slice(-12).map((item) => {
      const who = item.sender_role === 'customer' ? 'Customer' : 'Khiel';
      return `${who}: ${clean(item.body, 500)}`;
    }).join('\n');
    const handoffBody = clean([
      clean(message, 1200),
      summary ? `\nAssistant conversation:\n${summary}` : '',
    ].join(''), 4000);

    let supportCase = existingRows?.[0] || null;
    let reused = Boolean(supportCase);
    if (supportCase) {
      const { error } = await supabase.from('support_messages').insert({
        case_id: supportCase.id,
        sender_user_id: userId,
        sender_role: 'customer',
        body: handoffBody,
      });
      if (error) throw error;
      await supabase.from('support_cases').update({
        status: 'customer_reply', updated_at: new Date().toISOString(),
      }).eq('id', supportCase.id).eq('user_id', userId);
    } else {
      const ticketId = `NOOD-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const slaHours = safeCategory === 'payment' ? 4 : 24;
      const { data, error } = await supabase.from('support_cases').insert({
        ticket_id: ticketId,
        user_id: userId,
        customer_email: customer.email || null,
        category: safeCategory,
        subject: clean(subject, 120) || 'Khiel handoff',
        order_id: safeOrderId,
        priority: safeCategory === 'payment' ? 'high' : 'normal',
        status: 'open',
        sla_due_at: new Date(Date.now() + slaHours * 3600000).toISOString(),
      }).select().single();
      if (error || !data) throw error || new Error('Support case could not be created.');
      supportCase = data;
      const { error: messageError } = await supabase.from('support_messages').insert({
        case_id: supportCase.id,
        sender_user_id: userId,
        sender_role: 'customer',
        body: handoffBody,
      });
      if (messageError) throw messageError;
      reused = false;
    }

    if (conversationId) await store.linkCase(conversationId, userId, supportCase.id);
    return { supportCase, reused };
  }

  return {
    userId,
    listRecentOrders,
    getOwnedOrder,
    getOwnedTracking,
    listRefundRequests,
    getWalletSummary,
    listSupportCases,
    getOwnedSupportCase,
    createHumanHandoff,
  };
}

module.exports = { createCustomerSupportTools, OPEN_CASE_STATUSES };
