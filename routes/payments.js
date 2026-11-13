const express = require('express');
const crypto = require('crypto');
const { createShopifyOrder } = require('../server');
const { priceCart, moneyToCents } = require('../services/catalog-pricing');
const paypal = require('../services/paypal');
const { quotePayPalSettlement } = require('../services/paypal-currency');
const { savePayment, getPayment } = require('../utils/payment-state');
const { authenticateCustomer } = require('../services/customer-auth');
const { applyWalletTxn } = require('../utils/reward-ledger');
const { quoteCart, reserveCoupon, finalizeCoupon, releaseCoupon } = require('../services/promotions');

const router = express.Router();
const safeString = (value) => String(value ?? '').trim();

function errorResponse(res, error, fallback) {
  const status = Number(error?.statusCode || error?.response?.status || 500);
  const detail = error?.response?.data?.details?.[0];
  const message = detail?.description || error?.response?.data?.message || error?.message || fallback;
  return res.status(status >= 400 && status < 600 ? status : 500).json({ success: false, message });
}

async function identity(req) {
  return authenticateCustomer(req);
}

function customerFrom(body, resolved) {
  return {
    name: safeString(body.name) || 'NOOD Customer',
    email: safeString(resolved?.email || body.email),
    phone: safeString(body.phone),
  };
}

function captureSummary(data) {
  const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    id: safeString(capture?.id),
    status: safeString(capture?.status).toUpperCase(),
    amount: safeString(capture?.amount?.value),
    currency: safeString(capture?.amount?.currency_code).toUpperCase(),
  };
}

router.post('/api/orders', async (req, res) => {
  let reference = '';
  let reserved = false;
  try {
    const body = req.body || {};
    const resolved = await identity(req);
    const trusted = await quoteCart(body.cartItems || body.cart, body.couponCode, resolved?.userId);
    reference = safeString(body.clientOrderId || body.checkoutSessionId) || `nood_${crypto.randomUUID()}`;
    if (trusted.coupon) {
      await reserveCoupon({ coupon: trusted.coupon, userId: resolved.userId, reference });
      reserved = true;
    }
    const settlement = await quotePayPalSettlement(trusted);
    trusted.paypalSettlement = settlement;
    const order = await paypal.createOrder({ amount: settlement.amount, currency: settlement.currency, reference });
    if (!order?.id || order.status !== 'CREATED') throw new Error('PayPal did not create the order');
    await savePayment({
      provider_order_id: order.id, provider: 'paypal', user_id: resolved?.userId || null, status: 'created',
      amount: trusted.total, currency: trusted.currency, cart: trusted.lines, quote: trusted,
      coupon_reference: trusted.coupon ? reference : null,
      customer: customerFrom(body, resolved), shipping_address: body.shippingAddress || {},
      updated_at: new Date().toISOString(),
    });
    return res.status(201).json({ id: order.id, status: order.status, intent: order.intent, links: order.links || [], settlement });
  } catch (error) {
    if (reserved && reference) await releaseCoupon(reference).catch(() => {});
    console.error('[PAYPAL CREATE] failed:', error.response?.data || error.message);
    return errorResponse(res, error, 'Unable to create PayPal order');
  }
});

