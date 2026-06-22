const express = require('express');
const {
  paginateItems,
  paginateListProducts,
  searchProducts,
  safeString,
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
  return products.filter((product) => safeString(product?.status).toUpperCase() !== 'ARCHIVED');
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

    const allProducts = getActiveProducts(await cache.getAllProducts());
    let items;
    let cacheHit = false;

    if (mixKey !== undefined && mixKey !== null && String(mixKey).length > 0) {
      const mixed = getOrBuildMixedFeed(allProducts, mixKey);
      items = mixed.items;
      cacheHit = mixed.cacheHit;
    } else {
      items = sortProducts(allProducts, sortKey);
    }

    const page = paginateListProducts(items, first, after);

    console.log(
      `[NOOD catalog] products returned count=${page.edges.length} total=${allProducts.length}`
    );
    console.log(
      `[NOOD feed] mixed feed source=cache total=${allProducts.length} returned=${page.edges.length} cacheHit=${cacheHit} slim=true`
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

function createCatalogSyncHandler(cache) {
  return async function handleCatalogSync(req, res) {
    try {
      const restart =
        req.query.restart === '1' ||
        req.query.restart === 'true' ||
        req.body?.restart === true;

      const result = await startBackgroundCatalogSync(cache, {
        syncMenus: true,
        restart,
      });

      return res.status(202).json({
        success: true,
        source: 'shopify',
        status: result.status,
        resume: Boolean(result.resume),
        restart: Boolean(result.restart),
        message:
          result.status === 'already_running'
            ? 'Catalog sync is already running.'
            : 'Catalog sync started in background.',
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
        updatedAt: status.updatedAt,
        phase: status.phase,
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