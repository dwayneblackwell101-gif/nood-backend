const {
  fetchAllAdminProducts,
  fetchAdminProductById,
  fetchAllAdminCollections,
  storefrontGraphql,
  getShopifyConfig,
  STOREFRONT_MENU_QUERY,
} = require('./shopify');
const { transformAdminProduct, safeString } = require('./transform');

const DEFAULT_MENU_HANDLES = [
  'main-menu',
  'footer',
  'nood-categories',
  'categories',
  'mobile-menu',
];

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

const { clearMixedFeedCache } = require('./feed-mix');

function buildSyncedCatalog(adminProducts, adminCollections, config) {
  const activeProducts = adminProducts.filter(
    (product) => safeString(product?.status).toUpperCase() !== 'ARCHIVED'
  );

  const products = activeProducts.map((adminProduct) =>
    transformAdminProduct(adminProduct, config.currencyCode)
  );

  const collections = adminCollections.map(normalizeCollection);

  for (const collection of collections) {
    collection.productHandles = collection.productHandles.filter((handle) =>
      products.some((product) => product.handle === handle)
    );
  }

  return { products, collections };
}

async function persistPartialCatalog(cache, adminProducts, adminCollections, config, startedAt) {
  const { products, collections } = buildSyncedCatalog(adminProducts, adminCollections, config);

  if (!products.length && !collections.length) {
    return null;
  }

  return cache.replaceAll({
    products,
    collections,
    menus: {},
    meta: {
      lastSyncAt: new Date().toISOString(),
      productCount: products.length,
      collectionCount: collections.length,
      syncDurationMs: Date.now() - startedAt,
      source: 'shopify',
      syncInProgress: true,
    },
  });
}

async function syncAllProducts(cache, options = {}) {
  const startedAt = Date.now();
  const source = 'shopify';
  const config = getShopifyConfig();
  let adminProducts = [];
  let adminCollections = [];

  console.log('[NOOD catalog] full product sync started');

  try {
    adminProducts = await fetchAllAdminProducts();
    await persistPartialCatalog(cache, adminProducts, [], config, startedAt);

    adminCollections = await fetchAllAdminCollections();

    const { products, collections } = buildSyncedCatalog(
      adminProducts,
      adminCollections,
      config
    );

    const menus = options.syncMenus === false ? {} : await syncMenus(cache);

    const meta = await cache.replaceAll({
      products,
      collections,
      menus,
      meta: {
        lastSyncAt: new Date().toISOString(),
        productCount: products.length,
        collectionCount: collections.length,
        syncDurationMs: Date.now() - startedAt,
        source,
        syncInProgress: false,
      },
    });

    clearMixedFeedCache();

    console.log(
      `[NOOD sync] completed productCount=${meta.productCount} collectionCount=${meta.collectionCount}`
    );

    return meta;
  } catch (error) {
    try {
      const partialMeta = await persistPartialCatalog(
        cache,
        adminProducts,
        adminCollections,
        config,
        startedAt
      );
      if (partialMeta) {
        console.warn('[NOOD sync] saved partial catalog progress before failure', {
          productCount: partialMeta.productCount,
          collectionCount: partialMeta.collectionCount,
          error: error.message,
        });
      }
    } catch (partialError) {
      console.warn('[NOOD sync] failed to save partial catalog progress:', partialError.message);
    }

    throw error;
  }
}

async function ensureCatalogWarm(cache) {
  const meta = await cache.getMeta();
  const products = await cache.getAllProducts();

  if (String(process.env.NODE_ENV || '').trim() === 'production') {
    console.log('[NOOD catalog] production startup warm check skipped auto-sync', {
      cacheDriver: cache.driver(),
      productCount: meta.productCount || products.length,
      collectionCount: meta.collectionCount || 0,
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
  syncSingleProduct,
  syncProductByAdminId,
  syncMenus,
  ensureCatalogWarm,
  normalizeCollection,
};