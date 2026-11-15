const axios = require('axios');
const { countryCode } = require('../utils/shopify-country');
const { moneyToCents } = require('./catalog-pricing');
const failure = message => Object.assign(new Error(message), { statusCode: 409 });
const COST = `id cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } totalTaxAmount { amount currencyCode } }
  lines(first:100) { nodes { merchandise { ... on ProductVariant { requiresShipping } } } }`;

async function addShopifyShipping(quote, address) {
  if (!address?.address1 || !address?.city || !address?.country) throw failure('Add a complete shipping address before payment.');
  if (quote.coupon) throw failure('Coupon checkout is temporarily unavailable. Remove the code and try again.');
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim();
  const token = String(process.env.SHOPIFY_STOREFRONT_TOKEN || '').trim();
  if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(domain) || !token) throw failure('Shipping rates are temporarily unavailable.');
  const version = process.env.SHOPIFY_STOREFRONT_API_VERSION || '2026-04';
  const request = async (query, variables) => {
    const { data } = await axios.post(`https://${domain}/api/${version}/graphql.json`, { query, variables }, {
      headers: { 'X-Shopify-Storefront-Access-Token': token }, timeout: 20000,
    });
    if (data.errors?.length) throw failure('Shopify could not confirm shipping. Please try again.');
    return data.data;
  };
  const created = (await request(`mutation NoodShipping($input:CartInput!) { cartCreate(input:$input) {
    cart { ${COST} deliveryGroups(first:20) { nodes { id deliveryOptions { handle title estimatedCost { amount currencyCode } } } } }
    userErrors { message }
  } }`, { input: {
    lines: quote.lines.map(line => ({ merchandiseId: line.variantId, quantity: line.quantity })),
    buyerIdentity: { countryCode: countryCode(address.country), deliveryAddressPreferences: [{ deliveryAddress: {
      address1: String(address.address1), address2: String(address.address2 || ''), city: String(address.city),
      country: countryCode(address.country), province: String(address.region || address.state || ''),
      zip: String(address.postalCode || address.zip || ''),
    } }] },
  } })).cartCreate;
  if (created?.userErrors?.length || !created?.cart) throw failure('Shopify could not confirm your delivery address.');
  let cart = created.cart;
  // NOOD selling prices already include the ZQ Dropshipping shipping cost.
  // We still create the Shopify cart so variant prices, tax, and address validity
  // are confirmed, but we must never select or charge a Shopify delivery rate.
  const selected = [];
  const cost = cart.cost;
  if (cost?.totalAmount?.currencyCode !== quote.currency || cost?.subtotalAmount?.currencyCode !== quote.currency) {
    throw failure('Shopify changed the checkout currency. Please contact support before paying.');
  }
  const subtotal = moneyToCents(cost.subtotalAmount.amount);
  const total = moneyToCents(cost.totalAmount.amount);
  const shipping = selected.reduce((sum, { option }) => sum + moneyToCents(option.estimatedCost.amount), 0);
  const tax = cost.totalTaxAmount ? moneyToCents(cost.totalTaxAmount.amount) : 0;
  // Never charge a guessed total if Shopify changed prices or applied a discount
  // that the external-payment order cannot yet reproduce.
  if (subtotal !== moneyToCents(quote.subtotal) || total == null || tax == null || total !== subtotal + tax) {
    throw failure('Shopify changed this order’s price or discounts. Please refresh your cart before paying.');
  }
  return { ...quote, shipping: '0.00', tax: (tax / 100).toFixed(2), total: (total / 100).toFixed(2), shippingIncluded: true,
    shippingLines: selected.map(({ option }) => ({ title: option.title, amount: option.estimatedCost.amount })),
    shippingSource: 'shopify', quotedAt: new Date().toISOString() };
}
module.exports = { addShopifyShipping };
