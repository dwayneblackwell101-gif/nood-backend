const { adminGraphql } = require('./shopify');
const { safeString } = require('./transform');

const DISCOUNTS_QUERY = `
  query NoodActiveDiscounts($automaticCursor: String, $codeCursor: String) {
    automaticDiscountNodes(first: 25, after: $automaticCursor, query: "status:active") {
      edges {
        cursor
        node {
          id
          automaticDiscount {
            __typename
            ... on DiscountAutomaticBasic {
              title
              status
              startsAt
              endsAt
              summary
              customerGets {
                value {
                  __typename
                  ... on DiscountPercentage {
                    percentage
                  }
                  ... on DiscountAmount {
                    amount {
                      amount
                      currencyCode
                    }
                  }
                }
              }
              minimumRequirement {
                __typename
                ... on DiscountMinimumQuantity {
                  greaterThanOrEqualToQuantity
                }
                ... on DiscountMinimumSubtotal {
                  greaterThanOrEqualToSubtotal {
                    amount
                    currencyCode
                  }
                }
              }
            }
            ... on DiscountAutomaticBxgy {
              title
              status
              startsAt
              endsAt
              summary
            }
            ... on DiscountAutomaticFreeShipping {
              title
              status
              startsAt
              endsAt
              summary
              minimumRequirement {
                __typename
                ... on DiscountMinimumSubtotal {
                  greaterThanOrEqualToSubtotal {
                    amount
                    currencyCode
                  }
                }
                ... on DiscountMinimumQuantity {
                  greaterThanOrEqualToQuantity
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    codeDiscountNodes(first: 25, after: $codeCursor, query: "status:active") {
      edges {
        cursor
        node {
          id
          codeDiscount {
            __typename
            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt
              summary
              codes(first: 10) {
                edges {
                  node {
                    code
                  }
                }
              }
              customerGets {
                value {
                  __typename
                  ... on DiscountPercentage {
                    percentage
                  }
                  ... on DiscountAmount {
                    amount {
                      amount
                      currencyCode
                    }
                  }
                }
              }
              minimumRequirement {
                __typename
                ... on DiscountMinimumQuantity {
                  greaterThanOrEqualToQuantity
                }
                ... on DiscountMinimumSubtotal {
                  greaterThanOrEqualToSubtotal {
                    amount
                    currencyCode
                  }
                }
              }
            }
            ... on DiscountCodeBxgy {
              title
              status
              startsAt
              endsAt
              summary
              codes(first: 10) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
            ... on DiscountCodeFreeShipping {
              title
              status
              startsAt
              endsAt
              summary
              codes(first: 10) {
                edges {
                  node {
                    code
                  }
                }
              }
              minimumRequirement {
                __typename
                ... on DiscountMinimumSubtotal {
                  greaterThanOrEqualToSubtotal {
                    amount
                    currencyCode
                  }
                }
                ... on DiscountMinimumQuantity {
                  greaterThanOrEqualToQuantity
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

let cachedPayload = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function parseDate(value) {
  const raw = safeString(value);
  if (!raw) {
    return null;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getDiscountTiming(startsAt, endsAt) {
  const now = Date.now();
  const startMs = startsAt ? new Date(startsAt).getTime() : null;
  const endMs = endsAt ? new Date(endsAt).getTime() : null;

  if (endMs && endMs < now) {
    return { isActive: false, status: 'expired' };
  }

  if (startMs && startMs > now) {
    return { isActive: false, status: 'scheduled' };
  }

  return { isActive: true, status: 'active' };
}

function formatMinimumRequirement(minimumRequirement) {
  if (!minimumRequirement?.__typename) {
    return '';
  }

  if (minimumRequirement.__typename === 'DiscountMinimumQuantity') {
    const qty = Number(minimumRequirement.greaterThanOrEqualToQuantity || 0);
    return qty > 0 ? `Minimum ${qty} item${qty === 1 ? '' : 's'}` : '';
  }

  if (minimumRequirement.__typename === 'DiscountMinimumSubtotal') {
    const amount = minimumRequirement.greaterThanOrEqualToSubtotal;
    const value = Number(amount?.amount || 0);
    const currency = safeString(amount?.currencyCode, 'TTD');
    return value > 0 ? `Minimum order ${currency} ${value.toFixed(2)}` : '';
  }

  return '';
}

function formatCustomerGetsValue(customerGets) {
  const value = customerGets?.value;
  if (!value?.__typename) {
    return { discountType: 'other', valueLabel: 'Special offer', percentage: null, amount: null, currencyCode: null };
  }

  if (value.__typename === 'DiscountPercentage') {
    const percentage = Number(value.percentage || 0);
    const percentLabel = `${Math.round(percentage * 1000) / 10}% off`;
    return {
      discountType: 'percentage',
      valueLabel: percentLabel,
      percentage,
      amount: null,
      currencyCode: null,
    };
  }

  if (value.__typename === 'DiscountAmount') {
    const amount = Number(value.amount?.amount || 0);
    const currencyCode = safeString(value.amount?.currencyCode, 'TTD');
    return {
      discountType: 'fixed_amount',
      valueLabel: `${currencyCode} ${amount.toFixed(2)} off`,
      percentage: null,
      amount,
      currencyCode,
    };
  }

  return { discountType: 'other', valueLabel: 'Special offer', percentage: null, amount: null, currencyCode: null };
}

function extractCodes(codeDiscount) {
  const edges = codeDiscount?.codes?.edges || [];
  return edges.map((edge) => safeString(edge?.node?.code)).filter(Boolean);
}

function normalizeAutomaticDiscount(node) {
  const discount = node?.automaticDiscount;
  const typename = safeString(discount?.__typename);
  if (!discount || !typename) {
    return null;
  }

  const startsAt = parseDate(discount.startsAt);
  const endsAt = parseDate(discount.endsAt);
  const timing = getDiscountTiming(startsAt, endsAt);
  const minimumRequirement = formatMinimumRequirement(discount.minimumRequirement);
  const minQuantity =
    discount.minimumRequirement?.__typename === 'DiscountMinimumQuantity'
      ? Number(discount.minimumRequirement.greaterThanOrEqualToQuantity || 0)
      : null;

  if (typename === 'DiscountAutomaticFreeShipping') {
    return {
      id: safeString(node.id),
      title: safeString(discount.title, 'Free shipping'),
      summary: safeString(discount.summary),
      kind: 'free_shipping',
      discountType: 'free_shipping',
      valueLabel: 'Free shipping',
      code: null,
      codes: [],
      minimumRequirement,
      minQuantity,
      percentage: null,
      startsAt,
      endsAt,
      status: timing.status,
      isActive: timing.isActive && safeString(discount.status).toUpperCase() === 'ACTIVE',
      appliesAutomatically: true,
    };
  }

  if (typename === 'DiscountAutomaticBxgy') {
    return {
      id: safeString(node.id),
      title: safeString(discount.title, 'Buy more, save more'),
      summary: safeString(discount.summary),
      kind: 'automatic',
      discountType: 'bxgy',
      valueLabel: 'Buy more, save more',
      code: null,
      codes: [],
      minimumRequirement,
      minQuantity,
      percentage: null,
      startsAt,
      endsAt,
      status: timing.status,
      isActive: timing.isActive && safeString(discount.status).toUpperCase() === 'ACTIVE',
      appliesAutomatically: true,
    };
  }

  const value = formatCustomerGetsValue(discount.customerGets);

  return {
    id: safeString(node.id),
    title: safeString(discount.title, 'Automatic discount'),
    summary: safeString(discount.summary),
    kind: 'automatic',
    discountType: value.discountType,
    valueLabel: value.valueLabel,
    code: null,
    codes: [],
    minimumRequirement,
    minQuantity,
    percentage: value.percentage,
    startsAt,
    endsAt,
    status: timing.status,
    isActive: timing.isActive && safeString(discount.status).toUpperCase() === 'ACTIVE',
    appliesAutomatically: true,
  };
}

function normalizeCodeDiscount(node) {
  const discount = node?.codeDiscount;
  const typename = safeString(discount?.__typename);
  if (!discount || !typename) {
    return null;
  }

  const codes = extractCodes(discount);
  const startsAt = parseDate(discount.startsAt);
  const endsAt = parseDate(discount.endsAt);
  const timing = getDiscountTiming(startsAt, endsAt);
  const minimumRequirement = formatMinimumRequirement(discount.minimumRequirement);
  const minQuantity =
    discount.minimumRequirement?.__typename === 'DiscountMinimumQuantity'
      ? Number(discount.minimumRequirement.greaterThanOrEqualToQuantity || 0)
      : null;

  if (typename === 'DiscountCodeFreeShipping') {
    return {
      id: safeString(node.id),
      title: safeString(discount.title, 'Free shipping'),
      summary: safeString(discount.summary),
      kind: 'free_shipping',
      discountType: 'free_shipping',
      valueLabel: 'Free shipping',
      code: codes[0] || null,
      codes,
      minimumRequirement,
      minQuantity,
      percentage: null,
      startsAt,
      endsAt,
      status: timing.status,
      isActive: timing.isActive && safeString(discount.status).toUpperCase() === 'ACTIVE',
      appliesAutomatically: false,
    };
  }

  if (typename === 'DiscountCodeBxgy') {
    return {
      id: safeString(node.id),
      title: safeString(discount.title, 'Buy more, save more'),
      summary: safeString(discount.summary),
      kind: 'coupon',
      discountType: 'bxgy',
      valueLabel: 'Buy more, save more',
      code: codes[0] || null,
      codes,
      minimumRequirement,
      minQuantity,
      percentage: null,
      startsAt,
      endsAt,
      status: timing.status,
      isActive: timing.isActive && safeString(discount.status).toUpperCase() === 'ACTIVE',
      appliesAutomatically: false,
    };
  }

  const value = formatCustomerGetsValue(discount.customerGets);

  return {
    id: safeString(node.id),
    title: safeString(discount.title, 'Coupon'),
    summary: safeString(discount.summary),
    kind: 'coupon',
    discountType: value.discountType,
    valueLabel: value.valueLabel,
    code: codes[0] || null,
    codes,
    minimumRequirement,
    minQuantity,
    percentage: value.percentage,
    startsAt,
    endsAt,
    status: timing.status,
    isActive: timing.isActive && safeString(discount.status).toUpperCase() === 'ACTIVE',
    appliesAutomatically: false,
  };
}

async function fetchDiscountPage(automaticCursor = null, codeCursor = null) {
  const payload = await adminGraphql(
    DISCOUNTS_QUERY,
    {
      automaticCursor,
      codeCursor,
    },
    {
      requestedQueryCost: 40,
    }
  );

  const automaticEdges = payload?.data?.automaticDiscountNodes?.edges || [];
  const codeEdges = payload?.data?.codeDiscountNodes?.edges || [];

  const automatic = automaticEdges
    .map((edge) => normalizeAutomaticDiscount(edge?.node))
    .filter(Boolean);
  const coupons = codeEdges.map((edge) => normalizeCodeDiscount(edge?.node)).filter(Boolean);

  return {
    automatic,
    coupons,
    automaticPageInfo: payload?.data?.automaticDiscountNodes?.pageInfo || {},
    codePageInfo: payload?.data?.codeDiscountNodes?.pageInfo || {},
  };
}

async function fetchAllActiveDiscounts({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedPayload && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { ...cachedPayload, cached: true };
  }

  const automatic = [];
  const coupons = [];
  let automaticCursor = null;
  let codeCursor = null;
  let guard = 0;

  while (guard < 6) {
    const page = await fetchDiscountPage(automaticCursor, codeCursor);
    automatic.push(...page.automatic);
    coupons.push(...page.coupons);

    const automaticHasMore = Boolean(page.automaticPageInfo?.hasNextPage && page.automaticPageInfo?.endCursor);
    const codeHasMore = Boolean(page.codePageInfo?.hasNextPage && page.codePageInfo?.endCursor);

    automaticCursor = automaticHasMore ? page.automaticPageInfo.endCursor : null;
    codeCursor = codeHasMore ? page.codePageInfo.endCursor : null;

    if (!automaticCursor && !codeCursor) {
      break;
    }

    guard += 1;
  }

  const activeAutomatic = automatic.filter((entry) => entry.isActive);
  const activeCoupons = coupons.filter((entry) => entry.isActive);
  const activeShipping = [...activeAutomatic, ...activeCoupons].filter(
    (entry) => entry.kind === 'free_shipping'
  );
  const nonShippingAutomatic = activeAutomatic.filter((entry) => entry.kind !== 'free_shipping');
  const nonShippingCoupons = activeCoupons.filter((entry) => entry.kind !== 'free_shipping');

  const payload = {
    success: true,
    source: 'shopify',
    cached: false,
    fetchedAt: new Date().toISOString(),
    automatic: nonShippingAutomatic,
    coupons: nonShippingCoupons,
    shipping: activeShipping,
    all: [...nonShippingAutomatic, ...nonShippingCoupons, ...activeShipping],
  };

  cachedPayload = payload;
  cachedAt = Date.now();

  return payload;
}

function getDiscountsErrorCode(message) {
  const normalized = safeString(message).toLowerCase();

  if (normalized.includes('read_discounts')) {
    return 'SHOPIFY_DISCOUNTS_SCOPE_REQUIRED';
  }

  if (
    normalized.includes('missing shopify_store_domain') ||
    normalized.includes('missing shopify_admin_access_token')
  ) {
    return 'SHOPIFY_DISCOUNTS_NOT_CONFIGURED';
  }

  return 'SHOPIFY_DISCOUNTS_FETCH_FAILED';
}

function createDiscountsHandler() {
  return async function handleDiscountsRequest(req, res) {
    try {
      const forceRefresh = String(req.query?.refresh || '') === '1';
      const payload = await fetchAllActiveDiscounts({ forceRefresh });
      return res.json(payload);
    } catch (error) {
      const message = error.message || 'Could not load Shopify discounts.';
      console.error('[NOOD discounts] fetch failed:', message);

      return res.status(200).json({
        success: false,
        source: 'shopify',
        code: getDiscountsErrorCode(message),
        message,
        automatic: [],
        coupons: [],
        shipping: [],
        all: [],
      });
    }
  };
}

module.exports = {
  fetchAllActiveDiscounts,
  createDiscountsHandler,
};