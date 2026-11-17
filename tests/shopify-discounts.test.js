const assert = require('node:assert/strict');
const { normalize } = require('../services/shopify-discounts');
const now = Date.parse('2026-11-15T12:00:00Z');
const discount = { __typename: 'DiscountCodeBasic', title: 'Public sale', status: 'ACTIVE', startsAt: '2026-11-01T00:00:00Z', endsAt: null,
  context: { __typename: 'DiscountBuyerSelectionAll' }, customerGets: { items: { allItems: true } },
  appliesOncePerCustomer: false, usageLimit: null, codes: { nodes: [{ code: 'SAVE20' }] } };
const offer = (changes = {}) => normalize({ id: 'discount1', discount: { ...discount, ...changes } }, now);
assert.equal(offer().checkoutSupported, true); assert.equal(offer().code, 'SAVE20');
assert.equal(offer({ context: { __typename: 'DiscountCustomers' } }), null);
assert.equal(offer({ context: { __typename: 'DiscountCustomerSegments' } }), null);
assert.equal(offer({ endsAt: '2026-11-14T00:00:00Z' }), null);
assert.equal(offer({ startsAt: '2026-12-01T00:00:00Z' }), null);
assert.equal(offer({ status: 'EXPIRED' }), null);
assert.equal(offer({ appliesOncePerCustomer: true }).checkoutSupported, false);
assert.equal(offer({ usageLimit: 100 }).checkoutSupported, false);
assert.equal(offer({ customerGets: { items: { allItems: false } } }).checkoutSupported, false);
assert.equal(offer({ __typename: 'DiscountAutomaticBasic', codes: undefined }).checkoutSupported, false);
console.log('Discount checks passed: private/segment codes hidden, dates enforced, usage and product restrictions preserved.');
