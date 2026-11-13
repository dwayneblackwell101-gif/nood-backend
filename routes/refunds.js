/**
 * Refunds / Returns API — server-side refund request handling.
 *
 * Endpoints:
 *   POST   /api/refunds/requests           — create a refund/return request (customer)
 *   GET    /api/refunds/requests/:id/status — get request status (customer)
 *   GET    /api/refunds/requests           — list requests for customer (customer)
 *   POST   /api/refunds/requests/:id/update — update request status (admin/support)
 *
 * Identity: customer endpoints validate a Shopify Customer Account token.
 * Admin endpoints use x-admin-token.
 */

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../utils/supabase-admin');
const { requireAdmin } = require('../utils/admin-auth');
const { authenticateCustomer } = require('../services/customer-auth');
const { createInboxItem } = require('../utils/inbox-db');
const { sendPush } = require('../utils/push-delivery');
const { applyWalletTxn } = require('../utils/reward-ledger');
const paypal = require('../services/paypal');
const { refundSettlement } = require('../services/paypal-currency');
const { getPaymentByCapture } = require('../utils/payment-state');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

const RETURN_WINDOW_DAYS = 30;
const PAID_STATUSES = new Set(['paid', 'processing', 'completed', 'delivered', 'shipped']);
const BLOCKED_STATUSES = new Set(['cancelled', 'canceled', 'refunded', 'failed']);

const ALLOWED_REFUND_METHODS = new Set(['original_payment', 'wallet']);
const ALLOWED_STATUSES = new Set([
  'pending_review',
  'approved',
  'rejected',
  'refunded_to_wallet',
  'refunded_to_original',
  'partially_refunded',
  'manual_refund_required',
  'failed',
  'cancelled',
]);

const REFUND_TYPE_TO_CATEGORY = {
  'refund-started': 'returns',
  'refund-processing': 'returns',
  'refund-completed': 'returns',
  'refund-failed': 'returns',
  'return-requested': 'returns',
  'return-approved': 'returns',
  'return-rejected': 'returns',
};

/**
 * Resolve authenticated Shopify customer identity.
 */
async function resolveCustomerIdentity(req) {
  return authenticateCustomer(req);
}

/**
 * Verify order ownership and eligibility for refund.
 * Returns { order, eligible, reason }.
 */
async function verifyOrderForRefund(identity, orderId, itemIds = []) {
  if (!identity?.userId && !identity?.email) {
    return { eligible: false, reason: 'auth_required' };
  }

  if (!supabaseAdmin) {
    return { eligible: false, reason: 'db_unavailable' };
  }

  // Fetch order from our orders table (synced from Shopify).
  // Falls back to order_tracking (which fulfillment webhooks populate even
  // when the orders table has no row yet).
  let order = null;

  const { data: orderRow, error: orderError } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('shopify_order_id', orderId)
    .maybeSingle();

  if (orderError) {
    console.error('[REFUNDS] Order lookup error:', orderError.message);
    return { eligible: false, reason: 'db_error' };
  }

  if (orderRow) {
    order = orderRow;
  } else {
    const { data: trackingRow, error: trackingError } = await supabaseAdmin
      .from('order_tracking')
      .select('shopify_order_id, order_name, email, user_id, status, created_at, updated_at')
      .eq('shopify_order_id', orderId)
      .maybeSingle();

    if (trackingError) {
      console.error('[REFUNDS] Tracking lookup error:', trackingError.message);
      return { eligible: false, reason: 'db_error' };
    }

    if (!trackingRow) {
      return { eligible: false, reason: 'order_not_found' };
    }

    // Tracking rows are created from Shopify fulfillment webhooks, which
    // only fire for real (paid) orders — treat as eligible on payment.
    order = {
      shopify_order_id: trackingRow.shopify_order_id,
      email: trackingRow.email,
      user_id: trackingRow.user_id,
      status: trackingRow.status || 'paid',
      financial_status: null,
      total: null,
      created_at: trackingRow.created_at,
    };
  }

  // Ownership check: user_id match or email match
  const userIdMatch = identity.userId && order.user_id === identity.userId;
  const emailMatch = identity.email && order.email && String(order.email).toLowerCase() === String(identity.email).toLowerCase();

  if (!userIdMatch && !emailMatch) {
    return { eligible: false, reason: 'not_owner' };
  }

  // Eligibility: paid order within return window, not already refunded
  const status = String(order.status || '').toLowerCase();
  const financialStatus = String(order.financial_status || '').toUpperCase();

  if (financialStatus === 'REFUNDED' || status === 'refunded') {
    return { eligible: false, reason: 'already_refunded' };
  }

  if (financialStatus === 'PARTIALLY_REFUNDED' && itemIds.length === 0) {
    // Allow partial refund requests for remaining items
  }

  // Only block explicitly non-refundable statuses. The orders table's
  // status is often NULL until a fulfillment webhook arrives; tracking
  // rows only exist for real paid orders, so missing status is treated
  // as eligible (optimistic) rather than blocking legitimate refunds.
  if (BLOCKED_STATUSES.has(status) || (financialStatus && ['FAILED', 'CANCELLED', 'CANCELED'].includes(financialStatus))) {
    return { eligible: false, reason: 'not_paid' };
  }

  // Return window check
  const createdAt = new Date(order.created_at || 0).getTime();
  if (!createdAt || Date.now() - createdAt > RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return { eligible: false, reason: 'outside_window' };
  }

  // Check for existing open refund request for this order/items
  const { data: existingRequests } = await supabaseAdmin
    .from('refund_requests')
    .select('*')
    .eq('shopify_order_id', orderId)
    .in('status', ['pending_review', 'approved', 'manual_refund_required']);

  if (existingRequests && existingRequests.length > 0) {
    // If specific items requested, check overlap
    if (itemIds.length > 0) {
      const overlapping = existingRequests.some(req => {
        const reqItems = Array.isArray(req.items) ? req.items.map(i => String(i.id || i.variantId || i.title || '')) : [];
        return itemIds.some(id => reqItems.includes(String(id)));
      });
      if (overlapping) {
        return { eligible: false, reason: 'duplicate_request' };
      }
    } else {
      return { eligible: false, reason: 'duplicate_request' };
    }
  }

  return { order, eligible: true, reason: 'eligible' };
}

