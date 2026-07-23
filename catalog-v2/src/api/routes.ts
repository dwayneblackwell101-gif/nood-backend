/**
 * Catalog v2 API Routes
 * Clean, versioned API for catalog operations
 */

import express, { Request, Response, NextFunction } from 'express';
import { ICache } from '../cache/interface';
import { Product, Collection } from '../domain/models';

export interface CreateCatalogRouterOptions {
  cache: ICache;
  requireAdminApiKey: () => (req: Request, res: Response, next: NextFunction) => void;
}

export function createCatalogRouter(options: CreateCatalogRouterOptions) {
  const { cache, requireAdminApiKey } = options;
  const router = express.Router();

  // ============ Health & Version ============

  router.get('/health', async (req: Request, res: Response) => {
    try {
      const meta = await cache.getMeta();
      const productCount = await cache.getProductCount();
      const collectionCount = await cache.getCollectionCount();
      const driver = await cache.driver?.() || 'unknown';

      return res.json({
        ok: true,
        cacheDriver: driver,
        productCount,
        collectionCount,
        lastSyncAt: meta?.lastSyncAt || null,
        catalogVersion: meta?.catalogVersion || 0,
        catalogUpdatedAt: meta?.catalogUpdatedAt || null,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: 'Cache unavailable',
      });
    }
  });

  router.get('/version', async (req: Request, res: Response) => {
    try {
      const meta = await cache.getMeta();
      return res.json({
        ok: true,
        catalogVersion: meta?.catalogVersion || 0,
        catalogUpdatedAt: meta?.catalogUpdatedAt || null,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: 'Could not read catalog version',
      });
    }
  });

  // ============ Products ============

  router.get('/products', async (req: Request, res: Response) => {
    try {
      const first = Math.max(1, Math.min(Number(req.query.first || req.query.limit || 50), 250));
      const after = req.query.after || null;
      const sortKey = req.query.sort as string || 'updated';
      const mixKey = req.query.mixKey as string;

      let loaded;
      if (mixKey) {
        loaded = await loadMixedCatalogProducts(cache, { mixKey, limit: first, after, inStockOnly: false });
      } else {
        if (typeof cache.listProductsPage === 'function') {
          loaded = await cache.listProductsPage({ limit: first, after, sortKey });
        } else {
          const allProducts = await cache.getAllProducts();
          loaded = { items: allProducts, total: allProducts.length, hasNextPage: false, endCursor: null };
        }
      }

      const page = loaded.paginate
        ? paginateListProducts(loaded.items, first, after)
        : buildProductListPage(loaded.items, loaded.total, loaded.hasNextPage, loaded.endCursor);

      return res.json({
        success: true,
        source: 'cache',
        data: { products: page },
      });
    } catch (error) {
      console.error('[Catalog v2] GET /products failed:', error);
      return res.status(500).json({
        success: false,
        source: 'cache',
        message: error instanceof Error ? error.message : 'Could not read catalog products',
      });
    }
  });

  router.get('/products/recommendations', async (req: Request, res: Response) => {
    try {
      const productId = req.query.productId as string || req.query.product_id as string || req.query.id as string;
      const result = await getProductRecommendations(cache, productId);

      return res.json({
        success: true,
        source: result.source,
        data: { productRecommendations: result.items },
      });
    } catch (error) {
      console.error('[Catalog v2] GET /products/recommendations failed:', error);
      return res.status(500).json({ success: false, message: 'Could not get recommendations' });
    }
  });

  router.get('/products/:handle', async (req: Request, res: Response) => {
    try {
      const handle = req.params.handle;
      if (handle === 'recommendations') {
        const productId = req.query.productId as string || req.query.product_id as string || req.query.id as string;
        const result = await getProductRecommendations(cache, productId);
        return res.json({
          success: true,
          source: result.source,
          data: { productRecommendations: result.items },
        });
      }

      if (!handle) {
        return res.status(404).json({ success: false, error: true, message: 'Product not found' });
      }

      let product = await cache.getProduct(handle);
      let responseSource = 'cache';

      if (!product) {
        // Fallback to Shopify storefront if not in cache
        // In v2, this would use storefrontClient
        return res.status(404).json({
          success: false,
          error: true,
          message: 'Product not found in cache',
        });
      }

      // Format product detail
      const detail = formatCachedProductDetail(product);

      return res.json({
        success: true,
        source: responseSource,
        data: { product: detail, productByHandle: detail },
      });
    } catch (error) {
      console.error('[Catalog v2] GET /products/:handle failed:', error);
      return res.status(500).json({
        success: false,
        error: true,
        message: error instanceof Error ? error.message : 'Could not read product detail',
      });
    }
  });

  router.get('/products/:handle/recommendations', async (req: Request, res: Response) => {
    try {
      const handle = req.params.handle;
      const result = await getProductRecommendations(cache, handle);

      return res.json({
        success: true,
        source: result.source,
        data: { productRecommendations: result.items },
      });
    } catch (error) {
      console.error('[Catalog v2] GET /products/:handle/recommendations failed:', error);
      return res.status(500).json({ success: false, message: 'Could not get recommendations' });
    }
  });

  // ============ Collections ============

  router.get('/collections/:handle/products', async (req: Request, res: Response) => {
    try {
      const handle = req.params.handle;
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

      const resolved = await resolveCollectionProductHandles(cache, collection);
      const handles = resolved.handles;
      const limit = Math.max(1, Math.min(first, 250));
      const start = after ? Number(after) : 0;

      let skippedMissing = 0;
      let validIndex = 0;
      const pageProducts = [];

      for (let batchStart = 0; batchStart < handles.length; batchStart += 50) {
        const batchHandles = handles.slice(batchStart, batchStart + 50);
        const fetchedProducts = await fetchProductsByHandles(cache, batchHandles);
        const productsByHandle = new Map(
          fetchedProducts.filter(p => p && isVisibleProduct(p)).map(p => [p.handle, p])
        );

        for (const handle of batchHandles) {
          const product = productsByHandle.get(handle);
          if (!product) {
            skippedMissing++;
            continue;
          }

          if (validIndex < start) {
            validIndex++;
            continue;
          }

          if (pageProducts.length < limit) {
            pageProducts.push(product);
            validIndex++;
            continue;
          }

          break;
        }

        if (pageProducts.length >= limit) break;
      }

      const nextIndex = start + pageProducts.length;
      const hasNextPage = nextIndex < handles.length;

      const payload = buildCollectionProductsPayload(collection, pageProducts, {
        hasNextPage,
        endCursor: hasNextPage ? String(nextIndex) : null,
      });

      return res.json({ success: true, source: 'cache', ...payload });
    } catch (error) {
      console.error('[Catalog v2] collection products error:', error);
      return res.status(500).json({ success: false, message: 'Could not read collection products' });
    }
  });

  router.get('/collections', async (req: Request, res: Response) => {
    try {
      const first = Number(req.query.first || 250);
      const after = req.query.after || null;
      const collections = await cache.getAllCollections();
      const page = paginateItems(collections, first, after);

      const edges = await Promise.all(page.edges.map(async (edge) => {
        const collection = edge.node;
        const previewProducts = (collection.productHandles || [])
          .slice(0, 24)
          .map((handle) => cache.getProduct(handle));
        const resolved = (await Promise.all(previewProducts)).filter(Boolean);

        const { imageUrl, imageSource } = resolveCollectionImageForResponse(collection, resolved);

        return {
          node: {
            id: collection.id,
            title: collection.title,
            handle: collection.handle,
            image: imageUrl ? { url: imageUrl } : collection.image,
            imageUrl,
            imageSource,
            previewImage: imageUrl || null,
            displayImage: collection.displayImage || imageUrl || null,
            fallbackImage: collection.fallbackImage || (resolved.length ? (resolved[0]?.featuredImage?.url || '') : ''),
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
            });,
          },
      })

      const meta = await cache.getMeta();
      const lastSyncAt = meta?.lastSyncAt || null;
      const cacheAgeMs = lastSyncAt ? Math.max(0, Date.now() - new Date(lastSyncAt).getTime()) : null;

      return res.json({
        success: true,
        source: 'cache',
        data: {
          collections: { pageInfo: page.pageInfo, edges },
        },
        meta: { lastSyncAt, cacheAgeMs, cacheAgeMinutes: cacheAgeMs === null ? null : Math.round(cacheAgeMs / 60000) },
      });
    } catch (error) {
      console.error('[Catalog v2] GET /collections failed:', error);
      return res.status(500).json({ success: false, message: 'Could not read collections' });
    }
  });

  // ============ Search ============

  router.get('/search', async (req: Request, res: Response) => {
    try {
      const query = req.query.q as string || req.query.query as string;
      const first = Math.max(1, Math.min(Number(req.query.first || req.query.limit || 48), 250));
      const after = Number(req.query.after ?? req.query.offset ?? 0) || 0;

      const allProducts = await cache.getAllProducts();
      const matches = searchProducts(allProducts, query);
      const page = paginateListProducts(matches, first, after);
      const nextOffset = page.pageInfo?.hasNextPage ? Number(page.pageInfo.endCursor) : null;

      return res.json({
        success: true,
        source: 'cache',
        data: { products: page },
        totalMatches: matches.length,
        nextOffset,
        nextCursor: nextOffset,
        hasMore: Boolean(page.pageInfo?.hasNextPage),
      });
    } catch (error) {
      console.error('[Catalog v2] GET /search failed:', error);
      return res.status(500).json({ success: false, message: 'Search failed' });
    }
  });

  // ============ Menus ============

  router.get('/menus/:handle', async (req: Request, res: Response) => {
    const handle = req.params.handle;
    const menu = await cache.getMenu(handle);
    let source = 'cache';

    if (!menu) {
      return res.status(404).json({ success: false, message: 'Menu not found' });
    }

    const meta = await cache.getMeta();
    const lastSyncAt = meta?.lastSyncAt || null;
    const cacheAgeMs = lastSyncAt ? Math.max(0, Date.now() - new Date(lastSyncAt).getTime()) : null;

    return res.json({
      success: true,
      source,
      data: { menu },
      lastSyncAt,
      cacheAgeMs,
    });
  });

  // ============ Sync Admin Routes ============

  function createCatalogSyncHandler(cache: any) {
    return async function handleCatalogSync(req: Request, res: Response) {
      try {
        const restart = req.query.restart === '1' || req.query.restart === 'true' || req.body?.restart === true;
        const forceResume = req.query.forceResume === '1' || req.query.forceResume === 'true' || req.body?.forceResume === true;
        const pages = parseInt(req.query.pages || req.body?.pages || '100', 10);
        const pageSize = parseInt(req.query.pageSize || req.body?.pageSize || '100', 10);

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
          message: result.message || 'Catalog sync started in background; auto-continuing until complete.',
        });
      } catch (error) {
        console.error('[Catalog v2] manual sync failed:', error);
        return res.status(500).json({ success: false, source: 'shopify', message: error instanceof Error ? error.message : 'Catalog sync failed' });
      }
    };
  }

  function createCatalogSyncStatusHandler(cache: any) {
    return async function handleCatalogSyncStatus(req: Request, res: Response) {
      try {
        const status = await cache.getSyncState();
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
          message: error instanceof Error ? error.message : 'Could not read catalog sync status',
          productCount: 0,
          collectionCount: 0,
        });
      }
    };
  }

  router.get('/sync/status', createCatalogSyncStatusHandler(cache));
  router.post('/sync', requireAdminApiKey, createCatalogSyncHandler(cache));

  return router;
}

