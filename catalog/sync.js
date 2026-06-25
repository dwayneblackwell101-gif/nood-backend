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
  fetchAdminCollectionById,
  fetchProductGidByInventoryItemId,
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

const SYNC_STALE_MS = 3 * 60 * 1000;
const INTER_PAGE_DELAY_MS = 400;
const MAX_CHUNK_PAGES = 50;
const MAX_PAGE_SIZE = 50;
const CHUNK_COMPLETE_MESSAGE = 'chunk complete, resume required';

let activeSyncPromise = null;

function isProductionEnv() {
  return String(process.env.NODE_ENV || '').trim() === 'production';
}

function resolveSyncChunkOptions(options = {}) {
  const defaultPages = isProductionEnv() ? 10 : 10;
  const defaultPageSize = isProductionEnv() ? 25 : 25;
  const pages = Math.min(
    MAX_CHUNK_PAGES,
    Math.max(1, Number(options.pages ?? options.maxPages) || defaultPages)
  );
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(options.pageSize) || defaultPageSize)
  );

  return { pages, pageSize };
}

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
    message: null,
    chunkPages: null,
    chunkPageSize: null,
    completedAt: null,
  };
}

function parseForceResumeFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function resolveSyncPhase(state, resume, options = {}) {
  const productCount = Number(options.productCount || 0);
  const productsAlreadySynced =
    productCount > 0 ||
    Number(state.syncedProductCount || 0) > 0 ||
    Boolean(state.productCursor);

  if (!resume) {
    if (state.phase === 'collections' || state.phase === 'menus') {
      return 'collections';
    }

    if (productsAlreadySynced && !state.productCursor) {
      return 'collections';
    }

    return 'products';
  }

  if (state.phase === 'completed') {
    return 'completed';
  }

  if (state.phase === 'collections' || state.phase === 'menus') {
    return 'collections';
  }

  if (state.productCursor) {
    return 'products';
  }

  if (productsAlreadySynced && !state.collectionCursor) {
    return 'collections';
  }

  return state.phase || 'products';
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

function isOrphanedRunning(state) {
  return state?.status === 'running' && !activeSyncPromise;
}

function isSyncStale(state, options = {}) {
  if (state?.status !== 'running') {
    return false;
  }

  if (parseForceResumeFlag(options.forceResume)) {
    return true;
  }

  if (isOrphanedRunning(state)) {
    return true;
  }

  const updatedAt = Date.parse(state.updatedAt || '');
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > SYNC_STALE_MS;
}

function clearActiveSyncLock() {
  activeSyncPromise = null;
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
    message: state.message || null,
    chunkPages: Number(state.chunkPages || 0) || null,
    chunkPageSize: Number(state.chunkPageSize || 0) || null,
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
  let saved = 0;

  for (const adminProduct of adminProducts) {
    const product = transformAdminProduct(
      adminProduct,
      config.catalogCurrencyCode || config.currencyCode
    );
    if (!product.handle) {
      continue;
    }

    if (safeString(product.status).toUpperCase() === 'ARCHIVED') {
      await cache.deleteProduct(product.handle);
      continue;
    }

    transformed.push(product);
  }

  if (transformed.length) {
    if (typeof cache.mergeProducts === 'function') {
      saved = await cache.mergeProducts(transformed);
    } else {
      for (const product of transformed) {
        await cache.setProduct(product.handle, product);
        saved += 1;
      }
    }
  }

  transformed.length = 0;
  return saved;
}

async function productHandleExists(cache, handle) {
  if (typeof cache.hasProduct === 'function') {
    return cache.hasProduct(handle);
  }

  if (typeof cache.getProduct === 'function') {
    const product = await cache.getProduct(handle);
    return Boolean(product);
  }

  return false;
}

async function filterHandlesInCatalog(cache, handles = []) {
  const existing = [];

  for (const handle of handles) {
    if (await productHandleExists(cache, handle)) {
      existing.push(handle);
    }
  }

  return existing;
}

async function saveCollectionPage(cache, adminCollections) {
  const normalized = [];
  let saved = 0;

  for (const adminCollection of adminCollections) {
    const collection = normalizeCollection(adminCollection);
    if (!collection.handle) {
      continue;
    }

    collection.productHandles = await filterHandlesInCatalog(
      cache,
      collection.productHandles
    );
    normalized.push(collection);
  }

  if (normalized.length) {
    if (typeof cache.mergeCollections === 'function') {
      saved = await cache.mergeCollections(normalized);
    } else {
      for (const collection of normalized) {
        await cache.setCollection(collection.handle, collection);
        saved += 1;
      }
    }
  }

  normalized.length = 0;
  return saved;
}

async function syncMenus(cache, menuHandles = DEFAULT_MENU_HANDLES, options = {}) {
  let saved = 0;

  if (options.replaceExisting && typeof cache.clearMenus === 'function') {
    await cache.clearMenus();
    console.log('[NOOD sync] cleared menus cache before full menu sync');
  }

  for (const handle of menuHandles) {
    try {
      const payload = await storefrontGraphql(STOREFRONT_MENU_QUERY, { handle });
      const menu = payload?.data?.menu;
      if (menu) {
        await cache.setMenu(handle, menu);
        saved += 1;
      }
    } catch (error) {
      console.warn(`[NOOD catalog] menu sync skipped for ${handle}:`, error.message);
    }
  }

  return saved;
}

function productCacheSnapshot(product) {
  if (!product) {
    return null;
  }

  const price =
    product?.priceRange?.minVariantPrice?.amount ||
    product?.variants?.edges?.[0]?.node?.price?.amount ||
    null;
  const image = product?.featuredImage?.url || null;

  return {
    title: safeString(product?.title),
    price: price ? String(price) : null,
    image: image ? String(image).slice(0, 160) : null,
  };
}

function productCacheKey(handle) {
  const key = safeString(handle);
  return key ? `nood:catalog:products:h:${key}` : '';
}

async function invalidateDerivedCatalogCaches(cache) {
  clearMixedFeedCache();
  if (typeof cache.clearMixedFeedCaches === 'function') {
    await cache.clearMixedFeedCaches();
  }
}

async function bumpCatalogVersion(cache, reason = 'catalog-change') {
  const current = (await cache.getMeta()) || {};
  const nextVersion = (Number(current.catalogVersion) || 0) + 1;
  const catalogUpdatedAt = new Date().toISOString();
  const meta = await cache.setMeta({
    catalogVersion: nextVersion,
    catalogUpdatedAt,
    lastCatalogChangeReason: safeString(reason),
  });

  console.log('[NOOD catalog version] bumped', {
    catalogVersion: meta.catalogVersion ?? nextVersion,
    catalogUpdatedAt,
    reason,
  });

  return meta;
}

async function syncSingleProduct(cache, adminProduct, context = {}) {
  const config = getShopifyConfig();
  const product = transformAdminProduct(
    adminProduct,
    config.catalogCurrencyCode || config.currencyCode
  );
  const handle = safeString(product?.handle);
  const productId = safeString(product?.id);
  const reason = safeString(context?.reason) || 'product-sync';

  let oldProduct = null;
  if (handle && typeof cache.getProduct === 'function') {
    oldProduct = await cache.getProduct(handle);
  }
  if (!oldProduct && productId && typeof cache.getProductById === 'function') {
    oldProduct = await cache.getProductById(productId);
  }

  const oldSnapshot = productCacheSnapshot(oldProduct);
  const newSnapshot = productCacheSnapshot(product);

  if (!handle || product.status === 'ARCHIVED') {
    if (handle) {
      const removed = await cache.deleteProduct(handle);
      await invalidateDerivedCatalogCaches(cache);
      await bumpCatalogVersion(cache, reason || 'product-archived');
      console.log('[NOOD cache] product updated', {
        productId,
        handle,
        cacheKey: productCacheKey(handle),
        action: 'removed',
        old: oldSnapshot,
        new: null,
        writeSuccess: removed,
      });
    }
    return null;
  }

  if (
    oldProduct?.handle &&
    oldProduct.handle !== handle &&
    typeof cache.deleteProduct === 'function'
  ) {
    await cache.deleteProduct(oldProduct.handle);
    console.log('[NOOD cache] product handle changed', {
      productId,
      oldHandle: oldProduct.handle,
      newHandle: handle,
    });
  }

  await cache.setProduct(handle, product);
  if (typeof cache.persist === 'function') {
    await cache.persist();
  }

  await invalidateDerivedCatalogCaches(cache);
  await bumpCatalogVersion(cache, reason);

  console.log('[NOOD cache] product updated', {
    productId,
    handle,
    cacheKey: productCacheKey(handle),
    action: oldProduct ? 'updated' : 'created',
    old: oldSnapshot,
    new: newSnapshot,
    writeSuccess: true,
  });

  return product;
}

async function syncProductByAdminId(cache, adminProductId, context = {}) {
  const lookupId = safeString(adminProductId);
  console.log('[NOOD webhook] synced product', {
    adminProductId: lookupId,
    reason: safeString(context?.reason) || 'webhook',
  });

  const adminProduct = await fetchAdminProductById(lookupId);
  if (!adminProduct) {
    console.warn('[NOOD webhook] synced product skipped: shopify product not found', {
      adminProductId: lookupId,
    });
    return null;
  }

  return syncSingleProduct(cache, adminProduct, {
    ...context,
    reason: safeString(context?.reason) || 'webhook-product-sync',
  });
}

async function deleteProductFromCache(cache, payload = {}) {
  const handle = safeString(payload?.handle);
  if (handle) {
    const existing = typeof cache.getProduct === 'function' ? await cache.getProduct(handle) : null;
    const removed = await cache.deleteProduct(handle);
    await invalidateDerivedCatalogCaches(cache);
    await bumpCatalogVersion(cache, 'product-delete');
    console.log('[NOOD cache] product updated', {
      productId: safeString(existing?.id) || safeString(payload?.id),
      handle,
      cacheKey: productCacheKey(handle),
      action: 'deleted',
      old: productCacheSnapshot(existing),
      new: null,
      writeSuccess: removed,
    });
    return { handle, removed };
  }

  const productGid = safeString(payload?.admin_graphql_api_id);
  const numericId = safeString(payload?.id);
  const lookupId = productGid || (numericId ? `gid://shopify/Product/${numericId}` : '');

  if (lookupId && typeof cache.getProductById === 'function') {
    const product = await cache.getProductById(lookupId);
    if (product?.handle) {
      const removed = await cache.deleteProduct(product.handle);
      await invalidateDerivedCatalogCaches(cache);
      await bumpCatalogVersion(cache, 'product-delete');
      console.log('[NOOD cache] product updated', {
        productId: lookupId,
        handle: product.handle,
        cacheKey: productCacheKey(product.handle),
        action: 'deleted',
        old: productCacheSnapshot(product),
        new: null,
        writeSuccess: removed,
      });
      return { handle: product.handle, removed };
    }
  }

  return { handle: '', removed: false };
}

async function syncCollectionByAdminId(cache, adminCollectionId, context = {}) {
  const adminCollection = await fetchAdminCollectionById(adminCollectionId);
  if (!adminCollection) {
    return null;
  }

  await saveCollectionPage(cache, [adminCollection]);
  await invalidateDerivedCatalogCaches(cache);
  await bumpCatalogVersion(cache, safeString(context?.reason) || 'collection-sync');
  return normalizeCollection(adminCollection);
}

async function deleteCollectionFromCache(cache, payload = {}) {
  const handle = safeString(payload?.handle);
  if (!handle) {
    return { handle: '', removed: false };
  }

  const removed =
    typeof cache.deleteCollection === 'function' ? await cache.deleteCollection(handle) : false;
  if (removed) {
    await invalidateDerivedCatalogCaches(cache);
    await bumpCatalogVersion(cache, 'collection-delete');
  }
  return { handle, removed };
}

async function syncCollectionsAndMenusLight(cache) {
  const menuCount = await syncMenus(cache, DEFAULT_MENU_HANDLES, { replaceExisting: false });
  return { menuCount };
}

async function syncProductsPhase(cache, config, state, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || 10);
  const pageSize = Math.max(1, Number(options.pageSize) || 25);
  let after =
    options.resume && state.productCursor ? state.productCursor : null;
  let totalSaved = options.resume ? Number(state.syncedProductCount || 0) : 0;
  let hasMore = true;
  let pagesProcessed = 0;
  let pageAttempts = 0;

  while (hasMore && pagesProcessed < maxPages) {
    let pageItems = null;
    let pageInfo = null;

    try {
      const page = await fetchAdminProductsPage(after, {
        interPageDelayMs: pagesProcessed > 0 ? INTER_PAGE_DELAY_MS : 0,
        pageSize,
      });

      pageItems = page.items;
      pageInfo = page.pageInfo;
      const savedThisPage = await saveProductPage(cache, pageItems, config);
      totalSaved += savedThisPage;
      after = pageInfo?.endCursor || null;
      hasMore = Boolean(pageInfo?.hasNextPage && after);
      pagesProcessed += 1;
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
        message: null,
        chunkPages: maxPages,
        chunkPageSize: pageSize,
        startedAt: state.startedAt || new Date().toISOString(),
      });

      await checkpointCache(cache);
      console.log(`[NOOD sync] page saved products=${productCount}`);
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
        chunkPages: maxPages,
        chunkPageSize: pageSize,
      });

      if (pageAttempts >= 8) {
        throw error;
      }

      await sleep(waitMs);
      continue;
    } finally {
      pageItems = null;
      pageInfo = null;
    }
  }

  return {
    totalSaved,
    nextCursor: after,
    completed: !hasMore,
    paused: hasMore,
    pagesProcessed,
  };
}