/** Recalculate a refund from the server-stored order snapshot. */
function calculateTrustedRefund(order, requestedItems) {
  const purchased = Array.isArray(order?.items) ? order.items : [];
  if (!purchased.length) return { ok: false, reason: 'order_items_unavailable' };

  const byId = new Map();
  for (const item of purchased) {
    const key = String(item.variantId || item.variant_id || item.id || '').trim();
    const quantity = Math.max(0, Math.floor(Number(item.quantity || 0)));
    const price = Number(item.price || item.unitPrice || item.unit_price || 0);
    if (key && quantity > 0 && Number.isFinite(price) && price >= 0) {
      byId.set(key, { item, quantity, price });
    }
  }

  let amount = 0;
  const normalized = [];
  const seen = new Set();
  for (const requested of requestedItems) {
    const key = String(requested.variantId || requested.id || '').trim();
    const match = byId.get(key);
    const quantity = Math.max(0, Math.floor(Number(requested.quantity || 0)));
    if (!match || !quantity || quantity > match.quantity || seen.has(key)) {
      return { ok: false, reason: 'invalid_refund_items' };
    }
    seen.add(key);
    amount += match.price * quantity;
    normalized.push({
      id: key,
      variantId: key,
      title: String(match.item.title || requested.title || 'Product'),
      quantity,
      unitPrice: Number(match.price.toFixed(2)),
    });
  }

  const orderTotalCents = Math.round(Number(order.total || 0) * 100);
  const amountCents = Math.round(amount * 100);
  if (!amountCents || !orderTotalCents || amountCents > orderTotalCents) {
    return { ok: false, reason: 'invalid_refund_amount' };
  }
  return {
    ok: true,
    amount: amountCents / 100,
    currency: String(order.currency || 'USD').toUpperCase(),
    items: normalized,
  };
}

/**
 * POST /api/refunds/requests
 * Body: {
 *   order_id, order_number, customer_email,
 *   amount, currency, refund_method,
 *   payment_provider, payment_method, payment_transaction_id,
 *   shopify_order_id, reason, notes, items
 * }
 */
