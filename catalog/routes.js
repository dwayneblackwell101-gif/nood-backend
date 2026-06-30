const express = require('express');
const {
  paginateItems,
  paginateListProducts,
  searchProducts,
  safeString,
  toStorefrontListProduct,
} = require('./transform');
const { getOrBuildMixedHandleOrder } = require('./feed-mix');
const { startBackgroundCatalogSync, getCatalogSyncStatus } = require('./sync');
const {
  storefrontGraphql,
  STOREFRONT_MENU_QUERY,
  STOREFRONT_COLLECTION_PRODUCTS_QUERY,
  STOREFRONT_COLLECTIONS_BROWSER_QUERY,
  STOREFRONT_PRODUCT_DETAIL_QUERY,
} = require('./shopify');
const { getProductRecommendations } = require('./recommendations');
const { createDiscountsHandler } = require('./discounts');
const {
  resolveCanonicalCollectionHandle,
} = require('./collection-aliases');
const {
  reconcileCollectionProductHandlesFromProducts,
  applyCollectionHandleAliases,
} = require('./sync');

function sendCatalogResponse(res, payload, source) {
  res.setHeader('X-NOOD-Catalog-Source', source);
  return res.json({
    success: true,
    source,
    ...payload,
  });
}

function formatCachedProductDetail(product) {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml || product.description || '',
    description: product.description || '',
    vendor: product.vendor || '',
    productType: product.productType || '',
    tags: Array.isArray(product.tags) ? product.tags : [],
    availableForSale: Boolean(product.availableForSale),
    featuredImage: product.featuredImage || null,
    images: product.images || { edges: [] },
    media: product.media || { edges: [] },
    priceRange: product.priceRange || null,
    compareAtPriceRange: product.compareAtPriceRange || { maxVariantPrice: null },
    variants: product.variants || { edges: [] },
    collections: product.collections || { edges: [] },
  };
}

function getActiveProducts(products) {
  return (Array.isArray(products) ? products : []).filter((product) => {
    if (!product || !product.id || !product.handle) {
      return false;
    }
    return safeString(product?.status).toUpperCase() !== 'ARCHIVED';
  });
}

let searchableProductsCache = null;
let searchableProductsCacheAt = 0;
let searchableProductsCacheVersion = null;
let searchableProductsCachePromise = null;
const SEARCHABLE_PRODUCTS_TTL_MS = 10 * 60 * 1000;

function invalidateSearchableProductsCache() {
  searchableProductsCache = null;
  searchableProductsCacheAt = 0;
  searchableProductsCacheVersion = null;
  searchableProductsCachePromise = null;
  invalidateCollectionProductHandlesIndex();
}

let collectionProductHandlesIndex = null;
let collectionProductHandlesIndexAt = 0;
let collectionProductHandlesIndexVersion = null;
let collectionProductHandlesIndexPromise = null;
const COLLECTION_HANDLES_INDEX_TTL_MS = 10 * 60 * 1000;

function invalidateCollectionProductHandlesIndex() {
  collectionProductHandlesIndex = null;
  collectionProductHandlesIndexAt = 0;
  collectionProductHandlesIndexVersion = null;
  collectionProductHandlesIndexPromise = null;
}

