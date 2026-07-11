const crypto = require('crypto');
const { usdToCents, centsToUsd, requirePositiveCents } = require('../lib/money');

const REFUND_STATES = new Set([
  'requested',
  'under_review',
  'approved',
  'rejected',
  'refund_pending',
  'provider_refunding',
  'wallet_crediting',
  'completed',
  'failed',
  'manual_review',
]);

const TERMINAL_STATES = new Set(['completed', 'rejected']);
const VALID_TRANSITIONS = new Map([
  ['requested', new Set(['under_review', 'approved', 'rejected', 'manual_review'])],
  ['under_review', new Set(['approved', 'rejected', 'manual_review'])],
  ['approved', new Set(['refund_pending', 'manual_review', 'provider_refunding', 'wallet_crediting', 'rejected'])],
  ['refund_pending', new Set(['provider_refunding', 'wallet_crediting', 'manual_review', 'failed'])],
  ['provider_refunding', new Set(['completed', 'manual_review', 'failed'])],
  ['wallet_crediting', new Set(['completed', 'manual_review', 'failed'])],
  ['manual_review', new Set(['provider_refunding', 'wallet_crediting', 'completed', 'failed'])],
  ['failed', new Set(['manual_review'])],
  ['completed', new Set([])],
  ['rejected', new Set([])],
]);

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeCustomerId(value) {
  const raw = safeString(value);
  if (!raw) return '';
  const numeric = raw.match(/Customer\/(\d+)/)?.[1] || raw.match(/(\d+)$/)?.[1] || raw;
  return numeric ? `gid://shopify/Customer/${numeric}` : '';
}

function normalizeOrderGid(value) {
  const raw = safeString(value);
  if (!raw) return '';
  if (raw.startsWith('gid://shopify/Order/')) return raw;
  const numeric = raw.replace(/\D/g, '');
  return numeric ? `gid://shopify/Order/${numeric}` : '';
}

function normalizeCurrency(value, fallback = 'USD') {
  return safeString(value, fallback).toUpperCase();
}

