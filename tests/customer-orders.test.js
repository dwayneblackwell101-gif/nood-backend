const assert = require('node:assert/strict');
const express = require('express');
let identity = null, responseId = 'gid://shopify/Customer/17', calls = [];
function mock(path, exports) { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; }
mock('../services/customer-auth', { authenticateCustomer: async () => identity });
mock('../services/shopify-admin-auth', { getAdminToken: async () => 'private-test-token' });
mock('axios', { post: async (_url, payload) => {
  calls.push(payload);
  return { data: { data: { customer: { id: responseId, orders: { nodes: [{
    id: 'gid://shopify/Order/9', name: '#1009', createdAt: '2026-11-15T00:00:00Z',
    displayFinancialStatus: 'PARTIALLY_REFUNDED', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: { shopMoney: { amount: '254.48', currencyCode: 'TTD' } },
    totalRefundedSet: { shopMoney: { amount: '10.00' } },
    lineItems: { nodes: [{ id: 'line1', title: 'Product', quantity: 2, variant: { id: 'variant1' }, originalUnitPriceSet: { shopMoney: { amount: '127.24', currencyCode: 'TTD' } } }] },
    fulfillments: [{ trackingInfo: [{ number: 'TRACK9', url: 'https://example.com/track/9' }] }],
  }] } } } } };
} });
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
const app = express(); app.use(require('../routes/customer-orders').router);
const server = app.listen(0, '127.0.0.1', async () => {
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/customer/orders?email=victim@example.com&customerId=999&limit=999`;
    assert.equal((await fetch(url)).status, 401); assert.equal(calls.length, 0);
    identity = { userId: 'gid://shopify/Customer/17' };
    const response = await fetch(url); const result = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(calls[0].variables, { id: identity.userId, first: 100 });
    assert.equal(result.orders[0].total, 254.48); assert.equal(result.orders[0].currency, 'TTD');
    assert.equal(result.orders[0].refundedAmount, 10); assert.equal(result.orders[0].trackingNumber, 'TRACK9');
    assert.equal(result.orders[0].items[0].price, 127.24);
    responseId = 'gid://shopify/Customer/999';
    assert.equal((await fetch(url)).status, 503);
    console.log('Customer order checks passed: authentication, owner-only lookup, query spoof rejection, bounded lookup, currency/refund/tracking mapping.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); }
});
