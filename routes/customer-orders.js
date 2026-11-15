const express = require('express');
const axios = require('axios');
const { authenticateCustomer } = require('../services/customer-auth');
const { getAdminToken } = require('../services/shopify-admin-auth');
const router = express.Router();

// Scope the query to the verified customer, never an email or ID supplied by the app.
const QUERY = `query NoodCustomerOrders($id: ID!, $first: Int!) {
  customer(id: $id) { id orders(first: $first, sortKey: CREATED_AT, reverse: true) {
    nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt cancelReason
      totalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      lineItems(first: 100) { nodes { id title quantity variantTitle originalUnitPriceSet { shopMoney { amount currencyCode } } image { url } variant { id } } }
      fulfillments { status trackingInfo { company number url } }
    }
  } }
}`;

function serializeOrder(order) {
  const financial = order.displayFinancialStatus;
  const fulfillment = order.displayFulfillmentStatus;
  const tracking = (order.fulfillments || []).flatMap(entry => entry.trackingInfo || [])[0];
  return {
    id: order.id, shopifyOrderId: order.id, shopifyOrderName: order.name,
    date: order.createdAt, createdAt: order.createdAt,
    total: Number(order.totalPriceSet?.shopMoney?.amount || 0),
    currency: order.totalPriceSet?.shopMoney?.currencyCode || 'TTD',
    status: order.cancelledAt ? 'Cancelled' : financial === 'REFUNDED' ? 'Refunded' : fulfillment === 'FULFILLED' ? 'Shipped' : 'Processing',
    paymentMethod: 'Checkout', financialStatus: financial, displayFinancialStatus: financial,
    fulfillmentStatus: fulfillment, cancelledAt: order.cancelledAt, cancelReason: order.cancelReason,
    refunded: financial === 'REFUNDED', refundedAmount: Number(order.totalRefundedSet?.shopMoney?.amount || 0),
    trackingNumber: tracking?.number, trackingUrl: tracking?.url, carrier: tracking?.company,
    fulfillments: order.fulfillments || [], source: 'shopify',
    items: (order.lineItems?.nodes || []).map(item => ({
      id: item.id, title: item.title, quantity: item.quantity, variantTitle: item.variantTitle,
      variantId: item.variant?.id, image: item.image?.url,
      price: Number(item.originalUnitPriceSet?.shopMoney?.amount || 0),
      currency: item.originalUnitPriceSet?.shopMoney?.currencyCode || 'TTD',
    })),
  };
}

router.get('/api/customer/orders', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const customer = await authenticateCustomer(req);
    if (!customer || !/^gid:\/\/shopify\/Customer\/\d+$/.test(customer.userId)) {
      return res.status(401).json({ success: false, message: 'Please sign in to view your orders.' });
    }
    const first = Math.max(1, Math.min(100, Math.trunc(Number(req.query.limit) || 50)));
    const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)) throw new Error('Store unavailable');
    const version = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';
    const { data } = await axios.post(`https://${domain}/admin/api/${version}/graphql.json`, {
      query: QUERY, variables: { id: customer.userId, first },
    }, { headers: { 'X-Shopify-Access-Token': await getAdminToken() }, timeout: 15000 });
    if (data.errors?.length || data.data?.customer?.id !== customer.userId) throw new Error('Order lookup unavailable');
    return res.json({ success: true, orders: (data.data.customer.orders?.nodes || []).map(serializeOrder) });
  } catch (error) {
    console.error('[CUSTOMER ORDERS] lookup failed:', error.message);
    return res.status(503).json({ success: false, message: 'Your orders are temporarily unavailable. Please try again.' });
  }
});
module.exports = { router, serializeOrder };
