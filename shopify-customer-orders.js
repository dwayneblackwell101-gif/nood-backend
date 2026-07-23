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
          metafield(namespace: "nood", key: "refund_request") {
            value
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

  if (normalized === 'PARTIALLY_REFUNDED') {
    return 'Partially refunded';
  }
  if (normalized === 'REFUNDED') {
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

function parseRefundMetafield(rawValue) {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
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
  const refundRecords = refunds.map((refund) => ({
    createdAt: safeString(refund?.createdAt),
    amount: Number(refund?.totalRefundedSet?.shopMoney?.amount || 0),
    currency: safeString(refund?.totalRefundedSet?.shopMoney?.currencyCode, 'TTD'),
  }));

  const refundedAmount = refundRecords.reduce((sum, refund) => {
    const amount = Number(refund?.amount || 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  const displayFinancialStatus = safeString(node?.displayFinancialStatus);
  const financialStatus = displayFinancialStatus;
  const fulfillmentStatus = safeString(node?.displayFulfillmentStatus);
  const trackingNumber = safeString(primaryTracking?.number);
  const cancelledAt = safeString(node?.cancelledAt);
  const total = Number(node?.totalPriceSet?.shopMoney?.amount || 0);
  const normalizedFinancialStatus = displayFinancialStatus.toUpperCase();

  let status = mapFinancialStatus(displayFinancialStatus);
  if (cancelledAt) {
    status = 'Cancelled';
  }

  const shopifyRefundRequest = parseRefundMetafield(node?.metafield?.value);
  const latestRefundDate = refundRecords
    .map((entry) => safeString(entry.createdAt))
    .filter(Boolean)
    .sort()
    .pop();

  const isPartiallyRefunded =
    normalizedFinancialStatus === 'PARTIALLY_REFUNDED' ||
    (refundedAmount > 0 && total > 0 && refundedAmount < total);
  const isFullyRefunded =
    normalizedFinancialStatus === 'REFUNDED' || (total > 0 && refundedAmount >= total);

  if (isPartiallyRefunded || isFullyRefunded) {
    console.log('[SHOPIFY REFUND DETECTED]', {
      orderName: safeString(node?.name),
      displayFinancialStatus,
      refundedAmount,
      total,
      isPartiallyRefunded,
      isFullyRefunded,
      latestRefundDate,
    });
  }

  return {
    id: safeString(node?.name) || safeString(node?.id),
    date: safeString(node?.createdAt) || new Date().toISOString(),
    total,
    currency: safeString(node?.totalPriceSet?.shopMoney?.currencyCode, 'TTD'),
    status,
    paymentMethod: 'Shopify',
    shopifyOrderId: safeString(node?.id),
    shopifyOrderName: safeString(node?.name),
    refunded: isFullyRefunded || isPartiallyRefunded || refundedAmount > 0,
    financialStatus,
    displayFinancialStatus,
    fulfillmentStatus: mapFulfillmentStatus(fulfillmentStatus, trackingNumber),
    trackingNumber,
    trackingUrl: safeString(primaryTracking?.url),
    carrier: safeString(primaryTracking?.company),
    cancelledAt: cancelledAt || undefined,
    cancelReason: safeString(node?.cancelReason) || undefined,
    refundedAmount,
    refundRecords,
    shopifyRefundRequest: shopifyRefundRequest || undefined,
    refundProcessedAt: latestRefundDate || undefined,
    refundMethodLabel: shopifyRefundRequest?.refund_destination_label || undefined,
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