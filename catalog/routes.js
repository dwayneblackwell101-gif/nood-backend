const express = require('express');
const {
  paginateItems,
  paginateListProducts,
  searchProducts,
  safeString,
  toStorefrontListProduct,
} = require('./transform');
const { getOrBuildMixedFeed } = require('./feed-mix');
const { startBackgroundCatalogSync, getCatalogSyncStatus } = require('./sync');
const {
  storefrontGraphql,
  STOREFRONT_MENU_QUERY,
  STOREFRONT_COLLECTIONS_BROWSER_QUERY,
  STOREFRONT_PRODUCT_DETAIL_QUERY,
} = require('./shopify');
const { getProductRecommendations } = require('./recommendations');

function sendCatalogResponse(res, payload, source) {
  res.setHeader('X-NOOD-Catalog-Source', source);
  return res.json({
    success: true,
    source,
    ...payload,
  });
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

async function loadCatalogProductsForList(cache, { mixKey, sortKey, limit, after }) {
  const hasMixKey = mixKey !== undefined && mixKey !== null && String(mixKey).length > 0;

  if (hasMixKey) {
    const allProducts =
      typeof cache.readAllProductsSafe === 'function'
        ? getActiveProducts(await cache.readAllProductsSafe())
        : getActiveProducts(await cache.getAllProducts());
    const mixed = getOrBuildMixedFeed(allProducts, mixKey);

    return {
      items: mixed.items,
      total: allProducts.length,
      cacheHit: mixed.cacheHit,
      paginate: true,
    };
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

function createCatalogRouter({ cache, requireAdminApiKey }) {
  const router = express.Router();

  router.get('/sync/shopify/products/status', createCatalogSyncStatusHandler(cache));
  router.post('/sync/shopify/products', requireAdminApiKey, createCatalogSyncHandler(cache));
  console.log('[NOOD sync] status route mounted');

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
    });
  });

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
    let product = await cache.getProduct(handle);
    let source = 'cache';

    if (!product) {
      try {
        const payload = await storefrontGraphql(STOREFRONT_PRODUCT_DETAIL_QUERY, { handle });
        const storefrontProduct = payload?.data?.productByHandle;
        if (storefrontProduct) {
          source = 'shopify';
          return sendCatalogResponse(res, payload, source);
        }
      } catch (error) {
        console.warn('[NOOD catalog] product detail storefront fallback failed:', error.message);
      }

      return res.status(404).json({
        success: false,
        source: 'cache',
        message: 'Product not found in catalog cache.',
      });
    }

    console.log('[NOOD catalog] GET /products/:handle', { source, handle });

    return sendCatalogResponse(
      res,
      {
        data: {
          productByHandle: {
            id: product.id,
            title: product.title,
            handle: product.handle,
            descriptionHtml: product.descriptionHtml,
            vendor: product.vendor,
            productType: product.productType,
            featuredImage: product.featuredImage,
            images: product.images,
            media: product.media,
            priceRange: product.priceRange,
            variants: product.variants,
          },
        },
      },
      source
    );
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
    const first = Number(req.query.first || 250);
    const after = req.query.after || null;

    const collection = await cache.getCollection(handle);
    const products = await cache.getAllProducts();
    const productsByHandle = Object.fromEntries(
      products.map((product) => [product.handle, product])
    );

    if (collection) {
      const payload = buildCollectionStorefront(collection, productsByHandle, first, after);
      console.log('[NOOD catalog] GET /collections/:handle/products', {
        source: 'cache',
        handle,
        returned: payload.data.collectionByHandle.products.edges.length,
      });
      return sendCatalogResponse(res, payload, 'cache');
    }

    return res.status(404).json({
      success: false,
      source: 'cache',
      message: 'Collection not found in catalog cache.',
    });
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

    console.log('[NOOD catalog] GET /collections', {
      source: 'cache',
      returned: edges.length,
      total: collections.length,
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
        console.log('[NOOD catalog] GET /menus/:handle from shopify', { handle });
        return sendCatalogResponse(res, payload, source);
      } catch (error) {
        console.warn('[NOOD catalog] menu storefront fallback failed:', error.message);
      }
    }

    console.log('[NOOD catalog] GET /menus/:handle from cache', { handle });

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