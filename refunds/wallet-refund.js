function createWalletRefundService({
  walletTransactions,
  persistWalletTransactions,
  safeMoney,
  safeString,
  defaultCurrency = 'TTD',
}) {
  function creditWalletRefund({
    requestId,
    customerId,
    customerEmail,
    amount,
    amountCents,
    currency,
    orderId,
    orderNumber,
  }) {
    const normalizedRequestId = safeString(requestId);
    const normalizedCustomerId = safeString(customerId || customerEmail).toLowerCase();
    const normalizedEmail = safeString(customerEmail).toLowerCase();
    const walletTransactionId = `refund_wallet_${normalizedRequestId}`;
    const creditAmount = Number.isSafeInteger(Number(amountCents))
      ? Number(amountCents) / 100
      : Number(safeMoney(amount));

    const existing = walletTransactions.get(walletTransactionId);
    if (existing) {
      if (
        safeString(existing.customerId).toLowerCase() !== normalizedCustomerId ||
        Number(safeMoney(existing.amount)) !== Number(safeMoney(creditAmount))
      ) {
        const error = new Error('Wallet refund idempotency conflict.');
        error.statusCode = 409;
        throw error;
      }
      console.log('[WALLET REFUND CREDITED]', {
        requestId: normalizedRequestId,
        duplicate: true,
        walletTransactionId,
      });
      return {
        credited: false,
        duplicate: true,
        walletTransactionId,
        balance: null,
      };
    }

    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
      throw new Error('Invalid wallet refund amount.');
    }

    const record = {
      walletTransactionId,
      provider: 'wallet_refund',
      transactionId: normalizedRequestId,
      orderId: safeString(orderId),
      orderNumber: safeString(orderNumber),
      customerId: normalizedCustomerId,
      customerEmail: normalizedEmail,
      amount: safeMoney(creditAmount),
      currency: safeString(currency, defaultCurrency).toUpperCase(),
      status: 'confirmed',
      type: 'refund_credit',
      createdAt: new Date().toISOString(),
    };

    walletTransactions.set(walletTransactionId, record);
    persistWalletTransactions();

    console.log('[WALLET REFUND CREDITED]', {
      requestId: normalizedRequestId,
      orderId: record.orderId,
      orderNumber: record.orderNumber,
      customerEmail: normalizedEmail,
      amount: record.amount,
      currency: record.currency,
      walletTransactionId,
    });

    return {
      credited: true,
      duplicate: false,
      walletTransactionId,
      record,
    };
  }

  return {
    creditWalletRefund,
  };
}

module.exports = {
  createWalletRefundService,
};
