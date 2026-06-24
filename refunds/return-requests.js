const VALID_STATUSES = new Set([
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

const VALID_ACTIONS = new Set([
  'approve',
  'reject',
  'refund_to_wallet',
  'mark_manual_refund_required',
  'mark_refunded',
]);

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeStatus(value) {
  const status = safeString(value, 'pending_review').toLowerCase();
  return VALID_STATUSES.has(status) ? status : 'pending_review';
}

function normalizeRefundMethod(value) {
  const normalized = safeString(value).toLowerCase();
  if (normalized === 'wallet' || normalized === 'nood_wallet') {
    return 'wallet';
  }
  return 'original_payment';
}

function getRefundDestinationLabel(refundMethod) {
  return normalizeRefundMethod(refundMethod) === 'wallet'
    ? 'NOOD Wallet'
    : 'Original payment method';
}

function normalizeRequest(raw = {}) {
  const now = new Date().toISOString();
  const requestId = safeString(raw.request_id || raw.requestId || raw.id);

  return {
    request_id: requestId,
    order_id: safeString(raw.order_id || raw.orderId),
    order_number: safeString(raw.order_number || raw.orderNumber || raw.order_id || raw.orderId),
    customer_email: safeString(raw.customer_email || raw.customerEmail).toLowerCase(),
    amount: Number(raw.amount || 0),
    currency: safeString(raw.currency, 'TTD').toUpperCase(),
    refund_method: normalizeRefundMethod(raw.refund_method || raw.refundMethod),
    payment_provider: safeString(raw.payment_provider || raw.paymentProvider),
    payment_method: safeString(raw.payment_method || raw.paymentMethod),
    payment_transaction_id: safeString(raw.payment_transaction_id || raw.paymentTransactionId) || null,
    shopify_order_id: safeString(raw.shopify_order_id || raw.shopifyOrderId) || null,
    reason: safeString(raw.reason),
    notes: safeString(raw.notes),
    items: Array.isArray(raw.items) ? raw.items : [],
    status: normalizeStatus(raw.status),
    created_at: safeString(raw.created_at || raw.createdAt, now),
    updated_at: safeString(raw.updated_at || raw.updatedAt, now),
    admin_note: safeString(raw.admin_note || raw.adminNote) || '',
    shopify_order_gid: safeString(raw.shopify_order_gid || raw.shopifyOrderGid) || null,
    shopify_synced_at: safeString(raw.shopify_synced_at || raw.shopifySyncedAt) || null,
    refund_destination_label:
      safeString(raw.refund_destination_label || raw.refundDestinationLabel) ||
      getRefundDestinationLabel(raw.refund_method || raw.refundMethod),
    wallet_credited: Boolean(raw.wallet_credited || raw.walletCredited),
    wallet_transaction_id:
      safeString(raw.wallet_transaction_id || raw.walletTransactionId) || null,
  };
}

function resolveStatusFromAction(action, record) {
  const normalizedAction = safeString(action).toLowerCase();

  switch (normalizedAction) {
    case 'approve':
      return record.refund_method === 'wallet' ? 'refunded_to_wallet' : 'manual_refund_required';
    case 'reject':
      return 'rejected';
    case 'refund_to_wallet':
      return 'refunded_to_wallet';
    case 'mark_manual_refund_required':
      return 'manual_refund_required';
    case 'mark_refunded':
      return 'refunded_to_original';
    default:
      return '';
  }
}

async function applyPostApprovalEffects(record, walletRefundService) {
  let nextRecord = normalizeRequest(record);

  if (nextRecord.refund_method === 'wallet' && nextRecord.status === 'refunded_to_wallet') {
    if (!walletRefundService?.creditWalletRefund) {
      throw new Error('Wallet refund service is not configured.');
    }

    const credit = walletRefundService.creditWalletRefund({
      requestId: nextRecord.request_id,
      customerEmail: nextRecord.customer_email,
      amount: nextRecord.amount,
      currency: nextRecord.currency,
      orderId: nextRecord.order_id,
      orderNumber: nextRecord.order_number,
    });

    nextRecord = normalizeRequest({
      ...nextRecord,
      wallet_credited: credit.credited || credit.duplicate,
      wallet_transaction_id: credit.walletTransactionId || nextRecord.wallet_transaction_id,
    });
  }

  if (
    nextRecord.refund_method === 'original_payment' &&
    nextRecord.status === 'manual_refund_required'
  ) {
    console.log('[ORIGINAL PAYMENT MANUAL REQUIRED]', {
      requestId: nextRecord.request_id,
      orderNumber: nextRecord.order_number,
      amount: nextRecord.amount,
      currency: nextRecord.currency,
      paymentProvider: nextRecord.payment_provider,
      paymentTransactionId: nextRecord.payment_transaction_id,
    });
  }

  return nextRecord;
}

function createReturnRequestHandlers({ refundRequests, shopifyRefundSync, walletRefundService }) {
  async function reconcileRequestWithShopify(record) {
    if (!shopifyRefundSync?.pullRefundStatusFromShopify) {
      return record;
    }

    try {
      const reconciled = await shopifyRefundSync.pullRefundStatusFromShopify(record);
      if (reconciled.status !== record.status) {
        refundRequests.set(record.request_id, reconciled);
        return reconciled;
      }
    } catch (error) {
      console.log('[REFUND STATUS SYNC]', {
        requestId: record.request_id,
        reason: 'shopify_pull_failed',
        error: error.message,
      });
    }

    return record;
  }

  async function pushRequestToShopify(record) {
    if (!shopifyRefundSync?.syncRefundRequestToShopify) {
      return { shopify_synced: false };
    }

    try {
      const result = await shopifyRefundSync.syncRefundRequestToShopify(record);
      const updated = {
        ...record,
        shopify_order_gid: result.shopify_order_gid || record.shopify_order_gid || null,
        shopify_synced_at: new Date().toISOString(),
      };
      refundRequests.set(record.request_id, updated);
      return { ...result, request: updated };
    } catch (error) {
      console.log('[SHOPIFY REFUND REQUEST TAGGED]', {
        requestId: record.request_id,
        failed: true,
        error: error.message,
      });
      return { shopify_synced: false, error: error.message };
    }
  }

  async function listRequests(req, res) {
    try {
    const email = safeString(req.query.email || req.query.customerEmail).toLowerCase();
    if (!email) {
      return res.status(400).json({
        ok: false,
        success: false,
        message: 'customer email is required.',
        requests: [],
      });
    }

    const rows = refundRequests.values().filter(
      (entry) => safeString(entry.customer_email).toLowerCase() === email
    );

    const reconciled = [];
    for (const entry of rows) {
      reconciled.push(await reconcileRequestWithShopify(entry));
    }

    console.log('[REFUND STATUS SYNC]', {
      email,
      requestCount: reconciled.length,
      source: 'list_requests',
    });

    return res.json({
      ok: true,
      success: true,
      requests: reconciled,
      count: reconciled.length,
    });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'list_requests', error: error.message });
      return res.status(500).json({
        ok: false,
        success: false,
        message: error.message || 'Could not load refund requests.',
        requests: [],
      });
    }
  }

  async function getRequestStatus(req, res) {
    try {
    const requestId = safeString(req.params.id || req.params.requestId);
    let record = refundRequests.get(requestId);

    if (!record) {
      return res.status(404).json({
        ok: false,
        success: false,
        message: 'Return request not found.',
      });
    }

    record = await reconcileRequestWithShopify(record);

    console.log('[REFUND STATUS SYNC]', {
      requestId,
      status: record.status,
      source: 'get_request_status',
    });

    return res.json({
      ok: true,
      success: true,
      request: record,
      status: record.status,
    });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'get_request_status', error: error.message });
      return res.status(500).json({
        ok: false,
        success: false,
        message: error.message || 'Could not load refund request status.',
      });
    }
  }

  async function createRequest(req, res) {
    try {
    const body = req.body || {};
    const requestId = safeString(body.request_id || body.requestId);

    if (!requestId) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'missing_request_id' });
      return res.status(400).json({
        ok: false,
        success: false,
        message: 'request_id is required.',
      });
    }

    if (!safeString(body.order_id || body.orderId)) {
      console.log('[RETURN REQUEST FAILED]', { requestId, reason: 'missing_order_id' });
      return res.status(400).json({
        ok: false,
        success: false,
        message: 'order_id is required.',
      });
    }

    if (!safeString(body.reason)) {
      console.log('[RETURN REQUEST FAILED]', { requestId, reason: 'missing_reason' });
      return res.status(400).json({
        ok: false,
        success: false,
        message: 'reason is required.',
      });
    }

    const existing = refundRequests.get(requestId);
    if (existing) {
      const shopifyResult = await pushRequestToShopify(existing);
      console.log('[RETURN REQUEST SAVED]', { requestId, deduped: true, status: existing.status });
      return res.json({
        ok: true,
        success: true,
        request_id: requestId,
        status: existing.status,
        message: 'Return request already registered.',
        request: shopifyResult.request || existing,
        shopify_synced: Boolean(shopifyResult.shopify_synced),
      });
    }

    let record = normalizeRequest({
      ...body,
      request_id: requestId,
      status: 'pending_review',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    console.log('[REFUND DESTINATION SELECTED]', {
      requestId: record.request_id,
      orderId: record.order_id,
      orderNumber: record.order_number,
      refundMethod: record.refund_method,
      refundDestinationLabel: record.refund_destination_label,
      amount: record.amount,
      currency: record.currency,
    });

    console.log('[RETURN REQUEST CREATE]', {
      requestId: record.request_id,
      orderId: record.order_id,
      orderNumber: record.order_number,
      refundMethod: record.refund_method,
      amount: record.amount,
      currency: record.currency,
    });

    refundRequests.set(requestId, record);

    console.log('[RETURN REQUEST SAVED]', {
      requestId: record.request_id,
      status: record.status,
      storage: 'redis_or_json',
    });

    const shopifyResult = await pushRequestToShopify(record);
    record = shopifyResult.request || refundRequests.get(requestId) || record;

    return res.status(201).json({
      ok: true,
      success: true,
      request_id: record.request_id,
      status: record.status,
      message: 'Return request submitted for review.',
      request: record,
      shopify_synced: Boolean(shopifyResult.shopify_synced),
    });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'create_request', error: error.message });
      return res.status(500).json({
        ok: false,
        success: false,
        message: error.message || 'Could not create refund request.',
      });
    }
  }

  async function patchRequest(req, res) {
    try {
    const requestId = safeString(req.params.id || req.params.requestId);
    const existing = refundRequests.get(requestId);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        success: false,
        message: 'Return request not found.',
      });
    }

    const action = safeString(req.body?.action).toLowerCase();
    const explicitStatus = safeString(req.body?.status).toLowerCase();
    let resolvedStatus = '';

    if (action) {
      if (!VALID_ACTIONS.has(action)) {
        return res.status(400).json({
          ok: false,
          success: false,
          message: 'Invalid action.',
        });
      }
      resolvedStatus = resolveStatusFromAction(action, existing);
    } else if (explicitStatus) {
      resolvedStatus = normalizeStatus(explicitStatus);
      if (resolvedStatus === 'approved') {
        resolvedStatus =
          existing.refund_method === 'wallet' ? 'refunded_to_wallet' : 'manual_refund_required';
      }
    }

    if (!resolvedStatus || !VALID_STATUSES.has(resolvedStatus)) {
      return res.status(400).json({
        ok: false,
        success: false,
        message: 'A valid action or status is required.',
      });
    }

    let updated = normalizeRequest({
      ...existing,
      status: resolvedStatus,
      updated_at: new Date().toISOString(),
      admin_note: safeString(req.body?.admin_note || req.body?.adminNote) || existing.admin_note || '',
    });

    updated = await applyPostApprovalEffects(updated, walletRefundService);
    refundRequests.set(requestId, updated);

    const shopifyResult = await pushRequestToShopify(updated);
    updated = shopifyResult.request || updated;

    console.log('[REFUND STATUS SYNC]', {
      requestId,
      action: action || null,
      status: updated.status,
      source: 'admin_patch',
      shopify_synced: Boolean(shopifyResult.shopify_synced),
    });

    return res.json({
      ok: true,
      success: true,
      request_id: requestId,
      status: updated.status,
      request: updated,
      shopify_synced: Boolean(shopifyResult.shopify_synced),
    });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'patch_request', error: error.message });
      return res.status(500).json({
        ok: false,
        success: false,
        message: error.message || 'Could not update refund request.',
      });
    }
  }

  return {
    listRequests,
    getRequestStatus,
    createRequest,
    patchRequest,
  };
}

module.exports = {
  createReturnRequestHandlers,
  normalizeRequest,
  VALID_ACTIONS,
  VALID_STATUSES,
};