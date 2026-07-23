const { AsyncLocalStorage } = require('async_hooks');
const { JsonCatalogCache } = require('./json-cache');
const { safeString } = require('../transform');
const {
  connectRedisClient,
  logRedisStatus,
  resolveRedisUrl,
} = require('../../storage/redis-config');

const PRODUCT_SCAN_COUNT = 100;
const PRODUCT_FETCH_BATCH = 50;

const KEY_PREFIX = 'nood:catalog:';
const META_KEY = `${KEY_PREFIX}meta`;
const PRODUCTS_HASH_KEY = `${KEY_PREFIX}products:h`;
const PRODUCTS_BY_ID_HASH_KEY = `${KEY_PREFIX}productsById:h`;
const COLLECTIONS_HASH_KEY = `${KEY_PREFIX}collections:h`;
const MENUS_HASH_KEY = `${KEY_PREFIX}menus:h`;
const SYNC_STATE_KEY = `${KEY_PREFIX}syncState`;
const ACTIVE_VERSION_KEY = `${KEY_PREFIX}active-version`;
const PREVIOUS_VERSION_KEY = `${KEY_PREFIX}previous-version`;
const VERSION_INDEX_KEY = `${KEY_PREFIX}versions`;
const VERSION_AUDIT_KEY = `${KEY_PREFIX}version:audit`;
const MIX_META_INDEX_PREFIX = `${KEY_PREFIX}mixMetaIndex`;
const MIX_HANDLE_ORDER_PREFIX = `${KEY_PREFIX}mixedHandles`;
const MIX_CACHE_TTL_SECONDS = 60 * 60 * 24;
const mixMetaIndexL1 = new Map();

const LEGACY_PRODUCTS_KEY = `${KEY_PREFIX}products`;
const LEGACY_PRODUCTS_BY_ID_KEY = `${KEY_PREFIX}productsById`;
const LEGACY_COLLECTIONS_KEY = `${KEY_PREFIX}collections`;
const LEGACY_MENUS_KEY = `${KEY_PREFIX}menus`;
const catalogWriteContext = new AsyncLocalStorage();

function versionKey(versionId, part) {
  const version = safeString(versionId);
  if (!version) return '';
  return `${KEY_PREFIX}version:${version}:${part}`;
}

