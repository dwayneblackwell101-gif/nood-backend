const { createCatalogCache } = require('./cache/redis-cache');
const { createCatalogRouter, mountCatalogSyncRoutes } = require('./routes');
const { createWebhookRouter } = require('./webhooks');
const { ensureCatalogWarm, startBackgroundCatalogSync } = require('./sync');
const { SUPPORTED_SCHEMA_VERSION } = require('./catalog-validator');

function isProductionEnv() {
  return String(process.env.NODE_ENV || '').trim() === 'production';
}

function workersDisabled() {
  return (
    String(process.env.NODE_ENV || '').trim() === 'test' ||
    String(process.env.NOOD_DISABLE_BACKGROUND_WORKERS || '').trim().toLowerCase() === 'true'
  );
}

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

  if (typeof mountedCache.getActiveVersionId === 'function') {
    const activeVersionId = await mountedCache.getActiveVersionId();
    const activeMeta =
      activeVersionId && typeof mountedCache.getCatalogVersionMeta === 'function'
        ? await mountedCache.getCatalogVersionMeta(activeVersionId)
        : null;
    if (!activeVersionId) {
      return {
        ready: false,
        cacheDriver,
        productCount,
        collectionCount,
        lastSyncAt: meta.lastSyncAt || null,
        redisConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
        redisPing,
        reason: 'catalog_active_version_missing',
      };
    }
    if (!activeMeta) {
      return {
        ready: false,
        cacheDriver,
        productCount,
        collectionCount,
        lastSyncAt: meta.lastSyncAt || null,
        redisConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
        redisPing,
        reason: 'catalog_active_metadata_missing',
      };
    }
    if (
      activeMeta.status !== 'active' ||
      String(activeMeta.schemaVersion || SUPPORTED_SCHEMA_VERSION) !== SUPPORTED_SCHEMA_VERSION
    ) {
      return {
        ready: false,
        cacheDriver,
        productCount,
        collectionCount,
        lastSyncAt: meta.lastSyncAt || null,
        redisConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
        redisPing,
        reason: 'catalog_active_version_invalid',
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
    const webhookRouter = createWebhookRouter({
      cache,
      requireAdminApiKey,
      autoStartWorker: !workersDisabled(),
    });

    app.use('/api/catalog', catalogRouter);
    app.use('/webhooks', webhookRouter);
    app.use('/api/webhooks', webhookRouter);
    console.log('[NOOD catalog] Shopify webhooks mounted at /webhooks/shopify and /api/webhooks/shopify');
    mountCatalogSyncRoutes(app, { cache, requireAdminApiKey });

    mountedCache = cache;
    catalogMounted = true;
    catalogMountError = null;

    if (!workersDisabled()) {
      void (async () => {
      if (isProductionEnv()) {
        const result = await ensureCatalogWarm(cache);
        console.log('[NOOD catalog] startup warm check', result);
        return;
      }

      const syncResult = await startBackgroundCatalogSync(cache, { syncMenus: true });
      console.log('[NOOD catalog] startup auto-sync', syncResult);
      })();
    } else {
      console.log('[NOOD catalog] background workers disabled');
    }

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
