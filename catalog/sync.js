const shopify = require('./shopify');

const MISSING_SHOPIFY_PRODUCTS_PAGE_FETCHER =
  'catalog/shopify.js must export fetchAdminProductsPage (Admin GraphQL products page fetcher).';
const MISSING_SHOPIFY_COLLECTIONS_PAGE_FETCHER =
  'catalog/shopify.js must export fetchAdminCollectionsPage (Admin GraphQL collections page fetcher).';

function listShopifyFunctionExports() {
  return Object.keys(shopify)
    .filter((key) => typeof shopify[key] === 'function')
    .sort()
    .join(', ');
}

function buildMissingShopifyFetcherError(exportName, message) {
  const error = new Error(
    `${message} Missing export "${exportName}". Available functions: ${listShopifyFunctionExports() || 'none'}.`
  );
  error.code = 'MISSING_SHOPIFY_SYNC_FUNCTION';
  return error;
}

const rawFetchAdminProductsPage = shopify.fetchAdminProductsPage;
const rawFetchAdminCollectionsPage = shopify.fetchAdminCollectionsPage;
const fetchAdminProductsPageAvailable = typeof rawFetchAdminProductsPage === 'function';
const fetchAdminCollectionsPageAvailable = typeof rawFetchAdminCollectionsPage === 'function';

console.log(
  `[NOOD sync] fetchAdminProductsPage available=${fetchAdminProductsPageAvailable}`
);

async function fetchAdminProductsPage(after = null, options = {}) {
  if (!fetchAdminProductsPageAvailable) {
    throw buildMissingShopifyFetcherError(
      'fetchAdminProductsPage',
      MISSING_SHOPIFY_PRODUCTS_PAGE_FETCHER
    );
  }

  return rawFetchAdminProductsPage(after, options);
}

async function fetchAdminCollectionsPage(after = null, options = {}) {
  if (!fetchAdminCollectionsPageAvailable) {
    throw buildMissingShopifyFetcherError(
      'fetchAdminCollectionsPage',
      MISSING_SHOPIFY_COLLECTIONS_PAGE_FETCHER
    );
  }

  return rawFetchAdminCollectionsPage(after, options);
}

const {
  fetchAdminProductById,
  storefrontGraphql,
  getShopifyConfig,
  STOREFRONT_MENU_QUERY,
} = shopify;
const { transformAdminProduct, safeString } = require('./transform');
const { clearMixedFeedCache } = require('./feed-mix');

const DEFAULT_MENU_HANDLES = [
  'main-menu',
  'footer',
  'nood-categories',
  'categories',
  'mobile-menu',
];

const SYNC_STALE_MS = 5 * 60 * 1000;
const INTER_PAGE_DELAY_MS = 400;
const MAX_PRODUCT_PAGES = 250;
const MAX_COLLECTION_PAGES = 100;

let activeSyncPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSyncState() {
  return {
    status: 'idle',
    phase: null,
    productCursor: null,
    collectionCursor: null,
    syncedProductCount: 0,
    syncedCollectionCount: 0,
    startedAt: null,
    updatedAt: null,
    lastError: null,
    completedAt: null,
  };
}

function normalizeCollection(adminCollection) {
  const productHandles = (adminCollection?.products?.edges || [])
    .map((edge) => safeString(edge?.node?.handle))
    .filter(Boolean);

  return {
    id: adminCollection.id,
    title: safeString(adminCollection.title),
    handle: safeString(adminCollection.handle),
    image: adminCollection?.image?.url
      ? { url: adminCollection.image.url }
      : null,
    productHandles,
    updatedAt: new Date().toISOString(),
  };
}

async function getSyncState(cache) {
  if (typeof cache.getSyncState === 'function') {
    return cache.getSyncState();
  }
  return defaultSyncState();
}

async function setSyncState(cache, patch) {
  if (typeof cache.setSyncState === 'function') {
    return cache.setSyncState(patch);
  }
  return { ...defaultSyncState(), ...patch };
}

