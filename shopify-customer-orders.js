const { adminGraphql } = require('./catalog/shopify');
const { getShopifyOrderAccessToken } = require('./shopify-order-access');

const CUSTOMER_ORDERS_QUERY = `
  query CustomerOrders($query: String!, $first: Int!, $after: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          email
          createdAt
          cancelledAt
          cancelReason
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 50) {
            edges {
              node {
                title
                quantity
                variant {
                  id
                  title
                  image {
                    url
                  }
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
          fulfillments(first: 10) {
            status
            trackingInfo {
              number
              url
              company
            }
          }
          refunds {
            createdAt
            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
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

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function mapFinancialStatus(status) {
  const normalized = safeString(status).toUpperCase();

  if (normalized.includes('REFUND')) {
    return 'Refunded';
  }
  if (normalized.includes('VOID') || normalized.includes('CANCEL')) {
    return 'Cancelled';
  }
  if (normalized.includes('PAID')) {
    return 'Paid';
  }
  if (normalized.includes('PENDING')) {
    return 'Processing';
  }

  return status || 'Processing';
}

function mapFulfillmentStatus(status, trackingNumber = '') {
  const normalized = safeString(status).toUpperCase();

  if (normalized.includes('FULFILLED')) {
    return trackingNumber ? 'Shipped' : 'Delivered';
  }
  if (normalized.includes('PARTIAL')) {
    return 'Partially shipped';
  }
  if (normalized.includes('UNFULFILLED') || normalized.includes('OPEN')) {
    return 'Preparing shipment';
  }

  return status || 'Preparing shipment';
}

function mapShopifyOrderNode(node) {
  const lineItems = (node?.lineItems?.edges || [])
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((item) => ({
      title: safeString(item.title, 'Product'),
      quantity: Number(item.quantity || 1),
      price: Number(item?.originalUnitPriceSet?.shopMoney?.amount || 0),
      currency: safeString(item?.originalUnitPriceSet?.shopMoney?.currencyCode, 'TTD'),
      variantId: safeString(item?.variant?.id),
      variantTitle: safeString(item?.variant?.title),
      image: safeString(item?.variant?.image?.url),
    }));

  const fulfillments = Array.isArray(node?.fulfillments) ? node.fulfillments : [];
  const primaryTracking = fulfillments
    .flatMap((fulfillment) =>
      Array.isArray(fulfillment?.trackingInfo) ? fulfillment.trackingInfo : []
    )
    .find((entry) => safeString(entry?.number));

  const refunds = Array.isArray(node?.refunds) ? node.refunds : [];
  const refundedAmount = refunds.reduce((sum, refund) => {
    const amount = Number(refund?.totalRefundedSet?.shopMoney?.amount || 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  const financialStatus = safeString(node?.displayFinancialStatus);
  const fulfillmentStatus = safeString(node?.displayFulfillmentStatus);
  const trackingNumber = safeString(primaryTracking?.number);
  const cancelledAt = safeString(node?.cancelledAt);

  let status = mapFinancialStatus(financialStatus);
  if (cancelledAt) {
    status = 'Cancelled';
  }

  return {
    id: safeString(node?.name) || safeString(node?.id),
    date: safeString(node?.createdAt) || new Date().toISOString(),
    total: Number(node?.totalPriceSet?.shopMoney?.amount || 0),
    currency: safeString(node?.totalPriceSet?.shopMoney?.currencyCode, 'TTD'),
    status,
    paymentMethod: 'Shopify',
    shopifyOrderId: safeString(node?.id),
    shopifyOrderName: safeString(node?.name),
    refunded: status === 'Refunded' || refundedAmount > 0,
    financialStatus,
    fulfillmentStatus: mapFulfillmentStatus(fulfillmentStatus, trackingNumber),
    trackingNumber,
    trackingUrl: safeString(primaryTracking?.url),
    carrier: safeString(primaryTracking?.company),
    cancelledAt: cancelledAt || undefined,
    cancelReason: safeString(node?.cancelReason) || undefined,
    refundedAmount,
    fulfillments,
    items: lineItems,
    source: 'shopify',
  };
}

async function fetchShopifyCustomerOrders({ email, customerId, limit = 50 }) {
  const normalizedEmail = safeString(email).toLowerCase();
  const normalizedCustomerId = safeString(customerId);

  if (!normalizedEmail && !normalizedCustomerId) {
    return [];
  }

  const accessToken = getShopifyOrderAccessToken();
  if (!accessToken) {
    throw new Error('Missing SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN for customer order sync.');
  }

  const queryParts = [];
  if (normalizedEmail) {
    queryParts.push(`email:${normalizedEmail}`);
  }
  if (normalizedCustomerId) {
    const numericId = normalizedCustomerId.match(/(\d+)$/)?.[1] || normalizedCustomerId;
    queryParts.push(`customer_id:${numericId}`);
  }

  const searchQuery = queryParts.join(' ');
  const orders = [];
  let after = null;
  let hasNextPage = true;
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 50);

  while (hasNextPage && orders.length < limit) {
    const payload = await adminGraphql(
      CUSTOMER_ORDERS_QUERY,
      {
        query: searchQuery,
        first: pageSize,
        after,
      },
      { accessToken }
    );

    const connection = payload?.orders;
    const edges = Array.isArray(connection?.edges) ? connection.edges : [];

    edges.forEach((edge) => {
      if (edge?.node) {
        orders.push(mapShopifyOrderNode(edge.node));
      }
    });

    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor || null;

    if (!edges.length) {
      break;
    }
  }

  return orders.slice(0, limit);
}

module.exports = {
  fetchShopifyCustomerOrders,
  mapShopifyOrderNode,
};