const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', '..', 'catalog-cache.json');

function emptyState() {
  return {
    meta: {
      version: 1,
      lastSyncAt: null,
      productCount: 0,
      collectionCount: 0,
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

  async setProduct(handle, product) {
    const key = String(handle || '').trim();
    if (!key) return null;
    this.state.products[key] = product;
    if (product?.id) {
      this.state.productsById[String(product.id)] = key;
    }
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

  async getProductCount() {
    return Object.keys(this.state.products || {}).length;
  }

  async getCollectionCount() {
    return Object.keys(this.state.collections || {}).length;
  }

  async getAllProducts() {
    return Object.values(this.state.products);
  }

  async getCollection(handle) {
    return this.state.collections[String(handle || '').trim()] || null;
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