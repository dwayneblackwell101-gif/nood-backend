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
}

module.exports = {
  JsonCatalogCache,
  CACHE_FILE,
};