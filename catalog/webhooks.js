const crypto = require('crypto');
const { safeString } = require('./transform');
const { syncProductByAdminId } = require('./sync');

function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !rawBody) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(hmacHeader)));
}

function getAdminProductGid(payload) {
  const adminGraphqlId = safeString(payload?.admin_graphql_api_id);
  if (adminGraphqlId) return adminGraphqlId;

  const numericId = safeString(payload?.id);
  return numericId ? `gid://shopify/Product/${numericId}` : '';
}

function getVariantInventoryUpdates(payload) {
  const updates = [];

  if (Array.isArray(payload?.variants)) {
    payload.variants.forEach((variant) => {
      updates.push({
        variantId: safeString(variant?.admin_graphql_api_id || variant?.id),
        inventoryQuantity: Number(variant?.inventory_quantity ?? 0),
      });
    });
  }

  if (payload?.inventory_item_id) {
    updates.push({
      inventoryItemId: safeString(payload.inventory_item_id),
      available: Number(payload?.available ?? payload?.available_adjustment ?? 0),
    });
  }

  return updates;
}

async function applyInventoryUpdates(cache, productHandle, updates) {
  const product = await cache.getProduct(productHandle);
  if (!product) return null;

  const variants = (product.variants?.edges || []).map((edge) => {
    const node = { ...edge.node };
    const update = updates.find(
      (item) =>
        item.variantId &&
        (item.variantId === node.id ||
          item.variantId.endsWith(String(node.id).split('/').pop() || '__none__'))
    );

    if (update && Number.isFinite(update.inventoryQuantity)) {
      node.quantityAvailable = update.inventoryQuantity;
      node.availableForSale = update.inventoryQuantity > 0;
    }

    return { node };
  });

  const nextProduct = {
    ...product,
    variants: { edges: variants },
    availableForSale: variants.some((edge) => edge.node.availableForSale),
    updatedAt: new Date().toISOString(),
  };

  await cache.setProduct(productHandle, nextProduct);
  return nextProduct;
}

function createWebhookRouter({ cache }) {
  const router = require('express').Router();
  const webhookSecret = safeString(process.env.SHOPIFY_WEBHOOK_SECRET);

  router.post('/shopify', async (req, res) => {
    const topic = safeString(req.get('X-Shopify-Topic'));
    const rawBody = req.rawBody || '';
    const hmac = req.get('X-Shopify-Hmac-Sha256');

    if (webhookSecret) {
      const valid = verifyShopifyWebhook(rawBody, hmac, webhookSecret);
      if (!valid) {
        console.warn('[NOOD catalog] webhook rejected: invalid HMAC', { topic });
        return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
      }
    }

    let payload = req.body;
    if (!payload || typeof payload !== 'object') {
      try {
        payload = JSON.parse(rawBody || '{}');
      } catch {
        payload = {};
      }
    }

    console.log('[NOOD catalog] webhook received', { topic });

    try {
      if (topic === 'products/create' || topic === 'products/update') {
        const productGid = getAdminProductGid(payload);
        if (productGid) {
          await syncProductByAdminId(cache, productGid);
          console.log('[NOOD catalog] webhook product synced', {
            topic,
            handle: payload?.handle || '',
            source: 'shopify',
          });
        }
      } else if (topic === 'products/delete') {
        const handle = safeString(payload?.handle);
        if (handle) {
          await cache.deleteProduct(handle);
          console.log('[NOOD catalog] webhook product deleted from cache', { handle });
        }
      } else if (
        topic === 'inventory_levels/update' ||
        topic === 'inventory_items/update' ||
        topic === 'variants/in_stock' ||
        topic === 'variants/out_of_stock'
      ) {
        const productGid = getAdminProductGid(payload);
        if (productGid) {
          const product = await syncProductByAdminId(cache, productGid);
          console.log('[NOOD catalog] webhook inventory refreshed product', {
            topic,
            handle: product?.handle || payload?.handle || '',
          });
        }
      } else if (topic === 'orders/create' || topic === 'orders/paid') {
        const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
        for (const lineItem of lineItems) {
          const productGid = safeString(lineItem?.product_id)
            ? `gid://shopify/Product/${lineItem.product_id}`
            : '';
          if (productGid) {
            await syncProductByAdminId(cache, productGid);
          }
        }
        console.log('[NOOD catalog] webhook order inventory refresh', {
          topic,
          lineItemCount: lineItems.length,
        });
      }

      return res.json({ success: true, topic });
    } catch (error) {
      console.error('[NOOD catalog] webhook handler failed:', error.message);
      return res.status(500).json({
        success: false,
        topic,
        message: error.message || 'Webhook processing failed.',
      });
    }
  });

  return router;
}

module.exports = {
  createWebhookRouter,
  verifyShopifyWebhook,
};