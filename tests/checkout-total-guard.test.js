const assert = require('node:assert/strict');
const pricing = require('../services/catalog-pricing');
const id = require.resolve('../services/catalog-pricing');
require.cache[id].exports = { ...pricing, priceCart: async () => ({ lines: [], currency: 'TTD', subtotal: '100.00' }) };
const shippingId = require.resolve('../services/checkout-shipping');
require.cache[shippingId] = { id: shippingId, filename: shippingId, loaded: true, exports: {
  addShopifyShipping: async quote => ({ ...quote, total: '175.00', shipping: '75.00', shippingSource: 'shopify' }),
} };
const { quoteCart } = require('../services/promotions');
(async () => {
  const checkout = { shippingAddress: {}, enforceExpected: true, currency: 'TTD', total: '175.00' };
  assert.equal((await quoteCart([], null, null, checkout)).total, '175.00');
  await assert.rejects(quoteCart([], null, null, { ...checkout, total: '100.00' }), /total changed/);
  await assert.rejects(quoteCart([], null, null, { ...checkout, currency: 'USD' }), /total changed/);
  await assert.rejects(quoteCart([], null, null, { ...checkout, total: undefined }), /total changed/);
  console.log('Checkout total guard passed: requires the reviewed shipping-inclusive total and currency before payment.');
})().catch(error => { console.error(error); process.exitCode = 1; });
