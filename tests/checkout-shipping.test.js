const assert = require('node:assert/strict');
let mode = 'valid', selected = [];
const id = require.resolve('axios');
require.cache[id] = { id, filename: id, loaded: true, exports: { post: async (_url, { query, variables }) => {
  const cost = { subtotalAmount: { amount: mode === 'changed' ? '110.00' : '100.00', currencyCode: 'TTD' }, totalAmount: { amount: '180.00', currencyCode: mode === 'currency' ? 'USD' : 'TTD' }, totalTaxAmount: { amount: '5.00', currencyCode: 'TTD' } };
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
  assert.equal(result.shipping, '75.00'); assert.equal(result.tax, '5.00'); assert.equal(result.total, '180.00');
  assert.equal(result.shippingLines[0].title, 'Standard'); assert.equal(selected[0].deliveryOptionHandle, 'standard');
  await assert.rejects(addShopifyShipping(quote, null), /complete shipping address/);
  for (const scenario of ['no-rate', 'changed', 'currency']) {
    mode = scenario; await assert.rejects(addShopifyShipping(quote, address));
  }
  console.log('Shipping checks passed: Shopify selection, shipping/tax total, missing address/rate, changed pricing and currency fail closed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