// ============ Helper Functions ============

function paginateItems(items: any[], first: number, after: string | null) {
  const array = Array.isArray(items) ? items : [];
  const start = Number(after) > 0 ? Number(after) : 0;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const end = start + limit;
  const paginated = array.slice(start, end);
  const hasNextPage = end < array.length;

  return {
    edges: paginated.map((node, index) => ({ node, cursor: String(start + index) })),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? String(end) : null,
    },
    total: array.length,
  };
}

function paginateListProducts(items: any[], first: number, after: string | null) {
  const array = Array.isArray(items) ? items : [];
  const start = Number(after) > 0 ? Number(after) : 0;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const end = start + limit;
  const paginated = array.slice(start, end);
  const hasNextPage = end < array.length;

  return {
    edges: paginated.map((node) => ({ node })),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? String(end) : null,
    },
    total: array.length,
  };
}

function buildProductListPage(items: any[], total: number, hasNextPage: boolean, endCursor: string | null) {
  const edges = (Array.isArray(items) ? items : []).map((product) => {
    const node = safeToStorefrontListProduct(product);
    return node ? { node } : null;
  }).filter(Boolean);

  return {
    edges,
    pageInfo: {
      hasNextPage: Boolean(hasNextPage),
      endCursor: hasNextPage ? endCursor : null,
    },
    total,
  };
}