function moneyToCents(value, label = 'money') {
  try {
    return usdToCents(String(value ?? '0'));
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

function getMoneyAmount(value) {
  return (
    value?.shopMoney?.amount ||
    value?.presentmentMoney?.amount ||
    value?.amount ||
    '0.00'
  );
}

function getNodeList(connectionOrArray) {
  if (Array.isArray(connectionOrArray)) return connectionOrArray;
  if (Array.isArray(connectionOrArray?.nodes)) return connectionOrArray.nodes;
  if (Array.isArray(connectionOrArray?.edges)) {
    return connectionOrArray.edges.map((edge) => edge?.node).filter(Boolean);
  }
  return [];
}

function createRequestId() {
  return `refund_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function createFingerprint(value = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicRefund(record) {
  if (!record) return null;
  const { trusted_order_snapshot, provider_raw, internal_audit, ...safeRecord } = record;
  return safeRecord;
}

function errorWithStatus(message, statusCode = 400, code = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function assertTransition(fromState, toState) {
  if (fromState === toState) return;
  if (TERMINAL_STATES.has(fromState)) {
    throw errorWithStatus('Terminal refund state cannot be overwritten.', 409, 'terminal_refund_state');
  }
  const allowed = VALID_TRANSITIONS.get(fromState);
  if (!allowed || !allowed.has(toState)) {
    throw errorWithStatus(`Invalid refund state transition ${fromState} -> ${toState}.`, 409, 'invalid_refund_transition');
  }
}

function getActor({ type = 'system', id = '', reason = '' } = {}) {
  return {
    actor_type: safeString(type, 'system'),
    actor_id: safeString(id) ? createFingerprint({ id: safeString(id) }).slice(0, 16) : '',
    reason: safeString(reason),
    at: new Date().toISOString(),
  };
}

function transitionRecord(record, nextState, actor, patch = {}) {
  assertTransition(record.status, nextState);
  const now = new Date().toISOString();
  return {
    ...record,
    ...patch,
    status: nextState,
    updated_at: now,
    transitions: [
      ...(Array.isArray(record.transitions) ? record.transitions : []),
      { state: nextState, ...getActor(actor), at: now },
    ],
  };
}

function normalizeDestination(value) {
  const normalized = safeString(value).toLowerCase();
  if (normalized === 'wallet' || normalized === 'nood_wallet') return 'wallet';
  if (normalized === 'manual') return 'manual';
  return 'original_payment_method';
}

function getOrderCurrency(order) {
  return normalizeCurrency(
    order?.currencyCode ||
      order?.currency ||
      order?.currentTotalPriceSet?.shopMoney?.currencyCode ||
      order?.totalPriceSet?.shopMoney?.currencyCode ||
      'USD'
  );
}

function getOrderFinancialStatus(order) {
  return safeString(order?.displayFinancialStatus || order?.financialStatus || order?.financial_status).toUpperCase();
}

function getLineUnitCents(line) {
  const quantity = Number(line?.quantity || 0);
  if (!Number.isInteger(quantity) || quantity <= 0) return 0;
  const discounted = moneyToCents(
    getMoneyAmount(line?.discountedTotalSet) ||
      getMoneyAmount(line?.originalTotalSet) ||
      String(Number(line?.price || 0) * quantity),
    'line subtotal'
  );
  return Math.floor(discounted / quantity);
}

function getLineTaxUnitCents(line) {
  const quantity = Number(line?.quantity || 0);
  if (!Number.isInteger(quantity) || quantity <= 0) return 0;
  const taxLines = getNodeList(line?.taxLines || []);
  const taxTotal = taxLines.reduce((sum, tax) => {
    return sum + moneyToCents(getMoneyAmount(tax?.priceSet) || tax?.price || '0.00', 'line tax');
  }, 0);
  return Math.floor(taxTotal / quantity);
}

function getLineRefundedQuantities(order) {
  const quantities = new Map();
  for (const refund of getNodeList(order?.refunds || [])) {
    for (const item of getNodeList(refund?.refundLineItems || refund?.refund_line_items || [])) {
      const lineId = safeString(item?.lineItem?.id || item?.line_item_id || item?.lineItemId);
      const quantity = Number(item?.quantity || 0);
      if (lineId && Number.isInteger(quantity) && quantity > 0) {
        quantities.set(lineId, (quantities.get(lineId) || 0) + quantity);
      }
    }
  }
  return quantities;
}

function getPreviousRefundCents(order) {
  let total = 0;
  for (const refund of getNodeList(order?.refunds || [])) {
    for (const item of getNodeList(refund?.refundLineItems || refund?.refund_line_items || [])) {
      const subtotal = getMoneyAmount(item?.subtotalSet) || item?.subtotal || '0.00';
      const tax = getMoneyAmount(item?.totalTaxSet) || item?.total_tax || '0.00';
      total += moneyToCents(subtotal, 'previous refund subtotal') + moneyToCents(tax, 'previous refund tax');
    }
    const shipping = getMoneyAmount(refund?.totalShippingSet) || refund?.shipping?.amount || '0.00';
    total += moneyToCents(shipping, 'previous refund shipping');
  }
  return total;
}

function getCapturedCents(order) {
  const transactions = getNodeList(order?.transactions || []);
  const captured = transactions.reduce((sum, tx) => {
    const kind = safeString(tx?.kind).toUpperCase();
    const status = safeString(tx?.status).toUpperCase();
    if (!['SALE', 'CAPTURE'].includes(kind) || !['SUCCESS', 'COMPLETED'].includes(status)) return sum;
    return sum + moneyToCents(getMoneyAmount(tx?.amountSet) || tx?.amount || '0.00', 'captured amount');
  }, 0);

  if (captured > 0) return captured;
  return moneyToCents(getMoneyAmount(order?.totalReceivedSet) || getMoneyAmount(order?.currentTotalPriceSet) || '0.00', 'captured amount');
}

function getPaymentProvider(order) {
  const tx = getNodeList(order?.transactions || []).find((entry) => {
    const kind = safeString(entry?.kind).toUpperCase();
    return ['SALE', 'CAPTURE'].includes(kind);
  });
  const gateway = safeString(tx?.gateway || tx?.paymentDetails?.company);
  if (gateway.toLowerCase().includes('paypal')) return 'paypal';
  if (gateway.toLowerCase().includes('wipay')) return 'wipay';
  if (gateway.toLowerCase().includes('wallet')) return 'wallet';
  return gateway.toLowerCase() || 'unknown';
}

function getPayPalCaptureId(order) {
  const tx = getNodeList(order?.transactions || []).find((entry) => {
    const kind = safeString(entry?.kind).toUpperCase();
    const gateway = safeString(entry?.gateway).toLowerCase();
    return ['SALE', 'CAPTURE'].includes(kind) && gateway.includes('paypal');
  });
  return safeString(tx?.id || tx?.authorizationCode || tx?.receiptJson);
}

function verifyOwnership({ order, customer }) {
  const authCustomerId = normalizeCustomerId(customer?.id);
  const orderCustomerId = normalizeCustomerId(order?.customer?.id || order?.customer_id);
  const authEmail = safeString(customer?.email).toLowerCase();
  const orderEmail = safeString(order?.customer?.email || order?.email).toLowerCase();

  if (orderCustomerId && authCustomerId && orderCustomerId === authCustomerId) {
    return { ok: true, method: 'shopify_customer_id' };
  }

  if (!orderCustomerId && authEmail && orderEmail && authEmail === orderEmail) {
    return { ok: true, method: 'verified_customer_email_fallback' };
  }

  if (!orderCustomerId) {
    throw errorWithStatus('Guest order refund ownership cannot be securely proven.', 403, 'guest_order_unverified');
  }

  throw errorWithStatus('Authenticated customer does not own this order.', 403, 'order_owner_mismatch');
}

function assertOrderEligible(order) {
  if (!order?.id) throw errorWithStatus('Shopify order was not found.', 404, 'order_not_found');
  const status = getOrderFinancialStatus(order);
  if (!['PAID', 'PARTIALLY_REFUNDED', 'PARTIALLY_PAID'].includes(status)) {
    throw errorWithStatus('Order is not in a refundable paid state.', 400, 'order_not_refundable');
  }
  if (order?.cancelledAt || order?.cancelled_at) {
    throw errorWithStatus('Cancelled orders require manual refund review.', 400, 'cancelled_order_manual_review');
  }
  if (status === 'REFUNDED') {
    throw errorWithStatus('Order is already fully refunded.', 400, 'order_already_refunded');
  }
  if (getOrderCurrency(order) !== 'USD') {
    throw errorWithStatus('Refunds currently support USD orders only.', 400, 'unsupported_refund_currency');
  }
}

function normalizeRequestedItems(items = []) {
  const merged = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const lineItemId = safeString(raw.lineItemId || raw.line_item_id || raw.id);
    const variantId = safeString(raw.variantId || raw.variant_id);
    const quantity = Number(raw.quantity || 0);
    if (!lineItemId) throw errorWithStatus('Refund line item ID is required.', 400, 'missing_line_item');
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw errorWithStatus('Refund line item quantity must be a positive integer.', 400, 'invalid_line_item_quantity');
    }
    const existing = merged.get(lineItemId) || { lineItemId, variantId, quantity: 0 };
    existing.quantity += quantity;
    if (variantId) existing.variantId = variantId;
    merged.set(lineItemId, existing);
  }
  if (!merged.size) throw errorWithStatus('At least one refund line item is required.', 400, 'missing_refund_items');
  return Array.from(merged.values());
}

function calculateRefund({ order, requestedItems, shippingPolicy = 'none' }) {
  assertOrderEligible(order);
  const lineItems = getNodeList(order?.lineItems || order?.line_items || []);
  const refundedQuantities = getLineRefundedQuantities(order);
  const requested = normalizeRequestedItems(requestedItems);
  const trustedItems = [];
  let merchandiseCents = 0;
  let taxCents = 0;

  for (const item of requested) {
    const line = lineItems.find((entry) => safeString(entry?.id) === item.lineItemId);
    if (!line) throw errorWithStatus('Requested line item does not belong to this order.', 400, 'unknown_line_item');
    const trustedVariantId = safeString(line?.variant?.id || line?.variant_id);
    if (item.variantId && trustedVariantId && item.variantId !== trustedVariantId) {
      throw errorWithStatus('Requested variant does not match the order line item.', 400, 'variant_mismatch');
    }

    const purchasedQuantity = Number(line?.quantity || 0);
    const alreadyRefunded = Number(refundedQuantities.get(line.id) || 0);
    const remainingQuantity = purchasedQuantity - alreadyRefunded;
    if (remainingQuantity <= 0) {
      throw errorWithStatus('Requested line item is already fully refunded.', 400, 'line_item_fully_refunded');
    }
    if (item.quantity > remainingQuantity) {
      throw errorWithStatus('Requested quantity exceeds remaining refundable quantity.', 400, 'quantity_exceeds_refundable');
    }

    const unitSubtotalCents = getLineUnitCents(line);
    const unitTaxCents = getLineTaxUnitCents(line);
    const lineSubtotalCents = unitSubtotalCents * item.quantity;
    const lineTaxCents = unitTaxCents * item.quantity;
    merchandiseCents += lineSubtotalCents;
    taxCents += lineTaxCents;
    trustedItems.push({
      line_item_id: line.id,
      variant_id: trustedVariantId || null,
      title: safeString(line.title, 'Item'),
      quantity: item.quantity,
      purchased_quantity: purchasedQuantity,
      previously_refunded_quantity: alreadyRefunded,
      remaining_refundable_quantity: remainingQuantity - item.quantity,
      subtotal_cents: lineSubtotalCents,
      tax_cents: lineTaxCents,
    });
  }

  const previousRefundCents = getPreviousRefundCents(order);
  const capturedCents = getCapturedCents(order);
  const shippingCents = shippingPolicy === 'refund_shipping'
    ? Math.max(0, moneyToCents(getMoneyAmount(order?.totalShippingPriceSet) || '0.00', 'shipping refund'))
    : 0;
  const requestedTotalCents = merchandiseCents + taxCents + shippingCents;
  const remainingCapturedCents = capturedCents - previousRefundCents;

  requirePositiveCents(requestedTotalCents, 'refund amount');
  if (requestedTotalCents > remainingCapturedCents) {
    throw errorWithStatus('Refund amount exceeds remaining captured amount.', 400, 'refund_exceeds_captured');
  }

  return {
    amount_cents: requestedTotalCents,
    amount: centsToUsd(requestedTotalCents),
    currency: getOrderCurrency(order),
    merchandise_cents: merchandiseCents,
    tax_cents: taxCents,
    shipping_cents: shippingCents,
    previous_refund_cents: previousRefundCents,
    captured_cents: capturedCents,
    remaining_captured_cents: remainingCapturedCents - requestedTotalCents,
    shipping_policy: shippingPolicy,
    items: trustedItems,
  };
}

function createRefundService({
  refundRequests,
  lockService,
  redisWallet,
  walletRefundService,
  fetchShopifyOrder,
  paypalRefundClient = null,
  paypalRefundsEnabled = false,
  shippingPolicy = 'none',
} = {}) {
  async function withLock(key, fn) {
    if (!lockService) return fn();
    return lockService.withLock(`refund:${key}`, Number(process.env.REFUND_LOCK_TTL_SECONDS || 60), fn);
  }

  function get(requestId) {
    return refundRequests.get(safeString(requestId));
  }

  function save(record) {
    refundRequests.set(record.request_id, record);
    return record;
  }

  async function loadTrustedOrder(orderReference) {
    if (!fetchShopifyOrder) {
      throw errorWithStatus('Shopify order lookup is unavailable for refunds.', 503, 'shopify_order_lookup_unavailable');
    }
    return fetchShopifyOrder(orderReference);
  }

  async function submitCustomerRequest({ body = {}, customer = {} } = {}) {
    const requestId = safeString(body.request_id || body.requestId, createRequestId());
    const orderReference = safeString(body.order_id || body.orderId || body.shopify_order_id || body.shopifyOrderId);
    if (!orderReference) throw errorWithStatus('order_id is required.', 400, 'missing_order_id');
    if (!safeString(body.reason)) throw errorWithStatus('reason is required.', 400, 'missing_reason');

    return withLock(`request:${requestId}`, async () => {
      const existing = get(requestId);
      if (existing) {
        if (safeString(existing.customer_id) !== normalizeCustomerId(customer.id)) {
          throw errorWithStatus('Authenticated customer does not own this return request.', 403, 'refund_owner_mismatch');
        }
        return { record: existing, duplicate: true };
      }

      const order = await loadTrustedOrder(orderReference);
      const ownership = verifyOwnership({ order, customer });
      const calculation = calculateRefund({
        order,
        requestedItems: body.items,
        shippingPolicy,
      });
      const destination = normalizeDestination(body.refund_destination || body.refundDestination || body.refund_method || body.refundMethod);
      const now = new Date().toISOString();
      const record = {
        request_id: requestId,
        order_id: safeString(order.id || orderReference),
        order_number: safeString(order.name || order.orderNumber || orderReference),
        shopify_order_id: normalizeOrderGid(order.id || orderReference),
        shopify_order_gid: normalizeOrderGid(order.id || orderReference),
        customer_id: normalizeCustomerId(customer.id),
        customer_email: safeString(customer.email).toLowerCase(),
        ownership_verification: ownership.method,
        amount_cents: calculation.amount_cents,
        amount: calculation.amount,
        currency: calculation.currency,
        refund_destination: destination,
        refund_method: destination === 'wallet' ? 'wallet' : 'original_payment',
        refund_destination_label: destination === 'wallet' ? 'NOOD Wallet' : destination === 'manual' ? 'Manual review' : 'Original payment method',
        payment_provider: getPaymentProvider(order),
        paypal_capture_id: getPayPalCaptureId(order) || null,
        reason: safeString(body.reason),
        notes: safeString(body.notes),
        items: calculation.items,
        calculation,
        status: 'requested',
        created_at: now,
        updated_at: now,
        transitions: [{ state: 'requested', ...getActor({ type: 'customer', id: customer.id, reason: 'submitted' }), at: now }],
        wallet_credited: false,
        wallet_transaction_id: null,
        provider_refund_id: null,
        compensation_destination: null,
        trusted_order_snapshot: {
          order_id: safeString(order.id),
          order_number: safeString(order.name || order.orderNumber),
          currency: calculation.currency,
          captured_cents: calculation.captured_cents,
          previous_refund_cents: calculation.previous_refund_cents,
          payment_provider: getPaymentProvider(order),
        },
      };
      save(record);
      return { record, duplicate: false };
    });
  }

  function getCustomerRequest({ requestId, customer }) {
    const record = get(requestId);
    if (!record) throw errorWithStatus('Return request not found.', 404, 'refund_not_found');
    const authId = normalizeCustomerId(customer?.id);
    const authEmail = safeString(customer?.email).toLowerCase();
    if (safeString(record.customer_id) && safeString(record.customer_id) !== authId) {
      throw errorWithStatus('Authenticated customer does not own this return request.', 403, 'refund_owner_mismatch');
    }
    if (!safeString(record.customer_id) && safeString(record.customer_email).toLowerCase() !== authEmail) {
      throw errorWithStatus('Authenticated customer does not own this return request.', 403, 'refund_owner_mismatch');
    }
    return record;
  }

  function listCustomerRequests(customer) {
    const authId = normalizeCustomerId(customer?.id);
    const authEmail = safeString(customer?.email).toLowerCase();
    return refundRequests.values().filter((entry) => {
      return safeString(entry.customer_id) === authId ||
        (!safeString(entry.customer_id) && safeString(entry.customer_email).toLowerCase() === authEmail);
    });
  }

  async function creditWallet(record) {
    const operationKey = `refund:wallet:${record.request_id}`;
    if (record.compensation_destination && record.compensation_destination !== 'wallet') {
      throw errorWithStatus('Refund was already compensated through another destination.', 409, 'double_compensation_blocked');
    }
    if (record.wallet_credited || record.wallet_transaction_id) {
      return { duplicate: true, walletTransactionId: record.wallet_transaction_id };
    }
    if (redisWallet) {
      const credit = await redisWallet.credit({
        customerId: record.customer_id,
        amountCents: record.amount_cents,
        idempotencyKey: operationKey,
        source: 'refund_wallet_credit',
        providerTransactionId: record.request_id,
        metadata: {
          refundRequestId: record.request_id,
          orderId: record.order_id,
        },
      });
      return { duplicate: Boolean(credit.duplicate), walletTransactionId: credit.walletTransactionId, record: credit };
    }
    if (!walletRefundService?.creditWalletRefund) {
      throw errorWithStatus('Wallet refund service is unavailable.', 503, 'wallet_refund_unavailable');
    }
    return walletRefundService.creditWalletRefund({
      requestId: record.request_id,
      customerId: record.customer_id,
      customerEmail: record.customer_email,
      amount: record.amount,
      amountCents: record.amount_cents,
      currency: record.currency,
      orderId: record.order_id,
      orderNumber: record.order_number,
    });
  }

  async function issuePayPalRefund(record) {
    if (record.compensation_destination && record.compensation_destination !== 'paypal') {
      throw errorWithStatus('Refund was already compensated through another destination.', 409, 'double_compensation_blocked');
    }
    if (!paypalRefundsEnabled || !paypalRefundClient?.refundCapture) {
      return { manual: true, reason: 'paypal_refund_not_enabled' };
    }
    if (!record.paypal_capture_id) {
      return { manual: true, reason: 'paypal_capture_missing' };
    }
    const response = await paypalRefundClient.refundCapture({
      captureId: record.paypal_capture_id,
      amountCents: record.amount_cents,
      currency: record.currency,
      requestId: `refund:${record.request_id}`,
    });
    const providerRefundId = safeString(response?.id || response?.refundId);
    if (!providerRefundId) throw errorWithStatus('PayPal refund ID missing.', 502, 'paypal_refund_id_missing');
    const responseCents = moneyToCents(response?.amount?.value || response?.amount || record.amount, 'PayPal refund amount');
    const responseCurrency = normalizeCurrency(response?.amount?.currency_code || response?.currency || record.currency);
    if (responseCents !== Number(record.amount_cents) || responseCurrency !== record.currency) {
      throw errorWithStatus('PayPal refund response amount mismatch.', 502, 'paypal_refund_mismatch');
    }
    return { providerRefundId, response };
  }

  async function adminApply({ requestId, action, status, destination, adminId = 'admin', reason = '' } = {}) {
    return withLock(`apply:${requestId}`, async () => {
      let record = get(requestId);
      if (!record) throw errorWithStatus('Return request not found.', 404, 'refund_not_found');

      const normalizedAction = safeString(action || status).toLowerCase();
      if (destination && !['requested', 'under_review', 'approved'].includes(record.status)) {
        throw errorWithStatus('Refund destination cannot change after processing begins.', 409, 'destination_locked');
      }
      const selectedDestination = normalizeDestination(destination || record.refund_destination);
      record = { ...record, refund_destination: selectedDestination };

      if (normalizedAction === 'reject' || normalizedAction === 'rejected') {
        record = transitionRecord(record, 'rejected', { type: 'admin', id: adminId, reason: reason || 'rejected' });
        save(record);
        return { record, result: { rejected: true } };
      }

      if (record.status === 'completed') {
        return { record, result: { duplicate: true, completed: true } };
      }

      if (!['approve', 'approved', 'refund_to_wallet', 'mark_refunded', 'mark_manual_refund_required'].includes(normalizedAction)) {
        throw errorWithStatus('A valid refund action is required.', 400, 'invalid_refund_action');
      }

      if (record.status === 'requested') {
        record = transitionRecord(record, 'approved', { type: 'admin', id: adminId, reason: reason || normalizedAction });
      }

      if (selectedDestination === 'wallet' || normalizedAction === 'refund_to_wallet') {
        if (record.compensation_destination && record.compensation_destination !== 'wallet') {
          throw errorWithStatus('Refund was already compensated through another destination.', 409, 'double_compensation_blocked');
        }
        record = transitionRecord(record, 'wallet_crediting', { type: 'admin', id: adminId, reason: 'wallet_refund' });
        save(record);
        const credit = await creditWallet(record);
        record = transitionRecord(record, 'completed', { type: 'system', id: 'wallet', reason: 'wallet_credit_complete' }, {
          wallet_credited: true,
          wallet_transaction_id: credit.walletTransactionId || record.wallet_transaction_id,
          compensation_destination: 'wallet',
        });
        save(record);
        return { record, result: { wallet: credit } };
      }

      if (record.payment_provider === 'wipay') {
        record = transitionRecord(record, 'manual_review', { type: 'admin', id: adminId, reason: 'wipay_manual_refund_required' }, {
          manual_review_reason: 'wipay_refunds_disabled',
        });
        save(record);
        return { record, result: { manual: true, provider: 'wipay' } };
      }

      if (record.payment_provider === 'paypal') {
        record = transitionRecord(record, 'provider_refunding', { type: 'admin', id: adminId, reason: 'paypal_refund' });
        save(record);
        const provider = await issuePayPalRefund(record);
        if (provider.manual) {
          record = transitionRecord(record, 'manual_review', { type: 'system', id: 'paypal', reason: provider.reason }, {
            manual_review_reason: provider.reason,
          });
          save(record);
          return { record, result: provider };
        }
        record = transitionRecord(record, 'completed', { type: 'system', id: 'paypal', reason: 'paypal_refund_complete' }, {
          provider_refund_id: provider.providerRefundId,
          compensation_destination: 'paypal',
        });
        save(record);
        return { record, result: provider };
      }

      record = transitionRecord(record, 'manual_review', { type: 'admin', id: adminId, reason: 'manual_refund_required' }, {
        manual_review_reason: 'provider_refund_not_configured',
      });
      save(record);
      return { record, result: { manual: true } };
    });
  }

  return {
    REFUND_STATES,
    VALID_TRANSITIONS,
    adminApply,
    calculateRefund,
    getCustomerRequest,
    listCustomerRequests,
    publicRefund,
    submitCustomerRequest,
    verifyOwnership,
  };
}

module.exports = {
  REFUND_STATES,
  VALID_TRANSITIONS,
  assertTransition,
  calculateRefund,
  createRefundService,
  publicRefund,
  verifyOwnership,
};