async function syncCollectionsPhase(cache, state, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || 10);
  const pageSize = Math.max(1, Number(options.pageSize) || 25);
  const resume = Boolean(options.resume);
  let after = resume && state.collectionCursor ? state.collectionCursor : null;
  let totalSaved = resume ? Number(state.syncedCollectionCount || 0) : 0;
  let hasMore = true;
  let pagesProcessed = 0;
  let pageAttempts = 0;
  const syncedHandles = new Set();

  if (!resume && typeof cache.clearCollections === 'function') {
    await cache.clearCollections();
    console.log('[NOOD sync] cleared collections cache before full collections sync');
  }

  while (hasMore && pagesProcessed < maxPages) {
    let pageItems = null;
    let pageInfo = null;

    try {
      const page = await fetchAdminCollectionsPage(after, {
        interPageDelayMs: pagesProcessed > 0 ? INTER_PAGE_DELAY_MS : 0,
        pageSize,
      });

      pageItems = page.items;
      pageInfo = page.pageInfo;
      const savedThisPage = await saveCollectionPage(cache, pageItems);
      for (const adminCollection of pageItems || []) {
        const handle = safeString(adminCollection?.handle);
        if (handle) {
          syncedHandles.add(handle);
        }
      }
      totalSaved += savedThisPage;
      after = pageInfo?.endCursor || null;
      hasMore = Boolean(pageInfo?.hasNextPage && after);
      pagesProcessed += 1;
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

      const liveProductCount =
        typeof cache.getProductCount === 'function'
          ? Number(await cache.getProductCount()) || 0
          : Number(state.syncedProductCount || 0);

      await setSyncState(cache, {
        status: 'running',
        phase: 'collections',
        collectionCursor: after,
        syncedCollectionCount: totalSaved,
        syncedProductCount: liveProductCount,
        lastError: null,
        message: null,
        chunkPages: maxPages,
        chunkPageSize: pageSize,
        updatedAt: new Date().toISOString(),
      });

      await checkpointCache(cache);
      console.log(`[NOOD sync] page saved collections=${collectionCount}`);
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
        chunkPages: maxPages,
        chunkPageSize: pageSize,
      });

      if (pageAttempts >= 8) {
        throw error;
      }

      await sleep(waitMs);
      continue;
    } finally {
      pageItems = null;
      pageInfo = null;
    }
  }

  if (!resume && !hasMore && typeof cache.replaceCollections === 'function') {
    const syncedCollections = await cache.getAllCollections();
    const replacedCount = await cache.replaceCollections(syncedCollections);
    totalSaved = replacedCount;
    console.log('[NOOD sync] replaced collections cache after full collections sync', {
      replacedCount,
      syncedHandleCount: syncedHandles.size,
    });
  }

  return {
    totalSaved,
    nextCursor: after,
    completed: !hasMore,
    paused: hasMore,
    pagesProcessed,
  };
}