function isSyncStale(state) {
  if (state?.status !== 'running') {
    return false;
  }

  const updatedAt = Date.parse(state.updatedAt || '');
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > SYNC_STALE_MS;
}

async function checkpointCache(cache) {
  if (typeof cache.flush === 'function') {
    await cache.flush();
  }
}

function metaCount(meta, field, fallback = 0) {
  return Number(meta?.[field] ?? fallback) || 0;
}

async function getCatalogCounts(cache, options = {}) {
  const meta = (await cache.getMeta?.()) || null;
  const liveProductCount =
    typeof cache.getProductCount === 'function'
      ? Number(await cache.getProductCount()) || 0
      : 0;
  const liveCollectionCount =
    typeof cache.getCollectionCount === 'function'
      ? Number(await cache.getCollectionCount()) || 0
      : 0;

  const productCount = liveProductCount || metaCount(meta, 'productCount', 0);
  const collectionCount =
    options.phase === 'collections' || options.phase === 'completed'
      ? liveCollectionCount || metaCount(meta, 'collectionCount', 0)
      : Number(options.syncedCollectionCount ?? 0) || 0;

  return { productCount, collectionCount };
}

async function getCatalogSyncStatus(cache) {
  const state = await getSyncState(cache);
  const counts = await getCatalogCounts(cache, {
    phase: state.phase || null,
    syncedCollectionCount: state.syncedCollectionCount,
  });
  const cursor =
    state.phase === 'collections'
      ? state.collectionCursor || null
      : state.productCursor || null;

  return {
    status: state.status || 'idle',
    phase: state.phase || null,
    productCount: counts.productCount,
    collectionCount: counts.collectionCount,
    cursor,
    productCursor: state.productCursor || null,
    collectionCursor: state.collectionCursor || null,
    syncedProductCount: Number(state.syncedProductCount || 0),
    syncedCollectionCount: Number(state.syncedCollectionCount || 0),
    startedAt: state.startedAt || null,
    updatedAt: state.updatedAt || null,
    completedAt: state.completedAt || null,
    lastError: state.lastError || null,
    cacheDriver: cache.driver(),
    stale: isSyncStale(state),
  };
}

async function prepareFreshSync(cache) {
  const meta = (await cache.getMeta()) || {};

  if (typeof cache.clearProducts === 'function') {
    await cache.clearProducts();
  } else {
    const collections = await cache.getAllCollections();
    await cache.replaceAll({
      products: [],
      collections,
      menus: {},
      meta: {
        ...meta,
        productCount: 0,
        syncInProgress: true,
        lastSyncAt: null,
      },
    });
  }

  await cache.setMeta({
    ...meta,
    productCount: 0,
    syncInProgress: true,
    lastSyncAt: null,
  });

  await setSyncState(cache, {
    ...defaultSyncState(),
    status: 'idle',
  });
  await checkpointCache(cache);
}

async function saveProductPage(cache, adminProducts, config) {
  const transformed = [];

  for (const adminProduct of adminProducts) {
    const product = transformAdminProduct(adminProduct, config.currencyCode);
    if (!product.handle) {
      continue;
    }

    if (safeString(product.status).toUpperCase() === 'ARCHIVED') {
      await cache.deleteProduct(product.handle);
      continue;
    }

    transformed.push(product);
  }

  if (!transformed.length) {
    return 0;
  }

  if (typeof cache.mergeProducts === 'function') {
    return cache.mergeProducts(transformed);
  }

  let saved = 0;
  for (const product of transformed) {
    await cache.setProduct(product.handle, product);
    saved += 1;
  }
  return saved;
}

async function getCachedProductHandles(cache) {
  if (typeof cache.getAllProductHandles === 'function') {
    const handles = await cache.getAllProductHandles();
    return new Set(handles);
  }

  const products = await cache.getAllProducts();
  return new Set(products.map((product) => product.handle));
}

