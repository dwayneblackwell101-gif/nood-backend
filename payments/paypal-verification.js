const { usdToCents } = require('../lib/money');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function captureStatus(capture = {}) {
  return safeString(capture.status).toUpperCase();
}

function getPurchaseUnits(order = {}) {
  return Array.isArray(order.purchase_units) ? order.purchase_units : [];
}

function getCaptures(order = {}) {
  return getPurchaseUnits(order).flatMap((unit) => unit?.payments?.captures || []).filter(Boolean);
}

function getRefunds(order = {}) {
  return getPurchaseUnits(order).flatMap((unit) => unit?.payments?.refunds || []).filter(Boolean);
}

function normalizedResult(status, patch = {}) {
  return {
    status,
    verified: status === 'verified',
    verifiedAt: new Date().toISOString(),
    provider: 'paypal',
    ...patch,
  };
}

function isTimeout(error) {
  return ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code) || /timeout/i.test(safeString(error?.message));
}

async function verifyPayPalPayment({
  paypalClient,
  payment = {},
  expectedMerchantId = '',
  assignedCapturePayment = null,
} = {}) {
  if (!paypalClient || typeof paypalClient.getOrder !== 'function') {
    return normalizedResult('provider_unavailable', { reason: 'paypal_client_unavailable' });
  }

  const paypalOrderId = safeString(payment.providerOrderId || payment.paypalOrderId || payment.orderId);
  const expectedCaptureId = safeString(payment.providerTransactionId || payment.paypalCaptureId || payment.transactionId);
  if (!paypalOrderId) return normalizedResult('not_found', { reason: 'missing_paypal_order_id' });

  let order;
  try {
    order = await paypalClient.getOrder(paypalOrderId);
  } catch (error) {
    if (error?.response?.status === 404) return normalizedResult('not_found', { paypalOrderId });
    if (isTimeout(error)) return normalizedResult('provider_unavailable', { paypalOrderId, reason: 'paypal_timeout' });
    return normalizedResult('provider_unavailable', { paypalOrderId, reason: 'paypal_error' });
  }

  if (!order || typeof order !== 'object') return normalizedResult('manual_review', { paypalOrderId, reason: 'malformed_provider_response' });
  const captures = getCaptures(order);
  if (!captures.length) return normalizedResult('not_completed', { paypalOrderId, reason: 'missing_capture' });

  const capture = expectedCaptureId
    ? captures.find((item) => safeString(item.id) === expectedCaptureId)
    : captures[0];
  if (!capture) return normalizedResult('not_found', { paypalOrderId, reason: 'capture_id_missing' });

  const status = captureStatus(capture);
  if (['DENIED', 'DECLINED', 'VOIDED', 'FAILED'].includes(status)) {
    return normalizedResult(status === 'VOIDED' ? 'reversed' : 'not_completed', { paypalOrderId, captureId: safeString(capture.id), reason: status.toLowerCase() });
  }
  if (status !== 'COMPLETED') {
    return normalizedResult('not_completed', { paypalOrderId, captureId: safeString(capture.id), reason: status.toLowerCase() || 'not_completed' });
  }

  const refunds = getRefunds(order);
  if (refunds.some((refund) => safeString(refund.status).toUpperCase() === 'COMPLETED')) {
    return normalizedResult('refunded', { paypalOrderId, captureId: safeString(capture.id), reason: 'refund_present' });
  }

  const currency = safeString(capture.amount?.currency_code || order.purchase_units?.[0]?.amount?.currency_code).toUpperCase();
  const amountCents = usdToCents(capture.amount?.value || order.purchase_units?.[0]?.amount?.value);
  const expectedAmountCents = Number(payment.expectedAmountCents ?? payment.amountCents ?? 0);
  const expectedCurrency = safeString(payment.expectedCurrency || payment.currency, 'USD').toUpperCase();

  if (expectedAmountCents && amountCents !== expectedAmountCents) {
    return normalizedResult('amount_mismatch', { paypalOrderId, captureId: safeString(capture.id), amountCents, currency });
  }
  if (expectedCurrency && currency !== expectedCurrency) {
    return normalizedResult('currency_mismatch', { paypalOrderId, captureId: safeString(capture.id), amountCents, currency });
  }

  const merchantId = safeString(expectedMerchantId);
  const payeeMerchantId = safeString(capture.payee?.merchant_id || order.purchase_units?.[0]?.payee?.merchant_id);
  if (merchantId && payeeMerchantId && merchantId !== payeeMerchantId) {
    return normalizedResult('merchant_mismatch', { paypalOrderId, captureId: safeString(capture.id), amountCents, currency });
  }

  if (assignedCapturePayment && safeString(assignedCapturePayment.paymentId) !== safeString(payment.paymentId)) {
    return normalizedResult('manual_review', { paypalOrderId, captureId: safeString(capture.id), reason: 'capture_mapped_to_another_payment' });
  }

  return normalizedResult('verified', {
    paypalOrderId,
    captureId: safeString(capture.id),
    amountCents,
    currency,
    environment: safeString(process.env.PAYPAL_ENV || process.env.PAYPAL_ENVIRONMENT, 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox',
  });
}

module.exports = {
  getCaptures,
  verifyPayPalPayment,
};