async function pauseSyncChunk(cache, patch = {}) {
  const counts = await getCatalogCounts(cache, {
    phase: patch.phase || null,
    syncedCollectionCount: patch.syncedCollectionCount,
  });

  await setSyncState(cache, {
    status: 'paused',
    lastError: null,
    message: CHUNK_COMPLETE_MESSAGE,
    ...patch,
  });
  await checkpointCache(cache);

  if (patch.phase === 'collections') {
    console.log(`[NOOD sync] chunk complete collections=${counts.collectionCount}`);
  } else {
    console.log(`[NOOD sync] chunk complete products=${counts.productCount}`);
  }

  return {
    status: 'paused',
    message: CHUNK_COMPLETE_MESSAGE,
    productCount: counts.productCount,
    collectionCount: counts.collectionCount,
    phase: patch.phase || null,
  };
}

async function runResumableCatalogSync(cache, options = {}) {
  const startedAt = Date.now();
  const config = getShopifyConfig();
  const previousState = await getSyncState(cache);
  const resume = Boolean(options.resume);
  const state = resume ? previousState : defaultSyncState();
  const chunk = resolveSyncChunkOptions(options);
  const liveProductCount =
    typeof cache.getProductCount === 'function'
      ? Number(await cache.getProductCount()) || 0
      : Number(state.syncedProductCount || 0);
  const phase = resolveSyncPhase(state, resume, { productCount: liveProductCount });

  if (phase === 'completed') {
    const counts = await getCatalogCounts(cache, { phase: 'completed' });
    return {
      status: 'completed',
      message: 'Catalog sync already completed.',
      productCount: counts.productCount,
      collectionCount: counts.collectionCount,
    };
  }

  await setSyncState(cache, {
    status: 'running',
    phase,
    productCursor: resume ? state.productCursor : null,
    collectionCursor: resume ? state.collectionCursor : null,
    syncedProductCount: resume ? Number(state.syncedProductCount || 0) : 0,
    syncedCollectionCount: resume ? Number(state.syncedCollectionCount || 0) : 0,
    startedAt: resume && state.startedAt ? state.startedAt : new Date().toISOString(),
    lastError: null,
    message: null,
    chunkPages: chunk.pages,
    chunkPageSize: chunk.pageSize,
    completedAt: null,
  });

  try {
    if (phase === 'products') {
      const productsResult = await syncProductsPhase(cache, config, state, {
        resume,
        maxPages: chunk.pages,
        pageSize: chunk.pageSize,
      });

      if (productsResult.paused) {
        return pauseSyncChunk(cache, {
          phase: 'products',
          productCursor: productsResult.nextCursor,
          syncedProductCount: productsResult.totalSaved,
          chunkPages: chunk.pages,
          chunkPageSize: chunk.pageSize,
        });
      }

      return pauseSyncChunk(cache, {
        phase: 'collections',
        productCursor: null,
        collectionCursor: null,
        syncedProductCount: productsResult.totalSaved,
        syncedCollectionCount: 0,
        chunkPages: chunk.pages,
        chunkPageSize: chunk.pageSize,
      });
    }

    const collectionsResult = await syncCollectionsPhase(cache, state, {
      resume,
      maxPages: chunk.pages,
      pageSize: chunk.pageSize,
    });

    if (collectionsResult.paused) {
      return pauseSyncChunk(cache, {
        phase: 'collections',
        collectionCursor: collectionsResult.nextCursor,
        syncedCollectionCount: collectionsResult.totalSaved,
        chunkPages: chunk.pages,
        chunkPageSize: chunk.pageSize,
      });
    }

    if (options.syncMenus !== false) {
      await setSyncState(cache, {
        status: 'running',
        phase: 'menus',
        message: null,
      });
      await syncMenus(cache, DEFAULT_MENU_HANDLES, { replaceExisting: true });
    }

    const counts = await getCatalogCounts(cache, { phase: 'completed' });
    const meta = await cache.setMeta({
      lastSyncAt: new Date().toISOString(),
      productCount: counts.productCount,
      collectionCount: counts.collectionCount,
      syncDurationMs: Date.now() - startedAt,
      source: 'shopify',
      syncInProgress: false,
      catalogVersion: (Number((await cache.getMeta())?.catalogVersion) || 0) + 1,
      catalogUpdatedAt: new Date().toISOString(),
      lastCatalogChangeReason: 'full-sync',
    });
    console.log('[NOOD catalog version] bumped', {
      catalogVersion: meta.catalogVersion,
      catalogUpdatedAt: meta.catalogUpdatedAt,
      reason: 'full-sync',
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
      message: null,
      completedAt: new Date().toISOString(),
    });

    clearMixedFeedCache();
    if (typeof cache.clearMixedFeedCaches === 'function') {
      await cache.clearMixedFeedCaches();
    }
    await checkpointCache(cache);

    console.log(
      `[NOOD sync] completed productCount=${productCount} collectionCount=${collectionCount}`
    );

    return {
      status: 'completed',
      message: null,
      productCount,
      collectionCount,
    };
  } catch (error) {
    await setSyncState(cache, {
      status: 'failed',
      lastError: safeString(error.message, 'Catalog sync failed.'),
      message: null,
    });
    await checkpointCache(cache);
    console.log(`[NOOD sync] failed error=${error.message}`);
    throw error;
  }
}

