const { JsonCatalogCache } = require('./json-cache');

const KEY_PREFIX = 'nood:catalog:';
const META_KEY = `${KEY_PREFIX}meta`;
const PRODUCTS_KEY = `${KEY_PREFIX}products`;
const PRODUCTS_BY_ID_KEY = `${KEY_PREFIX}productsById`;
const COLLECTIONS_KEY = `${KEY_PREFIX}collections`;
const MENUS_KEY = `${KEY_PREFIX}menus`;

async function createRedisCache(redisUrl) {
  let Redis;
  try {
    Redis = require('ioredis');
  } catch (error) {
    throw new Error('ioredis is not installed. Run npm install ioredis to use Redis.');
  }

  const useTls = redisUrl.startsWith('rediss://');
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    tls: useTls ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();

  class RedisCatalogCache {
    constructor() {
      this.client = client;
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

    async getMeta() {
      return this.getJson(META_KEY, { version: 1, lastSyncAt: null, productCount: 0, collectionCount: 0 });
    }

    async setMeta(meta) {
      const current = await this.getMeta();
      await this.setJson(META_KEY, { ...current, ...meta });
    }

    async getProduct(handle) {
      const products = await this.getJson(PRODUCTS_KEY, {});
      return products[String(handle || '').trim()] || null;
    }

    async getProductById(id) {
      const map = await this.getJson(PRODUCTS_BY_ID_KEY, {});
      const handle = map[String(id || '').trim()];
      return handle ? this.getProduct(handle) : null;
    }

    async setProduct(handle, product) {
      const key = String(handle || '').trim();
      if (!key) return null;
      const products = await this.getJson(PRODUCTS_KEY, {});
      const byId = await this.getJson(PRODUCTS_BY_ID_KEY, {});
      products[key] = product;
      if (product?.id) {
        byId[String(product.id)] = key;
      }
      await this.setJson(PRODUCTS_KEY, products);
      await this.setJson(PRODUCTS_BY_ID_KEY, byId);
      return product;
    }

    async deleteProduct(handle) {
      const key = String(handle || '').trim();
      const products = await this.getJson(PRODUCTS_KEY, {});
      const product = products[key];
      if (!product) return false;
      delete products[key];
      const byId = await this.getJson(PRODUCTS_BY_ID_KEY, {});
      if (product.id) {
        delete byId[String(product.id)];
      }
      await this.setJson(PRODUCTS_KEY, products);
      await this.setJson(PRODUCTS_BY_ID_KEY, byId);
      return true;
    }

    async getAllProducts() {
      const products = await this.getJson(PRODUCTS_KEY, {});
      return Object.values(products);
    }

    async getCollection(handle) {
      const collections = await this.getJson(COLLECTIONS_KEY, {});
      return collections[String(handle || '').trim()] || null;
    }

    async setCollection(handle, collection) {
      const key = String(handle || '').trim();
      if (!key) return null;
      const collections = await this.getJson(COLLECTIONS_KEY, {});
      collections[key] = collection;
      await this.setJson(COLLECTIONS_KEY, collections);
      return collection;
    }

    async getAllCollections() {
      const collections = await this.getJson(COLLECTIONS_KEY, {});
      return Object.values(collections);
    }

    async setMenu(handle, menu) {
      const key = String(handle || '').trim();
      if (!key) return null;
      const menus = await this.getJson(MENUS_KEY, {});
      menus[key] = menu;
      await this.setJson(MENUS_KEY, menus);
      return menu;
    }

    async getMenu(handle) {
      const menus = await this.getJson(MENUS_KEY, {});
      return menus[String(handle || '').trim()] || null;
    }

    async replaceAll({ products, collections, menus, meta }) {
      const nextProducts = {};
      const nextById = {};
      const nextCollections = {};
      const nextMenus = {};

      for (const product of products || []) {
        if (!product?.handle) continue;
        nextProducts[product.handle] = product;
        if (product.id) {
          nextById[String(product.id)] = product.handle;
        }
      }

      for (const collection of collections || []) {
        if (!collection?.handle) continue;
        nextCollections[collection.handle] = collection;
      }

      for (const [menuHandle, menu] of Object.entries(menus || {})) {
        nextMenus[menuHandle] = menu;
      }

      await Promise.all([
        this.setJson(PRODUCTS_KEY, nextProducts),
        this.setJson(PRODUCTS_BY_ID_KEY, nextById),
        this.setJson(COLLECTIONS_KEY, nextCollections),
        this.setJson(MENUS_KEY, nextMenus),
        this.setMeta(meta || {}),
      ]);

      return this.getMeta();
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