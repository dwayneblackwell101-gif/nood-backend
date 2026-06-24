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
  STOREFRONT_COLLECTIONS_BROWSER_QUERY,
  STOREFRONT_PRODUCT_DETAIL_QUERY,
} = require('./shopify');
const { getProductRecommendations } = require('./recommendations');
const { createDiscountsHandler } = require('./discounts');

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
  const handles = Array.isArray(collection?.productHandles)
    ? collection.productHandles.map((handle) => safeString(handle)).filter(Boolean)
    : [];
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

function createCatalogRouter({ cache, requireAdminApiKey }) {
  const router = express.Router();

  router.get('/sync/shopify/products/status', createCatalogSyncStatusHandler(cache));
  router.post('/sync/shopify/products', requireAdminApiKey, createCatalogSyncHandler(cache));
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

      const product = await cache.getProduct(handle);

      if (!product?.handle || !product?.id) {
        console.log(`[NOOD product] cache miss handle=${handle}`);
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

    const collection = await cache.getCollection(handle);

    if (!collection) {
      return res.status(404).json({
        success: false,
        source: 'cache',
        message: 'Collection not found in catalog cache.',
      });
    }

    console.log('[NOOD catalog] collection products fast path', { handle });

    const { pageProducts, skippedMissing, pageInfo } = await loadCollectionProductsPage(
      cache,
      collection,
      first,
      after
    );
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

        return {
          node: {
            id: collection.id,
            title: collection.title,
            handle: collection.handle,
            image: collection.image,
            products: {
              edges: resolved.map((product) => ({
                node: {
                  id: product.id,
                  handle: product.handle,
                  title: product.title,
                  featuredImage: product.featuredImage,
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

    console.log('[NOOD catalog] GET /collections', {
      source: 'cache',
      returned: edges.length,
      total: collections.length,
      lastSyncAt,
      cacheAgeMs,
      cacheAgeMinutes: cacheAgeMs === null ? null : Math.round(cacheAgeMs / 60000),
    });

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
    const query = safeString(req.query.q || req.query.query);
    const first = Number(req.query.first || 50);
    const allProducts = getActiveProducts(await cache.getAllProducts());
    const matches = searchProducts(allProducts, query);
    const page = paginateListProducts(matches, first, 0);

    console.log('[NOOD catalog] GET /search', {
      source: 'cache',
      query,
      returned: page.edges.length,
      totalMatches: matches.length,
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
        message:
          result.message ||
          (result.status === 'already_running'
            ? 'Catalog sync chunk is already running.'
            : 'Catalog sync chunk started in background.'),
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
};