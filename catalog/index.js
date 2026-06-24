const { createCatalogCache } = require('./cache/redis-cache');
const { createCatalogRouter, mountCatalogSyncRoutes } = require('./routes');
const { createWebhookRouter } = require('./webhooks');
const { ensureCatalogWarm } = require('./sync');

let catalogCachePromise = null;
let mountedCache = null;
let catalogMounted = false;
let catalogMountError = null;

async function getCatalogCache() {
  if (!catalogCachePromise) {
    catalogCachePromise = createCatalogCache();
  }
  return catalogCachePromise;
}

async function getCatalogReadiness() {
  if (!catalogMounted || !mountedCache) {
    return {
      ready: false,
      cacheDriver: null,
      productCount: 0,
      collectionCount: 0,
      lastSyncAt: null,
      redisConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
      redisPing: null,
      reason: catalogMountError?.message || 'catalog_not_mounted',
    };
  }

  const meta = await mountedCache.getMeta();
  const productCount =
    typeof mountedCache.getProductCount === 'function'
      ? Number(await mountedCache.getProductCount())
      : Number(meta.productCount || 0);
  const collectionCount =
    typeof mountedCache.getCollectionCount === 'function'
      ? Number(await mountedCache.getCollectionCount())
      : Number(meta.collectionCount || 0);
  const cacheDriver = mountedCache.driver();
  let redisPing = null;

  if (typeof mountedCache.ping === 'function') {
    try {
      redisPing = await mountedCache.ping();
    } catch (error) {
      return {
        ready: false,
        cacheDriver,
        productCount,
        collectionCount,
        lastSyncAt: meta.lastSyncAt || null,
        redisConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
        redisPing: null,
        reason: 'cache_ping_failed',
        message: error.message,
      };
    }
  }

  return {
    ready: productCount > 0,
    cacheDriver,
    productCount,
    collectionCount,
    lastSyncAt: meta.lastSyncAt || null,
    redisConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
    redisPing,
    reason: productCount > 0 ? null : 'catalog_empty',
  };
}

async function mountCatalog(app, { requireAdminApiKey }) {
  try {
    const cache = await getCatalogCache();
    const catalogRouter = createCatalogRouter({ cache, requireAdminApiKey });
    const webhookRouter = createWebhookRouter({ cache });

    app.use('/api/catalog', catalogRouter);
    app.use('/webhooks', webhookRouter);
    app.use('/api/webhooks', webhookRouter);
    console.log('[NOOD catalog] Shopify webhooks mounted at /webhooks/shopify and /api/webhooks/shopify');
    mountCatalogSyncRoutes(app, { cache, requireAdminApiKey });

    mountedCache = cache;
    catalogMounted = true;
    catalogMountError = null;

    void ensureCatalogWarm(cache).then((result) => {
      console.log('[NOOD catalog] startup warm check', result);
    });

    return cache;
  } catch (error) {
    catalogMounted = false;
    mountedCache = null;
    catalogMountError = error;
    throw error;
  }
}

module.exports = {
  mountCatalog,
  getCatalogCache,
  getCatalogReadiness,
};