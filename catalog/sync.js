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
  adminGraphql,
  STOREFRONT_MENU_QUERY,
  fetchRemainingImages,
  fetchRemainingMedia,
  fetchRemainingVariants,
  fetchRemainingVariantMedia,
} = shopify;
const { transformAdminProduct, compactProductForCache, safeString } = require('./transform');
const { clearMixedFeedCache } = require('./feed-mix');
const { applyCollectionHandleAliases } = require('./collection-aliases');
const { createCatalogSyncLock } = require('./catalog-lock');
const { validateCatalogVersion } = require('./catalog-validator');

const DEFAULT_MENU_HANDLES = [
  'main-menu',
  'footer',
  'nood-categories',
  'categories',
  'mobile-menu',
];

const SYNC_STALE_MS = 3 * 60 * 1000;
const INTER_PAGE_DELAY_MS = 400;
const AUTO_RESUME_DELAY_MS = 750;
const MAX_CHUNK_PAGES = 250;
const MAX_PAGE_SIZE = 50;
const CHUNK_COMPLETE_MESSAGE = 'chunk complete, resume required';
let activeSyncPromise = null;

function isProductionEnv() {
  return String(process.env.NODE_ENV || '').trim() === 'production';
}

function resolveSyncChunkOptions(options = {}) {
  const defaultPages = isProductionEnv() ? 250 : 250;
  const defaultPageSize = isProductionEnv() ? 50 : 50;
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
    productsCompleted: false,
    syncedProductCount: 0,
    syncedCollectionCount: 0,
    shopifyProductsCount: null,
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
  const productsCompleted = state.productsCompleted === true;

  if (!resume) {
    if (productsCompleted && (state.phase === 'collections' || state.phase === 'menus')) {
      return 'collections';
    }

    if (productsCompleted) {
      return 'collections';
    }

    return 'products';
  }

  if (state.phase === 'completed' && productsCompleted) {
    return 'completed';
  }

  if (productsCompleted && (state.phase === 'collections' || state.phase === 'menus')) {
    return 'collections';
  }

  if (state.productCursor) {
    return 'products';
  }

  if (productsCompleted && !state.collectionCursor) {
    return 'collections';
  }

  return 'products';
}