router.post('/api/orders/:id/capture', async (req, res) => {
  const paypalOrderId = safeString(req.params.id);
  let session = null;
  let paymentCaptured = false;
  try {
    session = await getPayment(paypalOrderId);
    if (!session || session.provider !== 'paypal') return res.status(404).json({ success: false, message: 'Payment session not found' });
    if (session.user_id) {
      const resolved = await identity(req);
      if (!resolved || resolved.userId !== session.user_id) {
        return res.status(403).json({ success: false, message: 'Payment session does not belong to this customer' });
      }
    }
    if (session.shopify_order) {
      return res.json({ success: true, captureId: session.capture_id, orderId: paypalOrderId,
        shopify_order_id: session.shopify_order.id, shopify_order_name: session.shopify_order.name,
        shopify_order: session.shopify_order, replay: true });
    }

    const expectedSettlement = session.quote?.paypalSettlement || { amount: session.amount, currency: session.currency };
    let summary;
    if (session.status === 'captured' && session.capture_id) {
      summary = { id: session.capture_id, status: 'COMPLETED', amount: session.quote?.paypalSettlement?.amount || session.amount, currency: session.quote?.paypalSettlement?.currency || session.currency };
      paymentCaptured = true;
    } else {
      const captured = await paypal.captureOrder(paypalOrderId);
      summary = captureSummary(captured);
      if (summary.status !== 'COMPLETED' || !summary.id) throw Object.assign(new Error('PayPal payment was not completed'), { statusCode: 409 });
      paymentCaptured = true;
      if (moneyToCents(summary.amount) !== moneyToCents(expectedSettlement.amount) || summary.currency !== expectedSettlement.currency) {
        throw Object.assign(new Error('PayPal captured amount or currency does not match the trusted order'), { statusCode: 409 });
      }
      session = { ...session, status: 'captured', capture_id: summary.id, updated_at: new Date().toISOString() };
      await savePayment(session);
    }
    const settlement = session.quote?.paypalSettlement || { amount: session.amount, currency: session.currency };
    if (moneyToCents(summary.amount) !== moneyToCents(settlement.amount) || summary.currency !== settlement.currency) {
      throw Object.assign(new Error('PayPal captured amount or currency does not match the trusted order'), { statusCode: 409 });
    }
    if (session.coupon_reference) await finalizeCoupon(session.coupon_reference, paypalOrderId);

    const shopifyOrder = await createShopifyOrder({
      ...session.customer, total: session.amount, currency: session.currency,
      cartItems: session.cart, pricedCart: session.quote || { lines: session.cart, subtotal: session.amount, total: session.amount, currency: session.currency },
      gateway: 'PayPal', paymentTransactionId: summary.id, clientOrderId: paypalOrderId,
      shippingAddress: session.shipping_address,
    });
    await savePayment({ ...session, status: 'completed', capture_id: summary.id, shopify_order: shopifyOrder, updated_at: new Date().toISOString() });
    return res.json({ success: true, captureId: summary.id, orderId: paypalOrderId,
      shopify_order_id: shopifyOrder.id, shopify_order_name: shopifyOrder.name, shopify_order: shopifyOrder });
  } catch (error) {
    console.error('[PAYPAL CAPTURE] failed:', error.response?.data || error.message);
    if (paymentCaptured) {
      return res.status(409).json({ success: false, payment_received: true,
        status: 'payment_received_order_review', transaction_id: session?.capture_id || '',
        order_id: paypalOrderId, message: 'Payment was received, but the Shopify order needs review. Do not pay again.' });
    }
    return errorResponse(res, error, 'PayPal capture failed');
  }
});

