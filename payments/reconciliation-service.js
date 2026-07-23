const { revalidateSnapshot, snapshotToCartItems, verifySnapshotHash } = require('../checkout/cart-pricing');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function publicResult(result = {}) {
  const { rawProviderResponse, ...safe } = result;
  return safe;
}

function createRecoveryId(payment = {}) {
  return `paypal_recovery_${safeString(payment.paymentId || payment.providerOrderId || Date.now())}`;
}

function createPayPalReconciliationService({
  paymentState,
  lockService,
  reconciliationRecords,
  failedPaidOrders,
  paypalVerifier,
  shopifyLookup,
  createShopifyOrder,
  getCatalogCache,
  expectedMerchantId = '',
  lockTtlSeconds = 120,
} = {}) {
  function requireReady() {
    if (!paymentState || !lockService || !paypalVerifier || !reconciliationRecords) {
      const error = new Error('PayPal reconciliation service is unavailable.');
      error.statusCode = 503;
      throw error;
    }
  }

  function getRecordKey(payment = {}, recoveryId = '') {
    return safeString(payment.paymentId || recoveryId || createRecoveryId(payment));
  }

  function saveReconciliation(key, patch = {}) {
    const existing = reconciliationRecords.get(key) || {};
    const next = {
      ...existing,
      ...patch,
      reconciliationId: key,
      updatedAt: nowIso(),
      createdAt: existing.createdAt || nowIso(),
      attempts: Number(existing.attempts || 0) + (patch.incrementAttempt ? 1 : 0),
    };
    delete next.incrementAttempt;
    reconciliationRecords.set(key, next);
    return next;
  }

  async function findPaymentForRecovery(record = {}) {
    if (record.paymentId && paymentState.getPayment) {
      const byId = await paymentState.getPayment(record.paymentId).catch(() => null);
      if (byId) return byId;
    }
    if (record.paypalOrderId && paymentState.getByProviderTransaction) {
      const byOrder = await paymentState.getByProviderTransaction('paypal', record.paypalOrderId).catch(() => null);
      if (byOrder) return byOrder;
    }
    if (record.paypalCaptureId && paymentState.getByProviderTransaction) {
      const byCapture = await paymentState.getByProviderTransaction('paypal', record.paypalCaptureId).catch(() => null);
      if (byCapture) return byCapture;
    }
    return {
      paymentId: safeString(record.paymentId || record.paymentKey || record.recoveryId),
      provider: 'paypal',
      providerOrderId: safeString(record.paypalOrderId || record.orderId),
      providerTransactionId: safeString(record.paypalCaptureId || record.transactionId),
      expectedAmountCents: Number(record.expectedAmountCents || 0),
      expectedCurrency: safeString(record.currency, 'USD').toUpperCase(),
      customerId: safeString(record.customerId || record.customer?.id),
      state: safeString(record.state || record.status, 'recovery_required'),
      metadata: { trustedSnapshot: record.trustedCartSnapshot || null },
    };
  }

  function getTrustedSnapshot(payment = {}, recoveryRecord = {}) {
    return payment.metadata?.trustedSnapshot || payment.trustedCartSnapshot || recoveryRecord.trustedCartSnapshot || null;
  }

  async function verifySnapshot({ payment, recoveryRecord }) {
    const snapshot = getTrustedSnapshot(payment, recoveryRecord);
    if (!snapshot) return { ok: false, status: 'snapshot_missing', reason: 'trusted_snapshot_missing' };
    try {
      verifySnapshotHash(snapshot);
      if (safeString(snapshot.customerId) && safeString(payment.customerId) && safeString(snapshot.customerId) !== safeString(payment.customerId)) {
        return { ok: false, status: 'manual_review', reason: 'customer_mismatch' };
      }
      if (Number(payment.expectedAmountCents || 0) && Number(payment.expectedAmountCents) !== Number(snapshot.totalCents)) {
        return { ok: false, status: 'amount_mismatch', reason: 'snapshot_amount_mismatch' };
      }
      if (safeString(payment.expectedCurrency, snapshot.currency).toUpperCase() !== safeString(snapshot.currency).toUpperCase()) {
        return { ok: false, status: 'currency_mismatch', reason: 'snapshot_currency_mismatch' };
      }
      await revalidateSnapshot({ cache: await getCatalogCache(), snapshot });
      return { ok: true, snapshot };
    } catch (error) {
      return { ok: false, status: 'manual_review', reason: error.code || error.message };
    }
  }

  async function reconcilePayment({ payment, recoveryRecord = {}, apply = false, actor = 'system' } = {}) {
    requireReady();
    if (!payment) throw new Error('Payment is required for reconciliation.');
    if (safeString(payment.provider).toLowerCase() !== 'paypal') {
      return { status: 'skipped', reason: 'provider_not_paypal' };
    }
    if (payment.state === 'completed' && payment.shopifyOrderId) {
      return { status: 'already_completed', shopifyOrderId: payment.shopifyOrderId };
    }

    const recoveryId = safeString(recoveryRecord.recoveryId) || createRecoveryId(payment);
    const key = getRecordKey(payment, recoveryId);
    const existing = reconciliationRecords.get(key);
    if (existing?.status === 'recovered' && existing.shopifyOrderId) {
      return publicResult({ status: 'already_completed', shopifyOrderId: existing.shopifyOrderId, reconciliation: existing });
    }

    const run = async () => {
      saveReconciliation(key, {
        status: 'pending_verification',
        paymentId: safeString(payment.paymentId),
        recoveryId,
        provider: 'paypal',
        providerTransactionId: safeString(payment.providerTransactionId),
        expectedAmountCents: Number(payment.expectedAmountCents || 0),
        expectedCurrency: safeString(payment.expectedCurrency, 'USD').toUpperCase(),
        incrementAttempt: true,
      });

      const assigned = payment.providerTransactionId && paymentState.getByProviderTransaction
        ? await paymentState.getByProviderTransaction('paypal', payment.providerTransactionId).catch(() => null)
        : null;
      const verification = await paypalVerifier.verify({
        payment,
        expectedMerchantId,
        assignedCapturePayment: assigned,
      });
      saveReconciliation(key, { status: verification.verified ? 'provider_verified' : 'manual_review', verificationResult: verification });
      if (!verification.verified) return { status: verification.status, verification };

      const snapshotResult = await verifySnapshot({ payment, recoveryRecord });
      if (!snapshotResult.ok) {
        saveReconciliation(key, { status: 'manual_review', lastSafeError: snapshotResult.reason });
        return { status: snapshotResult.status, reason: snapshotResult.reason, verification };
      }

      const lookup = await shopifyLookup({
        payment,
        recoveryId,
        paypalOrderId: verification.paypalOrderId,
        paypalCaptureId: verification.captureId,
      });
      if (lookup?.found) {
        if (apply && paymentState.transitionPayment && payment.state !== 'completed') {
          await paymentState.transitionPayment(payment.paymentId, 'completed', {
            shopifyOrderId: safeString(lookup.shopifyOrderId),
            shopifyOrderName: safeString(lookup.shopifyOrderName),
          });
        }
        const reconciliation = saveReconciliation(key, {
          status: 'existing_order_found',
          shopifyLookup: lookup,
          shopifyOrderId: safeString(lookup.shopifyOrderId),
          completedAt: nowIso(),
        });
        return { status: 'already_completed', shopifyOrderId: lookup.shopifyOrderId, reconciliation, verification };
      }

      if (!apply) {
        return { status: 'would_create_order', verification, snapshotHash: snapshotResult.snapshot.snapshotHash };
      }

      const orderInput = {
        email: recoveryRecord.customer?.email || recoveryRecord.email || '',
        phone: recoveryRecord.customer?.phone || recoveryRecord.phone || '',
        name: recoveryRecord.customer?.name || recoveryRecord.name || 'NOOD Customer',
        total: snapshotResult.snapshot.total,
        cartItems: snapshotToCartItems(snapshotResult.snapshot),
        shippingAddress: recoveryRecord.shippingAddress || {},
        paymentTransactionId: verification.captureId,
        paymentMethod: 'PayPal',
        clientOrderId: recoveryRecord.orderId || payment.providerOrderId || payment.paymentId,
        currency: snapshotResult.snapshot.currency,
        paymentCurrency: snapshotResult.snapshot.currency,
        paymentAmount: snapshotResult.snapshot.total,
        pending: {
          currency: snapshotResult.snapshot.currency,
          cartItems: snapshotToCartItems(snapshotResult.snapshot),
          trustedCartSnapshot: snapshotResult.snapshot,
          paypalOrderId: verification.paypalOrderId,
          paymentId: payment.paymentId,
          recoveryId,
        },
      };

      saveReconciliation(key, { status: 'order_creating' });
      let shopifyOrder;
      try {
        shopifyOrder = await createShopifyOrder(orderInput);
      } catch (error) {
        const afterFailureLookup = await shopifyLookup({
          payment,
          recoveryId,
          paypalOrderId: verification.paypalOrderId,
          paypalCaptureId: verification.captureId,
        }).catch(() => null);
        if (afterFailureLookup?.found) {
          shopifyOrder = { id: afterFailureLookup.shopifyOrderId, name: afterFailureLookup.shopifyOrderName };
        } else {
          saveReconciliation(key, { status: 'manual_review', lastSafeError: error.message || 'shopify_order_create_failed' });
          return { status: 'manual_review', reason: 'shopify_order_create_failed' };
        }
      }

      if (!shopifyOrder?.id) {
        saveReconciliation(key, { status: 'manual_review', lastSafeError: 'missing_shopify_order_id' });
        return { status: 'manual_review', reason: 'missing_shopify_order_id' };
      }

      if (paymentState.transitionPayment && payment.paymentId) {
        await paymentState.transitionPayment(payment.paymentId, 'completed', {
          shopifyOrderId: safeString(shopifyOrder.id),
          shopifyOrderName: safeString(shopifyOrder.name),
          providerTransactionId: verification.captureId,
        });
      }

      const reconciliation = saveReconciliation(key, {
        status: 'recovered',
        shopifyOrderId: safeString(shopifyOrder.id),
        shopifyOrderName: safeString(shopifyOrder.name),
        completedAt: nowIso(),
      });
      return { status: 'recovered', shopifyOrder, reconciliation, verification };
    };

    if (!apply) return run();
    return lockService.withLock(`reconciliation:${key}`, lockTtlSeconds, run);
  }

  async function reconcileRecovery({ recoveryRecord, apply = false, actor = 'admin' } = {}) {
    const payment = await findPaymentForRecovery(recoveryRecord);
    return reconcilePayment({ payment, recoveryRecord, apply, actor });
  }

  return {
    reconcilePayment,
    reconcileRecovery,
  };
}

module.exports = {
  createPayPalReconciliationService,
};
