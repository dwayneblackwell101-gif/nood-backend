const crypto = require('crypto');
const express = require('express');
const { safeString } = require('./transform');

const WEBHOOK_BODY_LIMIT = '50mb';
const {
  syncProductByAdminId,
  deleteProductFromCache,
  syncCollectionByAdminId,
  deleteCollectionFromCache,
  syncCollectionsAndMenusLight,
} = require('./sync');
const { fetchProductGidByInventoryItemId } = require('./shopify');

const WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_DEDUP_MAX = 5000;
const WEBHOOK_JOB_DEBOUNCE_MS = 1200;

function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !rawBody) {
    return false;
  }

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digest = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('base64');
  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(String(hmacHeader), 'utf8');

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

function getAdminProductGid(payload) {
  const adminGraphqlId = safeString(payload?.admin_graphql_api_id);
  if (adminGraphqlId) {
    return adminGraphqlId;
  }

  const numericId = safeString(payload?.id);
  return numericId ? `gid://shopify/Product/${numericId}` : '';
}

function getAdminCollectionGid(payload) {
  const adminGraphqlId = safeString(payload?.admin_graphql_api_id);
  if (adminGraphqlId) {
    return adminGraphqlId;
  }

  const numericId = safeString(payload?.id);
  return numericId ? `gid://shopify/Collection/${numericId}` : '';
}

function topicAction(topic) {
  const parts = String(topic || '').split('/');
  return parts[parts.length - 1] || 'unknown';
}

function isShopifyWebhookRequest(req) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    return false;
  }

  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path === '/webhooks/shopify' || path === '/api/webhooks/shopify';
}

function mountShopifyWebhookBodyParser(app) {
  const rawParser = express.raw({
    type: 'application/json',
    limit: WEBHOOK_BODY_LIMIT,
  });

  app.use((req, res, next) => {
    if (!isShopifyWebhookRequest(req)) {
      return next();
    }

    rawParser(req, res, (err) => {
      if (err) {
        if (err.type === 'entity.too.large' || err.status === 413) {
          console.error('[NOOD webhook] payload too large', {
            path: String(req.originalUrl || req.url || ''),
            limit: WEBHOOK_BODY_LIMIT,
            length: err.length,
          });
          return res.status(413).json({
            success: false,
            message: 'Webhook payload too large.',
          });
        }

        console.error('[NOOD webhook] raw body parse failed', {
          path: String(req.originalUrl || req.url || ''),
          message: err.message,
        });
        return res.status(400).json({
          success: false,
          message: 'Invalid webhook body.',
        });
      }

      if (Buffer.isBuffer(req.body)) {
        req.rawBody = req.body;
        req._shopifyWebhookRawBody = true;
      }

      return next();
    });
  });

  console.log(`[NOOD webhook] raw body parser mounted limit=${WEBHOOK_BODY_LIMIT}`);
}