function createVersionId() {
  return `catalog_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
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

  if (safeString(product.status, 'ACTIVE').toUpperCase() !== 'ACTIVE') {
    return null;
  }

  return {
    handle: product.handle,
    id: product.id,
    updatedAt: product.updatedAt || '',
    availableForSale: Boolean(product.availableForSale),
  };
}

function parseRedisCollection(handle, raw) {
  if (!raw) {
    return null;
  }

  try {
    const collection = JSON.parse(raw);
    if (!collection || typeof collection !== 'object') {
      return null;
    }

    const collectionHandle = safeString(collection.handle) || safeString(handle);
    if (!collectionHandle) {
      return null;
    }

    if (!collection.handle) {
      collection.handle = collectionHandle;
    }

    if (!Array.isArray(collection.productHandles)) {
      collection.productHandles = [];
    }

    return collection;
  } catch {
    return null;
  }
}

function parseCollectionHashValues(rawMap = {}) {
  const items = [];
  for (const [handle, value] of Object.entries(rawMap || {})) {
    const collection = parseRedisCollection(handle, value);
    if (collection) {
      items.push(collection);
    }
  }
  return items;
}

function parseProductMixMeta(handle, raw) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const productHandle = safeString(parsed.handle) || safeString(handle);
    if (!productHandle || !parsed.id) {
      return null;
    }

    if (safeString(parsed.status, 'ACTIVE').toUpperCase() !== 'ACTIVE') {
      return null;
    }

    const collectionHandles = Array.isArray(parsed.collectionHandles) && parsed.collectionHandles.length
      ? parsed.collectionHandles.map((value) => safeString(value)).filter(Boolean)
      : (parsed.collections?.edges || [])
          .map((edge) => safeString(edge?.node?.handle))
          .filter(Boolean);

    return {
      handle: productHandle,
      id: String(parsed.id),
      collectionHandles,
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 12) : [],
      productType: safeString(parsed.productType),
      vendor: safeString(parsed.vendor),
    };
  } catch {
    logSkippedRedisProduct(handle, 'mix_meta_bad_json');
    return null;
  }
}

async function createRedisCache(redisUrl) {
  const client = await connectRedisClient(redisUrl, {
    maxRetriesPerRequest: 3,
  });

  class RedisCatalogCache {
    constructor() {
      this.client = client;
      this._legacyMigrated = false;
      this._stagingVersionId = '';
    }

    async getActiveVersionId() {
      return safeString(await this.client.get(ACTIVE_VERSION_KEY));
    }

    async getPreviousVersionId() {
      return safeString(await this.client.get(PREVIOUS_VERSION_KEY));
    }

    async countProductsForVersion(versionId) {
      const version = safeString(versionId);
      if (!version) {
        return Number(await this.client.hlen(PRODUCTS_HASH_KEY)) || 0;
      }
      return Number(await this.client.hlen(versionKey(version, 'products'))) || 0;
    }

    /**
     * P0 recovery: production had active-version missing/empty while products still
     * lived under a previous/staging version or legacy hash. Reads then hit
     * nood:catalog:version:__missing_active__:products → 0 products, collections 404,
     * product detail 404 → mobile preview-only (1 image, 0 variants, sold out).
     */
    async recoverReadableCatalogVersionId() {
      const candidates = [];
      const previous = await this.getPreviousVersionId();
      if (previous) candidates.push(previous);

      try {
        const indexed = await this.client.smembers(VERSION_INDEX_KEY);
        for (const id of indexed || []) {
          if (id && !candidates.includes(id)) candidates.push(id);
        }
      } catch {
        // ignore index failures
      }

      let bestId = '';
      let bestCount = 0;
      for (const id of candidates) {
        const count = await this.countProductsForVersion(id);
        if (count > bestCount) {
          bestCount = count;
          bestId = id;
        }
      }

      if (bestId && bestCount > 0) {
        console.warn('[NOOD cache] recovering catalog active-version', {
          versionId: bestId,
          productCount: bestCount,
          reason: 'active_missing_or_empty',
        });
        try {
          const meta = await this.getCatalogVersionMeta(bestId);
          const now = new Date().toISOString();
          await this.client
            .multi()
            .set(ACTIVE_VERSION_KEY, bestId)
            .set(
              versionKey(bestId, 'metadata'),
              JSON.stringify({
                ...(meta || { versionId: bestId }),
                status: 'active',
                productCount: bestCount,
                recoveredAt: now,
                recoveryReason: 'active_missing_or_empty',
              })
            )
            .lpush(
              VERSION_AUDIT_KEY,
              JSON.stringify({
                action: 'recover_active',
                versionId: bestId,
                productCount: bestCount,
                at: now,
              })
            )
            .exec();
        } catch (error) {
          console.warn('[NOOD cache] active-version recovery write failed:', error.message);
          // Still return the version id so reads work even if meta write fails.
        }
        return bestId;
      }

      const legacyHashCount = Number(await this.client.hlen(PRODUCTS_HASH_KEY)) || 0;
      if (legacyHashCount > 0) {
        console.warn('[NOOD cache] using legacy unversioned product hash', {
          productCount: legacyHashCount,
        });
        return '';
      }

      return null;
    }

    async getReadVersionId() {
      const active = await this.getActiveVersionId();
      if (active) {
        const activeCount = await this.countProductsForVersion(active);
        if (activeCount > 0) {
          return active;
        }
        console.warn('[NOOD cache] active catalog version has 0 products', { active });
      } else {
        console.warn('[NOOD cache] catalog active-version key is empty');
      }

      const recovered = await this.recoverReadableCatalogVersionId();
      if (recovered !== null && recovered !== undefined) {
        return recovered;
      }

      // Default to legacy unversioned keys — never invent a fake version id that is always empty.
      // Set CATALOG_LEGACY_FALLBACK_ENABLED=false only if you intentionally want hard-fail.
      const legacyDenied =
        String(process.env.CATALOG_LEGACY_FALLBACK_ENABLED || 'true').toLowerCase() === 'false';
      if (legacyDenied) {
        return '__missing_active__';
      }
      return '';
    }

    getWriteVersionId() {
      return safeString(this._stagingVersionId);
    }

    async getReadKeys() {
      const versionId = await this.getReadVersionId();
      if (!versionId) {
        return {
          meta: META_KEY,
          products: PRODUCTS_HASH_KEY,
          productsById: PRODUCTS_BY_ID_HASH_KEY,
          collections: COLLECTIONS_HASH_KEY,
          menus: MENUS_HASH_KEY,
        };
      }
      return {
        meta: versionKey(versionId, 'metadata'),
        products: versionKey(versionId, 'products'),
        productsById: versionKey(versionId, 'productsById'),
        collections: versionKey(versionId, 'collections'),
        menus: versionKey(versionId, 'menus'),
      };
    }

    async getWriteKeys() {
      const writeTarget = catalogWriteContext.getStore()?.writeTarget || 'active';
      const versionId =
        writeTarget === 'staging' && this.getWriteVersionId()
          ? this.getWriteVersionId()
          : await this.getActiveVersionId();
      if (!versionId) {
        return {
          meta: META_KEY,
          products: PRODUCTS_HASH_KEY,
          productsById: PRODUCTS_BY_ID_HASH_KEY,
          collections: COLLECTIONS_HASH_KEY,
          menus: MENUS_HASH_KEY,
        };
      }
      return {
        meta: versionKey(versionId, 'metadata'),
        products: versionKey(versionId, 'products'),
        productsById: versionKey(versionId, 'productsById'),
        collections: versionKey(versionId, 'collections'),
        menus: versionKey(versionId, 'menus'),
      };
    }

    async getMirrorWriteKeys() {
      const writeTarget = catalogWriteContext.getStore()?.writeTarget || 'active';
      const stagingVersionId = this.getWriteVersionId();
      if (writeTarget !== 'active' || !stagingVersionId) {
        return null;
      }
      const activeVersionId = await this.getActiveVersionId();
      if (!activeVersionId || activeVersionId === stagingVersionId) {
        return null;
      }
      return {
        meta: versionKey(stagingVersionId, 'metadata'),
        products: versionKey(stagingVersionId, 'products'),
        productsById: versionKey(stagingVersionId, 'productsById'),
        collections: versionKey(stagingVersionId, 'collections'),
        menus: versionKey(stagingVersionId, 'menus'),
      };
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

    async setJsonWithTtl(key, value, ttlSeconds = MIX_CACHE_TTL_SECONDS) {
      await this.client.set(key, JSON.stringify(value), 'EX', Math.max(60, Number(ttlSeconds) || MIX_CACHE_TTL_SECONDS));
    }

    async withCatalogStagingWrites(callback) {
      return catalogWriteContext.run({ writeTarget: 'staging' }, callback);
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
        catalogVersion: 0,
        catalogUpdatedAt: null,
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
      const keys = await this.getReadKeys();
      const stored = await this.getJson(keys.meta, null);
      return this.normalizeMeta(stored);
    }

    async setMeta(meta = {}) {
      const keys = await this.getWriteKeys();
      const current = this.normalizeMeta(await this.getJson(keys.meta, null));
      const next = this.normalizeMeta({ ...current, ...(meta || {}) });
      await this.setJson(keys.meta, next);
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) {
        const mirrorCurrent = this.normalizeMeta(await this.getJson(mirrorKeys.meta, null));
        await this.setJson(mirrorKeys.meta, this.normalizeMeta({ ...mirrorCurrent, ...(meta || {}) }));
      }
      return next;
    }

    async hasProduct(handle) {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      const key = String(handle || '').trim();
      if (!key) return false;
      return Boolean(await this.client.hexists(keys.products, key));
    }

    async getProduct(handle) {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      const key = String(handle || '').trim();
      if (!key) return null;
      const raw = await this.client.hget(keys.products, key);
      return parseRedisProduct(key, raw);
    }

    async getProductById(id) {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      const handle = await this.client.hget(keys.productsById, String(id || '').trim());
      return handle ? this.getProduct(handle) : null;
    }

    async mergeProducts(incomingProducts = []) {
      await this.ensureLegacyMigrated();
      if (!incomingProducts.length) {
        return 0;
      }

      const pipeline = this.client.multi();
      const keys = await this.getWriteKeys();
      let saved = 0;

      for (const product of incomingProducts) {
        const key = String(product?.handle || '').trim();
        if (!key) continue;
        pipeline.hset(keys.products, key, JSON.stringify(product));
        if (product?.id) {
          pipeline.hset(keys.productsById, String(product.id), key);
        }
        saved += 1;
      }

      await pipeline.exec();
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) {
        const mirror = this.client.multi();
        for (const product of incomingProducts) {
          const key = String(product?.handle || '').trim();
          if (!key) continue;
          mirror.hset(mirrorKeys.products, key, JSON.stringify(product));
          if (product?.id) {
            mirror.hset(mirrorKeys.productsById, String(product.id), key);
          }
        }
        await mirror.exec();
      }
      return saved;
    }

    async clearCollections() {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      await this.client.del(keys.collections, LEGACY_COLLECTIONS_KEY);
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) await this.client.del(mirrorKeys.collections);
    }

    async clearMenus() {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      await this.client.del(keys.menus, LEGACY_MENUS_KEY);
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) await this.client.del(mirrorKeys.menus);
    }

    async mergeCollections(incomingCollections = []) {
      await this.ensureLegacyMigrated();
      if (!incomingCollections.length) {
        return 0;
      }

      const pipeline = this.client.multi();
      const keys = await this.getWriteKeys();
      let saved = 0;

      for (const collection of incomingCollections) {
        const key = String(collection?.handle || '').trim();
        if (!key) continue;
        pipeline.hset(keys.collections, key, JSON.stringify(collection));
        saved += 1;
      }

      await pipeline.exec();
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) {
        const mirror = this.client.multi();
        for (const collection of incomingCollections) {
          const key = String(collection?.handle || '').trim();
          if (!key) continue;
          mirror.hset(mirrorKeys.collections, key, JSON.stringify(collection));
        }
        await mirror.exec();
      }
      return saved;
    }

    async replaceCollections(incomingCollections = []) {
      await this.clearCollections();
      return this.mergeCollections(incomingCollections);
    }

    async setProduct(handle, product) {
      return this.mergeProducts([product]);
    }

    async deleteProduct(handle) {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      const key = String(handle || '').trim();
      const raw = await this.client.hget(keys.products, key);
      if (!raw) return false;

      const product = JSON.parse(raw);
      const pipeline = this.client.multi();
      pipeline.hdel(keys.products, key);
      if (product?.id) {
        pipeline.hdel(keys.productsById, String(product.id));
      }
      await pipeline.exec();
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) {
        const mirror = this.client.multi();
        mirror.hdel(mirrorKeys.products, key);
        if (product?.id) {
          mirror.hdel(mirrorKeys.productsById, String(product.id));
        }
        await mirror.exec();
      }
      return true;
    }

    async clearProducts() {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      await this.client.del(
        keys.products,
        keys.productsById,
        LEGACY_PRODUCTS_KEY,
        LEGACY_PRODUCTS_BY_ID_KEY
      );
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) await this.client.del(mirrorKeys.products, mirrorKeys.productsById);
    }

    async getProductCount() {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      const hashCount = Number(await this.client.hlen(keys.products)) || 0;
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

    async getWorkingProductCount() {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      return Number(await this.client.hlen(keys.products)) || 0;
    }

    async getCollectionCount() {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      const hashCount = Number(await this.client.hlen(keys.collections)) || 0;
      if (hashCount > 0) {
        return hashCount;
      }

      const legacy = await this.getJson(LEGACY_COLLECTIONS_KEY, {});
      return Object.keys(legacy || {}).length;
    }

    async getWorkingCollectionCount() {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      return Number(await this.client.hlen(keys.collections)) || 0;
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
      const keys = await this.getReadKeys();
      const handles = await this.client.hkeys(keys.products);
      if (handles.length > 0) {
        return handles;
      }
      const legacy = await this.getLegacyProductsArray();
      return legacy.map((product) => product.handle).filter(Boolean);
    }

    async scanProductEntries(onEntry) {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      let cursor = '0';

      do {
        const [nextCursor, chunk] = await this.client.hscan(
          keys.products,
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
      const keys = await this.getReadKeys();
      const uniqueHandles = [...new Set(handles.map((handle) => safeString(handle)).filter(Boolean))];
      if (!uniqueHandles.length) {
        return [];
      }

      const productsByHandle = new Map();

      for (let index = 0; index < uniqueHandles.length; index += PRODUCT_FETCH_BATCH) {
        const batch = uniqueHandles.slice(index, index + PRODUCT_FETCH_BATCH);
        const raws = await this.client.hmget(keys.products, ...batch);

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
      const keys = await this.getReadKeys();
      const hashCount = Number(await this.client.hlen(keys.products)) || 0;
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

    async listProductMixMeta() {
      const rows = [];

      await this.scanProductEntries((handle, raw) => {
        const mixMeta = parseProductMixMeta(handle, raw);
        if (mixMeta) {
          rows.push(mixMeta);
        }
      });

      return rows;
    }

    getMixMetaIndexKey(productCount) {
      return `${MIX_META_INDEX_PREFIX}:${Math.max(0, Number(productCount) || 0)}`;
    }

    getMixedHandleOrderKey(productCount, mixKey) {
      return `${MIX_HANDLE_ORDER_PREFIX}:${Math.max(0, Number(productCount) || 0)}:${safeString(mixKey)}`;
    }

    async getProductMixIndex() {
      const productCount = await this.getProductCount();
      const l1 = mixMetaIndexL1.get(productCount);

      if (l1 && Date.now() - l1.builtAt < MIX_CACHE_TTL_SECONDS * 1000) {
        return l1.rows;
      }

      const cacheKey = this.getMixMetaIndexKey(productCount);
      const cached = await this.getJson(cacheKey, null);

      if (Array.isArray(cached) && cached.length > 0) {
        mixMetaIndexL1.set(productCount, { rows: cached, builtAt: Date.now() });
        return cached;
      }

      const built = await this.listProductMixMeta();
      if (built.length > 0) {
        mixMetaIndexL1.set(productCount, { rows: built, builtAt: Date.now() });
        await this.setJsonWithTtl(cacheKey, built, MIX_CACHE_TTL_SECONDS);
      }

      return built;
    }

    async getMixedHandleOrder(productCount, mixKey) {
      const cacheKey = this.getMixedHandleOrderKey(productCount, mixKey);
      const cached = await this.getJson(cacheKey, null);
      return Array.isArray(cached) ? cached : null;
    }

    async setMixedHandleOrder(productCount, mixKey, handles = []) {
      const cacheKey = this.getMixedHandleOrderKey(productCount, mixKey);
      const normalizedHandles = Array.isArray(handles)
        ? handles.map((handle) => safeString(handle)).filter(Boolean)
        : [];

      if (!normalizedHandles.length) {
        return false;
      }

      await this.setJsonWithTtl(cacheKey, normalizedHandles, MIX_CACHE_TTL_SECONDS);
      return true;
    }

    async clearMixedFeedCaches() {
      mixMetaIndexL1.clear();
      const patterns = [`${MIX_META_INDEX_PREFIX}:*`, `${MIX_HANDLE_ORDER_PREFIX}:*`];

      for (const pattern of patterns) {
        let cursor = '0';

        do {
          const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = nextCursor;

          if (keys.length) {
            await this.client.del(...keys);
          }
        } while (cursor !== '0');
      }
    }

    async listProductsPage({ limit = 50, after = null, sortKey = 'updated' } = {}) {
      let summaries = await this.listProductSummaries();
      const pageLimit = Math.max(1, Math.min(Number(limit) || 50, 250));
      const start = Number(after) > 0 ? Number(after) : 0;

      if (sortKey === 'home' || sortKey === 'updated_in_stock') {
        summaries = summaries.filter((summary) => Boolean(summary.availableForSale));
      }

      if (sortKey === 'created') {
        summaries.sort((left, right) => String(right.id).localeCompare(String(left.id)));
      } else if (sortKey === 'home' || sortKey === 'updated_in_stock') {
        summaries.sort((left, right) => {
          const stockDelta =
            Number(Boolean(right.availableForSale)) - Number(Boolean(left.availableForSale));
          if (stockDelta !== 0) {
            return stockDelta;
          }
          return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
        });
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
      const keys = await this.getReadKeys();
      const raw = await this.client.hget(keys.collections, String(handle || '').trim());
      return raw ? JSON.parse(raw) : null;
    }

    async deleteCollection(handle) {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      const key = String(handle || '').trim();
      if (!key) return false;
      const removed = await this.client.hdel(keys.collections, key);
      return Number(removed) > 0;
    }

    async setCollection(handle, collection) {
      return this.mergeCollections([collection]);
    }

    async getAllCollections() {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      const hashCount = Number(await this.client.hlen(keys.collections)) || 0;

      if (hashCount > 0) {
        const raw = await this.client.hgetall(keys.collections);
        return parseCollectionHashValues(raw);
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
      const keys = await this.getWriteKeys();
      const key = String(handle || '').trim();
      if (!key) return null;
      await this.client.hset(keys.menus, key, JSON.stringify(menu));
      const mirrorKeys = await this.getMirrorWriteKeys();
      if (mirrorKeys) await this.client.hset(mirrorKeys.menus, key, JSON.stringify(menu));
      return menu;
    }

    async getMenu(handle) {
      await this.ensureLegacyMigrated();
      const keys = await this.getReadKeys();
      const raw = await this.client.hget(keys.menus, String(handle || '').trim());
      return raw ? JSON.parse(raw) : null;
    }

    async replaceAll({ products, collections, menus, meta }) {
      await this.ensureLegacyMigrated();
      const keys = await this.getWriteKeys();
      await this.client.del(
        keys.products,
        keys.productsById,
        keys.collections,
        keys.menus,
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

    async beginCatalogStaging({ syncId = '', versionId = '', resume = false, previousActiveVersion = '' } = {}) {
      const currentState = await this.getSyncState();
      const nextVersionId = resume && currentState.versionId ? currentState.versionId : safeString(versionId, createVersionId());
      const nextSyncId = resume && currentState.syncId ? currentState.syncId : safeString(syncId, `sync_${Date.now()}`);
      this._stagingVersionId = nextVersionId;
      const activeVersion = previousActiveVersion || await this.getActiveVersionId();
      const meta = {
        versionId: nextVersionId,
        syncId: nextSyncId,
        status: 'running',
        schemaVersion: safeString(process.env.CATALOG_SCHEMA_VERSION, '1'),
        startedAt: currentState.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        productCount: Number(currentState.syncedProductCount || 0),
        collectionCount: Number(currentState.syncedCollectionCount || 0),
        hasNextPage: true,
        previousActiveVersion: activeVersion || null,
        source: 'shopify',
      };
      await this.setJson(versionKey(nextVersionId, 'metadata'), meta);
      await this.client.sadd(VERSION_INDEX_KEY, nextVersionId);
      await this.setSyncState({
        syncId: nextSyncId,
        versionId: nextVersionId,
        previousActiveVersion: activeVersion || null,
      });
      return { syncId: nextSyncId, versionId: nextVersionId, previousActiveVersion: activeVersion || null };
    }

    async getCatalogVersionMeta(versionId) {
      return this.getJson(versionKey(versionId, 'metadata'), null);
    }

    async setCatalogVersionMeta(versionId, patch = {}) {
      const current = await this.getCatalogVersionMeta(versionId) || {};
      const next = { ...current, ...patch, versionId, updatedAt: new Date().toISOString() };
      await this.setJson(versionKey(versionId, 'metadata'), next);
      await this.client.sadd(VERSION_INDEX_KEY, versionId);
      return next;
    }

    async getActiveCatalogMeta() {
      const activeVersion = await this.getActiveVersionId();
      if (!activeVersion) return null;
      return this.getCatalogVersionMeta(activeVersion);
    }

    async getAllProductsForVersion(versionId) {
      const raw = await this.client.hgetall(versionKey(versionId, 'products'));
      return parseHashValues(raw);
    }

    async getAllCollectionsForVersion(versionId) {
      const raw = await this.client.hgetall(versionKey(versionId, 'collections'));
      return parseCollectionHashValues(raw);
    }

    async finalizeCatalogStaging({ versionId = this._stagingVersionId, hasNextPage = false, status = 'validated', validation = null } = {}) {
      const productCount = Number(await this.client.hlen(versionKey(versionId, 'products'))) || 0;
      const collectionCount = Number(await this.client.hlen(versionKey(versionId, 'collections'))) || 0;
      return this.setCatalogVersionMeta(versionId, {
        status,
        productCount,
        collectionCount,
        hasNextPage,
        validation,
        validatedAt: status === 'validated' ? new Date().toISOString() : undefined,
      });
    }

    async activateCatalogVersion(versionId, { lockOwner = '', actor = 'system', reason = 'sync_activation', validation = null } = {}) {
      const meta = await this.getCatalogVersionMeta(versionId);
      if (!meta || !['validated', 'active'].includes(safeString(meta.status))) {
        throw new Error('Catalog version must be validated before activation.');
      }
      const currentActive = await this.getActiveVersionId();
      const now = new Date().toISOString();
      const nextMeta = {
        ...meta,
        status: 'active',
        activatedAt: now,
        activation: {
          actor: safeString(actor),
          reason: safeString(reason),
          lockOwner: lockOwner ? 'present' : 'not_recorded',
          at: now,
        },
        validation: validation || meta.validation || null,
      };
      const multi = this.client.multi()
        .set(versionKey(versionId, 'metadata'), JSON.stringify(nextMeta))
        .set(PREVIOUS_VERSION_KEY, currentActive || '')
        .set(ACTIVE_VERSION_KEY, versionId)
        .lpush(VERSION_AUDIT_KEY, JSON.stringify({ action: 'activate', versionId, previousVersion: currentActive || null, actor, reason, at: now }));
      if (currentActive && currentActive !== versionId) {
        const oldMeta = await this.getCatalogVersionMeta(currentActive);
        if (oldMeta) {
          multi.set(versionKey(currentActive, 'metadata'), JSON.stringify({ ...oldMeta, status: 'superseded', supersededAt: now }));
        }
      }
      await multi.exec();
      this._stagingVersionId = '';
      return nextMeta;
    }

    async rollbackCatalogVersion({ apply = false, actor = 'cli', reason = 'manual_rollback' } = {}) {
      const active = await this.getActiveVersionId();
      const previous = await this.getPreviousVersionId();
      if (!previous) throw new Error('No previous catalog version is available.');
      const previousMeta = await this.getCatalogVersionMeta(previous);
      if (!previousMeta || !['active', 'superseded'].includes(safeString(previousMeta.status))) {
        throw new Error('Previous catalog version is not valid for rollback.');
      }
      const summary = {
        activeVersion: active || null,
        targetVersion: previous,
        activeProductCount: Number((await this.getCatalogVersionMeta(active))?.productCount || 0),
        targetProductCount: Number(previousMeta.productCount || 0),
        apply: Boolean(apply),
      };
      if (!apply) return summary;
      const now = new Date().toISOString();
      await this.client.multi()
        .set(ACTIVE_VERSION_KEY, previous)
        .set(PREVIOUS_VERSION_KEY, active || '')
        .set(versionKey(previous, 'metadata'), JSON.stringify({ ...previousMeta, status: 'active', rolledBackAt: now }))
        .lpush(VERSION_AUDIT_KEY, JSON.stringify({ action: 'rollback', activeVersion: active || null, targetVersion: previous, actor, reason, at: now }))
        .exec();
      return { ...summary, rolledBack: true };
    }

    async cleanupCatalogVersions({ apply = false } = {}) {
      const active = await this.getActiveVersionId();
      const previous = await this.getPreviousVersionId();
      const retainCount = Number(process.env.CATALOG_VERSION_RETENTION_COUNT || 5);
      const failedDays = Number(process.env.CATALOG_FAILED_VERSION_RETENTION_DAYS || 14);
      const cutoff = Date.now() - failedDays * 24 * 60 * 60 * 1000;
      const versions = await this.client.smembers(VERSION_INDEX_KEY);
      const metas = [];
      for (const id of versions) {
        const meta = await this.getCatalogVersionMeta(id);
        if (meta) metas.push(meta);
      }
      metas.sort((a, b) => String(b.activatedAt || b.updatedAt || '').localeCompare(String(a.activatedAt || a.updatedAt || '')));
      const retained = new Set([active, previous, ...metas.slice(0, retainCount).map((meta) => meta.versionId)].filter(Boolean));
      const deletable = metas.filter((meta) => {
        if (retained.has(meta.versionId)) return false;
        const status = safeString(meta.status);
        const updated = Date.parse(meta.updatedAt || meta.startedAt || 0);
        return ['failed', 'abandoned', 'rolled_back', 'superseded'].includes(status) && updated < cutoff;
      });
      if (apply && deletable.length) {
        for (const meta of deletable) {
          await this.client.del(
            versionKey(meta.versionId, 'metadata'),
            versionKey(meta.versionId, 'products'),
            versionKey(meta.versionId, 'productsById'),
            versionKey(meta.versionId, 'collections'),
            versionKey(meta.versionId, 'menus')
          );
          await this.client.srem(VERSION_INDEX_KEY, meta.versionId);
        }
      }
      return { apply: Boolean(apply), activeVersion: active || null, previousVersion: previous || null, deletableCount: deletable.length, deletableVersions: deletable.map((meta) => meta.versionId) };
    }

    async getSyncState() {
      return this.getJson(SYNC_STATE_KEY, defaultSyncState());
    }

    async setSyncState(state) {
      const current = await this.getSyncState();
      const next = {
        ...current,
        ...state,
        updatedAt: new Date().toISOString(),
      };
      await this.setJson(SYNC_STATE_KEY, next);
      if (next.versionId) {
        const currentMeta = await this.getCatalogVersionMeta(next.versionId);
        const mirroredStatus =
          currentMeta?.status === 'active' && next.status === 'completed'
            ? 'active'
            : next.status || current.status || 'running';
        await this.setCatalogVersionMeta(next.versionId, {
          syncId: next.syncId || current.syncId || null,
          status: mirroredStatus,
          phase: next.phase || null,
          productCursor: next.productCursor || null,
          collectionCursor: next.collectionCursor || null,
          productsProcessed: Number(next.syncedProductCount || 0),
          collectionsProcessed: Number(next.syncedCollectionCount || 0),
          pagesProcessed: Number(next.pagesProcessed || next.chunkPages || 0) || 0,
          hasNextPage: next.status === 'completed' ? false : true,
          lastSafeError: next.lastError || null,
          completedAt: next.completedAt || null,
          previousActiveVersion: next.previousActiveVersion || current.previousActiveVersion || null,
        });
      }
      return this.getSyncState();
    }
  }

  return new RedisCatalogCache();
}

async function createCatalogCache() {
  if (String(process.env.NOOD_CATALOG_FORCE_JSON || '').trim() === '1') {
    console.log('[NOOD catalog] using JSON file cache (NOOD_CATALOG_FORCE_JSON=1)');
    return new JsonCatalogCache();
  }

  const resolved = resolveRedisUrl();
  if (resolved.url) {
    try {
      const cache = await createRedisCache(resolved.url);
      logRedisStatus('catalog', {
        driver: resolved.driver,
        connected: true,
        source: resolved.source,
      });
      console.log('[NOOD catalog] using Redis cache');
      return cache;
    } catch (error) {
      logRedisStatus('catalog', {
        driver: resolved.driver,
        connected: false,
        source: resolved.source,
        error,
      });
      console.warn('[NOOD catalog] Redis unavailable, falling back to JSON cache:', error.message);
    }
  } else {
    logRedisStatus('catalog', {
      driver: 'memory',
      connected: false,
      source: resolved.source,
    });
  }

  console.log('[NOOD catalog] using JSON file cache');
  return new JsonCatalogCache();
}

module.exports = {
  createCatalogCache,
  createRedisCache,
};
