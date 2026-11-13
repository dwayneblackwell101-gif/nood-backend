const assert = require('node:assert/strict');
const { countryCode } = require('../utils/shopify-country');
for (const input of ['TT', 'tt', 'Trinidad & Tobago', 'Trinidad and Tobago']) assert.equal(countryCode(input), 'TT');
assert.equal(countryCode('United States'), 'US');
assert.equal(countryCode('United States of America'), 'US');
assert.equal(countryCode('United Kingdom'), 'GB');
assert.throws(() => countryCode('not a country'), /not recognized/);
console.log('Shopify country checks passed.');
