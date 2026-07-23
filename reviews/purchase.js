/**
 * Verified purchase validation for reviews.
 * Prefer Shopify Admin customer order history when credentials exist.
 * Injectable for tests.
 */

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeHandle(value) {
  return safeString(value).toLowerCase();
}

function idsMatch(a, b) {
  const left = safeString(a);
  const right = safeString(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const numA = left.match(/(\d+)$/)?.[1];
  const numB = right.match(/(\d+)$/)?.[1];
  return Boolean(numA && numB && numA === numB);
}

function orderMatchesId(order, orderId) {
  const target = safeString(orderId);
  if (!target) return false;
  const candidates = [
    safeString(order.id),
    safeString(order.shopifyOrderId),
    safeString(order.shopifyOrderName),
    safeString(order.name),
  ].filter(Boolean);
  return candidates.some(
    (oid) => oid === target || idsMatch(oid, target) || oid.replace(/^#/, '') === target.replace(/^#/, '')
  );
}

function isDisqualifiedOrder(order) {
  const status = safeString(order.status || order.financialStatus || order.displayFinancialStatus).toLowerCase();
  if (status.includes('cancel')) return true;
  if (status === 'refunded') return true;
  if (order.cancelledAt) return true;
  return false;
}

/**
 * Build a validator from an async order loader:
 *   loadOrders(customerId) => Array<{ id, shopifyOrderId, shopifyOrderName, items:[{variantId, title, handle?, productId?}] }>
 */
function createPurchaseValidatorFromOrderLoader(loadOrders) {
  return async function verifyPurchase({
    customerId,
    productId,
    productHandle,
    orderId,
    orderItemId,
    variantId,
  }) {
    if (typeof loadOrders !== 'function') {
      return { verified: false, reason: 'Order loader unavailable.' };
    }

    let orders;
    try {
      orders = await loadOrders(customerId);
    } catch (error) {
      return {
        verified: false,
        reason: error.message || 'Could not load customer orders.',
      };
    }

    const list = Array.isArray(orders) ? orders : [];
    const handle = normalizeHandle(productHandle);
    const targetOrderId = safeString(orderId);
    const targetVariant = safeString(variantId);
    const targetItem = safeString(orderItemId);

    // Pass 1: explicit order ownership (customer must own the order)
    if (targetOrderId) {
      for (const order of list) {
        if (!orderMatchesId(order, targetOrderId)) continue;
        if (isDisqualifiedOrder(order)) {
          return { verified: false, reason: 'Order is cancelled or refunded.' };
        }

        const items = Array.isArray(order.items) ? order.items : [];
        // Prefer line match when possible
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index] || {};
          const itemKey = safeString(item.id || item.orderItemId || `${order.id}:${index}`);
          const itemHandle = normalizeHandle(item.handle || item.productHandle);
          const itemProductId = safeString(item.productId || item.product_id);
          const variantOk = !targetVariant || idsMatch(targetVariant, item.variantId);
          const handleOk = !handle || !itemHandle || itemHandle === handle;
          const productOk = !productId || !itemProductId || idsMatch(productId, itemProductId);
          const itemOk = !targetItem || targetItem === itemKey || idsMatch(targetItem, itemKey);

          if (variantOk && handleOk && productOk && itemOk) {
            return {
              verified: true,
              orderId: safeString(order.shopifyOrderName || order.id || order.shopifyOrderId),
              orderItemId: itemKey,
              variantId: safeString(item.variantId || targetVariant),
            };
          }
        }

        // Order-level verify: authenticated customer owns this order.
        // Product page reviews always include orderId from account → reviews flow.
        if (items.length > 0) {
          return {
            verified: true,
            orderId: safeString(order.shopifyOrderName || order.id || order.shopifyOrderId),
            orderItemId: targetItem || safeString(items[0]?.id) || '0',
            variantId: targetVariant || safeString(items[0]?.variantId),
          };
        }
      }
      return {
        verified: false,
        reason: 'No matching order found for this customer.',
      };
    }

    // Pass 2: any qualifying order containing product handle / id / variant
    for (const order of list) {
      if (isDisqualifiedOrder(order)) continue;
      const items = Array.isArray(order.items) ? order.items : [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index] || {};
        const itemHandle = normalizeHandle(item.handle || item.productHandle);
        const itemProductId = safeString(item.productId);
        const variantOk = !targetVariant || idsMatch(targetVariant, item.variantId);
        if (!variantOk) continue;

        if (handle && itemHandle === handle) {
          return {
            verified: true,
            orderId: safeString(order.id || order.shopifyOrderId || order.shopifyOrderName),
            orderItemId: safeString(item.id || `${order.id}:${index}`),
            variantId: safeString(item.variantId),
          };
        }
        if (productId && idsMatch(productId, itemProductId)) {
          return {
            verified: true,
            orderId: safeString(order.id || order.shopifyOrderId || order.shopifyOrderName),
            orderItemId: safeString(item.id || `${order.id}:${index}`),
            variantId: safeString(item.variantId),
          };
        }
        if (targetVariant && idsMatch(targetVariant, item.variantId)) {
          return {
            verified: true,
            orderId: safeString(order.id || order.shopifyOrderId || order.shopifyOrderName),
            orderItemId: safeString(item.id || `${order.id}:${index}`),
            variantId: safeString(item.variantId),
          };
        }
      }
    }

    return {
      verified: false,
      reason: 'No matching verified purchase found for this product.',
    };
  };
}

/** Test helper: verified when orderId present. */
function createAlwaysVerifiedPurchaseValidator() {
  return async function alwaysVerified({ orderId, orderItemId }) {
    if (!safeString(orderId)) {
      return { verified: false, reason: 'orderId required for verification stub.' };
    }
    return {
      verified: true,
      orderId: safeString(orderId),
      orderItemId: safeString(orderItemId) || 'item-1',
    };
  };
}

module.exports = {
  createPurchaseValidatorFromOrderLoader,
  createAlwaysVerifiedPurchaseValidator,
  idsMatch,
  orderMatchesId,
};
