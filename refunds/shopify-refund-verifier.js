const { adminGraphql } = require('../catalog/shopify');
const { getShopifyOrderAccessToken } = require('../shopify-order-access');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeOrderQuery(reference) {
  const raw = safeString(reference);
  if (!raw) return '';
  if (raw.startsWith('gid://shopify/Order/')) return raw;
  const numeric = raw.replace(/\D/g, '');
  return numeric ? `gid://shopify/Order/${numeric}` : raw;
}

async function fetchRefundableShopifyOrder(reference) {
  const orderId = normalizeOrderQuery(reference);
  const accessToken = getShopifyOrderAccessToken();
  if (!accessToken) {
    throw new Error('Missing SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN for refund order verification.');
  }

  const query = `
    query noodRefundOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        currencyCode
        displayFinancialStatus
        cancelledAt
        customer {
          id
          email
        }
        totalReceivedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        transactions(first: 50) {
          id
          kind
          status
          gateway
          amountSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
              variant {
                id
              }
              originalTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              taxLines {
                priceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        refunds {
          id
          refundLineItems(first: 100) {
            edges {
              node {
                quantity
                subtotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                totalTaxSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                lineItem {
                  id
                }
              }
            }
          }
        }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const payload = await adminGraphql(
    query,
    { id: orderId },
    { accessToken, requestedQueryCost: 120 }
  );

  return payload?.data?.order || null;
}

module.exports = {
  fetchRefundableShopifyOrder,
  normalizeOrderQuery,
};