router.post('/api/wallet/checkout', async (req, res) => {
  let debit = null;
  let resolved = null;
  let trusted = null;
  let shopifyOrder = null;
  const body = req.body || {};
  const reference = safeString(body.clientOrderId || body.checkoutSessionId);
  const stateKey = reference ? `wallet:${reference}` : '';
  try {
    resolved = await identity(req);
    if (!resolved) return res.status(401).json({ success: false, message: 'Signed-in identity required' });
    if (!reference) return res.status(400).json({ success: false, message: 'Checkout session ID is required' });

    const existing = await getPayment(stateKey);
    if (existing?.shopify_order) {
      return res.json({ success: true, transaction_id: existing.capture_id, wallet_balance: existing.wallet_balance,
        shopify_order_id: existing.shopify_order.id, shopify_order_name: existing.shopify_order.name,
        shopify_order: existing.shopify_order, replay: true });
    }
    if (existing?.status === 'reversed') {
      return res.status(409).json({ success: false, message: 'This checkout attempt was reversed. Start checkout again.' });
    }
    if (existing?.status === 'debited' && existing.quote && existing.capture_id) {
      trusted = existing.quote;
      debit = { ok: true, replay: true, txnId: existing.capture_id, balance: existing.wallet_balance };
    } else {
      trusted = await quoteCart(body.cartItems, body.couponCode, resolved.userId);
      if (trusted.coupon) await reserveCoupon({ coupon: trusted.coupon, userId: resolved.userId, reference });
      debit = await applyWalletTxn({
        user_id: resolved.userId, amount: -Number(trusted.total), currency: trusted.currency,
        type: 'debit', source: 'order_payment', reference,
        idempotency_key: `wallet-checkout:${resolved.userId}:${reference}`,
        metadata: { checkoutSessionId: reference },
      });
      if (!debit.ok && !debit.replay) {
        const status = debit.error === 'insufficient_balance' ? 409 : 500;
        return res.status(status).json({ success: false,
          message: debit.error === 'insufficient_balance' ? 'Insufficient wallet balance' : 'Wallet debit failed',
          wallet_balance: debit.balance });
      }
      await savePayment({ provider_order_id: stateKey, provider: 'wallet', user_id: resolved.userId,
        status: 'debited', amount: trusted.total, currency: trusted.currency, cart: trusted.lines, quote: trusted,
        customer: customerFrom(body, resolved), shipping_address: body.shippingAddress || {},
        capture_id: debit.txnId, wallet_balance: debit.balance, updated_at: new Date().toISOString() });
    }

    shopifyOrder = await createShopifyOrder({
      ...customerFrom(body, resolved), total: trusted.total, currency: trusted.currency,
      cartItems: trusted.lines, pricedCart: trusted, gateway: 'NOOD Wallet',
      paymentTransactionId: debit.txnId, clientOrderId: reference, shippingAddress: body.shippingAddress,
      userId: resolved.userId,
    });
    await savePayment({ provider_order_id: stateKey, provider: 'wallet', user_id: resolved.userId,
      status: 'completed', amount: trusted.total, currency: trusted.currency, cart: trusted.lines, quote: trusted,
      customer: customerFrom(body, resolved), shipping_address: body.shippingAddress || {},
      capture_id: debit.txnId, shopify_order: shopifyOrder, wallet_balance: debit.balance,
      updated_at: new Date().toISOString() });
    if (trusted.coupon) await finalizeCoupon(reference, shopifyOrder.id).catch((error) => {
      console.error('[WALLET CHECKOUT] coupon finalization needs reconciliation:', error.message);
    });
    return res.json({ success: true, transaction_id: debit.txnId, wallet_balance: debit.balance,
      shopify_order_id: shopifyOrder.id, shopify_order_name: shopifyOrder.name, shopify_order: shopifyOrder });
  } catch (error) {
    if (shopifyOrder && debit) {
      console.error('[WALLET CHECKOUT] post-order persistence needs reconciliation:', error.message);
      return res.json({ success: true, transaction_id: debit.txnId, wallet_balance: debit.balance,
        shopify_order_id: shopifyOrder.id, shopify_order_name: shopifyOrder.name, shopify_order: shopifyOrder,
        reconciliation_pending: true });
    }
    if (debit?.ok && resolved && trusted) {
      const reversal = await applyWalletTxn({
        user_id: resolved.userId, amount: Number(trusted.total), currency: trusted.currency,
        type: 'reversal', source: 'reversal', reference,
        idempotency_key: `wallet-checkout-reversal:${resolved.userId}:${reference}`,
        reverses_transaction_id: debit.txnId, metadata: { reason: 'shopify_order_failed' },
      });
      if (!reversal.ok && !reversal.replay) console.error('[WALLET CHECKOUT] reversal failed:', reversal.error);
      if (reversal.ok || reversal.replay) {
        await savePayment({ provider_order_id: stateKey, provider: 'wallet', user_id: resolved.userId,
          status: 'reversed', amount: trusted.total, currency: trusted.currency, cart: trusted.lines, quote: trusted,
          customer: customerFrom(body, resolved), shipping_address: body.shippingAddress || {},
          capture_id: debit.txnId, wallet_balance: reversal.balance, updated_at: new Date().toISOString() }).catch(() => {});
      }
    }
    if (trusted?.coupon && reference) await releaseCoupon(reference).catch(() => {});
    console.error('[WALLET CHECKOUT] failed:', error.response?.data || error.message);
    return errorResponse(res, error, 'Wallet checkout failed; any debit was reversed');
  }
});