async function startBackgroundCatalogSync(cache, options = {}) {
  const state = await getSyncState(cache);
  const restart = Boolean(options.restart);
  const forceResume = parseForceResumeFlag(options.forceResume);
  const stale = isSyncStale(state, { forceResume });
  const chunk = resolveSyncChunkOptions(options);
  const alreadyRunning = state.status === 'running' && !stale;

  if (state.status === 'completed' && !restart && !forceResume) {
    return {
      status: 'already_completed',
      message: 'Catalog sync already completed.',
    };
  }

  if (alreadyRunning && !restart) {
    return { status: 'already_running', message: 'Catalog sync chunk is already running.' };
  }

  if (stale && activeSyncPromise) {
    clearActiveSyncLock();
  }

  const shouldResume =
    !restart &&
    (forceResume ||
      state.status === 'paused' ||
      state.status === 'failed' ||
      (state.status === 'running' && stale)) &&
    state.status !== 'completed';

  if (restart) {
    await prepareFreshSync(cache);
  }

  console.log(
    `[NOOD sync] started resume=${shouldResume} restart=${restart} forceResume=${forceResume} stale=${stale} pages=${chunk.pages} pageSize=${chunk.pageSize}`
  );

  activeSyncPromise = runResumableCatalogSync(cache, {
    syncMenus: options.syncMenus !== false,
    resume: shouldResume,
    pages: chunk.pages,
    pageSize: chunk.pageSize,
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
    forceResume,
    stale,
    pages: chunk.pages,
    pageSize: chunk.pageSize,
    message: forceResume
      ? 'Catalog sync resumed from saved phase/cursor.'
      : 'Catalog sync chunk started in background.',
  };
}

async function syncAllProducts(cache, options = {}) {
  return runResumableCatalogSync(cache, {
    syncMenus: options.syncMenus !== false,
    resume: false,
  });
}

async function ensureCatalogWarm(cache) {
  const meta = (await cache.getMeta()) || {};
  const productCount =
    typeof cache.getProductCount === 'function'
      ? Number(await cache.getProductCount()) || 0
      : metaCount(meta, 'productCount', 0);

  if (isProductionEnv()) {
    console.log(
      `[NOOD catalog] production startup warm check skipped auto-sync productCount=${productCount}`
    );
    return { warmed: false, meta, source: 'cache', skipped: true };
  }

  if (productCount > 0) {
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
  deleteProductFromCache,
  syncCollectionByAdminId,
  deleteCollectionFromCache,
  syncCollectionsAndMenusLight,
  syncMenus,
  ensureCatalogWarm,
  normalizeCollection,
};