const axios = require('axios');
const { getAdminToken } = require('./shopify-admin-auth');
const COMMON = 'title summary status startsAt endsAt context { __typename }';
const BASIC = 'customerGets { items { __typename ... on AllDiscountItems { allItems } } }';
const QUERY = `query NoodOffers($after:String) { discountNodes(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { id discount { __typename
  ... on DiscountCodeBasic { ${COMMON} ${BASIC} appliesOncePerCustomer usageLimit codes(first:100){nodes{code}} }
  ... on DiscountAutomaticBasic { ${COMMON} ${BASIC} }
  ... on DiscountCodeFreeShipping { ${COMMON} codes(first:100){nodes{code}} }
  ... on DiscountCodeBxgy { ${COMMON} codes(first:100){nodes{code}} }
  ... on DiscountAutomaticBxgy { ${COMMON} }
} } } }`;
let cached, pending;
function normalize(node, now = Date.now()) {
  const d = node.discount;
  // Customer-specific/private codes must never be advertised to everyone.
  if (!d?.title || d.context?.__typename !== 'DiscountBuyerSelectionAll') return null;
  const active = d.status === 'ACTIVE' && Date.parse(d.startsAt) <= now && (!d.endsAt || Date.parse(d.endsAt) > now);
  if (!active) return null;
  const automatic = d.__typename.startsWith('DiscountAutomatic');
  const codes = (d.codes?.nodes || []).map(x => x.code).filter(Boolean);
  const basic = /Basic$/.test(d.__typename);
  // External payment cannot safely reproduce per-customer/global usage limits.
  const checkoutSupported = !automatic && basic && d.customerGets?.items?.allItems === true &&
    !d.appliesOncePerCustomer && d.usageLimit == null;
  return { id: node.id, title: d.title, summary: d.summary, valueLabel: d.summary || d.title,
    kind: /FreeShipping$/.test(d.__typename) ? 'free_shipping' : automatic ? 'automatic' : 'coupon',
    discountType: /Bxgy$/.test(d.__typename) ? 'bxgy' : /FreeShipping$/.test(d.__typename) ? 'free_shipping' : 'other',
    startsAt: d.startsAt, endsAt: d.endsAt, status: 'active', isActive: true,
    appliesAutomatically: automatic, code: codes[0] || null, codes, checkoutSupported,
  };
}
async function listDiscounts() {
  if (cached?.until > Date.now()) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim();
    if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(domain)) throw new Error('Discount connection is not configured');
    const result = []; let after = null;
    for (let page = 0; page < 20; page++) {
      const { data } = await axios.post(`https://${domain}/admin/api/${process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04'}/graphql.json`,
        { query: QUERY, variables: { after } }, { headers: { 'X-Shopify-Access-Token': await getAdminToken() }, timeout: 15000 });
      if (data.errors?.length) throw new Error('Shopify discount lookup is unavailable');
      const connection = data.data?.discountNodes;
      if (!connection) throw new Error('Shopify discount response is incomplete');
      result.push(...connection.nodes.map(node => normalize(node)).filter(Boolean));
      if (!connection.pageInfo.hasNextPage) { cached = { until: Date.now() + 30000, value: result }; return result; }
      after = connection.pageInfo.endCursor;
    }
    throw new Error('Shopify discount lookup exceeded its limit');
  })();
  try { return await pending; } finally { pending = null; }
}
async function validatePublicCode(code) {
  const offer = (await listDiscounts()).find(offer => offer.codes.some(value => value.toUpperCase() === code.toUpperCase()));
  if (!offer || !offer.checkoutSupported) throw Object.assign(new Error('This code is invalid, expired, or not supported for app checkout.'), { statusCode: 409 });
  return offer;
}
module.exports = { listDiscounts, validatePublicCode, normalize, QUERY };
