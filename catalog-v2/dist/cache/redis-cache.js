"use strict";
/**
 * Redis cache implementation for catalog v2
 * Production-grade with connection pooling, pipelining, and graceful degradation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCache = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const KEY_PREFIX = 'nood:catalog:v2:';
class RedisCache {
    client;
    connected = false;
    namespace;
    versionPrefix;
    versionId = null;
    constructor(config) {
        this.namespace = config.namespace || 'nood';
        this.versionPrefix = `${KEY_PREFIX}${this.namespace}:versions:`;
        this.client = new ioredis_1.default(config.redisUrl, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: true,
            retryStrategy: (times) => {
                if (times > 3)
                    return null; // Stop retrying
                return Math.min(times * 200, 2000);
            },
        });
        this.client.on('connect', () => {
            this.connected = true;
            console.log('[Catalog v2 Redis] Connected');
        });
        this.client.on('error', (err) => {
            this.connected = false;
            console.error('[Catalog v2 Redis] Error:', err.message);
        });
        this.client.on('close', () => {
            this.connected = false;
            console.warn('[Catalog v2 Redis] Connection closed');
        });
    }
    async connect() {
        if (!this.connected) {
            await this.client.connect();
            this.connected = true;
        }
    }
    async disconnect() {
        if (this.connected) {
            await this.client.quit();
            this.connected = false;
        }
    }
    async ping() {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        }
        catch {
            return false;
        }
    }
    isConnected() {
        return this.connected && this.client.status === 'ready';
    }
    driver() {
        return 'redis';
    }
    // ============ Key Helpers ============
    p(key) {
        return `${KEY_PREFIX}${this.namespace}:${key}`;
    }
    vp(versionId, part) {
        return `${this.versionPrefix}${versionId}:${part}`;
    }
    vpCurrent(part) {
        if (!this.versionId) {
            throw new Error('No active version - call beginVersion() first');
        }
        return this.vp(this.versionId, part);
    }
    // ============ Products ============
    async getProduct(handle) {
        const key = this.p(`products:${handle}`);
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }
    async getProductById(gid) {
        // Reverse lookup: we maintain a handle->gid index
        const handle = await this.client.get(this.p(`product-gid:${gid}`));
        if (!handle)
            return null;
        return this.getProduct(handle);
    }
    async getProductsByHandles(handles) {
        if (!handles.length)
            return [];
        const keys = handles.map(h => this.p(`products:${h}`));
        const values = await this.client.mget(...keys);
        return values
            .filter((v) => v !== null)
            .map(v => JSON.parse(v));
    }
    async getAllProducts() {
        const products = [];
        const pattern = this.p('products:*');
        for await (const key of this.client.scanStream({ match: pattern, count: 100 })) {
            const data = await this.client.get(key);
            if (data)
                products.push(JSON.parse(data));
        }
        return products;
    }
    async getProductCount() {
        return this.client.scard(this.p('product-handles'));
    }
    async setProduct(product) {
        await this.setProducts([product]);
    }
    async setProducts(products) {
        if (!products.length)
            return 0;
        const pipeline = this.client.pipeline();
        let saved = 0;
        for (const product of products) {
            const key = this.p(`products:${product.handle}`);
            pipeline.set(key, JSON.stringify(product));
            pipeline.sadd(this.p('product-handles'), product.handle);
            pipeline.set(this.p(`product-gid:${product.id}`), product.handle);
            saved++;
        }
        await pipeline.exec();
        return saved;
    }
    async deleteProduct(handle) {
        const key = this.p(`products:${handle}`);
        const gidKey = this.p(`product-gid:${handle}`); // Also delete gid mapping if exists
        const result = await this.client.del(key, gidKey);
        await this.client.srem(this.p('product-handles'), handle);
        return result > 0;
    }
    async deleteProducts(handles) {
        if (!handles.length)
            return 0;
        const keys = handles.map(h => this.p(`products:${h}`));
        const gidKeys = handles.map(h => this.p(`product-gid:${h}`));
        const allKeys = [...keys, ...gidKeys];
        const deleted = await this.client.del(...allKeys);
        await this.client.srem(this.p('product-handles'), ...handles);
        return deleted;
    }
    async hasProduct(handle) {
        return this.client.exists(this.p(`products:${handle}`)) === 1;
    }
    // ============ Collections ============
    async getCollection(handle) {
        const key = this.p(`collections:${handle}`);
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }
    async getCollectionById(gid) {
        const handle = await this.client.get(this.p(`collection-gid:${gid}`));
        if (!handle)
            return null;
        return this.getCollection(handle);
    }
    async getAllCollections() {
        const collections = [];
        const pattern = this.p('collections:*');
        for await (const key of this.client.scanStream({ match: pattern, count: 100 })) {
            const data = await this.client.get(key);
            if (data)
                collections.push(JSON.parse(data));
        }
        return collections;
    }
    async getCollectionCount() {
        return this.client.scard(this.p('collection-handles'));
    }
    async setCollection(collection) {
        await this.setCollections([collection]);
    }
    async setCollections(collections) {
        if (!collections.length)
            return 0;
        const pipeline = this.client.pipeline();
        let saved = 0;
        for (const collection of collections) {
            const key = this.p(`collections:${collection.handle}`);
            pipeline.set(key, JSON.stringify(collection));
            pipeline.sadd(this.p('collection-handles'), collection.handle);
            pipeline.set(this.p(`collection-gid:${collection.id}`), collection.handle);
            saved++;
        }
        await pipeline.exec();
        return saved;
    }
    async deleteCollection(handle) {
        const key = this.p(`collections:${handle}`);
        const result = await this.client.del(key);
        await this.client.srem(this.p('collection-handles'), handle);
        return result > 0;
    }
    async hasCollection(handle) {
        return this.client.exists(this.p(`collections:${handle}`)) === 1;
    }
    // ============ Sync State ============
    async getSyncState() {
        const data = await this.client.get(this.p('sync-state'));
        if (!data)
            return this.defaultSyncState();
        return JSON.parse(data);
    }
    async setSyncState(state) {
        const current = await this.getSyncState();
        const next = { ...current, ...state, updatedAt: new Date().toISOString() };
        await this.client.set(this.p('sync-state'), JSON.stringify(next));
        return next;
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
        this.versionId = versionId;
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
        const pipeline = this.client.pipeline();
        pipeline.set(this.vp(versionId, 'meta'), JSON.stringify(meta));
        pipeline.sadd(this.p('versions'), versionId);
        await pipeline.exec();
    }
    async setProductInVersion(versionId, product) {
        const key = this.vp(versionId, `products:${product.handle}`);
        await this.client.set(key, JSON.stringify(product));
        await this.client.sadd(this.vp(versionId, 'product-handles'), product.handle);
    }
    async setCollectionInVersion(versionId, collection) {
        const key = this.vp(versionId, `collections:${collection.handle}`);
        await this.client.set(key, JSON.stringify(collection));
        await this.client.sadd(this.vp(versionId, 'collection-handles'), collection.handle);
    }
    async getProductsFromVersion(versionId) {
        const handles = await this.client.smembers(this.vp(versionId, 'product-handles'));
        if (!handles.length)
            return [];
        const keys = handles.map(h => this.vp(versionId, `products:${h}`));
        const values = await this.client.mget(...keys);
        return values
            .filter((v) => v !== null)
            .map(v => JSON.parse(v));
    }
    async getCollectionsFromVersion(versionId) {
        const handles = await this.client.smembers(this.vp(versionId, 'collection-handles'));
        if (!handles.length)
            return [];
        const keys = handles.map(h => this.vp(versionId, `collections:${h}`));
        const values = await this.client.mget(...keys);
        return values
            .filter((v) => v !== null)
            .map(v => JSON.parse(v));
    }
    async getProductCountForVersion(versionId) {
        return this.client.scard(this.vp(versionId, 'product-handles'));
    }
    async getCollectionCountForVersion(versionId) {
        return this.client.scard(this.vp(versionId, 'collection-handles'));
    }
    async getCatalogVersionMeta(versionId) {
        const data = await this.client.get(this.vp(versionId, 'meta'));
        return data ? JSON.parse(data) : null;
    }
    async setCatalogVersionMeta(versionId, meta) {
        const current = await this.getCatalogVersionMeta(versionId);
        const next = { ...(current || { versionId }), ...meta, updatedAt: new Date().toISOString() };
        await this.client.set(this.vp(versionId, 'meta'), JSON.stringify(next));
        return next;
    }
    async finalizeVersion(versionId, hasNextPage) {
        const count = await this.getProductCountForVersion(versionId);
        const colCount = await this.getCollectionCountForVersion(versionId);
        await this.setCatalogVersionMeta(versionId, {
            status: 'validated',
            productCount: count,
            collectionCount: colCount,
            hasNextPage,
            validatedAt: new Date().toISOString(),
        });
    }
    async activateVersion(versionId) {
        const currentActive = await this.getActiveVersionId();
        const pipeline = this.client.pipeline();
        pipeline.set(this.p('active-version'), versionId);
        pipeline.set(this.p('previous-version'), currentActive || '');
        // Update meta status
        const versionMeta = await this.getCatalogVersionMeta(versionId);
        if (versionMeta) {
            pipeline.set(this.vp(versionId, 'meta'), JSON.stringify({
                ...versionMeta,
                status: 'active',
                activatedAt: new Date().toISOString(),
            }));
        }
        // Mark previous as superseded
        if (currentActive) {
            const prevMeta = await this.getCatalogVersionMeta(currentActive);
            if (prevMeta) {
                pipeline.set(this.vp(currentActive, 'meta'), JSON.stringify({ ...prevMeta, status: 'superseded', supersededAt: new Date().toISOString() }));
            }
        }
        await pipeline.exec();
    }
    async rollbackVersion() {
        const previous = await this.client.get(this.p('previous-version'));
        if (!previous)
            throw new Error('No previous version available for rollback');
        const currentActive = await this.getActiveVersionId();
        await this.activateVersion(previous);
    }
    async cleanupVersions(retentionCount) {
        const versions = await this.client.smembers(this.p('versions'));
        const metas = await Promise.all(versions.map(v => this.getCatalogVersionMeta(v)));
        const valid = metas.filter(m => m !== null).sort((a, b) => new Date(b.activatedAt || b.startedAt).getTime() - new Date(a.activatedAt || a.startedAt).getTime());
        const toDelete = valid.slice(retentionCount);
        for (const meta of toDelete) {
            if (meta && meta.status !== 'active') {
                const pipeline = this.client.pipeline();
                pipeline.del(this.vp(meta.versionId, 'meta'), this.vp(meta.versionId, 'products:*'), this.vp(meta.versionId, 'collections:*'), this.vp(meta.versionId, 'product-handles'), this.vp(meta.versionId, 'collection-handles'));
                pipeline.srem(this.p('versions'), meta.versionId);
                await pipeline.exec();
            }
        }
    }
    async getActiveVersionId() {
        return this.client.get(this.p('active-version'));
    }
    async setActiveVersionId(versionId) {
        await this.client.set(this.p('active-version'), versionId);
    }
    async listCatalogVersions() {
        return this.client.smembers(this.p('versions'));
    }
    // ============ Menus ============
    async getMenu(handle) {
        const data = await this.client.get(this.p(`menus:${handle}`));
        return data ? JSON.parse(data) : null;
    }
    async setMenu(handle, menu) {
        await this.client.set(this.p(`menus:${handle}`), JSON.stringify(menu));
    }
    // ============ Meta ============
    async getMeta() {
        const data = await this.client.get(this.p('meta'));
        return data ? JSON.parse(data) : {};
    }
    async setMeta(meta) {
        await this.client.set(this.p('meta'), JSON.stringify(meta));
    }
    // ============ Validation ============
    async setValidationResult(versionId, result) {
        await this.client.set(this.vp(versionId, 'validation'), JSON.stringify(result));
    }
    async getValidationResult(versionId) {
        const data = await this.client.get(this.vp(versionId, 'validation'));
        return data ? JSON.parse(data) : null;
    }
    // ============ Low-level ============
    async flush() {
        await this.client.flushall();
    }
    async persist() {
        // Redis persists automatically
    }
    // ============ Menus ============
    async getMenu(handle) {
        const data = await this.client.get(this.p(`menus:${handle}`));
        return data ? JSON.parse(data) : null;
    }
    async setMenu(handle, menu) {
        await this.client.set(this.p(`menus:${handle}`), JSON.stringify(menu));
    }
}
exports.RedisCache = RedisCache;
//# sourceMappingURL=redis-cache.js.map