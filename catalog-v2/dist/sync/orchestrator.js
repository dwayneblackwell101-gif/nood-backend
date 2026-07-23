"use strict";
/**
 * Catalog Sync Orchestrator for v2
 * Coordinates the full sync process: products -> collections -> validation -> activation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatalogSyncOrchestrator = void 0;
exports.createCatalogSyncOrchestrator = createCatalogSyncOrchestrator;
const product_sync_1 = require("./product-sync");
const validator_1 = require("./validator");
const transform_1 = require("../transform");
class CatalogSyncOrchestrator {
    adminClient;
    cache;
    productSync;
    validator;
    currentVersionId = null;
    syncId = null;
    abortController = new AbortController();
    constructor(adminClient, cache) {
        this.adminClient = adminClient;
        this.cache = cache;
        this.productSync = (0, product_sync_1.createProductSyncService)(adminClient, cache);
        this.validator = (0, validator_1.createCatalogValidator)(cache);
    }
    /**
     * Execute a full catalog sync
     */
    async sync(options = {}) {
        const { pageSize = 100, maxPages = 200, forceFullSync = false } = options;
        try {
            // Check if sync is already running
            const currentState = await this.cache.getSyncState();
            if (currentState.status === 'running' && !forceFullSync) {
                return {
                    success: false,
                    versionId: '',
                    productCount: 0,
                    collectionCount: 0,
                    error: 'Sync already in progress',
                };
            }
            // Begin new catalog version
            this.currentVersionId = `catalog_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
            this.syncId = `sync_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
            console.log(`[Catalog v2 Sync] Starting sync ${this.syncId}`, {
                versionId: this.currentVersionId,
                pageSize,
                maxPages,
            });
            await this.cache.beginVersion(this.currentVersionId);
            // Initialize sync state
            await this.cache.setSyncState({
                status: 'running',
                phase: 'products',
                syncId: this.syncId,
                versionId: this.currentVersionId,
                startedAt: new Date().toISOString(),
            });
            // Phase 1: Sync Products
            const productResult = await this.syncProducts({ pageSize, maxPages });
            console.log(`[Catalog v2 Sync] Products phase complete`, productResult);
            // Phase 2: Sync Collections
            await this.cache.setSyncState({ phase: 'collections' });
            const collectionResult = await this.syncCollections();
            console.log(`[Catalog v2 Sync] Collections phase complete`, collectionResult);
            // Phase 3: Reconcile collection-product relationships
            await this.reconcileCollections();
            // Phase 4: Validate
            await this.cache.setSyncState({ phase: 'validating', status: 'validating' });
            const validation = await this.validate(this.currentVersionId);
            if (!validation.ok) {
                await this.cache.setSyncState({
                    status: 'failed',
                    lastError: validation.errors.map(e => e.message).join('; '),
                });
                return {
                    success: false,
                    versionId: this.currentVersionId,
                    productCount: validation.productCount,
                    collectionCount: validation.collectionCount,
                    validation,
                    error: validation.errors.map(e => e.message).join('; '),
                };
            }
            // Phase 5: Finalize and activate
            await this.cache.finalizeVersion(this.currentVersionId, false);
            await this.activateVersion(this.currentVersionId);
            console.log(`[Catalog v2 Sync] Sync ${this.syncId} completed successfully`, {
                versionId: this.currentVersionId,
                products: validation.productCount,
                collections: validation.collectionCount,
            });
            await this.cache.setSyncState({
                status: 'completed',
                phase: 'completed',
                completedAt: new Date().toISOString(),
            });
            return {
                success: true,
                versionId: this.currentVersionId,
                productCount: validation.productCount,
                collectionCount: validation.collectionCount,
                validation,
            };
        }
        catch (error) {
            console.error(`[Catalog v2 Sync] Sync failed`, error);
            await this.cache.setSyncState({
                status: 'failed',
                lastError: error.message,
            });
            return {
                success: false,
                versionId: this.currentVersionId || '',
                productCount: 0,
                collectionCount: 0,
                error: error.message,
            };
        }
    }
    /**
     * Phase 1: Sync all products from Shopify
     */
    async syncProducts(options) {
        let synced = 0;
        let pages = 0;
        let after = null;
        let totalPages = 0;
        // Get total product count from Shopify for progress tracking
        const shopifyCount = await this.productSync.adminClient.getProductsCount();
        console.log(`[Catalog v2 Sync] Shopify reports ${shopifyCount} products`);
        while (totalPages < options.maxPages) {
            if (this.abortController.signal.aborted) {
                throw new Error('Sync aborted');
            }
            const { items: products, pageInfo } = await this.productSync.adminClient.fetchProductsPage({
                first: options.pageSize,
                after,
                sortKey: 'UPDATED_AT',
                reverse: true,
            });
            if (!products.length && !pageInfo.hasNextPage)
                break;
            // Transform and save products
            const transformedProducts = transformAdminProducts(products);
            await this.cache.setProducts(transformedProducts);
            // Save to versioned storage
            for (const product of transformedProducts) {
                await this.cache.setProductInVersion(this.currentVersionId, product);
            }
            synced += transformedProducts.length;
            pages++;
            totalPages++;
            console.log(`[Catalog v2 Sync] Page ${pages}: synced ${transformedProducts.length} products (total: ${synced})`);
            if (!pageInfo.hasNextPage)
                break;
            after = pageInfo.endCursor;
        }
        return { synced, pages };
    }
    /**
     * Phase 2: Sync all collections from Shopify
     */
    async syncCollections() {
        let synced = 0;
        let pages = 0;
        let after = null;
        while (true) {
            const { items: collections, pageInfo } = await this.productSync.adminClient.fetchCollectionsPage({
                first: 100,
                after,
                sortKey: 'UPDATED_AT',
                reverse: true,
            });
            if (!collections.length && !pageInfo.hasNextPage)
                break;
            // Transform and save
            const transformed = collections.map(transform_1.transformAdminCollection);
            await this.cache.setCollections(transformed);
            // Save to versioned storage
            for (const collection of transformed) {
                await this.cache.setCollectionInVersion(this.currentVersionId, collection);
            }
            synced += transformed.length;
            pages++;
            if (!pageInfo.hasNextPage)
                break;
            after = pageInfo.endCursor;
        }
        return { synced, pages };
    }
    /**
     * Phase 3: Reconcile collection-product relationships
     */
    async reconcileCollections() {
        const collections = await this.cache.getAllCollections();
        const products = await this.cache.getAllProducts();
        const productHandleSet = new Set(products.map(p => p.handle));
        for (const collection of collections) {
            // Filter product handles to only those that exist
            const validHandles = collection.productHandles?.filter((h) => productHandleSet.has(h)) || [];
            if (validHandles.length !== (collection.productHandles?.length || 0)) {
                await this.cache.setCollection({
                    ...collection,
                    productHandles: validHandles,
                });
            }
        }
    }
    /**
     * Phase 4: Validate the catalog
     */
    async validate(versionId) {
        const products = await this.cache.getAllProducts();
        const collections = await this.cache.getAllCollections();
        return this.validator.validate(versionId, {
            versionId,
            shopifyProductsCount: await this.productSync.adminClient.getProductsCount(),
            shopifyCollectionsCount: await this.productSync.adminClient.getProductsCount(), // TODO: get collections count
            minProductCount: 1,
            maxDropPercent: 50,
        });
    }
    /**
     * Phase 5: Activate the version
     */
    async activateVersion(versionId) {
        await this.cache.activateVersion(versionId);
    }
    /**
     * Abort the current sync
     */
    abort() {
        this.abortController.abort();
    }
    /**
     * Get current sync status
     */
    async getStatus() {
        const state = await this.cache.getSyncState();
        return { ...state, versionId: this.currentVersionId || undefined };
    }
}
exports.CatalogSyncOrchestrator = CatalogSyncOrchestrator;
function createCatalogSyncOrchestrator(adminClient, cache) {
    return new CatalogSyncOrchestrator(adminClient, cache);
}
//# sourceMappingURL=orchestrator.js.map