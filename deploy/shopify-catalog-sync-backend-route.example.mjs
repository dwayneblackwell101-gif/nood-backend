/**
 * Drop-in backend route for simple Shopify -> Redis catalog sync.
 *
 * Usage in the backend service:
 *   import { installShopifyCatalogSyncRoute } from './shopify-catalog-sync-backend-route.example.mjs';
 *   installShopifyCatalogSyncRoute(app, { redis });
 *
 * Rules enforced here:
 * - Product sync resumes from the saved Shopify product cursor.
 * - Product sync completes only after Shopify returns products.pageInfo.hasNextPage === false.
 * - Collections run only after productsCompleted=true.
 * - Menus run only after collections finish and when menuHandles are configured.
 * - Final completed status is written only after products, collections, and enabled menus finish.
 */

const DEFAULT_PRODUCT_PAGE_SIZE = 100;
const DEFAULT_COLLECTION_PAGE_SIZE = 100;
const DEFAULT_MENU_HANDLES = ['main-menu'];

const SYNC_STATE_KEY = 'nood:shopify:catalog-sync:state';
const SYNC_LOCK_KEY = 'nood:shopify:catalog-sync:lock';
const PRODUCT_BY_HANDLE_PREFIX = 'nood:catalog:product:handle:';
const PRODUCT_BY_ID_PREFIX = 'nood:catalog:product:id:';
const COLLECTION_BY_HANDLE_PREFIX = 'nood:catalog:collection:handle:';
const MENU_BY_HANDLE_PREFIX = 'nood:catalog:menu:handle:';
const CATALOG_VERSION_KEY = 'nood:catalog:version';

