const { publicRefund } = require('./refund-service');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toResponse(record) {
  return publicRefund(record);
}

function getAdminActor(req) {
  return safeString(
    req.get?.('x-nood-admin-id') ||
      req.get?.('x-admin-id') ||
      req.get?.('x-nood-admin-api-key') ||
      req.get?.('x-admin-key') ||
      'admin'
  );
}

function createReturnRequestHandlers({ refundService, shopifyRefundSync }) {
  if (!refundService) {
    throw new Error('refundService is required.');
  }

  async function pushRequestToShopify(record) {
    if (!shopifyRefundSync?.syncRefundRequestToShopify) {
      return { shopify_synced: false };
    }

    try {
      const result = await shopifyRefundSync.syncRefundRequestToShopify(record);
      return { ...result, shopify_synced: true };
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
      const rows = refundService.listCustomerRequests(req.customer || []);
      return res.json({
        ok: true,
        success: true,
        requests: rows.map(toResponse),
        count: rows.length,
      });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'list_requests', error: error.message });
      return res.status(error.statusCode || 500).json({
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
      const record = refundService.getCustomerRequest({
        requestId,
        customer: req.customer || {},
      });

      return res.json({
        ok: true,
        success: true,
        request: toResponse(record),
        status: record.status,
      });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'get_request_status', error: error.message });
      return res.status(error.statusCode || 500).json({
        ok: false,
        success: false,
        message: error.message || 'Could not load refund request status.',
      });
    }
  }

  async function createRequest(req, res) {
    try {
      const result = await refundService.submitCustomerRequest({
        body: req.body || {},
        customer: req.customer || {},
      });
      const shopifyResult = await pushRequestToShopify(result.record);

      console.log('[RETURN REQUEST SAVED]', {
        requestId: result.record.request_id,
        status: result.record.status,
        deduped: Boolean(result.duplicate),
        amountCents: result.record.amount_cents,
      });

      return res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        success: true,
        request_id: result.record.request_id,
        status: result.record.status,
        message: result.duplicate
          ? 'Return request already registered.'
          : 'Return request submitted for review.',
        request: toResponse(result.record),
        shopify_synced: Boolean(shopifyResult.shopify_synced),
      });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'create_request', error: error.message });
      return res.status(error.statusCode || 500).json({
        ok: false,
        success: false,
        message: error.message || 'Could not create refund request.',
      });
    }
  }

  async function patchRequest(req, res) {
    try {
      const requestId = safeString(req.params.id || req.params.requestId);
      const result = await refundService.adminApply({
        requestId,
        action: req.body?.action,
        status: req.body?.status,
        destination: req.body?.refund_destination || req.body?.refundDestination || req.body?.refund_method,
        adminId: getAdminActor(req),
        reason: safeString(req.body?.admin_note || req.body?.adminNote || req.body?.reason),
      });
      const shopifyResult = await pushRequestToShopify(result.record);

      console.log('[REFUND STATUS SYNC]', {
        requestId,
        action: safeString(req.body?.action || req.body?.status),
        status: result.record.status,
        source: 'admin_patch',
        shopify_synced: Boolean(shopifyResult.shopify_synced),
      });

      return res.json({
        ok: true,
        success: true,
        request_id: requestId,
        status: result.record.status,
        request: toResponse(result.record),
        result: result.result,
        shopify_synced: Boolean(shopifyResult.shopify_synced),
      });
    } catch (error) {
      console.log('[RETURN REQUEST FAILED]', { reason: 'patch_request', error: error.message });
      return res.status(error.statusCode || 500).json({
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
};
