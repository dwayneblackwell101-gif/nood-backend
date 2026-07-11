const crypto = require('crypto');
const { centsToUsd, requirePositiveCents } = require('../lib/money');

const PAYPAL_PROVIDER = 'paypal';
const TERMINAL_DUPLICATE_STATES = new Set(['completed', 'recovery_required']);

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createFingerprint(value = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function getPayPalCaptureDetails(captureData = {}) {
  const capture =
    captureData?.purchase_units?.[0]?.payments?.captures?.[0] ||
    captureData?.purchase_units?.[0]?.payments?.authorizations?.[0] ||
    {};
  const purchaseUnit = captureData?.purchase_units?.[0] || {};

  return {
    id: safeString(capture?.id || captureData?.id),
    status: safeString(capture?.status || captureData?.status),
    amount: safeString(capture?.amount?.value || purchaseUnit?.amount?.value),
    currency: safeString(capture?.amount?.currency_code || purchaseUnit?.amount?.currency_code).toUpperCase(),
    payeeMerchantId: safeString(capture?.payee?.merchant_id || purchaseUnit?.payee?.merchant_id),
    raw: capture,
  };
}

function errorWithStatus(message, statusCode = 400, code = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function assertSupportedCurrency(currency) {
  if (safeString(currency).toUpperCase() !== 'USD') {
    throw errorWithStatus('PayPal payments support USD only.', 400, 'unsupported_currency');
  }
}

function assertRecordMatches(record, expected = {}) {
  const mismatches = [];
  const expectedFingerprint = createFingerprint({
    purpose: expected.purpose,
    customerId: expected.customerId,
    amountCents: expected.expectedAmountCents,
    currency: expected.expectedCurrency,
    snapshot: expected.trustedSnapshot || {},
  });

  if (safeString(record.customerId) !== safeString(expected.customerId)) mismatches.push('customer');
  if (safeString(record.purpose) !== safeString(expected.purpose)) mismatches.push('purpose');
  if (Number(record.expectedAmountCents) !== Number(expected.expectedAmountCents)) mismatches.push('amount');
  if (safeString(record.expectedCurrency).toUpperCase() !== safeString(expected.expectedCurrency).toUpperCase()) {
    mismatches.push('currency');
  }
  if (safeString(record.metadata?.requestFingerprint) !== expectedFingerprint) mismatches.push('request');

  if (mismatches.length) {
    throw errorWithStatus(
      `PayPal idempotency key was already used for a different ${mismatches.join(', ')}.`,
      409,
      'idempotency_conflict'
    );
  }
}

function verifyCapture({ captureData, expectedAmountCents, expectedCurrency = 'USD', expectedMerchantId = '' }) {
  const details = getPayPalCaptureDetails(captureData);
  if (captureData?.status !== 'COMPLETED' && details.status !== 'COMPLETED') {
    throw errorWithStatus(`PayPal payment was ${captureData?.status || details.status || 'not completed'}.`, 400, 'paypal_not_completed');
  }

  if (!details.id) {
    throw errorWithStatus('PayPal capture ID missing.', 400, 'paypal_capture_missing');
  }

  if (details.currency !== safeString(expectedCurrency, 'USD').toUpperCase()) {
    throw errorWithStatus('PayPal capture currency mismatch.', 400, 'paypal_currency_mismatch');
  }

  const capturedCents = Math.round(Number(details.amount) * 100);
  if (!Number.isSafeInteger(capturedCents) || capturedCents !== Number(expectedAmountCents)) {
    throw errorWithStatus('PayPal capture amount mismatch.', 400, 'paypal_amount_mismatch');
  }

  const merchantId = safeString(expectedMerchantId);
  if (merchantId && details.payeeMerchantId && merchantId !== details.payeeMerchantId) {
    throw errorWithStatus('PayPal merchant mismatch.', 400, 'paypal_merchant_mismatch');
  }

  return { ...details, amountCents: capturedCents };
}

function createPayPalPaymentService({
  paymentState,
  lockService,
  paypalClient,
  expectedMerchantId = '',
  lockTtlSeconds = 60,
} = {}) {
  function requireState() {
    if (!paymentState || !lockService) {
      throw errorWithStatus('PayPal persistent payment state is unavailable.', 503, 'payment_state_unavailable');
    }
  }

  async function withLock(lockKey, fn) {
    requireState();
    return lockService.withLock(lockKey, lockTtlSeconds, fn);
  }

  async function createOrder({
    purpose,
    customerId,
    expectedAmountCents,
    expectedCurrency = 'USD',
    trustedSnapshot = {},
    idempotencyKey,
    referenceId,
    description,
  }) {
    requireState();
    const amountCents = requirePositiveCents(expectedAmountCents, 'PayPal amount');
    const currency = safeString(expectedCurrency, 'USD').toUpperCase();
    assertSupportedCurrency(currency);

    const normalizedPurpose = safeString(purpose);
    const normalizedCustomerId = safeString(customerId);
    const operationKey = safeString(idempotencyKey);
    if (!normalizedPurpose) throw errorWithStatus('PayPal payment purpose is required.', 400, 'missing_purpose');
    if (!normalizedCustomerId) throw errorWithStatus('Authenticated customer is required.', 401, 'missing_customer');
    if (!operationKey) throw errorWithStatus('PayPal idempotency key is required.', 400, 'missing_idempotency_key');

    const requestFingerprint = createFingerprint({
      purpose: normalizedPurpose,
      customerId: normalizedCustomerId,
      amountCents,
      currency,
      snapshot: trustedSnapshot,
    });

    return withLock(`paypal:create:${operationKey}`, async () => {
      const created = await paymentState.createPayment({
        provider: PAYPAL_PROVIDER,
        purpose: normalizedPurpose,
        expectedAmountCents: amountCents,
        expectedCurrency: currency,
        providerAmountCents: amountCents,
        providerCurrency: currency,
        customerId: normalizedCustomerId,
        state: 'created',
        idempotencyKey: operationKey,
        cartFingerprint: trustedSnapshot.cartFingerprint || null,
        metadata: {
          purpose: normalizedPurpose,
          referenceId: safeString(referenceId),
          trustedSnapshot,
          requestFingerprint,
        },
      });

      assertRecordMatches(created.record, {
        purpose: normalizedPurpose,
        customerId: normalizedCustomerId,
        expectedAmountCents: amountCents,
        expectedCurrency: currency,
        trustedSnapshot,
      });

      if (created.record.providerOrderId) {
        return {
          duplicate: true,
          record: created.record,
          order: {
            id: created.record.providerOrderId,
            status: 'CREATED',
            links: created.record.metadata?.providerLinks || [],
          },
        };
      }

      const order = await paypalClient.createOrder({
        total: centsToUsd(amountCents),
        currency,
        referenceId,
        description,
      });

      const record = await paymentState.transitionPayment(created.record.paymentId, 'provider_pending', {
        providerOrderId: safeString(order?.id),
        metadata: {
          ...(created.record.metadata || {}),
          providerStatus: safeString(order?.status),
          providerLinks: Array.isArray(order?.links) ? order.links : [],
        },
      });

      return { duplicate: false, record, order };
    });
  }

  async function captureOrder({
    paypalOrderId,
    customerId,
    purpose,
    onCheckoutPaid,
    onWalletTopupPaid,
  }) {
    requireState();
    const normalizedOrderId = safeString(paypalOrderId);
    const normalizedCustomerId = safeString(customerId);
    const normalizedPurpose = safeString(purpose);
    if (!normalizedOrderId) throw errorWithStatus('PayPal order ID is required.', 400, 'missing_paypal_order');
    if (!normalizedCustomerId) throw errorWithStatus('Authenticated customer is required.', 401, 'missing_customer');

    return withLock(`paypal:capture:${normalizedOrderId}`, async () => {
      let record = await paymentState.getByProviderTransaction(PAYPAL_PROVIDER, normalizedOrderId);
      if (!record) throw errorWithStatus('PayPal payment record was not found.', 404, 'payment_not_found');
      if (safeString(record.customerId) !== normalizedCustomerId) {
        throw errorWithStatus('Authenticated customer does not own this PayPal payment.', 403, 'payment_owner_mismatch');
      }
      if (normalizedPurpose && safeString(record.purpose) !== normalizedPurpose) {
        throw errorWithStatus('PayPal payment purpose mismatch.', 400, 'payment_purpose_mismatch');
      }
      if (record.state === 'completed') {
        return { duplicate: true, completed: true, record, captureId: record.providerTransactionId };
      }
      if (TERMINAL_DUPLICATE_STATES.has(record.state)) {
        return { duplicate: true, recoveryRequired: record.state === 'recovery_required', record, captureId: record.providerTransactionId };
      }
      if (!['provider_pending', 'provider_approved', 'provider_verified'].includes(record.state)) {
        throw errorWithStatus(`PayPal payment cannot be captured from state ${record.state}.`, 409, 'invalid_capture_state');
      }

      let captureData;
      try {
        captureData = await paypalClient.captureOrder(normalizedOrderId);
      } catch (error) {
        if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
          let statusData = null;
          if (typeof paypalClient.getOrder === 'function') {
            statusData = await paypalClient.getOrder(normalizedOrderId).catch(() => null);
          }
          if (statusData?.status !== 'COMPLETED') {
            record = await paymentState.transitionPayment(record.paymentId, 'recovery_required', {
              lastSafeErrorCode: 'paypal_capture_timeout_unknown',
            });
            return { recoveryRequired: true, record, captureId: record.providerTransactionId || normalizedOrderId };
          }
          captureData = statusData;
        } else {
          throw error;
        }
      }

      const verified = verifyCapture({
        captureData,
        expectedAmountCents: record.expectedAmountCents,
        expectedCurrency: record.expectedCurrency,
        expectedMerchantId,
      });

      const captureOwner = await paymentState.getByProviderTransaction(PAYPAL_PROVIDER, verified.id);
      if (captureOwner && captureOwner.paymentId !== record.paymentId) {
        throw errorWithStatus('PayPal capture ID is already linked to another payment.', 409, 'capture_id_reused');
      }

      record = await paymentState.transitionPayment(record.paymentId, 'provider_verified', {
        providerTransactionId: verified.id,
        providerAmountCents: verified.amountCents,
        providerCurrency: verified.currency,
        metadata: {
          ...(record.metadata || {}),
          providerCaptureStatus: verified.status,
          providerCaptureId: verified.id,
        },
      });

      if (record.purpose === 'wallet_topup') {
        record = await paymentState.transitionPayment(record.paymentId, 'wallet_crediting');
        const walletResult = await onWalletTopupPaid({ record, captureData, captureId: verified.id });
        record = await paymentState.transitionPayment(record.paymentId, 'completed', {
          walletTransactionId: safeString(walletResult?.walletTransactionId || walletResult?.transactionId),
          walletCredited: true,
        });
        return { duplicate: false, completed: true, record, captureId: verified.id, walletResult, captureData };
      }

      record = await paymentState.transitionPayment(record.paymentId, 'order_creating');
      const shopifyResult = await onCheckoutPaid({ record, captureData, captureId: verified.id });
      if (!shopifyResult?.success) {
        record = await paymentState.transitionPayment(record.paymentId, 'recovery_required', {
          lastSafeErrorCode: 'shopify_order_create_failed',
        });
        return { recoveryRequired: true, record, captureId: verified.id, shopifyResult, captureData };
      }

      record = await paymentState.transitionPayment(record.paymentId, 'completed', {
        shopifyOrderId: safeString(shopifyResult.shopifyOrder?.id),
        shopifyOrderName: safeString(shopifyResult.shopifyOrder?.name),
      });
      return { duplicate: false, completed: true, record, captureId: verified.id, shopifyResult, captureData };
    });
  }

  return {
    createOrder,
    captureOrder,
    verifyCapture,
  };
}

module.exports = {
  createPayPalPaymentService,
  createFingerprint,
  getPayPalCaptureDetails,
  verifyCapture,
};