router.post('/api/wallet/paypal/orders', async (req, res) => {
  try {
    const resolved = await identity(req);
    if (!resolved) return res.status(401).json({ success: false, message: 'Signed-in identity required' });
    const amountCents = moneyToCents(req.body?.amount);
    const currency = safeString(req.body?.currency || 'USD').toUpperCase();
    const maxCents = Number(process.env.WALLET_TOPUP_MAX_CENTS || 50000);
    if (!amountCents || amountCents < 100 || amountCents > maxCents || currency !== 'USD') {
      return res.status(400).json({ success: false, message: `Top-up must be between USD 1.00 and USD ${(maxCents / 100).toFixed(2)}` });
    }
    const reference = `wallet-topup-${resolved.userId}-${crypto.randomUUID()}`;
    const amount = (amountCents / 100).toFixed(2);
    const order = await paypal.createOrder({ amount, currency, reference });
    const approvalUrl = order?.links?.find((link) => link.rel === 'approve')?.href || '';
    if (!order?.id || !approvalUrl) throw new Error('PayPal did not return an approval URL');
    await savePayment({ provider_order_id: order.id, provider: 'paypal_wallet_topup', user_id: resolved.userId,
      status: 'created', amount, currency, cart: [], customer: customerFrom(req.body || {}, resolved),
      shipping_address: {}, updated_at: new Date().toISOString() });
    return res.status(201).json({ success: true, id: order.id, order_id: order.id, approval_url: approvalUrl, status: order.status });
  } catch (error) {
    console.error('[PAYPAL TOPUP CREATE] failed:', error.response?.data || error.message);
    return errorResponse(res, error, 'Unable to create PayPal wallet top-up');
  }
});

router.post('/api/wallet/paypal/orders/:id/capture', async (req, res) => {
  try {
    const resolved = await identity(req);
    if (!resolved) return res.status(401).json({ success: false, message: 'Signed-in identity required' });
    const orderId = safeString(req.params.id);
    const session = await getPayment(orderId);
    if (!session || session.provider !== 'paypal_wallet_topup' || session.user_id !== resolved.userId) {
      return res.status(404).json({ success: false, message: 'Wallet top-up session not found' });
    }
    if (session.status === 'completed' && session.capture_id) {
      return res.json({ success: true, idempotent: true, transaction_id: session.capture_id,
        wallet_transaction_id: session.wallet_transaction_id, amount: session.amount,
        currency: session.currency, wallet_balance: session.wallet_balance, status: 'COMPLETED' });
    }
    const captured = await paypal.captureOrder(orderId);
    const summary = captureSummary(captured);
    if (summary.status !== 'COMPLETED' || moneyToCents(summary.amount) !== moneyToCents(session.amount) || summary.currency !== session.currency) {
      throw Object.assign(new Error('PayPal top-up verification failed'), { statusCode: 409 });
    }
    const credit = await applyWalletTxn({
      user_id: resolved.userId, amount: Number(session.amount), currency: session.currency,
      type: 'credit', source: 'topup', reference: summary.id,
      idempotency_key: `paypal-topup:${orderId}`, metadata: { paypalOrderId: orderId, paypalCaptureId: summary.id },
    });
    if (!credit.ok && !credit.replay) throw new Error('Wallet credit failed');
    await savePayment({ ...session, status: 'completed', capture_id: summary.id,
      wallet_transaction_id: credit.txnId, wallet_balance: credit.balance, updated_at: new Date().toISOString() });
    return res.json({ success: true, idempotent: Boolean(credit.replay), transaction_id: summary.id,
      wallet_transaction_id: credit.txnId, amount: session.amount, currency: session.currency,
      wallet_balance: credit.balance, status: 'COMPLETED' });
  } catch (error) {
    console.error('[PAYPAL TOPUP CAPTURE] failed:', error.response?.data || error.message);
    return errorResponse(res, error, 'Unable to capture PayPal wallet top-up');
  }
});

module.exports = { router, captureSummary };
