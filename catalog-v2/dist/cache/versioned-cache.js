"use strict";
/**
 * Versioned Cache Wrapper
 * Adds catalog versioning support on top of any ICache implementation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionedCache = void 0;
class VersionedCache {
    baseCache;
    config;
    currentVersionId = null;
    isStaging = false;
    constructor(baseCache, config) {
        this.baseCache = baseCache;
        this.config = config;
    }
    // Delegate all standard operations to base cache
    async connect() {
        return this.baseCache.connect();
    }
    async disconnect() {
        return this.baseCache.disconnect();
    }
    async ping() {
        return this.baseCache.ping();
    }
    isConnected() {
        return this.baseCache.isConnected();
    }
    driver() {
        return `versioned:${this.baseCache.driver()}`;
    }
    // ============ Products ============
    async getProduct(handle) {
        return this.baseCache.getProduct(handle);
    }
    async getProductById(gid) {
        return this.baseCache.getProductById(gid);
    }
    async getProductsByHandles(handles) {
        return this.baseCache.getProductsByHandles(handles);
    }
    async getAllProducts() {
        return this.baseCache.getAllProducts();
    }
    async getProductCount() {
        return this.baseCache.getProductCount();
    }
    async setProduct(product) {
        if (this.isStaging && this.currentVersionId) {
            await this.setProductInVersion(this.currentVersionId, product);
        }
        else {
            await this.baseCache.setProduct(product);
        }
    }
    async setProducts(products) {
        if (this.isStaging && this.currentVersionId) {
            let saved = 0;
            for (const product of products) {
                await this.setProductInVersion(this.currentVersionId, product);
                saved++;
            }
            return saved;
        }
        return this.baseCache.setProducts(products);
    }
    async deleteProduct(handle) {
        if (this.isStaging && this.currentVersionId) {
            // In staging, we don't delete - we just don't include in next version
            return true;
        }
        return this.baseCache.deleteProduct(handle);
    }
    async deleteProducts(handles) {
        if (this.isStaging)
            return handles.length; // No-op in staging
        return this.baseCache.deleteProducts(handles);
    }
    async hasProduct(handle) {
        return this.baseCache.hasProduct(handle);
    }
    // ============ Collections ============
    async getCollection(handle) {
        return this.baseCache.getCollection(handle);
    }
    async getCollectionById(gid) {
        return this.baseCache.getCollectionById(gid);
    }
    async getAllCollections() {
        return this.baseCache.getAllCollections();
    }
    async getCollectionCount() {
        return this.baseCache.getCollectionCount();
    }
    async setCollection(collection) {
        if (this.isStaging && this.currentVersionId) {
            await this.setCollectionInVersion(this.currentVersionId, collection);
        }
        else {
            await this.baseCache.setCollection(collection);
        }
    }
    async setCollections(collections) {
        if (this.isStaging && this.currentVersionId) {
            let saved = 0;
            for (const collection of collections) {
                await this.setCollectionInVersion(this.currentVersionId, collection);
                saved++;
            }
            return saved;
        }
        return this.baseCache.setCollections(collections);
    }
    async deleteCollection(handle) {
        if (this.isStaging)
            return true;
        return this.baseCache.deleteCollection(handle);
    }
    async hasCollection(handle) {
        return this.baseCache.hasCollection(handle);
    }
    // ============ Sync State ============
    async getSyncState() {
        return this.baseCache.getSyncState();
    }
    async setSyncState(state) {
        return this.baseCache.setSyncState(state);
    }
    // ============ Catalog Versioning ============
    async beginVersion(versionId) {
        this.currentVersionId = versionId;
        this.isStaging = true;
    }
    async setProductInVersion(versionId, product) {
        // Store in a version-specific namespace
        const key = `version:${versionId}:products:${product.handle}`;
        // We'll use a separate storage mechanism for versioned data
        // For now, store with version prefix
        await this.setVersionedProduct(versionId, product);
    }
    async setCollectionInVersion(versionId, collection) {
        await this.setVersionedCollection(versionId, collection);
    }
    async getProductsFromVersion(versionId) {
        return this.getVersionedProducts(versionId);
    }
    async getCollectionsFromVersion(versionId) {
        return this.getVersionedCollections(versionId);
    }
    async getProductCountForVersion(versionId) {
        const products = await this.getVersionedProducts(versionId);
        return products.length;
    }
    async getCollectionCountForVersion(versionId) {
        const collections = await this.getVersionedCollections(versionId);
        return collections.length;
    }
    async getCatalogVersionMeta(versionId) {
        return this.getVersionMeta(versionId);
    }
    async setCatalogVersionMeta(versionId, meta) {
        return this.setVersionMeta(versionId, meta);
    }
    async finalizeVersion(versionId, hasNextPage) {
        await this.setVersionMeta(versionId, {
            status: 'validated',
            hasNextPage,
            validatedAt: new Date().toISOString(),
        });
    }
    async activateVersion(versionId) {
        // Move version data to active storage
        const products = await this.getVersionedProducts(versionId);
        const collections = await this.getVersionedCollections(versionId);
        // Save to active storage
        for (const product of products) {
            await this.baseCache.setProduct(product);
        }
        for (const collection of collections) {
            await this.baseCache.setCollection(collection);
        }
        // Update active version pointer
        await this.setActiveVersionId(versionId);
    }
    async rollbackVersion() {
        // Implementation depends on previous version tracking
        const previous = await this.getPreviousVersionId();
        if (!previous)
            throw new Error('No previous version available');
        await this.activateVersion(previous);
    }
    async cleanupVersions(retentionCount) {
        // Implementation for cleaning old versions
    }
    async getActiveVersionId() {
        // Use base cache or internal storage
        return this.getActiveVersionIdInternal();
    }
    async setActiveVersionId(versionId) {
        await this.setActiveVersionIdInternal(versionId);
    }
    async listCatalogVersions() {
        return this.getVersionListInternal();
    }
    // ============ Menus ============
    async getMenu(handle) {
        return this.baseCache.getMenu(handle);
    }
    async setMenu(handle, menu) {
        return this.baseCache.setMenu(handle, menu);
    }
    // ============ Meta ============
    async getMeta() {
        return this.baseCache.getMeta();
    }
    async setMeta(meta) {
        return this.baseCache.setMeta(meta);
    }
    // ============ Validation ============
    async setValidationResult(versionId, result) {
        await this.setVersionValidation(versionId, result);
    }
    async getValidationResult(versionId) {
        return this.getVersionValidation(versionId);
    }
    // ============ Low-level ============
    async flush() {
        await this.baseCache.flush();
    }
    async persist() {
        return this.baseCache.persist();
    }
    // ============ Private methods for versioned storage ============
    async setVersionedProduct(versionId, product) {
        const key = `versioned:${versionId}:products:${product.handle}`;
        // Use base cache's low-level storage or maintain internal map
        if ('setVersioned' in this.baseCache) {
            return this.baseCache.setVersioned(key, product);
        }
        // Fallback: store in base cache with version prefix
        await this.baseCache.setMeta({ [key]: product });
    }
    async setVersionedCollection(versionId, collection) {
        if ('setVersioned' in this.baseCache) {
            return this.baseCache.setVersioned(`versioned:${versionId}:collections:${collection.handle}`, collection);
        }
        await this.baseCache.setMeta({ [`versioned:${versionId}:collections:${collection.handle}`]: collection });
    }
    async getVersionedProducts(versionId) {
        // Implementation depends on base cache capabilities
        if ('getVersionedProducts' in this.baseCache) {
            return this.baseCache.getVersionedProducts(versionId);
        }
        return [];
    }
    async getVersionedCollections(versionId) {
        if ('getVersionedCollections' in this.baseCache) {
            return this.baseCache.getVersionedCollections(versionId);
        }
        return [];
    }
    async getVersionMeta(versionId) {
        if ('getVersionMeta' in this.baseCache) {
            return this.baseCache.getVersionMeta(versionId);
        }
        return null;
    }
    async setVersionMeta(versionId, meta) {
        if ('setVersionMeta' in this.baseCache) {
            return this.baseCache.setVersionMeta(versionId, meta);
        }
        return meta;
    }
    async setVersionValidation(versionId, result) {
        if ('setVersionValidation' in this.baseCache) {
            return this.baseCache.setVersionValidation(versionId, result);
        }
    }
    async getVersionValidation(versionId) {
        if ('getVersionValidation' in this.baseCache) {
            return this.baseCache.getVersionValidation(versionId);
        }
        return null;
    }
    // Internal methods for version management
    async getActiveVersionIdInternal() {
        if ('getActiveVersionIdInternal' in this.baseCache) {
            return this.baseCache.getActiveVersionIdInternal();
        }
        return null;
    }
    async setActiveVersionIdInternal(versionId) {
        if ('setActiveVersionIdInternal' in this.baseCache) {
            return this.baseCache.setActiveVersionIdInternal(versionId);
        }
    }
    async getPreviousVersionId() {
        if ('getPreviousVersionId' in this.baseCache) {
            return this.baseCache.getPreviousVersionId();
        }
        return null;
    }
    async getVersionListInternal() {
        if ('getVersionListInternal' in this.baseCache) {
            return this.baseCache.getVersionListInternal();
        }
        return [];
    }
    async setVersionedProduct(versionId, product) {
        // Implemented by specific cache backends
    }
    async setVersionedCollection(versionId, collection) {
        // Implemented by specific cache backends
    }
}
exports.VersionedCache = VersionedCache;
//# sourceMappingURL=versioned-cache.js.map