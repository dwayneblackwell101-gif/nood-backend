const assert = require('node:assert/strict');
let mode = 'valid', selected = [];
const id = require.resolve('axios');
require.cache[id] = { id, filename: id, loaded: true, exports: { post: async (_url, { query, variables }) => {
  const cost = { subtotalAmount: { amount: mode === 'changed' ? '110.00' : '100.00', currencyCode: 'TTD' }, totalAmount: { amount: mode === 'changed' ? '115.00' : '105.00', currencyCode: mode === 'currency' ? 'USD' : 'TTD' }, totalTaxAmount: { amount: '5.00', currencyCode: 'TTD' } };
  const cart = { id: 'cart1', cost, lines: { nodes: [{ merchandise: { requiresShipping: true } }] } };
  if (query.includes('cartSelectedDeliveryOptionsUpdate')) {
    selected = variables.selectedDeliveryOptions;
    return { data: { data: { cartSelectedDeliveryOptionsUpdate: { cart, userErrors: [] } } } };
  }
  cart.deliveryGroups = { nodes: [{ id: 'group1', deliveryOptions: mode === 'no-rate' ? [] : [
    { handle: 'express', title: 'Express', estimatedCost: { amount: '120.00', currencyCode: 'TTD' } },
    { handle: 'standard', title: 'Standard', estimatedCost: { amount: '75.00', currencyCode: 'TTD' } },
  ] }] };
  return { data: { data: { cartCreate: { cart, userErrors: [] } } } };
} } };
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com'; process.env.SHOPIFY_STOREFRONT_TOKEN = 'test';
const { addShopifyShipping } = require('../services/checkout-shipping');
const quote = { lines: [{ variantId: 'variant1', quantity: 1 }], subtotal: '100.00', total: '100.00', currency: 'TTD' };
const address = { address1: '1 Test Street', city: 'Port of Spain', country: 'TT' };
(async () => {
  const result = await addShopifyShipping(quote, address);
  assert.equal(result.shipping, '0.00'); assert.equal(result.tax, '5.00'); assert.equal(result.total, '105.00');
  assert.equal(result.shippingIncluded, true); assert.equal(result.shippingLines.length, 0); assert.equal(selected.length, 0);
  mode = 'no-rate';
  assert.equal((await addShopifyShipping(quote, address)).total, '105.00');
  await assert.rejects(addShopifyShipping(quote, null), /complete shipping address/);
  for (const scenario of ['changed', 'currency']) {
    mode = scenario; await assert.rejects(addShopifyShipping(quote, address));
  }
  console.log('Included shipping checks passed: no added delivery charge or rate selection, tax preserved, complete address required, changed prices/currency rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
