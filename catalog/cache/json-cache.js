const fs = require('fs');
const path = require('path');
const { safeString } = require('../transform');

const CACHE_FILE = path.join(__dirname, '..', '..', 'catalog-cache.json');
const MIX_CACHE_TTL_MS = 60 * 60 * 24 * 1000;

const jsonMixMetaIndexCache = new Map();
const jsonMixedHandleOrderCache = new Map();

function parseJsonProductMixMeta(product) {
  if (!product?.handle || !product?.id) {
    return null;
  }

  if (safeString(product.status, 'ACTIVE').toUpperCase() !== 'ACTIVE') {
    return null;
  }

  const collectionHandles = Array.isArray(product.collectionHandles) && product.collectionHandles.length
    ? product.collectionHandles.map((value) => safeString(value)).filter(Boolean)
    : (product.collections?.edges || [])
        .map((edge) => safeString(edge?.node?.handle))
        .filter(Boolean);

  return {
    handle: product.handle,
    id: String(product.id),
    collectionHandles,
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 12) : [],
    productType: safeString(product.productType),
    vendor: safeString(product.vendor),
  };
}

function emptyState() {
  return {
    meta: {
      version: 1,
      lastSyncAt: null,
      productCount: 0,
      collectionCount: 0,
      catalogVersion: 0,
      catalogUpdatedAt: null,
    },
    products: {},
    productsById: {},
    collections: {},
    menus: {},
    syncState: {
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
    },
  };
}