router.post('/api/refunds/requests', async (req, res) => {
  const identity = await resolveCustomerIdentity(req);
  if (!identity) {
    return res.status(401).json({ success: false, message: 'Authenticated identity required' });
  }

  const body = req.body || {};

  // Required fields
  const orderId = safeString(body.order_id);
  const orderNumber = safeString(body.order_number || body.order_id);
  const customerEmail = safeString(body.customer_email || identity.email).toLowerCase();
  let amount = 0;
  let currency = 'USD';
  const refundMethod = safeString(body.refund_method);
  let paymentProvider = '';
  let paymentMethod = '';
  let paymentTransactionId = null;
  const shopifyOrderId = safeString(body.shopify_order_id || body.order_id);
  const reason = safeString(body.reason);
  const notes = safeString(body.notes);
  const items = Array.isArray(body.items) ? body.items : [];

  if (!orderId || !orderNumber || !customerEmail) {
    return res.status(400).json({ success: false, message: 'order_id, order_number, customer_email are required' });
  }
  if (!ALLOWED_REFUND_METHODS.has(refundMethod)) {
    return res.status(400).json({ success: false, message: 'refund_method must be original_payment or wallet' });
  }
  if (!reason) {
    return res.status(400).json({ success: false, message: 'reason is required' });
  }
  if (!items.length) {
    return res.status(400).json({ success: false, message: 'At least one item is required' });
  }

  // Verify order ownership + eligibility
  const itemIds = items.map(i => String(i.id || i.variantId || i.title || ''));
  const verification = await verifyOrderForRefund(identity, shopifyOrderId, itemIds);
  if (!verification.eligible) {
    const messages = {
      auth_required: 'Authenticated identity required',
      db_unavailable: 'Database unavailable',
      db_error: 'Order lookup failed',
      order_not_found: 'Order not found',
      not_owner: 'You do not own this order',
      already_refunded: 'Order already fully refunded',
      not_paid: 'Order is not paid',
      outside_window: `Return window expired (${RETURN_WINDOW_DAYS} days)`,
      duplicate_request: 'You already have a pending request for this order/items',
    };
    const statusCode = verification.reason === 'not_owner' ? 403 : 400;
    return res.status(statusCode).json({ success: false, message: messages[verification.reason] || 'Not eligible' });
  }

  const trustedRefund = calculateTrustedRefund(verification.order, items);
  if (!trustedRefund.ok) {
    const messages = {
      order_items_unavailable: 'Order item details are not available yet. Please retry after order sync completes.',
      invalid_refund_items: 'One or more selected items do not match the purchased order.',
      invalid_refund_amount: 'The refundable amount could not be verified.',
    };
    return res.status(409).json({
      success: false,
      message: messages[trustedRefund.reason] || 'Refund could not be verified',
    });
  }
  amount = trustedRefund.amount;
  currency = trustedRefund.currency;
  paymentProvider = safeString(verification.order.payment_provider).toLowerCase();
  paymentMethod = paymentProvider;
  paymentTransactionId = safeString(verification.order.payment_transaction_id) || null;

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, message: 'Database not configured' });
  }

  try {
    // Generate deterministic request_id (like frontend)
    const requestId = `req_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    const insertData = {
      request_id: requestId,
      order_id: orderId,
      order_number: orderNumber,
      customer_email: customerEmail,
      user_id: identity.userId || null,
      amount,
      currency,
      refund_method: refundMethod,
      payment_provider: paymentProvider || null,
      payment_method: paymentMethod || null,
      payment_transaction_id: paymentTransactionId,
      shopify_order_id: shopifyOrderId,
      reason,
      notes,
      items: trustedRefund.items,
      status: 'pending_review',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from('refund_requests')
      .insert(insertData)
      .select('request_id')
      .maybeSingle();

    if (error) {
      // Unique violation on request_id (extremely unlikely) or other constraint
      if (String(error.message).includes('duplicate key')) {
        return res.status(409).json({ success: false, message: 'Request already exists' });
      }
      console.error('[REFUNDS] Insert failed:', error.message);
      return res.status(500).json({ success: false, message: 'Failed to create refund request' });
    }

    // Create inbox notification for customer
    const inboxCampaignId = `noo_return_${shopifyOrderId}_${requestId}`;
    await createInboxItem({
      campaignId: inboxCampaignId,
      type: 'return-requested',
      title: '📋 Return Requested',
      body: `Your return request for order ${orderNumber} is pending review.`,
      data: { type: 'return-requested', route: '/account/returns', orderId: shopifyOrderId, requestId },
      route: '/account/returns',
      orderId: shopifyOrderId,
      userId: identity.userId || null,
    });

    // Send push notification (transactional, no frequency cap)
    const { loadTokens } = require('../utils/push-tokens-db');
    const registeredTokens = await loadTokens();
    const customerTokens = Object.values(registeredTokens).filter(
      (token) => token.userId === identity.userId && token.active !== false
    );
    if (customerTokens.length) {
      await sendPush({
        recipients: customerTokens,
        title: '📋 Return Requested',
        body: `Your return request for order ${orderNumber} is pending review.`,
        data: { type: 'return-requested', route: '/account/returns', orderId: shopifyOrderId, requestId },
        campaignId: inboxCampaignId,
        campaignType: 'return-requested',
        frequency: { check: false },
        saveInbox: false, // already created
      });
    }

    console.log('[REFUNDS] Request created', { requestId, orderId: shopifyOrderId, userId: identity.userId });
    return res.json({ success: true, request_id: requestId, message: 'Refund request submitted for review' });

  } catch (error) {
    console.error('[REFUNDS] Create request error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error creating request' });
  }
});

/**
 * GET /api/refunds/requests/:id/status
 */
router.get('/api/refunds/requests/:id/status', async (req, res) => {
  const identity = await resolveCustomerIdentity(req);
  if (!identity) {
    return res.status(401).json({ success: false, message: 'Authenticated identity required' });
  }

  const requestId = safeString(req.params.id);
  if (!requestId) {
    return res.status(400).json({ success: false, message: 'request id required' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, message: 'Database not configured' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('refund_requests')
      .select('*')
      .eq('request_id', requestId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    // Ownership check
    if (identity.userId && data.user_id !== identity.userId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    if (!identity.userId && data.customer_email !== identity.email) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    return res.json({ success: true, request: data });
  } catch (error) {
    console.error('[REFUNDS] Status lookup error:', error.message);
    return res.status(500).json({ success: false, message: 'Lookup failed' });
  }
});

/**
 * GET /api/refunds/requests?customerEmail=...
 * List all requests for a customer (by email from token)
 */
router.get('/api/refunds/requests', async (req, res) => {
  const identity = await resolveCustomerIdentity(req);
  if (!identity) {
    return res.status(401).json({ success: false, message: 'Authenticated identity required' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, message: 'Database not configured' });
  }

  try {
    let query = supabaseAdmin.from('refund_requests').select('*').order('created_at', { ascending: false });

    if (identity.userId) {
      query = query.eq('user_id', identity.userId);
    } else if (identity.email) {
      query = query.eq('customer_email', identity.email);
    } else {
      return res.status(400).json({ success: false, message: 'No customer identity' });
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ success: true, requests: data || [] });
  } catch (error) {
    console.error('[REFUNDS] List error:', error.message);
    return res.status(500).json({ success: false, message: 'List failed' });
  }
});

/**
 * POST /api/refunds/requests/:id/update (ADMIN/SUPPORT)
 * Body: { status, admin_notes, refund_destination_label }
 * Valid statuses: pending_review, approved, rejected, refunded_to_wallet, refunded_to_original, partially_refunded, manual_refund_required, failed, cancelled
 */
router.post('/api/refunds/requests/:id/update', requireAdmin, async (req, res) => {
  const requestId = safeString(req.params.id);
  const newStatus = safeString(req.body.status);
  const adminNotes = safeString(req.body.admin_notes);
  const refundDestinationLabel = safeString(req.body.refund_destination_label);

  if (!requestId) {
    return res.status(400).json({ success: false, message: 'request id required' });
  }
  if (!ALLOWED_STATUSES.has(newStatus)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ success: false, message: 'Database not configured' });
  }

  try {
    // Fetch current request
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('refund_requests')
      .select('*')
      .eq('request_id', requestId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    const completedStatuses = new Set(['refunded_to_wallet', 'refunded_to_original', 'partially_refunded']);
    if (completedStatuses.has(existing.status)) {
      if (newStatus === existing.status) {
        return res.json({ success: true, requestId, status: existing.status, replay: true });
      }
      return res.status(409).json({ success: false, message: 'A completed refund cannot be changed' });
    }

    if (newStatus === 'refunded_to_wallet') {
      if (existing.refund_method !== 'wallet' || !existing.user_id) {
        return res.status(409).json({ success: false, message: 'This request is not eligible for a wallet refund' });
      }
      const credit = await applyWalletTxn({
        user_id: existing.user_id,
        amount: Number(existing.amount),
        currency: existing.currency,
        type: 'credit',
        source: 'refund',
        reference: requestId,
        idempotency_key: `refund-wallet:${requestId}`,
        metadata: { refundRequestId: requestId, orderId: existing.shopify_order_id },
      });
      if (!credit.ok && !credit.replay) {
        return res.status(500).json({ success: false, message: 'Wallet refund transaction failed' });
      }
    }

    if (newStatus === 'refunded_to_original' || newStatus === 'partially_refunded') {
      if (existing.refund_method !== 'original_payment') {
        return res.status(409).json({ success: false, message: 'This request selected a wallet refund' });
      }
      if (!String(existing.payment_provider || '').includes('paypal') || !existing.payment_transaction_id) {
        return res.status(409).json({
          success: false,
          message: 'Automatic original-payment refund is unavailable for this provider; use manual_refund_required.',
        });
      }
      const paymentSession = await getPaymentByCapture(existing.payment_transaction_id);
      const refundQuote = refundSettlement(existing.amount, existing.currency, paymentSession);
      const providerRefund = await paypal.refundCapture(existing.payment_transaction_id, {
        ...refundQuote,
        requestId: `nood-refund-${requestId}`,
      });
      if (String(providerRefund?.status || '').toUpperCase() !== 'COMPLETED') {
        return res.status(502).json({ success: false, message: 'PayPal has not confirmed the refund as completed' });
      }
    }

    const updateData = {
      status: newStatus,
      admin_notes: adminNotes || existing.admin_notes,
      refund_destination_label: refundDestinationLabel || existing.refund_destination_label,
      updated_at: new Date().toISOString(),
    };

    // If status is a completion state, record completion timestamp
    if (['refunded_to_wallet', 'refunded_to_original', 'partially_refunded'].includes(newStatus)) {
      updateData.completed_at = new Date().toISOString();
    }

    const { error } = await supabaseAdmin
      .from('refund_requests')
      .update(updateData)
      .eq('request_id', requestId);

    if (error) throw error;

    // Notify customer via inbox + push
    const userId = existing.user_id;
    const customerEmail = existing.customer_email;
    const orderId = existing.shopify_order_id;
    const orderNumber = existing.order_number;

    const statusMessages = {
      approved: 'approved — we\'ll process your refund shortly',
      rejected: 'rejected — see admin notes for details',
      refunded_to_wallet: 'completed — refunded to your NOOD Wallet',
      refunded_to_original: 'completed — refunded to your original payment method',
      partially_refunded: 'completed — partially refunded',
      manual_refund_required: 'requires manual review',
      failed: 'failed — please contact support',
      cancelled: 'cancelled',
    };

    const message = statusMessages[newStatus] || `updated to ${newStatus}`;
    const inboxCampaignId = `noo_return_update_${requestId}_${newStatus}_${Date.now()}`;

    await createInboxItem({
      campaignId: inboxCampaignId,
      type: `refund-${newStatus.replace('_', '-')}`,
      title: `💰 Refund Request ${newStatus === 'approved' ? 'Approved' : newStatus === 'rejected' ? 'Rejected' : 'Updated'}`,
      body: `Your return request for order ${orderNumber} was ${message}.`,
      data: { type: `refund-${newStatus}`, route: '/account/returns', orderId, requestId, status: newStatus },
      route: '/account/returns',
      orderId,
      userId: userId || null,
    });

    if (userId) {
      const { loadTokens } = require('../utils/push-tokens-db');
      const tokens = await loadTokens();
      const userTokens = Object.values(tokens).filter(t => t.userId === userId && t.active !== false);
      if (userTokens.length) {
        await sendPush({
          recipients: userTokens,
          title: `💰 Refund Request ${newStatus === 'approved' ? 'Approved' : newStatus === 'rejected' ? 'Rejected' : 'Updated'}`,
          body: `Your return request for order ${orderNumber} was ${message}.`,
          data: { type: `refund-${newStatus}`, route: '/account/returns', orderId, requestId, status: newStatus },
          campaignId: inboxCampaignId,
          campaignType: `refund-${newStatus}`,
          frequency: { check: false },
          saveInbox: false,
        });
      }
    }

    console.log('[REFUNDS] Admin updated request', { requestId, newStatus, admin: true });
    return res.json({ success: true, requestId, status: newStatus });

  } catch (error) {
    console.error('[REFUNDS] Admin update error:', error.message);
    return res.status(500).json({ success: false, message: 'Update failed' });
  }
});

module.exports = { router, calculateTrustedRefund };