function getEnv(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

async function redisGetJson(redis, key, fallback = null) {
  const raw = await redis.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function redisSetJson(redis, key, value) {
  await redis.set(key, JSON.stringify(value));
}

async function setRedisLock(redis, key, value, ttlSeconds) {
  try {
    return await redis.set(key, value, 'EX', ttlSeconds, 'NX');
  } catch {
    return await redis.set(key, value, { EX: ttlSeconds, NX: true });
  }
}

async function deleteRedisKey(redis, key) {
  if (typeof redis.del === 'function') {
    await redis.del(key);
    return;
  }
  if (typeof redis.delete === 'function') {
    await redis.delete(key);
  }
}

function initialSyncState() {
  const timestamp = nowIso();
  return {
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    completed: false,
    productsCompleted: false,
    collectionsCompleted: false,
    menusCompleted: false,
    productCursor: null,
    collectionCursor: null,
    productCount: 0,
    shopifyProductsCount: null,
    productPagesSynced: 0,
    collectionPagesSynced: 0,
    menuHandlesSynced: [],
  };
}

async function saveState(redis, patch) {
  const current = await redisGetJson(redis, SYNC_STATE_KEY, initialSyncState());
  const next = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  await redisSetJson(redis, SYNC_STATE_KEY, next);
  return next;
}

async function readOrStartState(redis, restart) {
  if (restart) {
    const next = initialSyncState();
    await redisSetJson(redis, SYNC_STATE_KEY, next);
    return next;
  }

  const current = await redisGetJson(redis, SYNC_STATE_KEY, null);
  return current || (await saveState(redis, initialSyncState()));
}

function getShopifyConfig({ admin = false } = {}) {
  const shopDomain = getEnv('SHOPIFY_STORE_DOMAIN', getEnv('EXPO_PUBLIC_SHOPIFY_STORE_DOMAIN'));
  const apiVersion = getEnv('SHOPIFY_API_VERSION', getEnv('EXPO_PUBLIC_SHOPIFY_API_VERSION', '2026-04'));
  const token = admin
    ? getEnv('SHOPIFY_ADMIN_ACCESS_TOKEN', getEnv('SHOPIFY_ADMIN_TOKEN'))
    : getEnv('SHOPIFY_STOREFRONT_TOKEN', getEnv('EXPO_PUBLIC_SHOPIFY_STOREFRONT_TOKEN'));

  if (!shopDomain || !token) {
    throw new Error(admin ? 'Missing Shopify Admin token/domain.' : 'Missing Shopify Storefront token/domain.');
  }

  return { shopDomain, apiVersion, token };
}

async function shopifyGraphql({ admin = false, query, variables }) {
  const { shopDomain, apiVersion, token } = getShopifyConfig({ admin });
  const endpoint = admin
    ? `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`
    : `https://${shopDomain}/api/${apiVersion}/graphql.json`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [admin ? 'X-Shopify-Access-Token' : 'X-Shopify-Storefront-Access-Token']: token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json().catch(() => null);

  if (!response.ok || json?.errors?.length) {
    throw new Error(JSON.stringify(json || { status: response.status }));
  }

  return json.data;
}

async function fetchShopifyProductsCount() {
  try {
    const data = await shopifyGraphql({
      admin: true,
      query: `
        query SyncProductsCount {
          productsCount {
            count
          }
        }
      `,
    });
    const count = Number(data?.productsCount?.count);
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch (error) {
    console.warn('[NOOD Shopify sync] productsCount unavailable', {
      error: String(error?.message || error),
    });
    return null;
  }
}

async function fetchProductPage({ first, after }) {
  const data = await shopifyGraphql({
    query: `
      query SyncProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: UPDATED_AT) {
          edges {
            cursor
            node {
              id
              handle
              title
              vendor
              productType
              tags
              availableForSale
              featuredImage { url altText width height }
              priceRange { minVariantPrice { amount currencyCode } }
              compareAtPriceRange { maxVariantPrice { amount currencyCode } }
              collections(first: 10) {
                edges { node { id handle title } }
              }
              variants(first: 250) {
                edges {
                  node {
                    id
                    title
                    availableForSale
                    quantityAvailable
                    selectedOptions { name value }
                    price { amount currencyCode }
                    compareAtPrice { amount currencyCode }
                    image { url altText width height }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    variables: { first, after },
  });

  const products = data?.products;
  return {
    edges: Array.isArray(products?.edges) ? products.edges : [],
    pageInfo: products?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}

async function fetchCollectionPage({ first, after }) {
  const data = await shopifyGraphql({
    query: `
      query SyncCollections($first: Int!, $after: String) {
        collections(first: $first, after: $after, sortKey: UPDATED_AT) {
          edges {
            cursor
            node {
              id
              handle
              title
              description
              image { url altText width height }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    variables: { first, after },
  });

  const collections = data?.collections;
  return {
    edges: Array.isArray(collections?.edges) ? collections.edges : [],
    pageInfo: collections?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}

async function fetchMenu(handle) {
  const data = await shopifyGraphql({
    query: `
      query SyncMenu($handle: String!) {
        menu(handle: $handle) {
          id
          handle
          title
          items {
            id
            title
            type
            url
            resourceId
            items {
              id
              title
              type
              url
              resourceId
            }
          }
        }
      }
    `,
    variables: { handle },
  });

  return data?.menu || null;
}

async function saveProductEdges(redis, edges) {
  let savedCount = 0;

  for (const edge of edges) {
    const product = edge?.node;
    if (!product?.handle) continue;

    await redisSetJson(redis, `${PRODUCT_BY_HANDLE_PREFIX}${product.handle}`, product);
    if (product.id) {
      await redisSetJson(redis, `${PRODUCT_BY_ID_PREFIX}${product.id}`, product);
    }
    savedCount += 1;
  }

  return savedCount;
}

async function saveCollectionEdges(redis, edges) {
  for (const edge of edges) {
    const collection = edge?.node;
    if (!collection?.handle) continue;
    await redisSetJson(redis, `${COLLECTION_BY_HANDLE_PREFIX}${collection.handle}`, collection);
  }
}

async function syncProductsUntilShopifyDone({ redis, first, state }) {
  let cursor = state.productCursor || null;
  let pagesSynced = Number(state.productPagesSynced) || 0;
  let totalSaved = Number(state.productCount) || 0;

  while (!state.productsCompleted) {
    const page = await fetchProductPage({ first, after: cursor });
    const hasNextPage = page.pageInfo?.hasNextPage === true;
    const endCursor = page.pageInfo?.endCursor || null;

    const savedCount = await saveProductEdges(redis, page.edges);

    pagesSynced += 1;
    totalSaved += savedCount;
    cursor = hasNextPage ? endCursor : null;

    console.log('[NOOD Shopify sync] product page saved', {
      hasNextPage,
      endCursor,
      savedCount,
      totalSaved,
    });

    state = await saveState(redis, {
      productCursor: cursor,
      productCount: totalSaved,
      productPagesSynced: pagesSynced,
      productsCompleted: hasNextPage === false,
    });

    if (hasNextPage === false) {
      break;
    }
  }

  return state;
}

async function recoverBadCompletedProductState(redis, state, shopifyProductsCount) {
  if (!state?.completed && !state?.productsCompleted) {
    return state;
  }

  const productCount = Number(state?.productCount) || 0;
  if (!shopifyProductsCount || productCount >= shopifyProductsCount) {
    return state;
  }

  if (!state.productCursor) {
    const error = new Error(
      `Catalog state says completed at ${productCount}/${shopifyProductsCount} products and has no productCursor. Retry with restart=true.`
    );
    error.statusCode = 409;
    error.restartRequired = true;
    throw error;
  }

  console.warn('[NOOD Shopify sync] reopening incomplete completed product state', {
    productCount,
    shopifyProductsCount,
    productCursor: state.productCursor,
  });

  return saveState(redis, {
    completed: false,
    completedAt: null,
    productsCompleted: false,
    collectionsCompleted: false,
    menusCompleted: false,
    shopifyProductsCount,
  });
}

async function syncCollectionsUntilDone({ redis, first, state }) {
  let cursor = state.collectionCursor || null;
  let pagesSynced = Number(state.collectionPagesSynced) || 0;

  while (!state.collectionsCompleted) {
    const page = await fetchCollectionPage({ first, after: cursor });
    const hasNextPage = page.pageInfo?.hasNextPage === true;
    const endCursor = page.pageInfo?.endCursor || null;

    await saveCollectionEdges(redis, page.edges);

    pagesSynced += 1;
    cursor = endCursor;
    state = await saveState(redis, {
      collectionCursor: cursor,
      collectionPagesSynced: pagesSynced,
      collectionsCompleted: hasNextPage === false,
    });

    if (hasNextPage === false) {
      break;
    }
  }

  return state;
}

async function syncMenus({ redis, menuHandles, state }) {
  if (!menuHandles.length) {
    return saveState(redis, { menusCompleted: true, menuHandlesSynced: [] });
  }

  const synced = new Set(Array.isArray(state.menuHandlesSynced) ? state.menuHandlesSynced : []);

  for (const handle of menuHandles) {
    if (synced.has(handle)) continue;

    const menu = await fetchMenu(handle);
    if (menu) {
      await redisSetJson(redis, `${MENU_BY_HANDLE_PREFIX}${handle}`, menu);
    }
    synced.add(handle);
    state = await saveState(redis, {
      menuHandlesSynced: [...synced],
      menusCompleted: synced.size >= menuHandles.length,
    });
  }

  return state;
}

async function markCatalogComplete(redis, state) {
  if (!state.productsCompleted || !state.collectionsCompleted || !state.menusCompleted) {
    return state;
  }

  const productCount = Number(state.productCount) || 0;
  const shopifyProductsCount = Number(state.shopifyProductsCount) || 0;
  if (shopifyProductsCount > 0 && productCount < shopifyProductsCount) {
    console.warn('[NOOD Shopify sync] refusing completed status before all Shopify products are saved', {
      productCount,
      shopifyProductsCount,
    });
    return saveState(redis, {
      completed: false,
      completedAt: null,
      productsCompleted: false,
    });
  }

  const catalogVersion = Date.now();
  await redisSetJson(redis, CATALOG_VERSION_KEY, {
    catalogVersion,
    catalogUpdatedAt: nowIso(),
    lastSyncAt: nowIso(),
  });

  return saveState(redis, {
    completed: true,
    completedAt: nowIso(),
    catalogVersion,
  });
}

function assertAdmin(req, adminApiKey) {
  if (!adminApiKey) return;
  const headerValue = String(req.get?.('x-admin-api-key') || req.headers?.['x-admin-api-key'] || '');
  if (headerValue !== adminApiKey) {
    const error = new Error('Unauthorized.');
    error.statusCode = 401;
    throw error;
  }
}

export function installShopifyCatalogSyncRoute(app, options) {
  const redis = options?.redis;
  const adminApiKey = String(options?.adminApiKey || process.env.ADMIN_API_KEY || '').trim();
  const productPageSize = Number(options?.productPageSize) || DEFAULT_PRODUCT_PAGE_SIZE;
  const collectionPageSize = Number(options?.collectionPageSize) || DEFAULT_COLLECTION_PAGE_SIZE;
  const menuHandles = Array.isArray(options?.menuHandles)
    ? options.menuHandles.map(String).filter(Boolean)
    : DEFAULT_MENU_HANDLES;

  if (!app || !redis) {
    throw new Error('installShopifyCatalogSyncRoute requires { app, redis }.');
  }

  app.post('/api/sync/shopify/products', async (req, res) => {
    const lockValue = `${process.pid}:${Date.now()}`;

    try {
      assertAdmin(req, adminApiKey);

      const restart = normalizeBoolean(req.query?.restart ?? req.body?.restart);
      const menusEnabled = normalizeBoolean(req.query?.menus ?? req.body?.menus ?? menuHandles.length > 0);
      const lockAcquired = await setRedisLock(redis, SYNC_LOCK_KEY, lockValue, 900);

      if (!lockAcquired) {
        const state = await redisGetJson(redis, SYNC_STATE_KEY, null);
        res.status(202).json({
          success: true,
          message: 'Catalog sync already running.',
          state,
        });
        return;
      }

      const shopifyProductsCount = await fetchShopifyProductsCount();
      let state = await readOrStartState(redis, restart);
      state = await saveState(redis, { shopifyProductsCount });
      state = await recoverBadCompletedProductState(redis, state, shopifyProductsCount);

      if (!state.productsCompleted) {
        state = await syncProductsUntilShopifyDone({
          redis,
          first: productPageSize,
          state,
        });
      }

      if (state.productsCompleted && !state.collectionsCompleted) {
        state = await syncCollectionsUntilDone({
          redis,
          first: collectionPageSize,
          state,
        });
      }

      if (state.productsCompleted && state.collectionsCompleted && !state.menusCompleted) {
        state = await syncMenus({
          redis,
          menuHandles: menusEnabled ? menuHandles : [],
          state,
        });
      }

      state = await markCatalogComplete(redis, state);

      res.json({
        success: true,
        message: state.completed ? 'Catalog sync completed.' : 'Catalog sync progressed.',
        catalogVersion: state.catalogVersion || null,
        state,
      });
    } catch (error) {
      res.status(error?.statusCode || 500).json({
        success: false,
        message: String(error?.message || error),
      });
    } finally {
      const currentLock = await redis.get(SYNC_LOCK_KEY).catch(() => null);
      if (currentLock === lockValue) {
        await deleteRedisKey(redis, SYNC_LOCK_KEY);
      }
    }
  });
}