async function saveCollectionPage(cache, adminCollections, productHandles) {
  const normalized = [];

  for (const adminCollection of adminCollections) {
    const collection = normalizeCollection(adminCollection);
    if (!collection.handle) {
      continue;
    }

    collection.productHandles = collection.productHandles.filter((handle) =>
      productHandles.has(handle)
    );
    normalized.push(collection);
  }

  if (!normalized.length) {
    return 0;
  }

  if (typeof cache.mergeCollections === 'function') {
    return cache.mergeCollections(normalized);
  }

  let saved = 0;
  for (const collection of normalized) {
    await cache.setCollection(collection.handle, collection);
    saved += 1;
  }
  return saved;
}

async function syncMenus(cache, menuHandles = DEFAULT_MENU_HANDLES) {
  const menus = {};

  for (const handle of menuHandles) {
    try {
      const payload = await storefrontGraphql(STOREFRONT_MENU_QUERY, { handle });
      const menu = payload?.data?.menu;
      if (menu) {
        menus[handle] = menu;
        await cache.setMenu(handle, menu);
      }
    } catch (error) {
      console.warn(`[NOOD catalog] menu sync skipped for ${handle}:`, error.message);
    }
  }

  return menus;
}

async function syncSingleProduct(cache, adminProduct) {
  const config = getShopifyConfig();
  const product = transformAdminProduct(adminProduct, config.currencyCode);
  if (!product.handle || product.status === 'ARCHIVED') {
    if (product.handle) {
      await cache.deleteProduct(product.handle);
    }
    return null;
  }

  await cache.setProduct(product.handle, product);
  return product;
}

async function syncProductByAdminId(cache, adminProductId) {
  const adminProduct = await fetchAdminProductById(adminProductId);
  if (!adminProduct) {
    return null;
  }
  return syncSingleProduct(cache, adminProduct);
}

async function syncProductsPhase(cache, config, state, options = {}) {
  let after =
    options.resume && state.phase === 'products' && state.productCursor
      ? state.productCursor
      : null;
  let totalSaved = options.resume ? Number(state.syncedProductCount || 0) : 0;
  let hasMore = true;
  let guard = 0;
  let pageAttempts = 0;

  while (hasMore && guard < MAX_PRODUCT_PAGES) {
    try {
      const page = await fetchAdminProductsPage(after, {
        interPageDelayMs: guard > 0 ? INTER_PAGE_DELAY_MS : 0,
      });

      const savedThisPage = await saveProductPage(cache, page.items, config);
      totalSaved += savedThisPage;
      after = page.pageInfo?.endCursor || null;
      hasMore = Boolean(page.pageInfo?.hasNextPage && after);
      guard += 1;
      pageAttempts = 0;

      const liveProductCount =
        typeof cache.getProductCount === 'function'
          ? Number(await cache.getProductCount()) || 0
          : totalSaved;
      const productCount = metaCount(
        await cache.setMeta({
          productCount: liveProductCount,
          syncInProgress: true,
          source: 'shopify',
        }),
        'productCount',
        liveProductCount
      );

      await setSyncState(cache, {
        status: 'running',
        phase: 'products',
        productCursor: after,
        syncedProductCount: totalSaved,
        lastError: null,
        startedAt: state.startedAt || new Date().toISOString(),
      });

      await checkpointCache(cache);
      console.log(
        `[NOOD sync] page saved products=${productCount} cursor=${after || 'end'}`
      );
    } catch (error) {
      const nonRetryable =
        error?.code === 'MISSING_SHOPIFY_SYNC_FUNCTION' ||
        /is not a function/i.test(safeString(error?.message)) ||
        /cannot read properties of undefined/i.test(safeString(error?.message));

      if (nonRetryable) {
        console.error(`[NOOD sync] ${safeString(error.message, 'sync page failed')}`);
        throw error;
      }

      pageAttempts += 1;
      const waitMs = Math.min(2000 * Math.pow(2, pageAttempts - 1), 30000);
      console.log(`[NOOD sync] throttled waiting ${waitMs} ms`);
      await setSyncState(cache, {
        status: 'running',
        phase: 'products',
        productCursor: after,
        syncedProductCount: totalSaved,
        lastError: safeString(error.message, 'sync page failed'),
      });

      if (pageAttempts >= 8) {
        throw error;
      }

      await sleep(waitMs);
    }
  }

  return {
    totalSaved,
    nextCursor: after,
    completed: !hasMore,
  };
}