function safeToStorefrontListProduct(product: any) {
  if (!product?.id || !product?.handle) return null;
  return toStorefrontListProduct(product);
}

function toStorefrontListProduct(product: any) {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor || '',
    featuredImage: product.featuredImage,
    priceRange: product.priceRange || { minVariantPrice: { amount: '0', currencyCode: 'USD' } },
    availableForSale: Boolean(product.availableForSale),
  };
}

function isVisibleProduct(product: any): boolean {
  if (!product || !product.id || !product.handle) return false;
  return String(product.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
}

function safeString(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function searchProducts(products: any[], query: string): any[] {
  const needle = safeString(query).toLowerCase();
  if (!needle) return [];

  return (Array.isArray(products) ? products : []).filter((product) => {
    const haystack = [
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      ...(product.tags || []),
      ...(product.collectionHandles || []),
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

function isHomeInStockFeed(sortKey: string): boolean {
  return sortKey === 'home' || sortKey === 'updated_in_stock';
}

function isCatalogProductInStock(product: any): boolean {
  if (!isVisibleProduct(product)) return false;
  return Boolean(product.availableForSale);
}

function compareProductsByUpdatedAt(left: any, right: any): number {
  return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
}

function sortProducts(products: any[], sortKey = 'updated'): any[] {
  const copy = [...products];
  if (sortKey === 'created') {
    return copy.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  }
  if (sortKey === 'home' || sortKey === 'updated_in_stock') {
    return copy.sort((a, b) => {
      const stockDelta = Number(isCatalogProductInStock(b)) - Number(isCatalogProductInStock(a));
      if (stockDelta !== 0) return stockDelta;
      return compareProductsByUpdatedAt(a, b);
    });
  }
  return copy.sort(compareProductsByUpdatedAt);
}

function resolveCollectionImageForResponse(collection: any, resolvedProducts: any[]) {
  const collectionImageUrl = collection?.image?.url;
  if (collectionImageUrl) return { imageUrl: collectionImageUrl, imageSource: 'collection' };

  const displayImageUrl = collection?.displayImage;
  if (displayImageUrl) return { imageUrl: displayImageUrl, imageSource: 'displayImage' };

  const fallbackImageUrl = collection?.fallbackImage;
  if (fallbackImageUrl) return { imageUrl: fallbackImageUrl, imageSource: 'fallbackImage' };

  const cachedUrl = collection?.imageUrl || collection?.previewImage;
  if (cachedUrl) {
    return { imageUrl: cachedUrl, imageSource: collection?.imageSource || 'cache' };
  }

  for (const product of resolvedProducts || []) {
    const productImageUrl = product.featuredImage?.url || product.images?.edges?.[0]?.node?.url;
    if (productImageUrl) return { imageUrl: productImageUrl, imageSource: 'product' };
  }

  return { imageUrl: '', imageSource: 'fallback' };
}

async function loadMixMetaIndex(cache: any) {
  if (typeof cache.getProductMixIndex === 'function') {
    return cache.getProductMixIndex();
  }
  if (typeof cache.listProductMixMeta === 'function') {
    return cache.listProductMixMeta();
  }
  const products = await cache.getAllProducts();
  return products.map((product) => ({
    handle: product.handle,
    id: String(product.id),
    collectionHandles: Array.isArray(product.collectionHandles) && product.collectionHandles.length
      ? product.collectionHandles.map((v) => safeString(v)).filter(Boolean)
      : (product.collections?.edges || []).map((edge: any) => safeString(edge?.node?.handle)).filter(Boolean),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 12) : [],
    productType: safeString(product.productType),
    vendor: safeString(product.vendor),
    availableForSale: product.availableForSale === undefined ? undefined : Boolean(product.availableForSale),
  }));
}

async function getOrBuildOrderedMixedHandles(cache: any, mixMetaRows: any[], mixKey: string) {
  const productCount = mixMetaRows.length;

  if (typeof cache.getMixedHandleOrder === 'function') {
    const cached = await cache.getMixedHandleOrder(productCount, mixKey);
    if (Array.isArray(cached) && cached.length > 0) {
      return { handles: cached, cacheHit: true };
    }
  }

  const built = getOrBuildMixedHandleOrder(mixMetaRows, mixKey);

  if (built.cacheHit) {
    console.log('[Catalog v2] mixed handle order cache hit');
  } else {
    console.log('[Catalog v2] mixed handle order cache built');
    if (typeof cache.setMixedHandleOrder === 'function') {
      await cache.setMixedHandleOrder(productCount, mixKey, built.handles);
    }
  }

  return built;
}

async function loadMixedCatalogProductsPage(cache: any, { mixKey, limit, after, inStockOnly = false }) {
  const pageLimit = Math.max(1, Math.min(Number(limit) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;

  const mixMetaRows = await loadMixMetaIndex(cache);
  const { handles: orderedHandles } = await getOrBuildOrderedMixedHandles(cache, mixMetaRows, mixKey);

  const pageProducts = [];
  let scanIndex = start;
  let skippedMissing = 0;
  let skippedSoldOut = 0;
  const batchSize = Math.max(pageLimit, 50);

  while (scanIndex < orderedHandles.length && pageProducts.length < pageLimit) {
    const batchHandles = orderedHandles.slice(scanIndex, scanIndex + batchSize);
    if (!batchHandles.length) break;

    const fetchedProducts = await fetchProductsByHandles(cache, batchHandles);
    const productsByHandle = new Map(
      fetchedProducts.filter(isVisibleProduct).map((p) => [p.handle, p])
    );

    for (const handle of batchHandles) {
      scanIndex++;
      const product = productsByHandle.get(safeString(handle));
      if (!product) {
        skippedMissing++;
        continue;
      }
      if (inStockOnly && !isCatalogProductInStock(product)) {
        skippedSoldOut++;
        continue;
      }
      pageProducts.push(product);
      if (pageProducts.length >= pageLimit) break;
    }
  }

  const hasNextPage = scanIndex < orderedHandles.length;

  return {
    items: pageProducts,
    total: orderedHandles.length,
    cacheHit: true,
    paginate: false,
    hasNextPage,
    endCursor: hasNextPage ? String(scanIndex) : null,
  };
}

async function loadCatalogProductsForList(cache: any, { mixKey, sortKey, limit, after }) {
  const inStockOnly = isHomeInStockFeed(sortKey);
  const hasMixKey = mixKey !== undefined && mixKey !== null && String(mixKey).length > 0;

  if (hasMixKey) {
    return loadMixedCatalogProductsPage(cache, { mixKey, limit, after, inStockOnly });
  }

  if (typeof cache.listProductsPage === 'function') {
    return cache.listProductsPage({ limit, after, sortKey });
  }

  const allProducts = (await cache.getAllProducts()).filter(isVisibleProduct);
  const feedProducts = inStockOnly ? allProducts.filter(isCatalogProductInStock) : allProducts;

  return {
    items: sortProducts(feedProducts, inStockOnly ? 'updated' : sortKey),
    total: feedProducts.length,
    cacheHit: false,
    paginate: true,
  };
}

function buildCollectionProductsPayload(collection: any, pageProducts: any[], pageInfo: any) {
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
  }

async function fetchProductsByHandles(cache: any, handles: string[]) {
  const normalizedHandles = handles.map((h) => safeString(h)).filter(Boolean);
  if (!normalizedHandles.length) return [];

  if (typeof cache.getProductsByHandles === 'function') {
    return cache.getProductsByHandles(normalizedHandles);
  }

  const products = (await cache.getAllProducts()).filter(isVisibleProduct);
  const byHandle = Object.fromEntries(products.map((p) => [p.handle, p]));
  return normalizedHandles.map((h) => byHandle[h]).filter(Boolean);
}

async function loadCollectionProductsPage(cache: any, collection: any, first: number, after: string | null) {
  const resolved = await resolveCollectionProductHandles(cache, collection);
  const handles = resolved.handles;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;

  let skippedMissing = 0;
  let validIndex = 0;
  const pageProducts = [];
  let hasNextPage = false;

  for (let batchStart = 0; batchStart < handles.length; batchStart += 50) {
    const batchHandles = handles.slice(batchStart, batchStart + 50);
    const fetchedProducts = await fetchProductsByHandles(cache, batchHandles);
    const productsByHandle = new Map(
      fetchedProducts.filter(isVisibleProduct).map((p) => [p.handle, p])
    );

    for (const handle of batchHandles) {
      const product = productsByHandle.get(handle);
      if (!product) {
        skippedMissing++;
        continue;
      }

      if (validIndex < start) {
        validIndex++;
        continue;
      }

      if (pageProducts.length < limit) {
        pageProducts.push(product);
        validIndex++;
        continue;
      }

      hasNextPage = true;
      break;
    }

    if (hasNextPage) break;
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

async function resolveCollectionProductHandles(cache: any, collection: any) {
  const storedHandles = (collection?.productHandles || [])
    .map((h: any) => safeString(h)).filter(Boolean);

  const index = await warmCollectionProductHandlesIndex(cache);
  const matchKeys = collectionMatchKeys(collection);
  const merged = [];
  const seen = new Set();

  for (const key of matchKeys) {
    for (const handle of index.get(key) || []) {
      if (!seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (!merged.length) {
    const products = await getProductsForCollectionIndex(cache);
    for (const product of products) {
      if (productMatchesCollection(product, collection)) {
        const handle = safeString(product?.handle);
        if (handle && !seen.has(handle)) {
          seen.add(handle);
          merged.push(handle);
        }
      }
    }
  }

  if (!merged.length) {
    const handleKey = normalizeCollectionMatchKey(collection?.handle);
    const titleKey = normalizeCollectionMatchKey(collection?.title);
    const terms = Array.from(new Set([
      handleKey,
      titleKey,
      handleKey.replace(/-/g, ' '),
      titleKey.replace(/-/g, ' '),
      ...(COLLECTION_SEARCH_TERMS[handleKey] || []),
    ].filter(Boolean)));

    for (const term of terms) {
      const matches = searchIndexProducts(products, term);
      for (const product of matches) {
        const handle = safeString(product?.handle);
        if (handle && !seen.has(handle)) {
          seen.add(handle);
          merged.push(handle);
        }
      }
      if (merged.length) break;
    }
  }

  const source = merged.length
    ? (storedHandles.length && seen.size > 0 ? 'reverse_lookup+verified_handles' : 'reverse_lookup')
    : 'empty';

  if (merged.length && source.startsWith('reverse_lookup')) {
    console.log('[Catalog v2] collection products reverse lookup', {
      handle: collection?.handle,
      title: collection?.title,
      count: merged.length,
      storedHandles: storedHandles.length,
      source,
    });
  }

  return { handles: merged, source };
}

function normalizeCollectionMatchKey(value: any) {
  return safeString(value).toLowerCase().replace(/^#/, '').trim();
}

function getProductCollectionKeys(product: any) {
  const keys = new Set();

  for (const handle of Array.isArray(product?.collectionHandles) ? product.collectionHandles : []) {
    const key = normalizeCollectionMatchKey(handle);
    if (key) keys.add(key);
  }

  for (const edge of product?.collections?.edges || []) {
    const handle = normalizeCollectionMatchKey(edge?.node?.handle);
    const title = normalizeCollectionMatchKey(edge?.node?.title);
    if (handle) keys.add(handle);
    if (title) keys.add(title);
  }

  return keys;
}

function collectionMatchKeys(collection: any) {
  const keys = new Set();
  const handle = normalizeCollectionMatchKey(collection?.handle);
  const title = normalizeCollectionMatchKey(collection?.title);
  if (handle) {
    keys.add(handle);
    if (handle.endsWith('-1')) keys.add(handle.slice(0, -2));
    if (handle.endsWith('-2')) keys.add(handle.slice(0, -2));
  }
  if (title) keys.add(title);
  return keys;
}

function collectionKeysOverlap(leftKeys: Set<string>, rightKeys: Set<string>): boolean {
  for (const leftKey of leftKeys) {
    if (rightKeys.has(leftKey)) return true;
    if (leftKey.endsWith('-1') && rightKeys.has(leftKey.slice(0, -2))) return true;
    if (leftKey.endsWith('-2') && rightKeys.has(leftKey.slice(0, -2))) return true;
  }
  for (const rightKey of rightKeys) {
    if (rightKey.endsWith('-1') && leftKeys.has(rightKey.slice(0, -2))) return true;
    if (rightKey.endsWith('-2') && leftKeys.has(rightKey.slice(0, -2))) return true;
  }
  return false;
}

function productMatchesCollection(product: any, collection: any) {
  const targetKeys = collectionMatchKeys(collection);
  if (!targetKeys.size) return false;
  const productKeys = getProductCollectionKeys(product);
  return collectionKeysOverlap(productKeys, targetKeys);
}

function registerProductHandleOnIndexKey(index: Map<string, string[]>, key: string, productHandle: string) {
  const normalizedKey = normalizeCollectionMatchKey(key);
  if (!normalizedKey) return;

  if (!index.has(normalizedKey)) index.set(normalizedKey, []);

  const bucket = index.get(normalizedKey)!;
  if (!bucket.includes(productHandle)) bucket.push(productHandle);

  if (normalizedKey.endsWith('-1')) {
    registerProductHandleOnIndexKey(index, normalizedKey.slice(0, -2), productHandle);
  }
  if (normalizedKey.endsWith('-2')) {
    registerProductHandleOnIndexKey(index, normalizedKey.slice(0, -2), productHandle);
  }
}

function buildCollectionProductHandlesIndex(products: any[]) {
  const index = new Map<string, string[]>();

  for (const product of products) {
    const productHandle = safeString(product?.handle);
    if (!productHandle || !isVisibleProduct(product)) continue;

    for (const key of getProductCollectionKeys(product)) {
      registerProductHandleOnIndexKey(index, key, productHandle);
    }
  }

  return index;
}

function mapMixMetaRowToIndexProduct(row: any) {
  return {
    handle: row.handle,
    id: row.id,
    title: row.title || '',
    vendor: row.vendor || '',
    productType: row.productType || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    collectionHandles: row.collectionHandles,
    collections: {
      edges: (row.collectionHandles || []).map((handle: any) => ({
        node: { handle, title: handle },
      })),
    },
    status: 'ACTIVE',
  };
}

function searchIndexProducts(products: any[], query: string): any[] {
  const needle = safeString(query).toLowerCase();
  if (!needle) return [];

  return products.filter((product) => {
    const haystack = [
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      ...(product.tags || []),
      ...(product.collectionHandles || []),
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

function isActiveCatalogProduct(product: any): boolean {
  return isVisibleProduct(product);
}

const COLLECTION_PRODUCTS_BATCH_SIZE = 50;

const COLLECTION_SEARCH_TERMS: Record<string, string[]> = {
  lacefront: ['lace', 'lace front', 'lace-front', 'lace wig', 'lace frontal', 'lacefront'],
  nike: ['nike'],
  valley: ['valley'],
  'essentials-fog-1': ['fear of god', 'essentials fog', 'fog essentials'],
};

async function warmCollectionProductHandlesIndex(cache: any, { force = false } = {}) {
  const meta = await cache.getMeta();
  const catalogVersion = Number(meta?.catalogVersion) || 0;
  const cacheFresh =
    !force &&
    collectionProductHandlesIndex &&
    collectionProductHandlesIndexVersion === catalogVersion &&
    Date.now() - collectionProductHandlesIndexAt < 10 * 60 * 1000;

  if (cacheFresh) return collectionProductHandlesIndex;

  if (collectionProductHandlesIndexPromise) return collectionProductHandlesIndexPromise;

  collectionProductHandlesIndexPromise = (async () => {
    const startedAt = Date.now();
    const products = await getProductsForCollectionIndex(cache);
    collectionProductHandlesIndex = buildCollectionProductHandlesIndex(products);
    collectionProductHandlesIndexAt = Date.now();
    collectionProductHandlesIndexVersion = catalogVersion;
    collectionProductHandlesIndexPromise = null;
    console.log('[Catalog v2] collection handle index warmed', {
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

async function getProductsForCollectionIndex(cache: any) {
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

  return (await cache.getAllProducts()).filter(isVisibleProduct);
}

function mapMixMetaRowToIndexProduct(row: any) {
  return {
    handle: row.handle,
    id: row.id,
    title: row.title || '',
    vendor: row.vendor || '',
    productType: row.productType || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    collectionHandles: row.collectionHandles,
    collections: {
      edges: (row.collectionHandles || []).map((handle: any) => ({
        node: { handle, title: handle },
      })),
    },
    status: 'ACTIVE',
  };
}

function appendUniqueHandles(targetHandles: string[], seen: Set<string>, handles: string[]) {
  for (const handle of handles) {
    const normalized = safeString(handle);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    targetHandles.push(normalized);
  }
}

function resolveProductImageForCollectionResponse(product: any) {
  return safeString(resolvePrimaryListImage(product)?.url);
}

function resolveCollectionImageForResponse(collection: any, resolvedProducts: any[]) {
  const collectionImageUrl = safeString(collection?.image?.url);
  if (collectionImageUrl) return { imageUrl: collectionImageUrl, imageSource: 'collection' };

  const displayImageUrl = safeString(collection?.displayImage);
  if (displayImageUrl) return { imageUrl: displayImageUrl, imageSource: 'displayImage' };

  const fallbackImageUrl = safeString(collection?.fallbackImage);
  if (fallbackImageUrl) return { imageUrl: fallbackImageUrl, imageSource: 'fallbackImage' };

  const cachedUrl = safeString(collection?.imageUrl) || safeString(collection?.previewImage);
  if (cachedUrl) {
    return { imageUrl: cachedUrl, imageSource: safeString(collection?.imageSource) || 'cache' };
  }

  for (const product of resolvedProducts || []) {
    const productImageUrl = resolveProductImageForCollectionResponse(product);
    if (productImageUrl) return { imageUrl: productImageUrl, imageSource: 'product' };
  }

  return { imageUrl: '', imageSource: 'fallback' };
}

function buildCollectionProductsPayload(collection: any, pageProducts: any[], pageInfo: any) {
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
  }

async function tryCollectionProductsShopifyFallback(res: any, { handle, first, after, reason }) {
  const requestedHandle = safeString(handle);
  const lookupHandles = Array.from(
    new Set([requestedHandle, resolveCanonicalCollectionHandle(requestedHandle)].filter(Boolean))
  );

  for (const lookupHandle of lookupHandles) {
    try {
      const shopifyPayload = await fetchCollectionProductsFromShopify(lookupHandle, first, after);
      if (shopifyPayload) {
        console.log('[Catalog v2] collection products shopify fallback', {
          handle: requestedHandle,
          lookupHandle,
          reason,
          returned: shopifyPayload?.data?.collectionByHandle?.products?.edges?.length || 0,
        });
        sendCatalogResponse(res, shopifyPayload, 'shopify');
        return true;
      }
    } catch (error) {
      console.warn('[Catalog v2] collection shopify fallback failed:', {
        handle: requestedHandle,
        lookupHandle,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return false;
}

function resolvePrimaryListImage(product: any) {
  if (product?.featuredImage?.url) return product.featuredImage;
  for (const edge of product?.images?.edges || []) {
    if (edge?.node?.url) return edge.node;
  }
  for (const edge of product?.media?.edges || []) {
    const node = edge?.node;
    if (node?.image?.url) return node.image;
    if (node?.previewImage?.url) return node.previewImage;
  }
  return null;
}

function buildProductGalleryImages(product: any) {
  const images: any[] = [];
  const seen = new Set();

  for (const edge of product?.images?.edges || []) {
    const node = edge?.node;
    if (!node?.url || seen.has(node.url)) continue;
    seen.add(node.url);
    images.push({ id: node.id || node.url, url: node.url, altText: node.altText, width: node.width, height: node.height });
  }

  if (!images.length) {
    for (const edge of product?.media?.edges || []) {
      const node = edge?.node;
      if (node?.image?.url && !seen.has(node.image.url)) {
        seen.add(node.image.url);
        images.push({ id: node.id || node.image.url, url: node.image.url, altText: node.image.altText, width: node.image.width, height: node.image.height });
      }
    }
  }

  if (!images.length) {
    if (product?.thumbnail?.url) {
      images.push({ id: product.thumbnail.id || product.thumbnail.url, url: product.thumbnail.url, altText: product.thumbnail.altText, width: product.thumbnail.width, height: product.thumbnail.height });
    }
    if (product?.featuredImage?.url && !seen.has(product.featuredImage.url)) {
      seen.add(product.featuredImage.url);
      images.push({ id: product.featuredImage.id || product.featuredImage.url, url: product.featuredImage.url, altText: product.featuredImage.altText, width: product.featuredImage.width, height: product.featuredImage.height });
    }
  }

  return images;
}

function resolveCollectionImageForResponse(collection: any, resolvedProducts: any[]) {
  const collectionImageUrl = safeString(collection?.image?.url);
  if (collectionImageUrl) return { imageUrl: collectionImageUrl, imageSource: 'collection' };

  const displayImageUrl = safeString(collection?.displayImage);
  if (displayImageUrl) return { imageUrl: displayImageUrl, imageSource: 'displayImage' };

  const fallbackImageUrl = safeString(collection?.fallbackImage);
  if (fallbackImageUrl) return { imageUrl: fallbackImageUrl, imageSource: 'fallbackImage' };

  const cachedUrl = safeString(collection?.imageUrl) || safeString(collection?.previewImage);
  if (cachedUrl) {
    return { imageUrl: cachedUrl, imageSource: safeString(collection?.imageSource) || 'cache' };
  }

  for (const product of resolvedProducts || []) {
    const productImageUrl = resolvePrimaryListImage(product)?.url;
    if (productImageUrl) return { imageUrl: productImageUrl, imageSource: 'product' };
  }

  return { imageUrl: '', imageSource: 'fallback' };
}

function buildCollectionProductsPayload(collection: any, pageProducts: any[], pageInfo: any) {
  return {
    data: {
      collectionByHandle: {
        title: collection?.title || '',
        products: { edges: pageProducts.map((p) => ({ node: p })), pageInfo },
      },
    },
  };
}

async function resolveCollectionProductHandles(cache: any, collection: any) {
  const storedHandles = (collection?.productHandles || [])
    .map((h: any) => safeString(h)).filter(Boolean);

  const index = await warmCollectionProductHandlesIndex(cache);
  const matchKeys = collectionMatchKeys(collection);
  const merged = [];
  const seen = new Set();

  for (const key of matchKeys) {
    for (const handle of index.get(key) || []) {
      if (!seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (!merged.length) {
    const products = await getProductsForCollectionIndex(cache);
    for (const product of products) {
      if (!productMatchesCollection(product, collection)) continue;
      const handle = safeString(product?.handle);
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (storedHandles.length) {
    const verifiedStored = await fetchProductsByHandles(cache, storedHandles.slice(0, 50));
    const activeStoredHandles = verifiedStored
      .filter(isVisibleProduct)
      .map((p) => safeString(p.handle))
      .filter(Boolean);
    appendUniqueHandles(merged, seen, activeStoredHandles);
  }

  if (!merged.length) {
    const indexProducts = await getProductsForCollectionIndex(cache);
    const handleKey = normalizeCollectionMatchKey(collection?.handle);
    const titleKey = normalizeCollectionMatchKey(collection?.title);
    const terms = Array.from(new Set([
      handleKey,
      titleKey,
      handleKey.replace(/-/g, ' '),
      titleKey.replace(/-/g, ' '),
      ...(COLLECTION_SEARCH_TERMS[handleKey] || []),
    ].filter(Boolean)));

    for (const term of terms) {
      const matches = searchIndexProducts(indexProducts, term);
      for (const product of matches) {
        appendUniqueHandles(merged, seen, [safeString(product.handle)]);
      }
      if (merged.length) break;
    }
  }

  const source = merged.length
    ? storedHandles.length && seen.size > 0 ? 'reverse_lookup+verified_handles' : 'reverse_lookup'
    : 'empty';

  if (merged.length && source.startsWith('reverse_lookup')) {
    console.log('[Catalog v2] collection products reverse lookup', {
      handle: collection?.handle,
      title: collection?.title,
      count: merged.length,
      storedHandles: storedHandles.length,
      source,
    });
  }

  return { handles: merged, source };
}

async function loadCollectionProductsPage(cache: any, collection: any, first: number, after: string | null) {
  const resolved = await resolveCollectionProductHandles(cache, collection);
  const handles = resolved.handles;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;

  let skippedMissing = 0;
  let validIndex = 0;
  const pageProducts = [];
  let hasNextPage = false;

  for (let batchStart = 0; batchStart < handles.length; batchStart += 50) {
    const batchHandles = handles.slice(batchStart, batchStart + 50);
    const fetchedProducts = await fetchProductsByHandles(cache, batchHandles);
    const productsByHandle = new Map(
      fetchedProducts.filter(isVisibleProduct).map((p) => [p.handle, p])
    );

    for (const handle of batchHandles) {
      const product = productsByHandle.get(handle);
      if (!product) {
        skippedMissing++;
        continue;
      }

      if (validIndex < start) {
        validIndex++;
        continue;
      }

      if (pageProducts.length < limit) {
        pageProducts.push(product);
        validIndex++;
        continue;
      }

      hasNextPage = true;
      break;
    }

    if (hasNextPage) break;
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

function safeGetCollection(cache: any, handle: string) {
  const requestedHandle = safeString(handle);
  const canonicalHandle = resolveCanonicalCollectionHandle(requestedHandle);

  try {
    let collection = cache.getCollection(requestedHandle);
    if (!collection && canonicalHandle !== requestedHandle) {
      collection = cache.getCollection(canonicalHandle);
      if (collection) {
        console.log('[Catalog v2] collection alias resolved', {
          requested: requestedHandle,
          canonical: canonicalHandle,
        });
      }
    }
    return collection;
  } catch (error) {
    console.warn('[Catalog v2] cache.getCollection failed; trying Shopify fallback', {
      handle: requestedHandle,
      canonicalHandle,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function safeGetProduct(cache: any, handle: string) {
  try {
    return await cache.getProduct(handle);
  } catch (error) {
    console.warn('[Catalog v2] cache.getProduct failed; trying Shopify fallback', {
      handle,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function fetchCollectionProductsFromShopify(handle: string, first: number, after: string | null) {
  // Would use storefront client in v2
  return null;
}

async function fetchProductDetailFromShopify(handle: string) {
  // Would use storefront client in v2
  return null;
}

function buildCollectionProductsPayload(collection: any, pageProducts: any[], pageInfo: any) {
  return {
    data: {
      collectionByHandle: {
        title: collection?.title || '',
        products: { edges: pageProducts.map((p) => ({ node: p })), pageInfo },
      },
    },
  };
}

async function tryCollectionProductsShopifyFallback(res: any, { handle, first, after, reason }) {
  const requestedHandle = safeString(handle);
  const lookupHandles = Array.from(
    new Set([requestedHandle, resolveCanonicalCollectionHandle(requestedHandle)].filter(Boolean))
  );

  for (const lookupHandle of lookupHandles) {
    try {
      const shopifyPayload = await fetchCollectionProductsFromShopify(lookupHandle, first, after);
      if (shopifyPayload) {
        console.log('[Catalog v2] collection products shopify fallback', {
          handle: requestedHandle,
          lookupHandle,
          reason,
          returned: shopifyPayload?.data?.collectionByHandle?.products?.edges?.length || 0,
        });
        sendCatalogResponse(res, shopifyPayload, 'shopify');
        return true;
      }
    } catch (error) {
      console.warn('[Catalog v2] collection shopify fallback failed:', {
        handle: requestedHandle,
        lookupHandle,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return false;
}

function resolveProductImageForCollectionResponse(product: any) {
  return safeString(resolvePrimaryListImage(product)?.url);
}

function resolveCollectionImageForResponse(collection: any, resolvedProducts: any[]) {
  const collectionImageUrl = safeString(collection?.image?.url);
  if (collectionImageUrl) return { imageUrl: collectionImageUrl, imageSource: 'collection' };

  const displayImageUrl = safeString(collection?.displayImage);
  if (displayImageUrl) return { imageUrl: displayImageUrl, imageSource: 'displayImage' };

  const fallbackImageUrl = safeString(collection?.fallbackImage);
  if (fallbackImageUrl) return { imageUrl: fallbackImageUrl, imageSource: 'fallbackImage' };

  const cachedUrl = safeString(collection?.imageUrl) || safeString(collection?.previewImage);
  if (cachedUrl) {
    return { imageUrl: cachedUrl, imageSource: safeString(collection?.imageSource) || 'cache' };
  }

  for (const product of resolvedProducts || []) {
    const productImageUrl = resolveProductImageForCollectionResponse(product);
    if (productImageUrl) return { imageUrl: productImageUrl, imageSource: 'product' };
  }

  return { imageUrl: '', imageSource: 'fallback' };
}

function buildCollectionProductsPayload(collection: any, pageProducts: any[], pageInfo: any) {
  return {
    data: {
      collectionByHandle: {
        title: collection?.title || '',
        products: { edges: pageProducts.map((p) => ({ node: p })), pageInfo },
      },
    },
  };
}

async function tryCollectionProductsShopifyFallback(res: any, { handle, first, after, reason }) {
  const requestedHandle = safeString(handle);
  const lookupHandles = Array.from(
    new Set([requestedHandle, resolveCanonicalCollectionHandle(requestedHandle)].filter(Boolean))
  );

  for (const lookupHandle of lookupHandles) {
    try {
      const shopifyPayload = await fetchCollectionProductsFromShopify(lookupHandle, first, after);
      if (shopifyPayload) {
        console.log('[Catalog v2] collection products shopify fallback', {
          handle: requestedHandle,
          lookupHandle,
          reason,
          returned: shopifyPayload?.data?.collectionByHandle?.products?.edges?.length || 0,
        });
        sendCatalogResponse(res, shopifyPayload, 'shopify');
        return true;
      }
    } catch (error) {
      console.warn('[Catalog v2] collection shopify fallback failed:', {
        handle: requestedHandle,
        lookupHandle,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return false;
}

function resolveProductImageForCollectionResponse(product: any) {
  return safeString(resolvePrimaryListImage(product)?.url);
}

function resolveCollectionImageForResponse(collection: any, resolvedProducts: any[]) {
  const collectionImageUrl = safeString(collection?.image?.url);
  if (collectionImageUrl) return { imageUrl: collectionImageUrl, imageSource: 'collection' };

  const displayImageUrl = safeString(collection?.displayImage);
  if (displayImageUrl) return { imageUrl: displayImageUrl, imageSource: 'displayImage' };

  const fallbackImageUrl = safeString(collection?.fallbackImage);
  if (fallbackImageUrl) return { imageUrl: fallbackImageUrl, imageSource: 'fallbackImage' };

  const cachedUrl = safeString(collection?.imageUrl) || safeString(collection?.previewImage);
  if (cachedUrl) {
    return { imageUrl: cachedUrl, imageSource: safeString(collection?.imageSource) || 'cache' };
  }

  for (const product of resolvedProducts || []) {
    const productImageUrl = resolveProductImageForCollectionResponse(product);
    if (productImageUrl) return { imageUrl: productImageUrl, imageSource: 'product' };
  }

  return { imageUrl: '', imageSource: 'fallback' };
}

function buildCollectionProductsPayload(collection: any, pageProducts: any[], pageInfo: any) {
  return {
    data: {
      collectionByHandle: {
        title: collection?.title || '',
        products: { edges: pageProducts.map((p) => ({ node: p })), pageInfo },
      },
    },
  };
}

async function resolveCollectionProductHandles(cache: any, collection: any) {
  const storedHandles = (collection?.productHandles || [])
    .map((h: any) => safeString(h)).filter(Boolean);

  const index = await warmCollectionProductHandlesIndex(cache);
  const matchKeys = collectionMatchKeys(collection);
  const merged = [];
  const seen = new Set();

  for (const key of matchKeys) {
    for (const handle of index.get(key) || []) {
      if (!seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (!merged.length) {
    const products = await getProductsForCollectionIndex(cache);
    for (const product of products) {
      if (!productMatchesCollection(product, collection)) continue;
      const handle = safeString(product?.handle);
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (storedHandles.length) {
    const verifiedStored = await fetchProductsByHandles(cache, storedHandles.slice(0, 24));
    const activeStoredHandles = verifiedStored
      .filter(isVisibleProduct)
      .map((p) => safeString(p.handle))
      .filter(Boolean);
    appendUniqueHandles(merged, seen, activeStoredHandles);
  }

  if (!merged.length) {
    const indexProducts = await getProductsForCollectionIndex(cache);
    const handleKey = normalizeCollectionMatchKey(collection?.handle);
    const titleKey = normalizeCollectionMatchKey(collection?.title);
    const terms = Array.from(new Set([
      handleKey,
      titleKey,
      handleKey.replace(/-/g, ' '),
      titleKey.replace(/-/g, ' '),
      ...(COLLECTION_SEARCH_TERMS[handleKey] || []),
    ].filter(Boolean)));

    for (const term of terms) {
      const matches = searchIndexProducts(indexProducts, term);
      for (const product of matches) {
        appendUniqueHandles(merged, seen, [product.handle]);
      }
      if (merged.length) break;
    }
  }

  const source = merged.length
    ? storedHandles.length && seen.size > 0 ? 'reverse_lookup+verified_handles' : 'reverse_lookup'
    : 'empty';

  if (merged.length && source.startsWith('reverse_lookup')) {
    console.log('[Catalog v2] collection products reverse lookup', {
      handle: collection?.handle,
      title: collection?.title,
      count: merged.length,
      storedHandles: storedHandles.length,
      source,
    });
  }

  return { handles: merged, source };
}

function buildCollectionProductsPayload(collection: any, pageProducts: any[], pageInfo: any) {
  return {
    data: {
      collectionByHandle: {
        title: collection?.title || '',
        products: { edges: pageProducts.map((p) => ({ node: p })), pageInfo },
      },
    },
  };
}

async function resolveCollectionProductHandles(cache: any, collection: any) {
  const storedHandles = (collection?.productHandles || [])
    .map((h: any) => safeString(h)).filter(Boolean);

  const index = await warmCollectionProductHandlesIndex(cache);
  const matchKeys = collectionMatchKeys(collection);
  const merged = [];
  const seen = new Set();

  for (const key of matchKeys) {
    for (const handle of index.get(key) || []) {
      if (!seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (!merged.length) {
    const products = await getProductsForCollectionIndex(cache);
    for (const product of products) {
      if (!productMatchesCollection(product, collection)) continue;
      const handle = safeString(product?.handle);
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        merged.push(handle);
      }
    }
  }

  if (storedHandles.length) {
    const verifiedStored = await fetchProductsByHandles(cache, storedHandles.slice(0, 24));
    const activeStoredHandles = verifiedStored
      .filter(isVisibleProduct)
      .map((p) => safeString(p.handle))
      .filter(Boolean);
    appendUniqueHandles(merged, seen, activeStoredHandles);
  }

  if (!merged.length) {
    const indexProducts = await getProductsForCollectionIndex(cache);
    const handleKey = normalizeCollectionMatchKey(collection?.handle);
    const titleKey = normalizeCollectionMatchKey(collection?.title);
    const terms = Array.from(new Set([
      handleKey,
      titleKey,
      handleKey.replace(/-/g, ' '),
      titleKey.replace(/-/g, ' '),
      ...(COLLECTION_SEARCH_TERMS[handleKey] || []),
    ].filter(Boolean)));

    for (const term of terms) {
      const matches = searchIndexProducts(indexProducts, term);
      for (const product of matches) {
        appendUniqueHandles(merged, seen, [product.handle]);
      }
      if (merged.length) break;
    }
  }

  const source = merged.length
    ? storedHandles.length && seen.size > 0 ? 'reverse_lookup+verified_handles' : 'reverse_lookup'
    : 'empty';

  if (merged.length && source.startsWith('reverse_lookup')) {
    console.log('[Catalog v2] collection products reverse lookup', {
      handle: collection?.handle,
      title: collection?.title,
      count: merged.length,
      storedHandles: storedHandles.length,
      source,
    });
  }

  return { handles: merged, source };
}

async function loadCollectionProductsPage(cache: any, collection: any, first: number, after: string | null) {
  const resolved = await resolveCollectionProductHandles(cache, collection);
  const handles = resolved.handles;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;

  let skippedMissing = 0;
  let validIndex = 0;
  const pageProducts = [];
  let hasNextPage = false;

  for (let batchStart = 0; batchStart < handles.length; batchStart += 50) {
    const batchHandles = handles.slice(batchStart, batchStart + 50);
    const fetchedProducts = await fetchProductsByHandles(cache, batchHandles);
    const productsByHandle = new Map(
      fetchedProducts.filter(isVisibleProduct).map((p) => [p.handle, p])
    );

    for (const handle of batchHandles) {
      const product = productsByHandle.get(handle);
      if (!product) {
        skippedMissing++;
        continue;
      }

      if (validIndex < start) {
        validIndex++;
        continue;
      }

      if (pageProducts.length < limit) {
        pageProducts.push(product);
        validIndex++;
        continue;
      }

      hasNextPage = true;
      break;
    }

    if (hasNextPage) break;
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