function createWebhookQueue() {
  const seenWebhookIds = new Map();
  const pendingByKey = new Map();
  const queue = [];
  let processing = false;

  function pruneSeenWebhookIds() {
    const cutoff = Date.now() - WEBHOOK_DEDUP_TTL_MS;
    for (const [id, seenAt] of seenWebhookIds.entries()) {
      if (seenAt < cutoff) {
        seenWebhookIds.delete(id);
      }
    }

    if (seenWebhookIds.size <= WEBHOOK_DEDUP_MAX) {
      return;
    }

    const sorted = [...seenWebhookIds.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = seenWebhookIds.size - WEBHOOK_DEDUP_MAX;
    for (let i = 0; i < removeCount; i += 1) {
      seenWebhookIds.delete(sorted[i][0]);
    }
  }

  function hasSeenWebhook(webhookId) {
    if (!webhookId) {
      return false;
    }
    pruneSeenWebhookIds();
    return seenWebhookIds.has(webhookId);
  }

  function rememberWebhook(webhookId) {
    if (!webhookId) {
      return;
    }
    seenWebhookIds.set(webhookId, Date.now());
    pruneSeenWebhookIds();
  }

  async function drain() {
    if (processing) {
      return;
    }

    processing = true;

    while (queue.length > 0) {
      const dedupeKey = queue.shift();
      const job = pendingByKey.get(dedupeKey);
      pendingByKey.delete(dedupeKey);

      if (!job) {
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, WEBHOOK_JOB_DEBOUNCE_MS));

      const startedAt = Date.now();
      console.log('[NOOD webhook] sync queued', {
        topic: job.topic,
        action: job.action,
        shop: job.shop,
        webhookId: job.webhookId,
        dedupeKey: job.dedupeKey,
        resourceId: job.resourceId || '',
        handle: job.handle || '',
      });

      try {
        const result = await job.run();
        console.log('[NOOD webhook] sync completed', {
          topic: job.topic,
          action: job.action,
          shop: job.shop,
          webhookId: job.webhookId,
          resourceId: job.resourceId || '',
          handle: job.handle || result?.handle || '',
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        console.error('[NOOD webhook] sync failed', {
          topic: job.topic,
          action: job.action,
          shop: job.shop,
          webhookId: job.webhookId,
          resourceId: job.resourceId || '',
          handle: job.handle || '',
          message: error.message,
        });
      }
    }

    processing = false;
  }

  function enqueue(job) {
    if (job.webhookId && hasSeenWebhook(job.webhookId)) {
      return { accepted: false, duplicate: true };
    }

    if (job.webhookId) {
      rememberWebhook(job.webhookId);
    }

    const existing = pendingByKey.get(job.dedupeKey);
    if (existing) {
      existing.run = job.run;
      return { accepted: true, coalesced: true };
    }

    pendingByKey.set(job.dedupeKey, job);
    queue.push(job.dedupeKey);
    void drain();

    return { accepted: true, coalesced: false };
  }

  return { enqueue };
}

async function resolveInventoryProductGid(payload) {
  const directGid = getAdminProductGid(payload);
  if (directGid) {
    return directGid;
  }

  const inventoryItemId = safeString(payload?.inventory_item_id);
  if (!inventoryItemId) {
    return '';
  }

  try {
    return await fetchProductGidByInventoryItemId(inventoryItemId);
  } catch (error) {
    console.warn('[NOOD catalog] inventory webhook product lookup failed', {
      inventoryItemId,
      message: error.message,
    });
    return '';
  }
}

function createWebhookHandler({ cache }) {
  const queue = createWebhookQueue();
  const webhookSecret = safeString(process.env.SHOPIFY_WEBHOOK_SECRET);

  return async function handleShopifyWebhook(req, res) {
    const topic = safeString(req.get('X-Shopify-Topic'));
    const shop = safeString(req.get('X-Shopify-Shop-Domain'));
    const webhookId = safeString(req.get('X-Shopify-Webhook-Id'));
    const hmac = safeString(req.get('X-Shopify-Hmac-Sha256'));
    const rawBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : Buffer.isBuffer(req.body)
        ? req.body
        : null;

    if (!webhookSecret) {
      console.error('[NOOD webhook] rejected: missing SHOPIFY_WEBHOOK_SECRET');
      return res.status(401).json({ success: false, message: 'Webhook secret is not configured.' });
    }

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      console.warn('[NOOD webhook] rejected: missing raw request body', { topic, shop, webhookId });
      return res.status(401).json({ success: false, message: 'Missing raw webhook body.' });
    }

    const valid = verifyShopifyWebhook(rawBody, hmac, webhookSecret);
    if (!valid) {
      console.warn('[NOOD webhook] rejected: invalid HMAC', { topic, shop, webhookId });
      return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
    }

    let payload = null;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody.toString('utf8') || '{}');
      } catch {
        payload = {};
      }
    } else if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      payload = req.body;
    } else {
      payload = {};
    }

    const action = topicAction(topic);
    const productGid = getAdminProductGid(payload);
    const collectionGid = getAdminCollectionGid(payload);
    const handle = safeString(payload?.handle);
    const resourceId = productGid || collectionGid || safeString(payload?.id);

    console.log('[NOOD webhook] received', {
      topic,
      action,
      shop,
      webhookId,
      resourceId,
      productGid,
      handle,
      numericId: safeString(payload?.id),
      hmac: 'passed',
    });

    const supportedTopics = new Set([
      'products/create',
      'products/update',
      'products/delete',
      'collections/create',
      'collections/update',
      'collections/delete',
      'inventory_levels/update',
    ]);

    if (!supportedTopics.has(topic)) {
      return res.status(200).json({
        success: true,
        topic,
        ignored: true,
        message: 'Topic ignored.',
      });
    }

    let dedupeKey = `${topic}:${resourceId || handle || webhookId}`;
    let run = async () => null;

    if (topic === 'products/create' || topic === 'products/update') {
      dedupeKey = `product:${productGid || handle}`;
      run = async () => {
        if (!productGid) {
          throw new Error('Missing product ID in webhook payload.');
        }
        return syncProductByAdminId(cache, productGid, { reason: `webhook:${topic}` });
      };
    } else if (topic === 'products/delete') {
      dedupeKey = `product-delete:${productGid || handle || safeString(payload?.id)}`;
      run = async () => deleteProductFromCache(cache, payload);
    } else if (topic === 'collections/create' || topic === 'collections/update') {
      dedupeKey = `collection:${collectionGid || handle}`;
      run = async () => {
        if (collectionGid) {
          await syncCollectionByAdminId(cache, collectionGid, { reason: `webhook:${topic}` });
        }
        return syncCollectionsAndMenusLight(cache);
      };
    } else if (topic === 'collections/delete') {
      dedupeKey = `collection-delete:${collectionGid || handle}`;
      run = async () => {
        const deleted = await deleteCollectionFromCache(cache, payload);
        return syncCollectionsAndMenusLight(cache).then((menus) => ({
          ...deleted,
          menus,
        }));
      };
    } else if (topic === 'inventory_levels/update') {
      dedupeKey = `inventory:${safeString(payload?.inventory_item_id)}:${safeString(payload?.location_id)}`;
      run = async () => {
        const inventoryProductGid = await resolveInventoryProductGid(payload);
        if (!inventoryProductGid) {
          console.log('[NOOD catalog] inventory webhook skipped: product not resolved', {
            inventoryItemId: safeString(payload?.inventory_item_id),
            locationId: safeString(payload?.location_id),
            available: payload?.available,
          });
          return null;
        }
        return syncProductByAdminId(cache, inventoryProductGid, { reason: 'webhook:inventory_levels/update' });
      };
    }

    const queued = queue.enqueue({
      topic,
      action,
      shop,
      webhookId,
      dedupeKey,
      resourceId,
      handle,
      run,
    });

    if (queued.duplicate) {
      console.log('[NOOD webhook] duplicate ignored', { topic, shop, webhookId });
      return res.status(200).json({
        success: true,
        topic,
        duplicate: true,
        webhookId,
      });
    }

    return res.status(200).json({
      success: true,
      topic,
      webhookId,
      queued: true,
      coalesced: Boolean(queued.coalesced),
    });
  };
}

function createWebhookRouter({ cache }) {
  const router = require('express').Router();
  const handleShopifyWebhook = createWebhookHandler({ cache });

  router.post('/shopify', handleShopifyWebhook);

  return router;
}

module.exports = {
  createWebhookRouter,
  verifyShopifyWebhook,
  mountShopifyWebhookBodyParser,
  isShopifyWebhookRequest,
};