async function syncCollectionsPhase(cache, state, options = {}) {
  let after =
    options.resume && state.phase === 'collections' && state.collectionCursor
      ? state.collectionCursor
      : null;
  let totalSaved =
    options.resume && state.phase === 'collections'
      ? Number(state.syncedCollectionCount || 0)
      : 0;
  let hasMore = true;
  let guard = 0;
  let pageAttempts = 0;
  const productHandles = await getCachedProductHandles(cache);

  while (hasMore && guard < MAX_COLLECTION_PAGES) {
    try {
      const page = await fetchAdminCollectionsPage(after, {
        interPageDelayMs: guard > 0 ? INTER_PAGE_DELAY_MS : 0,
      });

      const savedThisPage = await saveCollectionPage(cache, page.items, productHandles);
      totalSaved += savedThisPage;
      after = page.pageInfo?.endCursor || null;
      hasMore = Boolean(page.pageInfo?.hasNextPage && after);
      guard += 1;
      pageAttempts = 0;

      const liveCollectionCount =
        typeof cache.getCollectionCount === 'function'
          ? Number(await cache.getCollectionCount()) || 0
          : totalSaved;
      const collectionCount = metaCount(
        await cache.setMeta({
          collectionCount: liveCollectionCount,
          syncInProgress: true,
          source: 'shopify',
        }),
        'collectionCount',
        liveCollectionCount
      );

      await setSyncState(cache, {
        status: 'running',
        phase: 'collections',
        collectionCursor: after,
        syncedCollectionCount: totalSaved,
        lastError: null,
      });

      await checkpointCache(cache);
      console.log(
        `[NOOD sync] page saved collections=${collectionCount} cursor=${after || 'end'}`
      );
    } catch (error) {
      const nonRetryable =
        error?.code === 'MISSING_SHOPIFY_SYNC_FUNCTION' ||
        /is not a function/i.test(safeString(error?.message)) ||
        /cannot read properties of undefined/i.test(safeString(error?.message));

      if (nonRetryable) {
        console.error(`[NOOD sync] ${safeString(error.message, 'sync page failed')}`);
        throw error;
      }

      pageAttempts += 1;
      const waitMs = Math.min(2000 * Math.pow(2, pageAttempts - 1), 30000);
      console.log(`[NOOD sync] throttled waiting ${waitMs} ms`);
      await setSyncState(cache, {
        status: 'running',
        phase: 'collections',
        collectionCursor: after,
        syncedCollectionCount: totalSaved,
        lastError: safeString(error.message, 'sync page failed'),
      });

      if (pageAttempts >= 8) {
        throw error;
      }

      await sleep(waitMs);
    }
  }

  return {
    totalSaved,
    completed: !hasMore,
  };
}