async function fetchShopifyProductsCount() {
  try {
    const payload = await adminGraphql(
      `
        query NoodProductsCount {
          productsCount(query: "status:active") {
            count
          }
        }
      `,
      {},
      { requestedQueryCost: 10 }
    );
    const count = Number(payload?.data?.productsCount?.count);
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch (error) {
    console.warn('[NOOD sync] Shopify productsCount unavailable', {
      message: safeString(error?.message || error),
    });
    return null;
  }
}

function resolveProductPreviewImageUrl(productNode) {
  const featuredImageUrl = safeString(productNode?.featuredImage?.url);
  if (featuredImageUrl) {
    return featuredImageUrl;
  }

  const previewEdges = productNode?.images?.edges || [];
  for (const edge of previewEdges) {
    const imageUrl = safeString(edge?.node?.url);
    if (imageUrl) {
      return imageUrl;
    }
  }

  return '';
}

function resolveCollectionImageFromAdminPreview(adminCollection) {
  const collectionImageUrl = safeString(adminCollection?.image?.url);
  if (collectionImageUrl) {
    return { imageUrl: collectionImageUrl, imageSource: 'collection' };
  }

  const productEdges = adminCollection?.products?.edges || [];
  for (const edge of productEdges) {
    const productImageUrl = resolveProductPreviewImageUrl(edge?.node);
    if (productImageUrl) {
      return { imageUrl: productImageUrl, imageSource: 'product' };
    }
  }

  return { imageUrl: '', imageSource: 'fallback' };
}

function normalizeCollection(adminCollection) {
  const productHandles = (adminCollection?.products?.edges || [])
    .map((edge) => safeString(edge?.node?.handle))
    .filter(Boolean);
  const resolved = resolveCollectionImageFromAdminPreview(adminCollection);

  return {
    id: adminCollection.id,
    title: safeString(adminCollection.title),
    handle: safeString(adminCollection.handle),
    image: resolved.imageUrl ? { url: resolved.imageUrl } : null,
    imageUrl: resolved.imageUrl,
    previewImage: resolved.imageUrl || null,
    imageSource: resolved.imageSource,
    productHandles,
    updatedAt: new Date().toISOString(),
  };
}

async function resolveCollectionImageFromCache(cache, collection) {
  const collectionImageUrl = safeString(collection?.image?.url);
  if (collectionImageUrl) {
    return { imageUrl: collectionImageUrl, imageSource: 'collection' };
  }

  const displayImageUrl = safeString(collection?.displayImage);
  if (displayImageUrl) {
    return { imageUrl: displayImageUrl, imageSource: 'displayImage' };
  }

  const fallbackImageUrl = safeString(collection?.fallbackImage);
  if (fallbackImageUrl) {
    return { imageUrl: fallbackImageUrl, imageSource: 'fallbackImage' };
  }

  const existingUrl = safeString(collection?.imageUrl);
  if (existingUrl) {
    return {
      imageUrl: existingUrl,
      imageSource: safeString(collection?.imageSource) || 'cache',
    };
  }

  for (const handle of (collection.productHandles || []).slice(0, 24)) {
    const product = await cache.getProduct(handle);
    const productImageUrl = safeString(product?.featuredImage?.url);
    if (productImageUrl) {
      return { imageUrl: productImageUrl, imageSource: 'product' };
    }

    const imageEdges = product?.images?.edges || [];
    for (const edge of imageEdges) {
      const imageUrl = safeString(edge?.node?.url);
      if (imageUrl) {
        return { imageUrl, imageSource: 'product' };
      }
    }
  }

  return { imageUrl: '', imageSource: 'fallback' };
}

async function enrichCollectionImageUrl(cache, collection, adminCollection) {
  const adminResolved = resolveCollectionImageFromAdminPreview(adminCollection);
  if (adminResolved.imageUrl) {
    collection.imageUrl = adminResolved.imageUrl;
    collection.previewImage = adminResolved.imageUrl;
    collection.imageSource = adminResolved.imageSource;
    collection.image = { url: adminResolved.imageUrl };
    return collection;
  }

  const cacheResolved = await resolveCollectionImageFromCache(cache, collection);
  if (cacheResolved.imageUrl) {
    collection.imageUrl = cacheResolved.imageUrl;
    collection.previewImage = cacheResolved.imageUrl;
    collection.imageSource = cacheResolved.imageSource;
    collection.image = { url: cacheResolved.imageUrl };
    return collection;
  }

  collection.imageUrl = '';
  collection.previewImage = null;
  collection.imageSource = 'fallback';
  return collection;
}

function normalizeCollectionMatchKey(value) {
  return safeString(value).toLowerCase().replace(/^#/, '').trim();
}

function getProductCollectionKeysForReconcile(product) {
  const keys = new Set();

  for (const handle of Array.isArray(product?.collectionHandles) ? product.collectionHandles : []) {
    const key = normalizeCollectionMatchKey(handle);
    if (key) {
      keys.add(key);
    }
  }

  for (const edge of product?.collections?.edges || []) {
    const handle = normalizeCollectionMatchKey(edge?.node?.handle);
    const title = normalizeCollectionMatchKey(edge?.node?.title);
    if (handle) {
      keys.add(handle);
    }
    if (title) {
      keys.add(title);
    }
  }

  return keys;
}

function collectionMatchKeysForReconcile(collection) {
  const keys = new Set();
  const handle = normalizeCollectionMatchKey(collection?.handle);
  const title = normalizeCollectionMatchKey(collection?.title);

  if (handle) {
    keys.add(handle);
    if (handle.endsWith('-1')) {
      keys.add(handle.slice(0, -2));
    }
    if (handle.endsWith('-2')) {
      keys.add(handle.slice(0, -2));
    }
  }

  if (title) {
    keys.add(title);
  }

  return keys;
}

function registerProductHandleOnReconcileIndex(index, key, productHandle) {
  const normalizedKey = normalizeCollectionMatchKey(key);
  if (!normalizedKey) {
    return;
  }

  if (!index.has(normalizedKey)) {
    index.set(normalizedKey, []);
  }

  const bucket = index.get(normalizedKey);
  if (!bucket.includes(productHandle)) {
    bucket.push(productHandle);
  }

  if (normalizedKey.endsWith('-1')) {
    registerProductHandleOnReconcileIndex(index, normalizedKey.slice(0, -2), productHandle);
  }

  if (normalizedKey.endsWith('-2')) {
    registerProductHandleOnReconcileIndex(index, normalizedKey.slice(0, -2), productHandle);
  }
}

function buildProductHandlesByCollectionKey(products = []) {
  const index = new Map();

  for (const product of products) {
    const productHandle = safeString(product?.handle);
    if (!productHandle) {
      continue;
    }

    for (const key of getProductCollectionKeysForReconcile(product)) {
      registerProductHandleOnReconcileIndex(index, key, productHandle);
    }
  }

  return index;
}

function resolveCollectionHandlesFromIndex(collection, index) {
  const matchKeys = collectionMatchKeysForReconcile(collection);
  const merged = [];
  const seen = new Set();

  for (const existing of Array.isArray(collection?.productHandles) ? collection.productHandles : []) {
    const handle = safeString(existing);
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      merged.push(handle);
    }
  }

  for (const key of matchKeys) {
    for (const handle of index.get(key) || []) {
      if (!seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  return merged;
}

async function reconcileCollectionProductHandlesFromProducts(cache) {
  const products =
    typeof cache.getAllProducts === 'function' ? await cache.getAllProducts() : [];
  const collections =
    typeof cache.getAllCollections === 'function' ? await cache.getAllCollections() : [];

  if (!Array.isArray(products) || !products.length || !Array.isArray(collections) || !collections.length) {
    return { updated: 0, collections: collections?.length || 0 };
  }

  const index = buildProductHandlesByCollectionKey(products);
  let updated = 0;

  for (const collection of collections) {
    const handle = safeString(collection?.handle);
    if (!handle) {
      continue;
    }

    const nextHandles = resolveCollectionHandlesFromIndex(collection, index);
    if (!nextHandles.length) {
      continue;
    }

    const previousHandles = Array.isArray(collection.productHandles) ? collection.productHandles : [];
    const changed =
      nextHandles.length !== previousHandles.length ||
      nextHandles.some((entry, index) => entry !== previousHandles[index]);

    if (!changed) {
      continue;
    }

    const nextCollection = {
      ...collection,
      productHandles: nextHandles,
      updatedAt: new Date().toISOString(),
    };

    if (typeof cache.setCollection === 'function') {
      await cache.setCollection(handle, nextCollection);
      updated += 1;
    }
  }

  if (updated > 0 && typeof cache.persist === 'function') {
    await cache.persist();
  }

  console.log('[NOOD sync] reconciled collection productHandles from products', {
    updated,
    collectionCount: collections.length,
    productCount: products.length,
  });

  return { updated, collections: collections.length };
}

async function reconcileAllCollectionImageUrls(cache) {
  const collections = await cache.getAllCollections();
  if (!Array.isArray(collections) || !collections.length) {
    return { updated: 0, withImage: 0 };
  }

  let updated = 0;
  let withImage = 0;

  for (const collection of collections) {
    if (!collection?.handle) continue;

    const resolved = await resolveCollectionImageFromCache(cache, collection);
    if (!resolved.imageUrl) continue;

    const existingUrl = safeString(collection.imageUrl);
    const existingSource = safeString(collection.imageSource);
    if (existingUrl === resolved.imageUrl && existingSource === resolved.imageSource) {
      withImage += 1;
      continue;
    }

    collection.imageUrl = resolved.imageUrl;
    collection.previewImage = resolved.imageUrl;
    collection.imageSource = resolved.imageSource;
    collection.image = { url: resolved.imageUrl };
    await cache.setCollection(collection.handle, collection);
    updated += 1;
    withImage += 1;
  }

  console.log('[NOOD sync] reconciled collection imageUrl cache', {
    total: collections.length,
    updated,
    withImage,
  });

  return { updated, withImage };
}

async function getSyncState(cache) {
  if (typeof cache.getSyncState === 'function') {
    return cache.getSyncState();
  }
  return defaultSyncState();
}

async function setSyncState(cache, patch, options = {}) {
  const previousState = await getSyncState(cache);
  const previousStatus = previousState.status || 'idle';
  const previousProductCount = syncStateProductCount(previousState);
  const nextPatch = { ...(patch || {}) };
  const nextPreview = { ...previousState, ...nextPatch };

  if (
    (previousStatus === 'running' || activeSyncPromise) &&
    nextPatch.status === 'idle' &&
    !options.allowRunningIdle
  ) {
    console.log('[NOOD sync] reset blocked during running sync');
    console.log(
      `[NOOD sync] state write previousStatus=${previousStatus} newStatus=${previousStatus} previousProductCount=${previousProductCount} newProductCount=${previousProductCount}`
    );
    return previousState;
  }

  let writtenState;
  if (typeof cache.setSyncState === 'function') {
    writtenState = await cache.setSyncState(nextPatch);
  } else {
    writtenState = { ...defaultSyncState(), ...nextPatch };
  }

  console.log(
    `[NOOD sync] state write previousStatus=${previousStatus} newStatus=${writtenState.status || 'idle'} previousProductCount=${previousProductCount} newProductCount=${syncStateProductCount(writtenState)}`
  );

  return writtenState;
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

function formatSyncCursor(state = {}) {
  if (state.phase === 'collections' || state.phase === 'menus') {
    return state.collectionCursor || 'start';
  }

  return state.productCursor || 'start';
}

async function checkpointCache(cache) {
  if (typeof cache.flush === 'function') {
    await cache.flush();
  }
}

function metaCount(meta, field, fallback = 0) {
  return Number(meta?.[field] ?? fallback) || 0;
}

function syncStateProductCount(state = {}) {
  return Number(state?.syncedProductCount ?? state?.productCount ?? 0) || 0;
}

async function getLiveProductCount(cache) {
  if (typeof cache.getWorkingProductCount === 'function') {
    return Number(await cache.getWorkingProductCount()) || 0;
  }
  return typeof cache.getProductCount === 'function'
    ? Number(await cache.getProductCount()) || 0
    : 0;
}

async function acquireCatalogSyncLock(cache) {
  return createCatalogSyncLock({
    redis: cache?.client || null,
    namespace: String(process.env.REDIS_NAMESPACE || 'nood').trim() || 'nood',
  }).acquire(`sync_${process.pid}_${Date.now()}`);
}

async function getLiveCollectionCount(cache) {
  if (typeof cache.getWorkingCollectionCount === 'function') {
    return Number(await cache.getWorkingCollectionCount()) || 0;
  }
  return typeof cache.getCollectionCount === 'function'
    ? Number(await cache.getCollectionCount()) || 0
    : 0;
}

async function getCatalogCounts(cache, options = {}) {
  const meta = (await cache.getMeta?.()) || null;
  const liveProductCount = await getLiveProductCount(cache);
  const liveCollectionCount = await getLiveCollectionCount(cache);

  const productCount = liveProductCount || metaCount(meta, 'productCount', 0);
  const collectionCount =
    options.phase === 'collections' || options.phase === 'completed'
      ? liveCollectionCount || metaCount(meta, 'collectionCount', 0)
      : liveCollectionCount || Number(options.syncedCollectionCount ?? 0) || 0;

  return { productCount, collectionCount };
}

function isCatalogProductCountSatisfied(productCount, shopifyProductsCount) {
  const liveCount = Number(productCount) || 0;
  const targetCount = Number(shopifyProductsCount) || 0;
  if (!targetCount) {
    return liveCount > 0;
  }
  return liveCount === targetCount;
}

function needsCatalogProductResync(productCount, shopifyProductsCount) {
  const liveCount = Number(productCount) || 0;
  const targetCount = Number(shopifyProductsCount) || 0;
  if (!targetCount) {
    return liveCount === 0;
  }
  return liveCount !== targetCount;
}

function hasStaleDeletedProducts(productCount, shopifyProductsCount) {
  const liveCount = Number(productCount) || 0;
  const targetCount = Number(shopifyProductsCount) || 0;
  return targetCount > 0 && liveCount > targetCount;
}

async function getCatalogSyncStatus(cache) {
  const state = await getSyncState(cache);
  const counts = await getCatalogCounts(cache, {
    phase: state.phase || null,
    syncedProductCount: state.syncedProductCount,
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

async function prepareFreshSync(cache, options = {}) {
  const state = await getSyncState(cache);
  if ((state.status === 'running' || activeSyncPromise) && !options.allowRunningReset) {
    console.log('[NOOD sync] reset blocked during running sync');
    return { reset: false, blocked: true };
  }

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
    syncId: state.syncId || null,
    versionId: state.versionId || null,
    previousActiveVersion: state.previousActiveVersion || null,
    status: 'idle',
  }, { allowRunningIdle: options.allowRunningReset });
  await checkpointCache(cache);
  return { reset: true, blocked: false };
}

async function saveProductPage(cache, adminProducts, config) {
  const transformed = [];
  let saved = 0;

  for (const adminProduct of adminProducts) {
    // --- Enrichment: fetch remaining images/media/variants for truncated connections ---
    try {
      const productId = adminProduct?.id;

      // Enrich images
      if (productId && adminProduct.images?.pageInfo?.hasNextPage && adminProduct.images?.pageInfo?.endCursor) {
        const remaining = await fetchRemainingImages(productId, adminProduct.images.pageInfo.endCursor);
        if (remaining.length) {
          adminProduct.images.edges = [...(adminProduct.images.edges || []), ...remaining];
        }
      }

      // Enrich media
      if (productId && adminProduct.media?.pageInfo?.hasNextPage && adminProduct.media?.pageInfo?.endCursor) {
        const remaining = await fetchRemainingMedia(productId, adminProduct.media.pageInfo.endCursor);
        if (remaining.length) {
          adminProduct.media.edges = [...(adminProduct.media.edges || []), ...remaining];
        }
      }

      // Enrich variants
      if (productId && adminProduct.variants?.pageInfo?.hasNextPage && adminProduct.variants?.pageInfo?.endCursor) {
        const remaining = await fetchRemainingVariants(productId, adminProduct.variants.pageInfo.endCursor);
        if (remaining.length) {
          adminProduct.variants.edges = [...(adminProduct.variants.edges || []), ...remaining];
        }
      }

      // Enrich variant-level media for variants whose media was truncated
      if (productId && Array.isArray(adminProduct.variants?.edges)) {
        const variantsNeedingMedia = adminProduct.variants.edges.filter(
          (vEdge) => vEdge?.node?.media?.pageInfo?.hasNextPage
        );
        if (variantsNeedingMedia.length) {
          const followUpEdges = await fetchRemainingVariantMedia(productId);
          // followUpEdges contains variants with their full media; merge by variant id
          const variantMediaMap = new Map();
          for (const fEdge of followUpEdges) {
            const vId = fEdge?.node?.id;
            if (vId && fEdge?.node?.media?.edges?.length) {
              variantMediaMap.set(vId, fEdge.node.media.edges);
            }
          }
          for (const vEdge of adminProduct.variants.edges) {
            const vId = vEdge?.node?.id;
            const extraMedia = variantMediaMap.get(vId);
            if (extraMedia && vEdge?.node?.media?.edges) {
              vEdge.node.media.edges = [...vEdge.node.media.edges, ...extraMedia];
            }
          }
        }
      }
    } catch (enrichErr) {
      console.warn('[NOOD sync] enrichment follow-up failed for product:', adminProduct?.handle, enrichErr.message);
      // Continue with partial data rather than failing the entire page
    }
    // --- End enrichment ---

    const product = compactProductForCache(
      transformAdminProduct(adminProduct, config.catalogCurrencyCode || config.currencyCode)
    );
    if (!product?.handle || !product?.id) {
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
    await enrichCollectionImageUrl(cache, collection, adminCollection);
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

    await applyCollectionHandleAliases(cache);
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
  const meta = (await cache.setMeta({
    catalogVersion: nextVersion,
    catalogUpdatedAt,
    lastCatalogChangeReason: safeString(reason),
  })) || {
    ...current,
    catalogVersion: nextVersion,
    catalogUpdatedAt,
    lastCatalogChangeReason: safeString(reason),
  };

  console.log('[NOOD catalog version] bumped', {
    catalogVersion: meta.catalogVersion ?? nextVersion,
    catalogUpdatedAt,
    reason,
  });

  return meta;
}

function extractCollectionIdsFromAdminProduct(adminProduct) {
  return (adminProduct?.collections?.edges || [])
    .map((edge) => safeString(edge?.node?.id))
    .filter(Boolean);
}

async function resolveCollectionIdForHandle(cache, handle) {
  const key = safeString(handle);
  if (!key || typeof cache.getCollection !== 'function') {
    return '';
  }

  const collection = await cache.getCollection(key);
  return safeString(collection?.id);
}

async function collectAffectedCollectionIds(cache, adminProduct, oldProduct) {
  const affected = new Set(extractCollectionIdsFromAdminProduct(adminProduct));

  const oldHandles = new Set([
    ...(Array.isArray(oldProduct?.collectionHandles) ? oldProduct.collectionHandles : []),
    ...(oldProduct?.collections?.edges || [])
      .map((edge) => safeString(edge?.node?.handle))
      .filter(Boolean),
  ]);

  for (const handle of oldHandles) {
    const collectionId = await resolveCollectionIdForHandle(cache, handle);
    if (collectionId) {
      affected.add(collectionId);
    }
  }

  return [...affected];
}

async function refreshAffectedCollections(cache, adminProduct, oldProduct, context = {}) {
  const collectionIds = await collectAffectedCollectionIds(cache, adminProduct, oldProduct);
  if (!collectionIds.length) {
    return { synced: 0, collectionIds: [] };
  }

  const reason = safeString(context?.reason) || 'product-collection-refresh';
  let synced = 0;
  const syncedHandles = [];

  for (const collectionId of collectionIds) {
    try {
      const collection = await syncCollectionByAdminId(cache, collectionId, {
        reason,
        bumpVersion: false,
      });
      if (collection) {
        synced += 1;
        if (collection.handle) {
          syncedHandles.push(collection.handle);
        }
      }
    } catch (error) {
      console.warn('[NOOD catalog] affected collection refresh failed', {
        collectionId,
        productId: safeString(adminProduct?.id),
        message: error.message,
      });
    }
  }

  if (synced > 0) {
    await invalidateDerivedCatalogCaches(cache);
    await bumpCatalogVersion(cache, reason);
    console.log('[NOOD cache] refreshed collections after product change', {
      productId: safeString(adminProduct?.id),
      productHandle: safeString(adminProduct?.handle),
      synced,
      collectionIds,
      collectionHandles: syncedHandles,
    });
  }

  return { synced, collectionIds, collectionHandles: syncedHandles };
}

async function refreshCollectionsForHandles(cache, handles = [], context = {}) {
  const uniqueHandles = [...new Set(handles.map((value) => safeString(value)).filter(Boolean))];
  if (!uniqueHandles.length) {
    return { synced: 0, collectionHandles: [] };
  }

  const reason = safeString(context?.reason) || 'product-delete-collection-refresh';
  let synced = 0;
  const syncedHandles = [];

  for (const handle of uniqueHandles) {
    const collectionId = await resolveCollectionIdForHandle(cache, handle);
    if (!collectionId) {
      continue;
    }

    try {
      const collection = await syncCollectionByAdminId(cache, collectionId, {
        reason,
        bumpVersion: false,
      });
      if (collection) {
        synced += 1;
        if (collection.handle) {
          syncedHandles.push(collection.handle);
        }
      }
    } catch (error) {
      console.warn('[NOOD catalog] collection refresh after product delete failed', {
        handle,
        collectionId,
        message: error.message,
      });
    }
  }

  if (synced > 0) {
    await invalidateDerivedCatalogCaches(cache);
    await bumpCatalogVersion(cache, reason);
    console.log('[NOOD cache] refreshed collections after product delete', {
      synced,
      collectionHandles: syncedHandles,
    });
  }

  return { synced, collectionHandles: syncedHandles };
}

async function syncSingleProduct(cache, adminProduct, context = {}) {
  const config = getShopifyConfig();
  const product = compactProductForCache(
    transformAdminProduct(adminProduct, config.catalogCurrencyCode || config.currencyCode)
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

  if (!handle || !productId) {
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

  await refreshAffectedCollections(cache, adminProduct, oldProduct, {
    reason: `${reason}:collections`,
  });

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

async function pruneProductsNotInHandleSet(cache, activeHandles) {
  const active =
    activeHandles instanceof Set
      ? activeHandles
      : new Set(
          (Array.isArray(activeHandles) ? activeHandles : [])
            .map((handle) => safeString(handle))
            .filter(Boolean)
        );

  const allProducts =
    typeof cache.getAllProducts === 'function' ? await cache.getAllProducts() : [];
  const staleHandles = [];

  for (const product of allProducts) {
    const handle = safeString(product?.handle);
    if (!handle || active.has(handle)) {
      continue;
    }
    staleHandles.push(handle);
  }

  let removed = 0;
  if (staleHandles.length && typeof cache.deleteProducts === 'function') {
    removed = await cache.deleteProducts(staleHandles);
  } else if (typeof cache.deleteProduct === 'function') {
    for (const handle of staleHandles) {
      const deleted = await cache.deleteProduct(handle);
      if (deleted) {
        removed += 1;
      }
    }
  }

  if (removed > 0) {
    await invalidateDerivedCatalogCaches(cache);
    await reconcileCollectionProductHandlesFromProducts(cache);
    const liveProductCount = await getLiveProductCount(cache);
    await cache.setMeta({
      productCount: liveProductCount,
      lastSyncAt: new Date().toISOString(),
      source: 'shopify',
    });
    await bumpCatalogVersion(cache, 'prune-deleted-products');
    console.log('[NOOD sync] pruned deleted products from cache', {
      removed,
      remaining: liveProductCount,
      activeHandleCount: active.size,
    });
  }

  return removed;
}

async function collectShopifyProductHandles() {
  const handles = new Set();
  let after = null;
  let hasMore = true;

  while (hasMore) {
    const page = await fetchAdminProductsPage(after, { pageSize: 50 });
    for (const item of page.items || []) {
      const handle = safeString(item?.handle);
      if (handle) {
        handles.add(handle);
      }
    }

    hasMore = Boolean(page.pageInfo?.hasNextPage && page.pageInfo?.endCursor);
    after = hasMore ? safeString(page.pageInfo?.endCursor) : null;
  }

  return handles;
}

async function pruneDeletedProductsFromShopify(cache) {
  const shopifyHandles = await collectShopifyProductHandles();
  const removed = await pruneProductsNotInHandleSet(cache, shopifyHandles);
  return {
    removed,
    shopifyHandleCount: shopifyHandles.size,
    productCount: await getLiveProductCount(cache),
  };
}

async function deleteProductFromCache(cache, payload = {}) {
  const handle = safeString(payload?.handle);
  if (handle) {
    const existing = typeof cache.getProduct === 'function' ? await cache.getProduct(handle) : null;
    const removed = await cache.deleteProduct(handle);
    await refreshCollectionsForHandles(cache, existing?.collectionHandles || [], {
      reason: 'product-delete:collections',
    });
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
      await refreshCollectionsForHandles(cache, product.collectionHandles || [], {
        reason: 'product-delete:collections',
      });
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
  const bumpVersion = context.bumpVersion !== false;
  if (bumpVersion) {
    await invalidateDerivedCatalogCaches(cache);
    await bumpCatalogVersion(cache, safeString(context?.reason) || 'collection-sync');
  }
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
  const resume = Boolean(options.resume);
  let after = resume && state.productCursor ? state.productCursor : null;
  let hasNextPage = true;
  let pagesProcessed = 0;
  let pageAttempts = 0;
  const syncedHandles = new Set(
    Array.isArray(state.syncedProductHandles)
      ? state.syncedProductHandles.map((handle) => safeString(handle)).filter(Boolean)
      : []
  );

  while (hasNextPage && pagesProcessed < maxPages) {
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
      for (const adminProduct of pageItems || []) {
        const handle = safeString(adminProduct?.handle);
        const status = safeString(adminProduct?.status, 'ACTIVE').toUpperCase();
        if (handle && status === 'ACTIVE') {
          syncedHandles.add(handle);
        }
      }
      hasNextPage = pageInfo?.hasNextPage === true;
      after = hasNextPage ? safeString(pageInfo?.endCursor) : null;
      console.log(`[NOOD sync] DIAG page=${pagesProcessed + 1} items=${pageItems?.length} hasNextPage=${hasNextPage} rawHasNextPage=${pageInfo?.hasNextPage} cursor=${after ? after.substring(0, 15) + '...' : 'null'} liveCount=${await getLiveProductCount(cache)}`);
      if (hasNextPage && !after) {
        throw new Error('Shopify products pageInfo.hasNextPage=true but endCursor is missing.');
      }
      pagesProcessed += 1;
      pageAttempts = 0;

      const liveProductCount = await getLiveProductCount(cache);
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
        productsCompleted: hasNextPage === false,
        syncedProductCount: liveProductCount,
        syncedProductHandles: [...syncedHandles],
        lastError: null,
        message: null,
        chunkPages: maxPages,
        chunkPageSize: pageSize,
        startedAt: state.startedAt || new Date().toISOString(),
      });

      await checkpointCache(cache);
      console.log('[NOOD sync] product page saved', {
        hasNextPage,
        endCursor: pageInfo?.endCursor || null,
        savedCount: savedThisPage,
        liveProductCount,
        productCount,
      });
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
        productsCompleted: false,
        syncedProductCount: await getLiveProductCount(cache),
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

  console.log(`[NOOD sync] DIAG loop-exit hasNextPage=${hasNextPage} pagesProcessed=${pagesProcessed} maxPages=${maxPages} liveCount=${await getLiveProductCount(cache)}`);
  const completed = hasNextPage === false;
  let prunedCount = 0;

  if (completed) {
    prunedCount = await pruneProductsNotInHandleSet(cache, syncedHandles);
    await setSyncState(cache, {
      syncedProductHandles: null,
    });
  }

  return {
    totalSaved: await getLiveProductCount(cache),
    nextCursor: after,
    completed,
    paused: hasNextPage === true,
    pagesProcessed,
    prunedCount,
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

      const liveProductCount = await getLiveProductCount(cache);

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
    syncedProductCount: patch.syncedProductCount,
    syncedCollectionCount: patch.syncedCollectionCount,
  });

  await setSyncState(cache, {
    status: 'paused',
    lastError: null,
    message: CHUNK_COMPLETE_MESSAGE,
    ...patch,
  });
  await checkpointCache(cache);

  const nextCursor =
    patch.phase === 'collections'
      ? patch.collectionCursor || null
      : patch.productCursor || null;

  console.log(`[NOOD sync] chunk complete productCount=${counts.productCount}`);

  return {
    status: 'paused',
    message: CHUNK_COMPLETE_MESSAGE,
    productCount: counts.productCount,
    collectionCount: counts.collectionCount,
    phase: patch.phase || null,
    nextCursor,
  };
}

async function runResumableCatalogSync(cache, options = {}) {
  const startedAt = Date.now();
  const config = getShopifyConfig();
  const previousState = await getSyncState(cache);
  const resume = Boolean(options.resume);
  const state = resume ? previousState : defaultSyncState();
  const chunk = resolveSyncChunkOptions(options);
  const shopifyProductsCount =
    options.shopifyProductsCount === undefined
      ? await fetchShopifyProductsCount()
      : options.shopifyProductsCount;
  const liveProductCount = await getLiveProductCount(cache);
  const phase = resolveSyncPhase(state, resume, {
    productCount: liveProductCount,
    shopifyProductsCount,
  });

  if (phase === 'completed') {
    const counts = await getCatalogCounts(cache, { phase: 'completed' });

    if (hasStaleDeletedProducts(counts.productCount, shopifyProductsCount)) {
      const pruneResult = await pruneDeletedProductsFromShopify(cache);
      const refreshedCounts = await getCatalogCounts(cache, { phase: 'completed' });
      if (!needsCatalogProductResync(refreshedCounts.productCount, shopifyProductsCount)) {
        return {
          status: 'pruned',
          message: `Removed ${pruneResult.removed} deleted products from cache.`,
          productCount: refreshedCounts.productCount,
          collectionCount: refreshedCounts.collectionCount,
          shopifyProductsCount,
          pruned: pruneResult.removed,
        };
      }
    }

    if (!isCatalogProductCountSatisfied(counts.productCount, shopifyProductsCount)) {
      return {
        status: 'restart_required',
        message: `Catalog sync is marked completed at ${counts.productCount}/${shopifyProductsCount || 'unknown'} Shopify products. Retry with restart=true.`,
        productCount: counts.productCount,
        collectionCount: counts.collectionCount,
        shopifyProductsCount,
        restartAllowed: true,
      };
    }

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
    productsCompleted: resume ? state.productsCompleted === true : false,
    syncedProductCount: resume ? Number(state.syncedProductCount || 0) : 0,
    syncedCollectionCount: resume ? Number(state.syncedCollectionCount || 0) : 0,
    shopifyProductsCount,
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

      await reconcileCollectionProductHandlesFromProducts(cache);

      if (productsResult.paused) {
        return pauseSyncChunk(cache, {
          phase: 'products',
          productCursor: productsResult.nextCursor,
          productsCompleted: false,
          syncedProductCount: productsResult.totalSaved,
          chunkPages: chunk.pages,
          chunkPageSize: chunk.pageSize,
        });
      }

      return pauseSyncChunk(cache, {
        phase: 'collections',
        productCursor: null,
        collectionCursor: null,
        productsCompleted: true,
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

    await reconcileAllCollectionImageUrls(cache);
    await reconcileCollectionProductHandlesFromProducts(cache);
    await applyCollectionHandleAliases(cache);

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

    if (!isCatalogProductCountSatisfied(productCount, shopifyProductsCount)) {
      const incompleteMessage = `Catalog sync finished pagination with ${productCount}/${shopifyProductsCount || 'unknown'} Shopify products in Redis. Retry with restart=true.`;
      await setSyncState(cache, {
        status: 'failed',
        phase: 'products',
        productCursor: null,
        collectionCursor: null,
        productsCompleted: false,
        syncedProductCount: productCount,
        syncedCollectionCount: collectionCount,
        shopifyProductsCount,
        lastError: incompleteMessage,
        message: incompleteMessage,
        completedAt: null,
      });
      await checkpointCache(cache);
      console.log(`[NOOD sync] incomplete productCount=${productCount} shopifyProductsCount=${shopifyProductsCount}`);

      return {
        status: 'restart_required',
        message: incompleteMessage,
        productCount,
        collectionCount,
        shopifyProductsCount,
        restartAllowed: true,
      };
    }

    await setSyncState(cache, {
      status: 'completed',
      phase: 'completed',
      productCursor: null,
      collectionCursor: null,
      productsCompleted: true,
      syncedProductCount: productCount,
      syncedCollectionCount: collectionCount,
      shopifyProductsCount,
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

async function activateCompletedCatalogVersion(cache, options = {}) {
  if (
    typeof cache.finalizeCatalogStaging !== 'function' ||
    typeof cache.activateCatalogVersion !== 'function'
  ) {
    return null;
  }

  const state = await getSyncState(cache);
  const versionId = safeString(state.versionId);
  if (!versionId) {
    return null;
  }

  if (typeof options.verifyLock === 'function') {
    const lockStillOwned = await options.verifyLock();
    if (!lockStillOwned) {
      const message = 'Catalog sync lock ownership was lost before activation.';
      await setSyncState(cache, { status: 'failed', lastError: message, message });
      if (typeof cache.setCatalogVersionMeta === 'function') {
        await cache.setCatalogVersionMeta(versionId, { status: 'failed', lastSafeError: message });
      }
      throw new Error(message);
    }
  }

  await setSyncState(cache, { status: 'validating', phase: 'validating' });
  await cache.finalizeCatalogStaging({ versionId, hasNextPage: false, status: 'validating' });
  const validation = await validateCatalogVersion(cache, versionId);
  await cache.finalizeCatalogStaging({ versionId, hasNextPage: false, status: 'validated', validation });

  if (typeof options.verifyLock === 'function' && !(await options.verifyLock())) {
    const message = 'Catalog sync lock ownership was lost during validation.';
    await setSyncState(cache, { status: 'failed', lastError: message, message });
    await cache.setCatalogVersionMeta(versionId, { status: 'failed', lastSafeError: message });
    throw new Error(message);
  }

  await setSyncState(cache, { status: 'activating', phase: 'activating' });
  const activeMeta = await cache.activateCatalogVersion(versionId, {
    lockOwner: safeString(options.lockOwner),
    actor: safeString(options.actor, 'catalog-sync'),
    reason: 'full-sync',
    validation,
  });
  await setSyncState(cache, {
    status: 'completed',
    phase: 'completed',
    activeVersionId: versionId,
    completedAt: activeMeta.activatedAt || new Date().toISOString(),
    lastError: null,
    message: null,
  });
  return activeMeta;
}

async function runCatalogSyncUntilComplete(cache, options = {}) {
  const chunk = resolveSyncChunkOptions(options);
  let resume = Boolean(options.resume);
  let lastResult = null;

  while (true) {
    const stateBefore = await getSyncState(cache);
    console.log(`[NOOD sync] chunk started cursor=${formatSyncCursor(stateBefore)}`);

    const runChunk = () => runResumableCatalogSync(cache, {
      syncMenus: options.syncMenus !== false,
      resume,
      pages: chunk.pages,
      pageSize: chunk.pageSize,
      shopifyProductsCount: options.shopifyProductsCount,
    });
    lastResult =
      typeof cache.withCatalogStagingWrites === 'function'
        ? await cache.withCatalogStagingWrites(runChunk)
        : await runChunk();

    if (lastResult?.status === 'completed') {
      await activateCompletedCatalogVersion(cache, {
        verifyLock: options.verifyLock,
        lockOwner: options.lockOwner,
        actor: options.actor,
      });
      return lastResult;
    }

    if (lastResult?.status !== 'paused') {
      return lastResult;
    }

    const nextCursor = lastResult.nextCursor || formatSyncCursor(await getSyncState(cache));
    console.log(`[NOOD sync] auto-resume next cursor=${nextCursor || 'start'}`);

    await sleep(AUTO_RESUME_DELAY_MS);
    resume = true;
  }
}

async function startBackgroundCatalogSync(cache, options = {}) {
  const state = await getSyncState(cache);
  let restart = Boolean(options.restart);
  const forceResume = parseForceResumeFlag(options.forceResume);
  const stale = isSyncStale(state, { forceResume });
  const chunk = resolveSyncChunkOptions(options);
  const alreadyRunning = state.status === 'running' && !stale;
  const backgroundSyncActive = Boolean(activeSyncPromise) && !stale;
  let counts = await getCatalogCounts(cache, {
    phase: state.phase || null,
    syncedProductCount: state.syncedProductCount,
    syncedCollectionCount: state.syncedCollectionCount,
  });
  const shopifyProductsCount = await fetchShopifyProductsCount();

  if (state.status === 'completed' && !restart && !forceResume) {
    if (hasStaleDeletedProducts(counts.productCount, shopifyProductsCount)) {
      console.log(
        `[NOOD sync] cache has stale deleted products cache=${counts.productCount} shopify=${shopifyProductsCount}; pruning`
      );
      const pruneResult = await pruneDeletedProductsFromShopify(cache);
      counts = await getCatalogCounts(cache, { phase: 'completed' });

      if (!needsCatalogProductResync(counts.productCount, shopifyProductsCount)) {
        return {
          status: 'pruned',
          message: `Removed ${pruneResult.removed} deleted products from cache.`,
          productCount: counts.productCount,
          shopifyProductsCount,
          pruned: pruneResult.removed,
        };
      }
    }

    if (needsCatalogProductResync(counts.productCount, shopifyProductsCount)) {
      restart = true;
      console.log(
        `[NOOD sync] product count mismatch cache=${counts.productCount} shopify=${shopifyProductsCount}; restarting sync`
      );
    } else {
      return {
        status: 'already_completed',
        message: 'Catalog sync already completed.',
        productCount: counts.productCount,
        shopifyProductsCount,
      };
    }
  }

  if (alreadyRunning || backgroundSyncActive) {
    if (restart) {
      console.log('[NOOD sync] reset blocked during running sync');
    }
    return {
      status: 'already_running',
      message: restart
        ? 'Catalog sync is already running; restart reset was blocked.'
        : 'Catalog sync is already running.',
      productCount: counts.productCount,
      shopifyProductsCount,
    };
  }

  if (stale && activeSyncPromise) {
    clearActiveSyncLock();
  }

  const redisSyncLock = await acquireCatalogSyncLock(cache);
  if (redisSyncLock && !redisSyncLock.acquired) {
    return {
      status: 'already_running',
      message: 'Catalog sync is already running on another backend instance.',
      productCount: counts.productCount,
      shopifyProductsCount,
    };
  }
  let renewTimer = null;
  let lockLostError = null;
  const renewLock = async () => {
    if (!redisSyncLock?.acquired || typeof redisSyncLock.renew !== 'function') {
      return true;
    }
    try {
      await redisSyncLock.renew();
      return true;
    } catch (error) {
      lockLostError = error;
      return false;
    }
  };
  if (redisSyncLock?.acquired && typeof redisSyncLock.renew === 'function') {
    const renewMs = Math.max(1, Number(process.env.CATALOG_SYNC_LOCK_RENEW_SECONDS || 300)) * 1000;
    renewTimer = setInterval(() => {
      void renewLock().catch(() => {});
    }, renewMs);
    if (typeof renewTimer.unref === 'function') renewTimer.unref();
  }

  const shouldResume =
    !restart &&
    (forceResume ||
      state.status === 'paused' ||
      state.status === 'failed' ||
      (state.status === 'running' && stale)) &&
    state.status !== 'completed';

  if (typeof cache.beginCatalogStaging === 'function') {
    await cache.beginCatalogStaging({
      resume: shouldResume,
      previousActiveVersion: state.previousActiveVersion || '',
    });
  }

  if (restart || !shouldResume) {
    const prepare = () => prepareFreshSync(cache, { allowRunningReset: true });
    const resetResult =
      typeof cache.withCatalogStagingWrites === 'function'
        ? await cache.withCatalogStagingWrites(prepare)
        : await prepare();
    if (resetResult.blocked) {
      return {
        status: 'already_running',
        message: 'Catalog sync is already running; reset was blocked.',
        productCount: counts.productCount,
        shopifyProductsCount,
      };
    }
    counts = await getCatalogCounts(cache, { phase: null });
  }

  console.log(
    `[NOOD sync] started resume=${shouldResume} restart=${restart} forceResume=${forceResume} stale=${stale} pages=${chunk.pages} pageSize=${chunk.pageSize}`
  );

  activeSyncPromise = runCatalogSyncUntilComplete(cache, {
    syncMenus: options.syncMenus !== false,
    resume: shouldResume,
    pages: chunk.pages,
    pageSize: chunk.pageSize,
    shopifyProductsCount,
    lockOwner: redisSyncLock?.ownerToken || '',
    verifyLock: async () => {
      if (lockLostError) return false;
      return renewLock();
    },
    actor: 'background-catalog-sync',
  })
    .catch(async (error) => {
      const message = safeString(error?.message || error, 'Catalog sync failed.');
      console.log(`[NOOD sync] failed error=${message}`);
      try {
        await setSyncState(cache, {
          status: 'failed',
          lastError: message,
          message: null,
        });
        await checkpointCache(cache);
      } catch (stateError) {
        console.log(`[NOOD sync] failed error=${safeString(stateError?.message || stateError)}`);
      }
      return null;
    })
    .finally(() => {
      activeSyncPromise = null;
      if (renewTimer) {
        clearInterval(renewTimer);
      }
      if (redisSyncLock?.acquired) {
        void redisSyncLock.release().catch((error) => {
          console.warn('[NOOD sync] failed to release Redis sync lock', {
            message: error.message,
          });
        });
      }
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
    productCount: counts.productCount,
    shopifyProductsCount,
    message: forceResume
      ? 'Catalog sync resumed from saved phase/cursor; auto-continuing until complete.'
      : shouldResume
        ? 'Catalog sync resumed in background; auto-continuing until complete.'
        : 'Catalog sync started in background; auto-continuing until complete.',
  };
}

async function syncAllProducts(cache, options = {}) {
  const redisSyncLock = await acquireCatalogSyncLock(cache);
  if (redisSyncLock && !redisSyncLock.acquired) {
    return {
      status: 'already_running',
      message: 'Catalog sync is already running on another backend instance.',
    };
  }

  try {
    if (typeof cache.beginCatalogStaging === 'function') {
      await cache.beginCatalogStaging({ resume: Boolean(options.resume) });
    }
    return await runCatalogSyncUntilComplete(cache, {
      syncMenus: options.syncMenus !== false,
      resume: Boolean(options.resume),
      pages: options.pages,
      pageSize: options.pageSize,
      lockOwner: redisSyncLock?.ownerToken || '',
      verifyLock: async () => {
        if (!redisSyncLock?.acquired || typeof redisSyncLock.renew !== 'function') return true;
        await redisSyncLock.renew();
        return true;
      },
      actor: 'manual-catalog-sync',
    });
  } finally {
    if (redisSyncLock?.acquired) {
      await redisSyncLock.release().catch((error) => {
        console.warn('[NOOD sync] failed to release Redis sync lock', { message: error.message });
      });
    }
  }
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
  pruneDeletedProductsFromShopify,
  pruneProductsNotInHandleSet,
  syncCollectionByAdminId,
  refreshAffectedCollections,
  refreshCollectionsForHandles,
  deleteCollectionFromCache,
  syncCollectionsAndMenusLight,
  syncMenus,
  ensureCatalogWarm,
  normalizeCollection,
  reconcileCollectionProductHandlesFromProducts,
  applyCollectionHandleAliases,
};