class JsonCatalogCache {
  constructor() {
    this.state = emptyState();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(CACHE_FILE)) return;
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      this.state = {
        ...emptyState(),
        ...parsed,
        products: parsed.products || {},
        productsById: parsed.productsById || {},
        collections: parsed.collections || {},
        menus: parsed.menus || {},
        meta: { ...emptyState().meta, ...(parsed.meta || {}) },
        syncState: { ...emptyState().syncState, ...(parsed.syncState || {}) },
      };
    } catch (error) {
      console.error('[NOOD catalog] failed to load JSON cache:', error.message);
    }
  }

  async persist() {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(this.state, null, 2));
  }

  async getMeta() {
    return { ...this.state.meta };
  }

  async setMeta(meta) {
    this.state.meta = { ...this.state.meta, ...meta };
    await this.persist();
    return { ...this.state.meta };
  }

  async getProduct(handle) {
    return this.state.products[String(handle || '').trim()] || null;
  }

  async getProductById(id) {
    const handle = this.state.productsById[String(id || '').trim()];
    return handle ? this.state.products[handle] : null;
  }

  async mergeProducts(incomingProducts = []) {
    let saved = 0;

    for (const product of incomingProducts) {
      const key = String(product?.handle || '').trim();
      if (!key) continue;
      this.state.products[key] = product;
      if (product?.id) {
        this.state.productsById[String(product.id)] = key;
      }
      saved += 1;
    }

    await this.persist();
    return saved;
  }

  async clearCollections() {
    this.state.collections = {};
    await this.persist();
  }

  async clearMenus() {
    this.state.menus = {};
    await this.persist();
  }

  async mergeCollections(incomingCollections = []) {
    let saved = 0;

    for (const collection of incomingCollections) {
      const key = String(collection?.handle || '').trim();
      if (!key) continue;
      this.state.collections[key] = collection;
      saved += 1;
    }

    await this.persist();
    return saved;
  }

  async replaceCollections(incomingCollections = []) {
    const next = {};

    for (const collection of incomingCollections || []) {
      const key = String(collection?.handle || '').trim();
      if (!key) continue;
      next[key] = collection;
    }

    this.state.collections = next;
    await this.persist();
    return Object.keys(next).length;
  }

  async setProduct(handle, product) {
    const key = String(handle || '').trim();
    if (!key) return null;
    this.state.products[key] = product;
    if (product?.id) {
      this.state.productsById[String(product.id)] = key;
    }
    await this.persist();
    return product;
  }

  async deleteProduct(handle) {
    const key = String(handle || '').trim();
    const product = this.state.products[key];
    if (!product) return false;
    delete this.state.products[key];
    if (product.id) {
      delete this.state.productsById[String(product.id)];
    }
    await this.persist();
    return true;
  }

  async clearProducts() {
    this.state.products = {};
    this.state.productsById = {};
    jsonMixMetaIndexCache.clear();
    jsonMixedHandleOrderCache.clear();
    await this.persist();
  }

  async deleteProducts(handles = []) {
    const keys = [...new Set(handles.map((handle) => String(handle || '').trim()).filter(Boolean))];
    if (!keys.length) {
      return 0;
    }

    let removed = 0;
    for (const key of keys) {
      const product = this.state.products[key];
      if (!product) {
        continue;
      }
      delete this.state.products[key];
      if (product.id) {
        delete this.state.productsById[String(product.id)];
      }
      removed += 1;
    }

    if (removed > 0) {
      jsonMixMetaIndexCache.clear();
      jsonMixedHandleOrderCache.clear();
      await this.persist();
    }

    return removed;
  }

  async getProductCount() {
    return Object.keys(this.state.products || {}).length;
  }

  async getCollectionCount() {
    return Object.keys(this.state.collections || {}).length;
  }

  async getAllProducts() {
    return Object.values(this.state.products);
  }

  async getProductsByHandles(handles = []) {
    const uniqueHandles = [...new Set(handles.map((handle) => safeString(handle)).filter(Boolean))];
    const productsByHandle = new Map();

    for (const handle of uniqueHandles) {
      const product = this.state.products[handle];
      if (product) {
        productsByHandle.set(handle, product);
      }
    }

    return handles
      .map((handle) => productsByHandle.get(safeString(handle)))
      .filter(Boolean);
  }

  async listProductMixMeta() {
    return Object.values(this.state.products || {})
      .map((product) => parseJsonProductMixMeta(product))
      .filter(Boolean);
  }

  async getProductMixIndex() {
    const productCount = await this.getProductCount();
    const cacheKey = String(productCount);
    const cached = jsonMixMetaIndexCache.get(cacheKey);

    if (cached && Date.now() - cached.builtAt < MIX_CACHE_TTL_MS) {
      return cached.rows;
    }

    const built = await this.listProductMixMeta();
    if (built.length > 0) {
      jsonMixMetaIndexCache.set(cacheKey, { rows: built, builtAt: Date.now() });
    }

    return built;
  }

  async getMixedHandleOrder(productCount, mixKey) {
    const cacheKey = `${productCount}:${safeString(mixKey)}`;
    const cached = jsonMixedHandleOrderCache.get(cacheKey);

    if (cached && Date.now() - cached.builtAt < MIX_CACHE_TTL_MS) {
      return cached.handles;
    }

    return null;
  }

  async setMixedHandleOrder(productCount, mixKey, handles = []) {
    const cacheKey = `${productCount}:${safeString(mixKey)}`;
    const normalizedHandles = Array.isArray(handles)
      ? handles.map((handle) => safeString(handle)).filter(Boolean)
      : [];

    if (!normalizedHandles.length) {
      return false;
    }

    jsonMixedHandleOrderCache.set(cacheKey, {
      handles: normalizedHandles,
      builtAt: Date.now(),
    });
    return true;
  }

  async clearMixedFeedCaches() {
    jsonMixMetaIndexCache.clear();
    jsonMixedHandleOrderCache.clear();
  }

  async getCollection(handle) {
    return this.state.collections[String(handle || '').trim()] || null;
  }

  async deleteCollection(handle) {
    const key = String(handle || '').trim();
    if (!key || !this.state.collections[key]) {
      return false;
    }
    delete this.state.collections[key];
    await this.persist();
    return true;
  }

  async setCollection(handle, collection) {
    const key = String(handle || '').trim();
    if (!key) return null;
    this.state.collections[key] = collection;
    return collection;
  }

  async getAllCollections() {
    return Object.values(this.state.collections);
  }

  async setMenu(handle, menu) {
    const key = String(handle || '').trim();
    if (!key) return null;
    this.state.menus[key] = menu;
    return menu;
  }

  async getMenu(handle) {
    return this.state.menus[String(handle || '').trim()] || null;
  }

  async replaceAll({ products, collections, menus, meta }) {
    const next = emptyState();
    const productsById = {};

    for (const product of products || []) {
      if (!product?.handle) continue;
      next.products[product.handle] = product;
      if (product.id) {
        productsById[String(product.id)] = product.handle;
      }
    }

    for (const collection of collections || []) {
      if (!collection?.handle) continue;
      next.collections[collection.handle] = collection;
    }

    for (const [menuHandle, menu] of Object.entries(menus || {})) {
      next.menus[menuHandle] = menu;
    }

    next.productsById = productsById;
    next.meta = { ...next.meta, ...(meta || {}) };
    this.state = next;
    await this.persist();
    return next.meta;
  }

  async flush() {
    await this.persist();
  }

  driver() {
    return 'json';
  }

  async ping() {
    return fs.existsSync(CACHE_FILE) ? 'OK' : 'MISSING';
  }

  async getSyncState() {
    return { ...this.state.syncState };
  }

  async setSyncState(state) {
    this.state.syncState = {
      ...this.state.syncState,
      ...state,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    return this.getSyncState();
  }
}

module.exports = {
  JsonCatalogCache,
  CACHE_FILE,
};
