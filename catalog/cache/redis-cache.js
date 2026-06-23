const { JsonCatalogCache } = require('./json-cache');
const { safeString } = require('../transform');

const PRODUCT_SCAN_COUNT = 100;
const PRODUCT_FETCH_BATCH = 50;

const KEY_PREFIX = 'nood:catalog:';
const META_KEY = `${KEY_PREFIX}meta`;
const PRODUCTS_HASH_KEY = `${KEY_PREFIX}products:h`;
const PRODUCTS_BY_ID_HASH_KEY = `${KEY_PREFIX}productsById:h`;
const COLLECTIONS_HASH_KEY = `${KEY_PREFIX}collections:h`;
const MENUS_HASH_KEY = `${KEY_PREFIX}menus:h`;
const SYNC_STATE_KEY = `${KEY_PREFIX}syncState`;

const LEGACY_PRODUCTS_KEY = `${KEY_PREFIX}products`;
const LEGACY_PRODUCTS_BY_ID_KEY = `${KEY_PREFIX}productsById`;
const LEGACY_COLLECTIONS_KEY = `${KEY_PREFIX}collections`;
const LEGACY_MENUS_KEY = `${KEY_PREFIX}menus`;

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

function parseHashValues(rawMap = {}) {
  const items = [];
  for (const [handle, value] of Object.entries(rawMap || {})) {
    const product = parseRedisProduct(handle, value);
    if (product) {
      items.push(product);
    }
  }
  return items;
}

function logSkippedRedisProduct(handle, reason = 'invalid') {
  console.log(
    `[NOOD catalog] skipped invalid redis product handle=${safeString(handle, 'unknown')} reason=${reason}`
  );
}

function parseRedisProduct(handle, raw) {
  if (!raw) {
    logSkippedRedisProduct(handle, 'empty');
    return null;
  }

  try {
    const product = JSON.parse(raw);
    if (!product || typeof product !== 'object') {
      logSkippedRedisProduct(handle, 'not_object');
      return null;
    }

    const productHandle = safeString(product.handle) || safeString(handle);
    if (!productHandle || !product.id) {
      logSkippedRedisProduct(handle, 'missing_handle_or_id');
      return null;
    }

    if (!product.handle) {
      product.handle = productHandle;
    }

    return product;
  } catch {
    logSkippedRedisProduct(handle, 'bad_json');
    return null;
  }
}

function parseProductSummary(handle, raw) {
  const product = parseRedisProduct(handle, raw);
  if (!product) {
    return null;
  }

  if (safeString(product.status).toUpperCase() === 'ARCHIVED') {
    return null;
  }

  return {
    handle: product.handle,
    id: product.id,
    updatedAt: product.updatedAt || '',
  };
}