async function runResumableCatalogSync(cache, options = {}) {
  const startedAt = Date.now();
  const config = getShopifyConfig();
  const previousState = await getSyncState(cache);
  const resume = Boolean(options.resume);
  const state = resume ? previousState : defaultSyncState();

  await setSyncState(cache, {
    status: 'running',
    phase: resume && state.phase === 'collections' ? 'collections' : 'products',
    productCursor: resume ? state.productCursor : null,
    collectionCursor: resume ? state.collectionCursor : null,
    syncedProductCount: resume ? Number(state.syncedProductCount || 0) : 0,
    syncedCollectionCount: resume ? Number(state.syncedCollectionCount || 0) : 0,
    startedAt: resume && state.startedAt ? state.startedAt : new Date().toISOString(),
    lastError: null,
    completedAt: null,
  });

  try {
    if (!resume || state.phase !== 'collections') {
      await syncProductsPhase(cache, config, state, { resume });
    }

    await setSyncState(cache, {
      status: 'running',
      phase: 'collections',
      productCursor: null,
    });

    await syncCollectionsPhase(cache, state, {
      resume: resume && state.phase === 'collections',
    });

    if (options.syncMenus !== false) {
      await setSyncState(cache, {
        status: 'running',
        phase: 'menus',
      });
      await syncMenus(cache);
    }

    const counts = await getCatalogCounts(cache, { phase: 'completed' });
    const meta = await cache.setMeta({
      lastSyncAt: new Date().toISOString(),
      productCount: counts.productCount,
      collectionCount: counts.collectionCount,
      syncDurationMs: Date.now() - startedAt,
      source: 'shopify',
      syncInProgress: false,
    });
    const productCount = metaCount(meta, 'productCount', counts.productCount);
    const collectionCount = metaCount(meta, 'collectionCount', counts.collectionCount);

    await setSyncState(cache, {
      status: 'completed',
      phase: 'completed',
      productCursor: null,
      collectionCursor: null,
      syncedProductCount: productCount,
      syncedCollectionCount: collectionCount,
      lastError: null,
      completedAt: new Date().toISOString(),
    });

    clearMixedFeedCache();
    await checkpointCache(cache);

    console.log(
      `[NOOD sync] completed productCount=${productCount} collectionCount=${collectionCount}`
    );

    return {
      ...(meta || {}),
      productCount,
      collectionCount,
    };
  } catch (error) {
    await setSyncState(cache, {
      status: 'failed',
      lastError: safeString(error.message, 'Catalog sync failed.'),
    });
    await checkpointCache(cache);
    console.log(`[NOOD sync] failed error=${error.message}`);
    throw error;
  }
}

async function startBackgroundCatalogSync(cache, options = {}) {
  const state = await getSyncState(cache);
  const restart = Boolean(options.restart);
  const stale = isSyncStale(state);
  const alreadyRunning = state.status === 'running' && !stale;

  if (activeSyncPromise && alreadyRunning && !restart) {
    return { status: 'already_running' };
  }

  if (alreadyRunning && !restart) {
    return { status: 'already_running' };
  }

  const shouldResume =
    !restart &&
    (state.status === 'failed' || (state.status === 'running' && stale)) &&
    (state.productCursor || state.collectionCursor || Number(state.syncedProductCount || 0) > 0);

  if (restart) {
    await prepareFreshSync(cache);
  }

  console.log('[NOOD sync] started', {
    resume: shouldResume,
    restart,
  });

  activeSyncPromise = runResumableCatalogSync(cache, {
    syncMenus: options.syncMenus !== false,
    resume: shouldResume,
  })
    .catch(() => null)
    .finally(() => {
      activeSyncPromise = null;
    });

  void activeSyncPromise;

  return {
    status: 'started',
    resume: shouldResume,
    restart,
  };
}

async function syncAllProducts(cache, options = {}) {
  return runResumableCatalogSync(cache, {
    syncMenus: options.syncMenus !== false,
    resume: false,
  });
}

async function ensureCatalogWarm(cache) {
  const meta = await cache.getMeta();
  const products = await cache.getAllProducts();

  if (String(process.env.NODE_ENV || '').trim() === 'production') {
    console.log('[NOOD catalog] production startup warm check skipped auto-sync', {
      cacheDriver: cache.driver(),
      productCount: metaCount(meta, 'productCount', products.length),
      collectionCount: metaCount(meta, 'collectionCount', 0),
    });
    return { warmed: false, meta, source: 'cache', skipped: true };
  }

  if (products.length > 0) {
    return { warmed: false, meta, source: 'cache' };
  }

  const nextMeta = await syncAllProducts(cache, { syncMenus: true });
  return { warmed: true, meta: nextMeta, source: 'shopify' };
}

module.exports = {
  DEFAULT_MENU_HANDLES,
  syncAllProducts,
  startBackgroundCatalogSync,
  getCatalogSyncStatus,
  runResumableCatalogSync,
  syncSingleProduct,
  syncProductByAdminId,
  syncMenus,
  ensureCatalogWarm,
  normalizeCollection,
};