function normalizeCollectionMatchKey(value) {
  return safeString(value).toLowerCase().replace(/^#/, '').trim();
}

function getProductCollectionKeys(product) {
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

function collectionMatchKeys(collection) {
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

function collectionKeysOverlap(leftKeys, rightKeys) {
  for (const leftKey of leftKeys) {
    if (rightKeys.has(leftKey)) {
      return true;
    }

    if (leftKey.endsWith('-1') && rightKeys.has(leftKey.slice(0, -2))) {
      return true;
    }

    if (leftKey.endsWith('-2') && rightKeys.has(leftKey.slice(0, -2))) {
      return true;
    }
  }

  for (const rightKey of rightKeys) {
    if (rightKey.endsWith('-1') && leftKeys.has(rightKey.slice(0, -2))) {
      return true;
    }

    if (rightKey.endsWith('-2') && leftKeys.has(rightKey.slice(0, -2))) {
      return true;
    }
  }

  return false;
}

function productMatchesCollection(product, collection) {
  const targetKeys = collectionMatchKeys(collection);
  if (!targetKeys.size) {
    return false;
  }

  const productKeys = getProductCollectionKeys(product);
  return collectionKeysOverlap(targetKeys, productKeys);
}

function appendUniqueHandles(targetHandles, seen, handles = []) {
  for (const handle of handles) {
    const normalized = safeString(handle);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    targetHandles.push(normalized);
  }
}

function registerProductHandleOnIndexKey(index, key, productHandle) {
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
    registerProductHandleOnIndexKey(index, normalizedKey.slice(0, -2), productHandle);
  }

  if (normalizedKey.endsWith('-2')) {
    registerProductHandleOnIndexKey(index, normalizedKey.slice(0, -2), productHandle);
  }
}

function buildCollectionProductHandlesIndex(products = []) {
  const index = new Map();

  for (const product of products) {
    const productHandle = safeString(product?.handle);
    if (!productHandle || !isActiveCatalogProduct(product)) {
      continue;
    }

    for (const key of getProductCollectionKeys(product)) {
      registerProductHandleOnIndexKey(index, key, productHandle);
    }
  }

  return index;
}

function mapMixMetaRowToIndexProduct(row) {
  return {
    handle: row.handle,
    id: row.id,
    title: row.title || '',
    vendor: row.vendor || '',
    productType: row.productType || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    collectionHandles: row.collectionHandles,
    collections: {
      edges: (row.collectionHandles || []).map((handle) => ({
        node: { handle, title: handle },
      })),
    },
    status: 'ACTIVE',
  };
}

function searchIndexProducts(products, query) {
  const needle = safeString(query).toLowerCase();
  if (!needle) {
    return [];
  }

  return products.filter((product) => {
    const haystack = [
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      ...(product.tags || []),
      ...(product.collectionHandles || []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

async function getProductsForCollectionIndex(cache) {
  if (typeof cache.getProductMixIndex === 'function') {
    const rows = await cache.getProductMixIndex();
    if (Array.isArray(rows) && rows.length) {
      return rows.map((row) => mapMixMetaRowToIndexProduct(row));
    }
  }

  if (typeof cache.listProductMixMeta === 'function') {
    const rows = await cache.listProductMixMeta();
    return rows.map((row) => mapMixMetaRowToIndexProduct(row));
  }

  return getActiveProducts(await cache.getAllProducts());
}

async function warmCollectionProductHandlesIndex(cache, { force = false } = {}) {
  const meta = await cache.getMeta();
  const catalogVersion = Number(meta?.catalogVersion) || 0;
  const cacheFresh =
    !force &&
    collectionProductHandlesIndex &&
    collectionProductHandlesIndexVersion === catalogVersion &&
    Date.now() - collectionProductHandlesIndexAt < COLLECTION_HANDLES_INDEX_TTL_MS;

  if (cacheFresh) {
    return collectionProductHandlesIndex;
  }

  if (collectionProductHandlesIndexPromise) {
    return collectionProductHandlesIndexPromise;
  }

  collectionProductHandlesIndexPromise = (async () => {
    const startedAt = Date.now();
    const products = await getProductsForCollectionIndex(cache);
    collectionProductHandlesIndex = buildCollectionProductHandlesIndex(products);
    collectionProductHandlesIndexAt = Date.now();
    collectionProductHandlesIndexVersion = catalogVersion;
    collectionProductHandlesIndexPromise = null;
    console.log('[NOOD catalog] collection handle index warmed', {
      productCount: products.length,
      collectionKeys: collectionProductHandlesIndex.size,
      catalogVersion,
      ms: Date.now() - startedAt,
    });
    return collectionProductHandlesIndex;
  })().catch((error) => {
    collectionProductHandlesIndexPromise = null;
    throw error;
  });

  return collectionProductHandlesIndexPromise;
}

async function resolveCollectionProductHandles(cache, collection) {
  const storedHandles = Array.isArray(collection?.productHandles)
    ? collection.productHandles.map((handle) => safeString(handle)).filter(Boolean)
    : [];

  const index = await warmCollectionProductHandlesIndex(cache);
  const matchKeys = collectionMatchKeys(collection);
  const merged = [];
  const seen = new Set();

  for (const key of matchKeys) {
    appendUniqueHandles(merged, seen, index.get(key) || []);
  }

  if (!merged.length) {
    const products = await getProductsForCollectionIndex(cache);
    for (const product of products) {
      if (!productMatchesCollection(product, collection)) {
        continue;
      }

      const handle = safeString(product?.handle);
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (storedHandles.length) {
    const verifiedStored = await fetchProductsByHandles(
      cache,
      storedHandles.slice(0, COLLECTION_PRODUCTS_BATCH_SIZE)
    );
    const activeStoredHandles = verifiedStored
      .filter(isActiveCatalogProduct)
      .map((product) => safeString(product.handle))
      .filter(Boolean);
    appendUniqueHandles(merged, seen, activeStoredHandles);
  }

  if (!merged.length) {
    const indexProducts = await getProductsForCollectionIndex(cache);
    const handleKey = normalizeCollectionMatchKey(collection?.handle);
    const titleKey = normalizeCollectionMatchKey(collection?.title);
    const terms = Array.from(
      new Set(
        [
          handleKey,
          titleKey,
          handleKey.replace(/-/g, ' '),
          titleKey.replace(/-/g, ' '),
          ...(COLLECTION_SEARCH_TERMS[handleKey] || []),
        ].filter(Boolean)
      )
    );

    for (const term of terms) {
      const matches = searchIndexProducts(indexProducts, term);
      for (const product of matches) {
        appendUniqueHandles(merged, seen, [product.handle]);
      }
      if (merged.length) {
        break;
      }
    }
  }

  const source = merged.length
    ? storedHandles.length && seen.size > 0
      ? 'reverse_lookup+verified_handles'
      : 'reverse_lookup'
    : 'empty';

  if (merged.length && source.startsWith('reverse_lookup')) {
    console.log('[NOOD catalog] collection products reverse lookup', {
      handle: collection?.handle,
      title: collection?.title,
      count: merged.length,
      storedHandles: storedHandles.length,
      source,
    });
  }

  return {
    handles: merged,
    source,
  };
}

async function warmSearchableProductsCache(cache, { force = false } = {}) {
  const meta = await cache.getMeta();
  const catalogVersion = Number(meta?.catalogVersion) || 0;
  const cacheFresh =
    !force &&
    searchableProductsCache &&
    searchableProductsCacheVersion === catalogVersion &&
    Date.now() - searchableProductsCacheAt < SEARCHABLE_PRODUCTS_TTL_MS;

  if (cacheFresh) {
    return searchableProductsCache;
  }

  if (searchableProductsCachePromise) {
    return searchableProductsCachePromise;
  }

  searchableProductsCachePromise = (async () => {
    const startedAt = Date.now();
    const products = getActiveProducts(await cache.getAllProducts());
    searchableProductsCache = products;
    searchableProductsCacheAt = Date.now();
    searchableProductsCacheVersion = catalogVersion;
    searchableProductsCachePromise = null;
    console.log('[NOOD catalog] search cache warmed', {
      count: products.length,
      catalogVersion,
      ms: Date.now() - startedAt,
    });
    return products;
  })().catch((error) => {
    searchableProductsCachePromise = null;
    throw error;
  });

  return searchableProductsCachePromise;
}

function safeToStorefrontListProduct(product) {
  if (!product?.id || !product?.handle) {
    return null;
  }

  try {
    return toStorefrontListProduct(product);
  } catch (error) {
    console.log(
      `[NOOD catalog] skipped invalid redis product handle=${safeString(product?.handle, 'unknown')} reason=map_error`
    );
    return null;
  }
}

function buildProductListPage(items, total, hasNextPage, endCursor) {
  const edges = (Array.isArray(items) ? items : [])
    .map((product) => {
      const node = safeToStorefrontListProduct(product);
      return node ? { node } : null;
    })
    .filter(Boolean);

  return {
    edges,
    pageInfo: {
      hasNextPage: Boolean(hasNextPage),
      endCursor: hasNextPage ? endCursor : null,
    },
    total,
  };
}

async function loadMixMetaIndex(cache) {
  if (typeof cache.getProductMixIndex === 'function') {
    return cache.getProductMixIndex();
  }

  if (typeof cache.listProductMixMeta === 'function') {
    return cache.listProductMixMeta();
  }

  const products = getActiveProducts(await cache.getAllProducts());
  return products.map((product) => ({
    handle: product.handle,
    id: String(product.id),
    collectionHandles: Array.isArray(product.collectionHandles) && product.collectionHandles.length
      ? product.collectionHandles.map((value) => safeString(value)).filter(Boolean)
      : (product.collections?.edges || [])
          .map((edge) => safeString(edge?.node?.handle))
          .filter(Boolean),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 12) : [],
    productType: safeString(product.productType),
    vendor: safeString(product.vendor),
  }));
}

async function getOrBuildOrderedMixedHandles(cache, mixMetaRows, mixKey) {
  const productCount = mixMetaRows.length;

  if (typeof cache.getMixedHandleOrder === 'function') {
    const cached = await cache.getMixedHandleOrder(productCount, mixKey);
    if (Array.isArray(cached) && cached.length > 0) {
      console.log('[NOOD catalog] mixed handle order cache hit');
      return { handles: cached, cacheHit: true };
    }
  }

  const built = getOrBuildMixedHandleOrder(mixMetaRows, mixKey);

  if (built.cacheHit) {
    console.log('[NOOD catalog] mixed handle order cache hit');
  } else {
    console.log('[NOOD catalog] mixed handle order cache built');
    if (typeof cache.setMixedHandleOrder === 'function') {
      await cache.setMixedHandleOrder(productCount, mixKey, built.handles);
    }
  }

  return built;
}

async function loadMixedCatalogProductsPage(cache, { mixKey, limit, after }) {
  const pageLimit = Math.max(1, Math.min(Number(limit) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;

  console.log(
    `[NOOD catalog] mixed feed fast path mixKey=${mixKey} after=${after ?? 'null'} limit=${pageLimit}`
  );

  const mixMetaRows = await loadMixMetaIndex(cache);
  const { handles: orderedHandles, cacheHit } = await getOrBuildOrderedMixedHandles(
    cache,
    mixMetaRows,
    mixKey
  );
  const pageHandles = orderedHandles.slice(start, start + pageLimit);

  console.log(`[NOOD catalog] mixed handles selected count=${pageHandles.length}`);

  const fetchedProducts = await fetchProductsByHandles(cache, pageHandles);
  const productsByHandle = new Map(
    fetchedProducts.filter(isActiveCatalogProduct).map((product) => [product.handle, product])
  );

  let skippedMissing = 0;
  const pageProducts = [];

  for (const handle of pageHandles) {
    const product = productsByHandle.get(safeString(handle));
    if (!product) {
      skippedMissing += 1;
      continue;
    }
    pageProducts.push(product);
  }

  if (skippedMissing > 0) {
    console.log(`[NOOD catalog] skipped missing mixed handles count=${skippedMissing}`);
  }

  const nextIndex = start + pageHandles.length;
  const hasNextPage = nextIndex < orderedHandles.length;

  console.log(
    `[NOOD catalog] mixed products returned count=${pageProducts.length} nextCursor=${hasNextPage ? String(nextIndex) : 'null'} hasMore=${hasNextPage}`
  );

  return {
    items: pageProducts,
    total: orderedHandles.length,
    cacheHit,
    paginate: false,
    hasNextPage,
    endCursor: hasNextPage ? String(nextIndex) : null,
  };
}

async function loadCatalogProductsForList(cache, { mixKey, sortKey, limit, after }) {
  const hasMixKey = mixKey !== undefined && mixKey !== null && String(mixKey).length > 0;

  if (hasMixKey) {
    return loadMixedCatalogProductsPage(cache, { mixKey, limit, after });
  }

  if (typeof cache.listProductsPage === 'function') {
    const pageResult = await cache.listProductsPage({
      limit,
      after,
      sortKey,
    });

    return {
      items: pageResult.items,
      total: pageResult.total,
      cacheHit: false,
      paginate: false,
      hasNextPage: pageResult.hasNextPage,
      endCursor: pageResult.endCursor,
    };
  }

  const allProducts = getActiveProducts(await cache.getAllProducts());
  return {
    items: sortProducts(allProducts, sortKey),
    total: allProducts.length,
    cacheHit: false,
    paginate: true,
  };
}

function sortProducts(products, sortKey = 'updated') {
  const copy = [...products];
  if (sortKey === 'created') {
    return copy.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  }
  return copy.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function buildCollectionStorefront(collection, productsByHandle, first, after) {
  const handles = collection?.productHandles || [];
  const products = handles
    .map((handle) => productsByHandle[handle])
    .filter(Boolean);
  const page = paginateItems(products, first, after);

  return {
    data: {
      collectionByHandle: {
        title: collection?.title || '',
        products: page,
      },
    },
  };
}

const COLLECTION_PRODUCTS_BATCH_SIZE = 50;

const COLLECTION_SEARCH_TERMS = {
  lacefront: ['lace', 'lace front', 'lace-front', 'lace wig', 'lace frontal', 'lacefront'],
  nike: ['nike'],
  valley: ['valley'],
  'essentials-fog-1': ['fear of god', 'essentials fog', 'fog essentials'],
};

function isActiveCatalogProduct(product) {
  if (!product?.id || !product?.handle) {
    return false;
  }
  return safeString(product?.status).toUpperCase() !== 'ARCHIVED';
}

async function fetchProductsByHandles(cache, handles = []) {
  const normalizedHandles = handles.map((handle) => safeString(handle)).filter(Boolean);
  if (!normalizedHandles.length) {
    return [];
  }

  if (typeof cache.getProductsByHandles === 'function') {
    return cache.getProductsByHandles(normalizedHandles);
  }

  const products = getActiveProducts(await cache.getAllProducts());
  const byHandle = Object.fromEntries(products.map((product) => [product.handle, product]));
  return normalizedHandles.map((handle) => byHandle[handle]).filter(Boolean);
}

async function loadCollectionProductsPage(cache, collection, first, after) {
  const resolved = await resolveCollectionProductHandles(cache, collection);
  const handles = resolved.handles;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;

  let skippedMissing = 0;
  let validIndex = 0;
  const pageProducts = [];
  let hasNextPage = false;

  for (let batchStart = 0; batchStart < handles.length; batchStart += COLLECTION_PRODUCTS_BATCH_SIZE) {
    const batchHandles = handles.slice(batchStart, batchStart + COLLECTION_PRODUCTS_BATCH_SIZE);
    const fetchedProducts = await fetchProductsByHandles(cache, batchHandles);
    const productsByHandle = new Map(
      fetchedProducts.filter(isActiveCatalogProduct).map((product) => [product.handle, product])
    );

    for (const handle of batchHandles) {
      const product = productsByHandle.get(handle);
      if (!product) {
        skippedMissing += 1;
        continue;
      }

      if (validIndex < start) {
        validIndex += 1;
        continue;
      }

      if (pageProducts.length < limit) {
        pageProducts.push(product);
        validIndex += 1;
        continue;
      }

      hasNextPage = true;
      break;
    }

    if (hasNextPage) {
      break;
    }
  }

  const nextIndex = start + pageProducts.length;

  return {
    pageProducts,
    skippedMissing,
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? String(nextIndex) : null,
    },
  };
}

async function safeGetCollection(cache, handle) {
  const requestedHandle = safeString(handle);
  const canonicalHandle = resolveCanonicalCollectionHandle(requestedHandle);

  try {
    let collection = await cache.getCollection(requestedHandle);
    if (!collection && canonicalHandle !== requestedHandle) {
      collection = await cache.getCollection(canonicalHandle);
      if (collection) {
        console.log('[NOOD catalog] collection alias resolved', {
          requested: requestedHandle,
          canonical: canonicalHandle,
        });
      }
    }
    return collection;
  } catch (error) {
    console.warn('[NOOD catalog] cache.getCollection failed; trying Shopify fallback', {
      handle: requestedHandle,
      canonicalHandle,
      message: error.message,
    });
    return null;
  }
}

async function safeGetProduct(cache, handle) {
  try {
    return await cache.getProduct(handle);
  } catch (error) {
    console.warn('[NOOD catalog] cache.getProduct failed; trying Shopify fallback', {
      handle,
      message: error.message,
    });
    return null;
  }
}

async function fetchCollectionProductsFromShopify(handle, first, after) {
  const payload = await storefrontGraphql(STOREFRONT_COLLECTION_PRODUCTS_QUERY, {
    handle,
    first: Math.max(1, Math.min(Number(first) || 50, 250)),
    after: after || null,
  });
  return payload?.data?.collectionByHandle ? payload : null;
}

async function fetchProductDetailFromShopify(handle) {
  const payload = await storefrontGraphql(STOREFRONT_PRODUCT_DETAIL_QUERY, { handle });
  const detail = payload?.data?.productByHandle;
  if (!detail) {
    return null;
  }

  return {
    data: {
      product: detail,
      productByHandle: detail,
    },
  };
}

function buildCollectionProductsPayload(collection, pageProducts, pageInfo) {
  return {
    data: {
      collectionByHandle: {
        title: collection?.title || '',
        products: {
          edges: pageProducts.map((product) => ({ node: product })),
          pageInfo,
        },
      },
    },
  };
}

async function tryCollectionProductsShopifyFallback(res, { handle, first, after, reason }) {
  const requestedHandle = safeString(handle);
  const lookupHandles = Array.from(
    new Set(
      [requestedHandle, resolveCanonicalCollectionHandle(requestedHandle)].filter(Boolean)
    )
  );

  for (const lookupHandle of lookupHandles) {
    try {
      const shopifyPayload = await fetchCollectionProductsFromShopify(lookupHandle, first, after);
      if (shopifyPayload) {
        console.log('[NOOD catalog] collection products shopify fallback', {
          handle: requestedHandle,
          lookupHandle,
          reason,
          returned: shopifyPayload?.data?.collectionByHandle?.products?.edges?.length || 0,
        });
        sendCatalogResponse(res, shopifyPayload, 'shopify');
        return true;
      }
    } catch (error) {
      console.warn('[NOOD catalog] collection shopify fallback failed:', {
        handle: requestedHandle,
        lookupHandle,
        message: error.message,
      });
    }
  }

  return false;
}

function createCatalogRouter({ cache, requireAdminApiKey }) {
  const router = express.Router();

  router.get('/sync/shopify/products/status', createCatalogSyncStatusHandler(cache));
  router.post('/sync/shopify/products', requireAdminApiKey, createCatalogSyncHandler(cache));
  router.post('/admin/rebuild-collections', requireAdminApiKey, async (req, res) => {
    try {
      const reconcile = await reconcileCollectionProductHandlesFromProducts(cache);
      const aliases = await applyCollectionHandleAliases(cache);
      invalidateCollectionProductHandlesIndex();

      const sample = {};
      for (const requiredHandle of ['men', 'women', 'kids', 'shoes', 'electronics']) {
        const collection = await safeGetCollection(cache, requiredHandle);
        sample[requiredHandle] = collection?.productHandles?.length || 0;
      }

      console.log('[NOOD catalog] admin rebuild-collections complete', {
        reconcile,
        aliases,
        sample,
      });

      return res.json({
        success: true,
        source: 'cache',
        reconcile,
        aliases,
        sample,
      });
    } catch (error) {
      console.error('[NOOD catalog] admin rebuild-collections failed:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Collection rebuild failed.',
      });
    }
  });
  console.log('[NOOD sync] status route mounted');

  router.get('/discounts', createDiscountsHandler());
  console.log('[NOOD routes] mounted GET /api/catalog/discounts');

  router.get('/health', async (req, res) => {
    const meta = await cache.getMeta();
    const productCount =
      typeof cache.getProductCount === 'function'
        ? await cache.getProductCount()
        : meta.productCount || 0;
    const collectionCount =
      typeof cache.getCollectionCount === 'function'
        ? await cache.getCollectionCount()
        : meta.collectionCount || 0;

    return res.json({
      ok: true,
      cacheDriver: cache.driver(),
      productCount,
      collectionCount,
      lastSyncAt: meta.lastSyncAt || null,
      catalogVersion: Number(meta.catalogVersion) || 0,
      catalogUpdatedAt: meta.catalogUpdatedAt || null,
    });
  });

  router.get('/version', async (req, res) => {
    try {
      const meta = await cache.getMeta();

      return res.json({
        ok: true,
        catalogVersion: Number(meta.catalogVersion) || 0,
        catalogUpdatedAt: meta.catalogUpdatedAt || null,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: error.message || 'Could not read catalog version.',
      });
    }
  });
  console.log('[NOOD routes] mounted GET /api/catalog/version');

  router.get('/products', async (req, res) => {
    const first = Number(req.query.first || req.query.limit || 50);
    const after = req.query.after || null;
    const sortKey = safeString(req.query.sort, 'updated');
    const mixKey = req.query.mixKey;
    const afterIndex = Number(after) > 0 ? Number(after) : 0;
    const pageNumber = Math.floor(afterIndex / Math.max(1, first)) + 1;

    try {
      const loaded = await loadCatalogProductsForList(cache, {
        mixKey,
        sortKey,
        limit: first,
        after,
      });

      const page = loaded.paginate
        ? paginateListProducts(loaded.items, first, after)
        : buildProductListPage(
            loaded.items,
            loaded.total,
            loaded.hasNextPage,
            loaded.endCursor
          );

      console.log(
        `[NOOD catalog] products returned count=${page.edges.length} total=${loaded.total}`
      );
      console.log(
        `[NOOD feed] mixed feed source=cache total=${loaded.total} returned=${page.edges.length} cacheHit=${loaded.cacheHit} slim=true`
      );
      console.log(`[NOOD feed] mixKey=${mixKey ?? 'none'} page=${pageNumber}`);

      return sendCatalogResponse(
        res,
        {
          data: {
            products: page,
          },
        },
        'cache'
      );
    } catch (error) {
      console.error('[NOOD catalog] GET /products failed:', error.message);
      return res.status(500).json({
        success: false,
        source: 'cache',
        message: error.message || 'Could not read catalog products.',
      });
    }
  });

  router.get('/products/recommendations', async (req, res) => {
    const productId = safeString(req.query.productId || req.query.product_id || req.query.id);
    const result = await getProductRecommendations(cache, productId);

    console.log('[NOOD catalog] GET /products/recommendations', {
      source: result.source,
      returned: result.items.length,
      usedFallback: result.usedFallback,
      productId: productId || null,
    });

    return sendCatalogResponse(
      res,
      {
        data: {
          productRecommendations: result.items,
        },
      },
      result.source
    );
  });

  router.get('/products/:handle', async (req, res) => {
    try {
      const handle = safeString(req.params.handle);
      if (handle === 'recommendations') {
        const productId = safeString(req.query.productId || req.query.product_id || req.query.id);
        const result = await getProductRecommendations(cache, productId);
        return sendCatalogResponse(
          res,
          {
            data: {
              productRecommendations: result.items,
            },
          },
          result.source
        );
      }

      if (!handle) {
        return res.status(404).json({
          success: false,
          error: true,
          message: 'Product not found',
        });
      }

      let product = await safeGetProduct(cache, handle);

      if (!product?.handle || !product?.id) {
        console.log(`[NOOD product] cache miss handle=${handle}`);
        try {
          const shopifyPayload = await fetchProductDetailFromShopify(handle);
          if (shopifyPayload?.data?.productByHandle) {
            const detail = formatCachedProductDetail(shopifyPayload.data.productByHandle);
            console.log(`[NOOD product] shopify fallback handle=${handle} title=${safeString(detail.title)}`);
            return sendCatalogResponse(
              res,
              {
                data: {
                  product: detail,
                  productByHandle: detail,
                },
              },
              'shopify'
            );
          }
        } catch (error) {
          console.warn('[NOOD catalog] product shopify fallback failed:', error.message);
        }

        return res.status(404).json({
          success: false,
          error: true,
          message: 'Product not found',
        });
      }

      console.log(`[NOOD product] cache hit handle=${handle} title=${safeString(product.title)}`);
      const detail = formatCachedProductDetail(product);
      console.log(`[NOOD product] detail returned handle=${handle} title=${safeString(detail.title)}`);

      return sendCatalogResponse(
        res,
        {
          data: {
            product: detail,
            productByHandle: detail,
          },
        },
        'cache'
      );
    } catch (error) {
      console.error('[NOOD catalog] GET /products/:handle failed:', error.message);
      return res.status(500).json({
        success: false,
        error: true,
        message: error.message || 'Could not read product detail.',
      });
    }
  });

  router.get('/products/:handle/recommendations', async (req, res) => {
    const handle = safeString(req.params.handle);
    const result = await getProductRecommendations(cache, handle);

    console.log('[NOOD catalog] GET /products/:handle/recommendations', {
      source: result.source,
      handle,
      returned: result.items.length,
      usedFallback: result.usedFallback,
    });

    return sendCatalogResponse(
      res,
      {
        data: {
          productRecommendations: result.items,
        },
      },
      result.source
    );
  });

  router.get('/collections/:handle/products', async (req, res) => {
    const handle = safeString(req.params.handle);
    const first = Number(req.query.first || req.query.limit || 250);
    const after = req.query.after || null;

    const collection = await safeGetCollection(cache, handle);

    if (!collection) {
      if (await tryCollectionProductsShopifyFallback(res, { handle, first, after, reason: 'cache_miss' })) {
        return;
      }

      return res.status(404).json({
        success: false,
        source: 'cache',
        message: 'Collection not found in catalog cache.',
      });
    }

    console.log('[NOOD catalog] collection products fast path', { handle });

    let pageProducts;
    let skippedMissing;
    let pageInfo;

    try {
      ({ pageProducts, skippedMissing, pageInfo } = await loadCollectionProductsPage(
        cache,
        collection,
        first,
        after
      ));
    } catch (error) {
      console.warn('[NOOD catalog] loadCollectionProductsPage failed; trying Shopify fallback', {
        handle,
        message: error.message,
      });
      if (await tryCollectionProductsShopifyFallback(res, { handle, first, after, reason: 'cache_read_error' })) {
        return;
      }
      return res.status(500).json({
        success: false,
        source: 'cache',
        message: error.message || 'Could not read collection products from cache.',
      });
    }

    if (!pageProducts.length && !after) {
      if (await tryCollectionProductsShopifyFallback(res, { handle, first, after, reason: 'empty_cache_page' })) {
        return;
      }
    }

    const payload = buildCollectionProductsPayload(collection, pageProducts, pageInfo);

    console.log('[NOOD catalog] collection products handle=' + handle, {
      requested: first,
      returned: payload.data.collectionByHandle.products.edges.length,
      cursor: pageInfo.endCursor,
      hasNextPage: pageInfo.hasNextPage,
    });

    if (skippedMissing > 0) {
      console.log('[NOOD catalog] collection products skipped missing=' + skippedMissing, {
        handle,
      });
    }

    return sendCatalogResponse(res, payload, 'cache');
  });

  function resolveProductImageForCollectionResponse(product) {
    const featuredImageUrl = safeString(product?.featuredImage?.url);
    if (featuredImageUrl) {
      return featuredImageUrl;
    }

    const imageEdges = product?.images?.edges || [];
    for (const edge of imageEdges) {
      const imageUrl = safeString(edge?.node?.url);
      if (imageUrl) {
        return imageUrl;
      }
    }

    return '';
  }

  function resolveCollectionImageForResponse(collection, resolvedProducts) {
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

    const cachedUrl = safeString(collection?.imageUrl) || safeString(collection?.previewImage);
    if (cachedUrl) {
      return {
        imageUrl: cachedUrl,
        imageSource: safeString(collection?.imageSource) || 'cache',
      };
    }

    for (const product of resolvedProducts || []) {
      const productImageUrl = resolveProductImageForCollectionResponse(product);
      if (productImageUrl) {
        return { imageUrl: productImageUrl, imageSource: 'product' };
      }
    }

    return { imageUrl: '', imageSource: 'fallback' };
  }

  router.get('/collections', async (req, res) => {
    const first = Number(req.query.first || 250);
    const after = req.query.after || null;
    const collections = await cache.getAllCollections();
    const page = paginateItems(collections, first, after);

    const edges = await Promise.all(
      page.edges.map(async (edge) => {
        const collection = edge.node;
        const previewProducts = (collection.productHandles || [])
          .slice(0, 24)
          .map((handle) => cache.getProduct(handle));
        const resolved = (await Promise.all(previewProducts)).filter(Boolean);
        const { imageUrl, imageSource } = resolveCollectionImageForResponse(collection, resolved);

        const firstProductImage = resolved.length
          ? resolveProductImageForCollectionResponse(resolved[0])
          : '';

        return {
          node: {
            id: collection.id,
            title: collection.title,
            handle: collection.handle,
            image: imageUrl ? { url: imageUrl } : collection.image,
            imageUrl,
            imageSource,
            previewImage: imageUrl || null,
            displayImage: safeString(collection?.displayImage) || imageUrl || null,
            fallbackImage: safeString(collection?.fallbackImage) || firstProductImage || null,
            products: {
              edges: resolved.map((product) => ({
                node: {
                  id: product.id,
                  handle: product.handle,
                  title: product.title,
                  featuredImage: product.featuredImage,
                  images: product.images || { edges: [] },
                  priceRange: product.priceRange,
                },
              })),
            },
          },
        };
      })
    );

    const meta = await cache.getMeta();
    const lastSyncAt = meta?.lastSyncAt || null;
    const cacheAgeMs = lastSyncAt ? Math.max(0, Date.now() - new Date(lastSyncAt).getTime()) : null;

    const menHandles = [
      'casablanca-collection',
      'chrome-of-hearts',
      'denim-tears',
      'essentials-fog-1',
      'godspeed',
      'gallery-dept-r',
      'glo-gang',
      'hellstar',
      'house-of-errors',
      'majestik',
      'nike-1',
      'nike',
      'offwhite-1',
      'offwhite',
      'rhude',
      'sp5der-apparel-collection',
      'saint-mxxxxxx',
      'cough-syrup-collection',
      'valley',
      'project-capri',
    ];
    const menImageSamples = edges
      .map((edge) => edge.node)
      .filter((node) => menHandles.includes(safeString(node?.handle)))
      .slice(0, 5)
      .map((node) => ({
        handle: node.handle,
        title: node.title,
        imageUrl: node.imageUrl || null,
        imageSource: node.imageSource || 'fallback',
      }));

    console.log('[NOOD catalog] GET /collections', {
      source: 'cache',
      returned: edges.length,
      total: collections.length,
      lastSyncAt,
      cacheAgeMs,
      cacheAgeMinutes: cacheAgeMs === null ? null : Math.round(cacheAgeMs / 60000),
      menImageUrlLiveCount: edges.filter((edge) => {
        const handle = safeString(edge?.node?.handle);
        return menHandles.includes(handle) && safeString(edge?.node?.imageUrl);
      }).length,
    });
    console.log('[NOOD categories] Render collection imageUrl sample', menImageSamples);

    return sendCatalogResponse(
      res,
      {
        data: {
          collections: {
            pageInfo: page.pageInfo,
            edges,
          },
        },
      },
      'cache'
    );
  });

  router.get('/search', async (req, res) => {
    const startedAt = Date.now();
    const query = safeString(req.query.q || req.query.query);
    const first = Number(req.query.first || 50);

    try {
      const allProducts = await warmSearchableProductsCache(cache);
      const matches = searchProducts(allProducts, query);
      const page = paginateListProducts(matches, first, 0);

      console.log('[NOOD catalog] GET /search', {
        source: 'cache',
        query,
        returned: page.edges.length,
        totalMatches: matches.length,
        ms: Date.now() - startedAt,
      });

      return sendCatalogResponse(
        res,
        {
          data: {
            products: page,
          },
        },
        'cache'
      );
    } catch (error) {
      console.error('[NOOD catalog] GET /search failed', {
        query,
        message: error?.message || String(error),
        ms: Date.now() - startedAt,
      });
      return res.status(500).json({
        success: false,
        message: error?.message || 'Search failed.',
      });
    }
  });

  router.get('/menus/:handle', async (req, res) => {
    const handle = safeString(req.params.handle);
    let menu = await cache.getMenu(handle);
    let source = 'cache';

    if (!menu) {
      try {
        const payload = await storefrontGraphql(STOREFRONT_MENU_QUERY, { handle });
        menu = payload?.data?.menu;
        source = 'shopify';
        if (menu) {
          await cache.setMenu(handle, menu);
        }
        const meta = await cache.getMeta();
        const lastSyncAt = meta?.lastSyncAt || null;
        const cacheAgeMs = lastSyncAt ? Math.max(0, Date.now() - new Date(lastSyncAt).getTime()) : null;
        console.log('[NOOD catalog] GET /menus/:handle from shopify', {
          handle,
          lastSyncAt,
          cacheAgeMs,
        });
        return sendCatalogResponse(res, payload, source);
      } catch (error) {
        console.warn('[NOOD catalog] menu storefront fallback failed:', error.message);
      }
    }

    const meta = await cache.getMeta();
    const lastSyncAt = meta?.lastSyncAt || null;
    const cacheAgeMs = lastSyncAt ? Math.max(0, Date.now() - new Date(lastSyncAt).getTime()) : null;
    console.log('[NOOD catalog] GET /menus/:handle from cache', {
      handle,
      lastSyncAt,
      cacheAgeMs,
      cacheAgeMinutes: cacheAgeMs === null ? null : Math.round(cacheAgeMs / 60000),
    });

    return sendCatalogResponse(
      res,
      {
        data: {
          menu,
        },
      },
      source
    );
  });

  return router;
}

function parseSyncInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function createCatalogSyncHandler(cache) {
  return async function handleCatalogSync(req, res) {
    try {
      const restart =
        req.query.restart === '1' ||
        req.query.restart === 'true' ||
        req.body?.restart === true;
      const forceResume =
        req.query.forceResume === '1' ||
        req.query.forceResume === 'true' ||
        req.body?.forceResume === true ||
        req.body?.forceResume === 1 ||
        req.body?.forceResume === '1';
      const pages = parseSyncInt(req.query.pages ?? req.body?.pages, 10);
      const pageSize = parseSyncInt(req.query.pageSize ?? req.body?.pageSize, 25);

      const result = await startBackgroundCatalogSync(cache, {
        syncMenus: true,
        restart,
        forceResume,
        pages,
        pageSize,
      });

      return res.status(202).json({
        success: true,
        source: 'shopify',
        status: result.status,
        resume: Boolean(result.resume),
        restart: Boolean(result.restart),
        forceResume: Boolean(result.forceResume),
        stale: Boolean(result.stale),
        pages: result.pages ?? pages,
        pageSize: result.pageSize ?? pageSize,
        productCount: result.productCount ?? null,
        shopifyProductsCount: result.shopifyProductsCount ?? null,
        restartAllowed: Boolean(result.restartAllowed),
        message:
          result.message ||
          (result.status === 'already_running'
            ? 'Catalog sync is already running.'
            : 'Catalog sync started in background; auto-continuing until complete.'),
      });
    } catch (error) {
      console.error('[NOOD catalog] manual sync failed:', error.message);
      return res.status(500).json({
        success: false,
        source: 'shopify',
        message: error.message || 'Catalog sync failed.',
      });
    }
  };
}

function createCatalogSyncStatusHandler(cache) {
  return async function handleCatalogSyncStatus(req, res) {
    try {
      const status = await getCatalogSyncStatus(cache);
      return res.json({
        success: true,
        status: status.status,
        syncInProgress: status.status === 'running',
        productCount: status.productCount,
        collectionCount: status.collectionCount,
        cursor: status.cursor,
        lastError: status.lastError,
        message: status.message,
        updatedAt: status.updatedAt,
        phase: status.phase,
        chunkPages: status.chunkPages,
        chunkPageSize: status.chunkPageSize,
        cacheDriver: status.cacheDriver,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        status: 'failed',
        message: error.message || 'Could not read catalog sync status.',
        productCount: 0,
        collectionCount: 0,
        cursor: null,
        lastError: error.message || null,
        updatedAt: null,
      });
    }
  };
}

function mountCatalogSyncRoutes(app, { cache, requireAdminApiKey }) {
  const handler = createCatalogSyncHandler(cache);
  const statusHandler = createCatalogSyncStatusHandler(cache);

  app.post('/api/sync/shopify/products', requireAdminApiKey, handler);
  console.log('[NOOD routes] mounted POST /api/sync/shopify/products');

  app.post('/api/catalog/sync/shopify/products', requireAdminApiKey, handler);
  console.log('[NOOD routes] mounted POST /api/catalog/sync/shopify/products');

  app.get('/api/sync/shopify/products/status', statusHandler);
  console.log('[NOOD sync] status route mounted');
  console.log('[NOOD routes] mounted GET /api/sync/shopify/products/status');

  app.get('/api/catalog/sync/shopify/products/status', statusHandler);
  console.log('[NOOD sync] status route mounted');
  console.log('[NOOD routes] mounted GET /api/catalog/sync/shopify/products/status');
}

module.exports = {
  createCatalogRouter,
  createCatalogSyncHandler,
  createCatalogSyncStatusHandler,
  mountCatalogSyncRoutes,
  warmSearchableProductsCache,
  invalidateSearchableProductsCache,
};