async function createRedisCache(redisUrl) {
  let Redis;
  try {
    Redis = require('ioredis');
  } catch (error) {
    throw new Error('ioredis is not installed. Run npm install ioredis to use Redis.');
  }

  const useTls = redisUrl.startsWith('rediss://');
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    connectTimeout: 20000,
    commandTimeout: 120000,
    tls: useTls ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();

  class RedisCatalogCache {
    constructor() {
      this.client = client;
      this._legacyMigrated = false;
    }

    async getJson(key, fallback) {
      const raw = await this.client.get(key);
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    async setJson(key, value) {
      await this.client.set(key, JSON.stringify(value));
    }

    async ensureLegacyMigrated() {
      if (this._legacyMigrated) {
        return;
      }

      const [legacyProducts, legacyById, legacyCollections, legacyMenus] = await Promise.all([
        this.client.get(LEGACY_PRODUCTS_KEY),
        this.client.get(LEGACY_PRODUCTS_BY_ID_KEY),
        this.client.get(LEGACY_COLLECTIONS_KEY),
        this.client.get(LEGACY_MENUS_KEY),
      ]);

      if (legacyProducts) {
        const products = JSON.parse(legacyProducts);
        const pipeline = this.client.multi();
        for (const product of Object.values(products || {})) {
          if (!product?.handle) continue;
          pipeline.hset(PRODUCTS_HASH_KEY, product.handle, JSON.stringify(product));
          if (product.id) {
            pipeline.hset(PRODUCTS_BY_ID_HASH_KEY, String(product.id), product.handle);
          }
        }
        await pipeline.exec();
        await this.client.del(LEGACY_PRODUCTS_KEY);
      }

      if (legacyById) {
        await this.client.del(LEGACY_PRODUCTS_BY_ID_KEY);
      }

      if (legacyCollections) {
        const collections = JSON.parse(legacyCollections);
        const pipeline = this.client.multi();
        for (const collection of Object.values(collections || {})) {
          if (!collection?.handle) continue;
          pipeline.hset(COLLECTIONS_HASH_KEY, collection.handle, JSON.stringify(collection));
        }
        await pipeline.exec();
        await this.client.del(LEGACY_COLLECTIONS_KEY);
      }

      if (legacyMenus) {
        const menus = JSON.parse(legacyMenus);
        const pipeline = this.client.multi();
        for (const [handle, menu] of Object.entries(menus || {})) {
          pipeline.hset(MENUS_HASH_KEY, handle, JSON.stringify(menu));
        }
        await pipeline.exec();
        await this.client.del(LEGACY_MENUS_KEY);
      }

      this._legacyMigrated = true;
    }

    defaultMeta() {
      return {
        version: 1,
        lastSyncAt: null,
        productCount: 0,
        collectionCount: 0,
        syncInProgress: false,
        source: null,
      };
    }

    normalizeMeta(meta) {
      const base = this.defaultMeta();
      const safeMeta = meta && typeof meta === 'object' ? meta : {};
      return {
        ...base,
        ...safeMeta,
        productCount: Number(safeMeta.productCount ?? base.productCount) || 0,
        collectionCount: Number(safeMeta.collectionCount ?? base.collectionCount) || 0,
      };
    }

    async getMeta() {
      const stored = await this.getJson(META_KEY, null);
      return this.normalizeMeta(stored);
    }

    async setMeta(meta = {}) {
      const current = await this.getMeta();
      const next = this.normalizeMeta({ ...current, ...(meta || {}) });
      await this.setJson(META_KEY, next);
      return next;
    }

    async hasProduct(handle) {
      await this.ensureLegacyMigrated();
      const key = String(handle || '').trim();
      if (!key) return false;
      return Boolean(await this.client.hexists(PRODUCTS_HASH_KEY, key));
    }

    async getProduct(handle) {
      await this.ensureLegacyMigrated();
      const key = String(handle || '').trim();
      if (!key) return null;
      const raw = await this.client.hget(PRODUCTS_HASH_KEY, key);
      return parseRedisProduct(key, raw);
    }

    async getProductById(id) {
      await this.ensureLegacyMigrated();
      const handle = await this.client.hget(PRODUCTS_BY_ID_HASH_KEY, String(id || '').trim());
      return handle ? this.getProduct(handle) : null;
    }

    async mergeProducts(incomingProducts = []) {
      await this.ensureLegacyMigrated();
      if (!incomingProducts.length) {
        return 0;
      }

      const pipeline = this.client.multi();
      let saved = 0;

      for (const product of incomingProducts) {
        const key = String(product?.handle || '').trim();
        if (!key) continue;
        pipeline.hset(PRODUCTS_HASH_KEY, key, JSON.stringify(product));
        if (product?.id) {
          pipeline.hset(PRODUCTS_BY_ID_HASH_KEY, String(product.id), key);
        }
        saved += 1;
      }

      await pipeline.exec();
      return saved;
    }

    async mergeCollections(incomingCollections = []) {
      await this.ensureLegacyMigrated();
      if (!incomingCollections.length) {
        return 0;
      }

      const pipeline = this.client.multi();
      let saved = 0;

      for (const collection of incomingCollections) {
        const key = String(collection?.handle || '').trim();
        if (!key) continue;
        pipeline.hset(COLLECTIONS_HASH_KEY, key, JSON.stringify(collection));
        saved += 1;
      }

      await pipeline.exec();
      return saved;
    }

    async setProduct(handle, product) {
      return this.mergeProducts([product]);
    }

    async deleteProduct(handle) {
      await this.ensureLegacyMigrated();
      const key = String(handle || '').trim();
      const raw = await this.client.hget(PRODUCTS_HASH_KEY, key);
      if (!raw) return false;

      const product = JSON.parse(raw);
      const pipeline = this.client.multi();
      pipeline.hdel(PRODUCTS_HASH_KEY, key);
      if (product?.id) {
        pipeline.hdel(PRODUCTS_BY_ID_HASH_KEY, String(product.id));
      }
      await pipeline.exec();
      return true;
    }

    async clearProducts() {
      await this.ensureLegacyMigrated();
      await this.client.del(
        PRODUCTS_HASH_KEY,
        PRODUCTS_BY_ID_HASH_KEY,
        LEGACY_PRODUCTS_KEY,
        LEGACY_PRODUCTS_BY_ID_KEY
      );
    }

    async getProductCount() {
      await this.ensureLegacyMigrated();
      const hashCount = Number(await this.client.hlen(PRODUCTS_HASH_KEY)) || 0;
      if (hashCount > 0) {
        console.log(`[NOOD cache] redis product hash count=${hashCount}`);
        return hashCount;
      }

      const legacy = await this.getJson(LEGACY_PRODUCTS_KEY, {});
      const legacyCount = Object.keys(legacy || {}).length;
      if (legacyCount > 0) {
        console.log(`[NOOD cache] redis legacy product blob count=${legacyCount}`);
        return legacyCount;
      }

      console.log('[NOOD cache] redis product hash count=0');
      return 0;
    }

    async getCollectionCount() {
      await this.ensureLegacyMigrated();
      const hashCount = Number(await this.client.hlen(COLLECTIONS_HASH_KEY)) || 0;
      if (hashCount > 0) {
        return hashCount;
      }

      const legacy = await this.getJson(LEGACY_COLLECTIONS_KEY, {});
      return Object.keys(legacy || {}).length;
    }

    async getLegacyProductsArray() {
      const legacy = await this.getJson(LEGACY_PRODUCTS_KEY, null);
      if (!legacy || typeof legacy !== 'object') {
        return [];
      }
      return Object.values(legacy).filter(Boolean);
    }

    async getAllProductHandles() {
      await this.ensureLegacyMigrated();
      const handles = await this.client.hkeys(PRODUCTS_HASH_KEY);
      if (handles.length > 0) {
        return handles;
      }
      const legacy = await this.getLegacyProductsArray();
      return legacy.map((product) => product.handle).filter(Boolean);
    }

    async scanProductEntries(onEntry) {
      await this.ensureLegacyMigrated();
      let cursor = '0';

      do {
        const [nextCursor, chunk] = await this.client.hscan(
          PRODUCTS_HASH_KEY,
          cursor,
          'COUNT',
          PRODUCT_SCAN_COUNT
        );
        cursor = nextCursor;

        for (let index = 0; index < chunk.length; index += 2) {
          onEntry(chunk[index], chunk[index + 1]);
        }
      } while (cursor !== '0');
    }

    async getProductsByHandles(handles = []) {
      await this.ensureLegacyMigrated();
      const uniqueHandles = [...new Set(handles.map((handle) => safeString(handle)).filter(Boolean))];
      if (!uniqueHandles.length) {
        return [];
      }

      const productsByHandle = new Map();

      for (let index = 0; index < uniqueHandles.length; index += PRODUCT_FETCH_BATCH) {
        const batch = uniqueHandles.slice(index, index + PRODUCT_FETCH_BATCH);
        const raws = await this.client.hmget(PRODUCTS_HASH_KEY, ...batch);

        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const product = parseRedisProduct(batch[batchIndex], raws[batchIndex]);
          if (product) {
            productsByHandle.set(product.handle, product);
          }
        }
      }

      return handles
        .map((handle) => productsByHandle.get(safeString(handle)))
        .filter(Boolean);
    }

    async readAllProductsSafe() {
      await this.ensureLegacyMigrated();
      const hashCount = Number(await this.client.hlen(PRODUCTS_HASH_KEY)) || 0;
      console.log(`[NOOD cache] redis product hash count=${hashCount}`);

      if (hashCount > 0) {
        const products = [];
        await this.scanProductEntries((handle, raw) => {
          const product = parseRedisProduct(handle, raw);
          if (product) {
            products.push(product);
          }
        });
        return products;
      }

      const legacyProducts = await this.getLegacyProductsArray();
      if (legacyProducts.length > 0) {
        console.log(`[NOOD cache] redis legacy product blob count=${legacyProducts.length}`);
        await this.mergeProducts(legacyProducts);
        await this.client.del(LEGACY_PRODUCTS_KEY, LEGACY_PRODUCTS_BY_ID_KEY);
        return legacyProducts
          .map((product) => parseRedisProduct(product?.handle, JSON.stringify(product)))
          .filter(Boolean);
      }

      return [];
    }

    async listProductSummaries() {
      const summaries = [];

      await this.scanProductEntries((handle, raw) => {
        const summary = parseProductSummary(handle, raw);
        if (summary) {
          summaries.push(summary);
        }
      });

      return summaries;
    }

    async listProductsPage({ limit = 50, after = null, sortKey = 'updated' } = {}) {
      const summaries = await this.listProductSummaries();
      const pageLimit = Math.max(1, Math.min(Number(limit) || 50, 250));
      const start = Number(after) > 0 ? Number(after) : 0;

      if (sortKey === 'created') {
        summaries.sort((left, right) => String(right.id).localeCompare(String(left.id)));
      } else {
        summaries.sort((left, right) =>
          String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
        );
      }

      const pageSummaries = summaries.slice(start, start + pageLimit);
      const items = await this.getProductsByHandles(pageSummaries.map((summary) => summary.handle));
      const nextIndex = start + pageSummaries.length;
      const hasNextPage = nextIndex < summaries.length;

      return {
        items,
        total: summaries.length,
        hasNextPage,
        endCursor: hasNextPage ? String(nextIndex) : null,
      };
    }

    async getAllProducts() {
      return this.readAllProductsSafe();
    }

    async getCollection(handle) {
      await this.ensureLegacyMigrated();
      const raw = await this.client.hget(COLLECTIONS_HASH_KEY, String(handle || '').trim());
      return raw ? JSON.parse(raw) : null;
    }

    async setCollection(handle, collection) {
      return this.mergeCollections([collection]);
    }

    async getAllCollections() {
      await this.ensureLegacyMigrated();
      const hashCount = Number(await this.client.hlen(COLLECTIONS_HASH_KEY)) || 0;

      if (hashCount > 0) {
        const raw = await this.client.hgetall(COLLECTIONS_HASH_KEY);
        return parseHashValues(raw);
      }

      const legacy = await this.getJson(LEGACY_COLLECTIONS_KEY, null);
      if (legacy && typeof legacy === 'object') {
        const legacyCollections = Object.values(legacy).filter(Boolean);
        if (legacyCollections.length > 0) {
          await this.mergeCollections(legacyCollections);
          await this.client.del(LEGACY_COLLECTIONS_KEY);
          return legacyCollections;
        }
      }

      return [];
    }

    async setMenu(handle, menu) {
      await this.ensureLegacyMigrated();
      const key = String(handle || '').trim();
      if (!key) return null;
      await this.client.hset(MENUS_HASH_KEY, key, JSON.stringify(menu));
      return menu;
    }

    async getMenu(handle) {
      await this.ensureLegacyMigrated();
      const raw = await this.client.hget(MENUS_HASH_KEY, String(handle || '').trim());
      return raw ? JSON.parse(raw) : null;
    }

    async replaceAll({ products, collections, menus, meta }) {
      await this.ensureLegacyMigrated();
      await this.client.del(
        PRODUCTS_HASH_KEY,
        PRODUCTS_BY_ID_HASH_KEY,
        COLLECTIONS_HASH_KEY,
        MENUS_HASH_KEY,
        LEGACY_PRODUCTS_KEY,
        LEGACY_PRODUCTS_BY_ID_KEY,
        LEGACY_COLLECTIONS_KEY,
        LEGACY_MENUS_KEY
      );

      const productList = Array.isArray(products) ? products : [];
      const collectionList = Array.isArray(collections) ? collections : [];

      for (let index = 0; index < productList.length; index += 50) {
        await this.mergeProducts(productList.slice(index, index + 50));
      }

      for (let index = 0; index < collectionList.length; index += 50) {
        await this.mergeCollections(collectionList.slice(index, index + 50));
      }

      if (menus && typeof menus === 'object') {
        for (const [menuHandle, menu] of Object.entries(menus)) {
          await this.setMenu(menuHandle, menu);
        }
      }

      return this.setMeta(meta || {});
    }

    async flush() {
      return undefined;
    }

    driver() {
      return 'redis';
    }

    async ping() {
      return this.client.ping();
    }

    async getSyncState() {
      return this.getJson(SYNC_STATE_KEY, defaultSyncState());
    }

    async setSyncState(state) {
      const current = await this.getSyncState();
      await this.setJson(SYNC_STATE_KEY, {
        ...current,
        ...state,
        updatedAt: new Date().toISOString(),
      });
      return this.getSyncState();
    }
  }

  return new RedisCatalogCache();
}

async function createCatalogCache() {
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (redisUrl) {
    try {
      const cache = await createRedisCache(redisUrl);
      console.log('[NOOD catalog] using Redis cache');
      return cache;
    } catch (error) {
      console.warn('[NOOD catalog] Redis unavailable, falling back to JSON cache:', error.message);
    }
  }

  console.log('[NOOD catalog] using JSON file cache');
  return new JsonCatalogCache();
}

module.exports = {
  createCatalogCache,
  createRedisCache,
};