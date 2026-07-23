"use strict";
/**
 * In-memory cache implementation for catalog v2
 * Used for development, testing, and CI environments without Redis
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryCache = void 0;
const KEY_PREFIX = 'nood:catalog:v2:';
class MemoryCache {
    products = new Map();
    productGidIndex = new Map(); // gid -> handle
    collections = new Map();
    collectionGidIndex = new Map();
    productHandles = new Set();
    collectionHandles = new Set();
    menus = new Map();
    syncState;
    meta = {};
    versions = new Map();
    versionIds = new Set();
    activeVersionId = null;
    previousVersionId = null;
    currentVersionId = null;
    validationResults = new Map();
    constructor(config) {
        this.syncState = this.defaultSyncState();
    }
    async connect() {
        // No-op for memory
    }
    async disconnect() {
        // No-op
    }
    async ping() {
        return true;
    }
    isConnected() {
        return true;
    }
    driver() {
        return 'memory';
    }
    p(key) {
        return `${KEY_PREFIX}${key}`;
    }
    vp(versionId, part) {
        return `v:${versionId}:${part}`;
    }
    // ============ Products ============
    async getProduct(handle) {
        return this.products.get(handle) || null;
    }
    async getProductById(gid) {
        const handle = this.productGidIndex.get(gid);
        if (!handle)
            return null;
        return this.products.get(handle) || null;
    }
    async getProductsByHandles(handles) {
        return handles.map(h => this.products.get(h)).filter((p) => p !== undefined);
    }
    async getAllProducts() {
        return Array.from(this.products.values());
    }
    async getProductCount() {
        return this.products.size;
    }
    async setProduct(product) {
        await this.setProducts([product]);
    }
    async setProducts(products) {
        let saved = 0;
        for (const product of products) {
            this.products.set(product.handle, product);
            this.productGidIndex.set(product.id, product.handle);
            this.productHandles.add(product.handle);
            saved++;
        }
        return saved;
    }
    async deleteProduct(handle) {
        const product = this.products.get(handle);
        if (!product)
            return false;
        this.products.delete(handle);
        this.productGidIndex.delete(product.id);
        this.productHandles.delete(handle);
        return true;
    }
    async deleteProducts(handles) {
        let deleted = 0;
        for (const handle of handles) {
            if (await this.deleteProduct(handle))
                deleted++;
        }
        return deleted;
    }
    async hasProduct(handle) {
        return this.products.has(handle);
    }
    // ============ Collections ============
    async getCollection(handle) {
        return this.collections.get(handle) || null;
    }
    async getCollectionById(gid) {
        const handle = this.collectionGidIndex.get(gid);
        if (!handle)
            return null;
        return this.collections.get(handle) || null;
    }
    async getAllCollections() {
        return Array.from(this.collections.values());
    }
    async getCollectionCount() {
        return this.collections.size;
    }
    async setCollection(collection) {
        await this.setCollections([collection]);
    }
    async setCollections(collections) {
        let saved = 0;
        for (const collection of collections) {
            this.collections.set(collection.handle, collection);
            this.collectionGidIndex.set(collection.id, collection.handle);
            this.collectionHandles.add(collection.handle);
            saved++;
        }
        return saved;
    }
    async deleteCollection(handle) {
        const collection = this.collections.get(handle);
        if (!collection)
            return false;
        this.collections.delete(handle);
        this.collectionGidIndex.delete(collection.id);
        this.collectionHandles.delete(handle);
        return true;
    }
    async hasCollection(handle) {
        return this.collections.has(handle);
    }
    // ============ Sync State ============
    async getSyncState() {
        return { ...this.syncState };
    }
    async setSyncState(state) {
        this.syncState = { ...this.syncState, ...state, updatedAt: new Date().toISOString() };
        return { ...this.syncState };
    }
    defaultSyncState() {
        return {
            status: 'idle',
            phase: undefined,
            productCursor: undefined,
            collectionCursor: undefined,
            productsCompleted: false,
            syncedProductCount: 0,
            syncedCollectionCount: 0,
        };
    }
    // ============ Catalog Versioning ============
    async beginVersion(versionId) {
        this.currentVersionId = versionId;
        const meta = {
            versionId,
            syncId: `sync_${Date.now()}`,
            status: 'running',
            schemaVersion: '1',
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            productCount: 0,
            collectionCount: 0,
            hasNextPage: true,
            source: 'shopify',
        };
        const versionData = {
            products: new Map(),
            collections: new Map(),
            productHandles: new Set(),
            collectionHandles: new Set(),
            meta,
        };
        this.versions.set(versionId, versionData);
        this.versionIds.add(versionId);
    }
    async setProductInVersion(versionId, product) {
        const version = this.versions.get(versionId);
        if (!version)
            throw new Error(`Version ${versionId} not found`);
        version.products.set(product.handle, product);
        version.productHandles.add(product.handle);
        version.meta.productCount = version.products.size;
        version.meta.updatedAt = new Date().toISOString();
    }
    async setCollectionInVersion(versionId, collection) {
        const version = this.versions.get(versionId);
        if (!version)
            throw new Error(`Version ${versionId} not found`);
        version.collections.set(collection.handle, collection);
        version.collectionHandles.add(collection.handle);
        version.meta.collectionCount = version.collections.size;
        version.meta.updatedAt = new Date().toISOString();
    }
    async getProductsFromVersion(versionId) {
        const version = this.versions.get(versionId);
        if (!version)
            return [];
        return Array.from(version.products.values());
    }
    async getCollectionsFromVersion(versionId) {
        const version = this.versions.get(versionId);
        if (!version)
            return [];
        return Array.from(version.collections.values());
    }
    async getProductCountForVersion(versionId) {
        const version = this.versions.get(versionId);
        return version?.products.size || 0;
    }
    async getCollectionCountForVersion(versionId) {
        const version = this.versions.get(versionId);
        return version?.collections.size || 0;
    }
    async getCatalogVersionMeta(versionId) {
        const version = this.versions.get(versionId);
        return version?.meta || null;
    }
    async setCatalogVersionMeta(versionId, meta) {
        const version = this.versions.get(versionId);
        if (!version)
            throw new Error(`Version ${versionId} not found`);
        version.meta = { ...version.meta, ...meta, updatedAt: new Date().toISOString() };
        return version.meta;
    }
    async finalizeVersion(versionId, hasNextPage) {
        const version = this.versions.get(versionId);
        if (!version)
            throw new Error(`Version ${versionId} not found`);
        version.meta.status = 'validated';
        version.meta.productCount = version.products.size;
        version.meta.collectionCount = version.collections.size;
        version.meta.hasNextPage = hasNextPage;
        version.meta.validatedAt = new Date().toISOString();
        version.meta.updatedAt = new Date().toISOString();
    }
    async activateVersion(versionId) {
        const version = this.versions.get(versionId);
        if (!version)
            throw new Error(`Version ${versionId} not found`);
        this.previousVersionId = this.activeVersionId || null;
        this.activeVersionId = versionId;
        version.meta.status = 'active';
        version.meta.activatedAt = new Date().toISOString();
        // Promote version data to main storage
        for (const [handle, product] of version.products) {
            this.products.set(handle, product);
            this.productGidIndex.set(product.id, handle);
            this.productHandles.add(handle);
        }
        for (const [handle, collection] of version.collections) {
            this.collections.set(handle, collection);
            this.collectionGidIndex.set(collection.id, handle);
            this.collectionHandles.add(handle);
        }
    }
    async rollbackVersion() {
        if (!this.previousVersionId)
            throw new Error('No previous version available for rollback');
        await this.activateVersion(this.previousVersionId);
    }
    async cleanupVersions(retentionCount) {
        const versions = Array.from(this.versionIds);
        const metas = await Promise.all(versions.map(v => this.getCatalogVersionMeta(v)));
        const valid = metas
            .filter(m => m !== null)
            .sort((a, b) => new Date(b.activatedAt || b.startedAt).getTime() - new Date(a.activatedAt || a.startedAt).getTime());
        const toDelete = valid.slice(retentionCount);
        for (const meta of toDelete) {
            if (meta && meta.status !== 'active') {
                this.versions.delete(meta.versionId);
                this.versionIds.delete(meta.versionId);
            }
        }
    }
    async getActiveVersionId() {
        return this.activeVersionId;
    }
    async setActiveVersionId(versionId) {
        this.activeVersionId = versionId;
    }
    async listCatalogVersions() {
        return Array.from(this.versionIds);
    }
    // ============ Menus ============
    async getMenu(handle) {
        return this.menus.get(handle) || null;
    }
    async setMenu(handle, menu) {
        this.menus.set(handle, menu);
    }
    // ============ Meta ============
    async getMeta() {
        return { ...this.meta };
    }
    async setMeta(meta) {
        this.meta = { ...this.meta, ...meta };
    }
    // ============ Validation ============
    async setValidationResult(versionId, result) {
        this.validationResults.set(versionId, result);
    }
    async getValidationResult(versionId) {
        return this.validationResults.get(versionId) || null;
    }
    // ============ Low-level ============
    async flush() {
        this.products.clear();
        this.productGidIndex.clear();
        this.collections.clear();
        this.collectionGidIndex.clear();
        this.productHandles.clear();
        this.collectionHandles.clear();
        this.menus.clear();
        this.versions.clear();
        this.versionIds.clear();
        this.activeVersionId = null;
        this.previousVersionId = null;
        this.currentVersionId = null;
        this.syncState = this.defaultSyncState();
        this.meta = {};
        this.validationResults.clear();
    }
    async persist() {
        // No-op for memory cache
    }
}
exports.MemoryCache = MemoryCache;
//# sourceMappingURL=memory-cache.js.map