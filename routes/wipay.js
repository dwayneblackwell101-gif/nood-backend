const express = require('express');
const crypto = require('crypto');
const wipay = require('../services/wipay');
const { savePayment, getPayment, claimPayment } = require('../utils/payment-state');
const { quoteCart } = require('../services/promotions');
const { moneyToCents } = require('../services/catalog-pricing');
const { authenticateCustomer } = require('../services/customer-auth');
const { applyWalletTxn } = require('../utils/reward-ledger');

module.exports = function createWiPayRouter({ createShopifyOrder, buildAppRedirect, baseUrl }) {
  const router = express.Router();
  const locks = new Set();
  function failure(res, error) {
    console.error('[WiPay]', error.message);
    return res.status(error.statusCode || 503).json({ success: false, message: error.message });
  }
  async function create(req, res, topup) {
    try {
      wipay.configuration();
      if (process.env.NODE_ENV === 'production' && !baseUrl.startsWith('https://')) throw new Error('WiPay requires an HTTPS BACKEND_BASE_URL');
      const body = req.body || {};
      const identity = await authenticateCustomer(req);
      if (topup && !identity) return res.status(401).json({ success: false, message: 'Sign in to top up your wallet' });
      if (body.couponCode) return res.status(400).json({ success: false, message: 'Use PayPal or Wallet for coupon checkout' });
      const quote = topup ? null : await quoteCart(body.cartItems || body.cart, null, identity?.userId);
      const cents = topup ? moneyToCents(body.amount) : moneyToCents(quote.total);
      const currency = topup ? String(body.currency || 'USD').toUpperCase() : quote.currency;
      if (!cents || cents < (currency === 'TTD' ? 500 : 100) || (topup && cents > Number(process.env.WALLET_TOPUP_MAX_CENTS || 50000)) ||
          !['USD', 'TTD'].includes(currency) || (topup && currency !== 'USD')) {
        return res.status(400).json({ success: false, message: 'WiPay minimum is TTD 5.00 or USD 1.00; wallet top-ups must use USD and stay within the top-up limit' });
      }
      const id = `nood_${crypto.randomUUID()}`;
      const token = crypto.randomBytes(32).toString('hex');
      const session = { provider_order_id: id, provider: topup ? 'wipay_wallet_topup' : 'wipay',
        user_id: identity?.userId || null, status: 'created', amount: (cents / 100).toFixed(2), currency,
        cart: quote?.lines || [], quote,
        customer: { name: String(body.name || 'NOOD Customer'), email: String(identity?.email || body.email || ''),
          phone: String(body.phone || ''), returnToken: token }, shipping_address: body.shippingAddress || {},
        updated_at: new Date().toISOString() };
      await savePayment(session);
      const url = await wipay.requestPayment(session, `${baseUrl}/payment-return?order_id=${encodeURIComponent(id)}&return_token=${token}`);
      return res.json({ success: true, url, payment_url: url, order_id: id });
    } catch (error) { return failure(res, error); }
  }
  router.post('/create-wipay-payment', (req, res) => create(req, res, false));
  router.post('/create-wallet-topup', (req, res) => create(req, res, true));
  router.post('/wallet/topup', (req, res) => {
    if (req.body?.provider === 'paypal') return res.redirect(307, '/api/wallet/paypal/orders');
    return create(req, res, true);
  });
  router.get('/payment-return', async (req, res) => {
    const id = typeof req.query.order_id === 'string' ? req.query.order_id : '';
    let verified = false;
    let acquired = false;
    const redirect = (params) => res.redirect(buildAppRedirect('payment-result', { method: 'wipay', order_id: id, ...params }));
    try {
      const session = await getPayment(id);
      if (!session || !['wipay', 'wipay_wallet_topup'].includes(session.provider) ||
          typeof req.query.return_token !== 'string' || req.query.return_token !== session.customer.returnToken) {
        return redirect({ status: 'failed', reason: 'invalid_payment_session' });
      }
      if (!wipay.verifyResponse(req.query, session, wipay.configuration().key)) {
        return redirect({ status: 'failed', reason: 'payment_not_verified' });
      }
      verified = true;
      if (locks.has(id)) return redirect({ status: 'payment_received_order_review', reason: 'payment_processing' });
      locks.add(id); acquired = true;
      const transaction = req.query.transaction_id;
      if (session.capture_id && session.capture_id !== transaction) throw new Error('Payment reference mismatch');
      if (session.status !== 'completed') {
        if (!(await claimPayment(id, transaction))) {
          return redirect({ status: 'payment_received_order_review', reason: 'fulfillment_already_claimed', transaction_id: transaction });
        }
        if (session.provider === 'wipay_wallet_topup') {
          const credit = await applyWalletTxn({ user_id: session.user_id, amount: Number(session.amount), currency: session.currency,
            type: 'credit', source: 'topup', reference: transaction, idempotency_key: `wipay-topup:${transaction}` });
          if (!credit.ok && !credit.replay) throw new Error('Wallet credit needs review');
          session.wallet_transaction_id = credit.txnId; session.wallet_balance = credit.balance;
        } else {
          session.shopify_order = await createShopifyOrder({ ...session.customer, total: session.amount, currency: session.currency,
            cartItems: session.cart, pricedCart: session.quote, gateway: 'WiPay', paymentTransactionId: transaction,
            clientOrderId: id, shippingAddress: session.shipping_address, userId: session.user_id });
        }
        await savePayment({ ...session, status: 'completed', capture_id: transaction, updated_at: new Date().toISOString() });
      }
      return redirect({ status: 'success', type: session.provider === 'wipay_wallet_topup' ? 'wallet_topup' : 'checkout',
        transaction_id: transaction, amount: session.amount, currency: session.currency,
        shopify_order_id: session.shopify_order?.id, shopify_order_name: session.shopify_order?.name });
    } catch (error) {
      console.error('[WiPay return]', error.message);
      return redirect({ status: verified ? 'payment_received_order_review' : 'failed', reason: verified ? 'fulfillment_needs_review' : 'verification_failed' });
    } finally { if (acquired) locks.delete(id); }
  });
  return router;
};

