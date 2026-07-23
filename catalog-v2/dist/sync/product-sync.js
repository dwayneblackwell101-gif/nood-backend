"use strict";
/**
 * Product Sync Service for Catalog v2
 * Handles syncing products from Shopify Admin API to cache
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductSyncService = void 0;
exports.createProductSyncService = createProductSyncService;
const product_1 = require("../transform/product");
class ProductSyncService {
    adminClient;
    cache;
    constructor(adminClient, cache) {
        this.adminClient = adminClient;
        this.cache = cache;
    }
    /**
     * Sync all products from Shopify
     */
    async syncAllProducts(options = {}) {
        const { pageSize = 100, maxPages = 200, query, onProgress } = options;
        let totalProcessed = 0;
        let totalSaved = 0;
        let totalErrors = 0;
        let hasNextPage = true;
        let after;
        let page = 0;
        let shopifyProductsCount;
        // Get total count if available
        try {
            shopifyProductsCount = await this.adminClient.getProductsCount();
        }
        catch {
            // Ignore count errors
        }
        console.log('[Catalog v2 Sync] Starting product sync', {
            shopifyProductsCount,
            pageSize,
            maxPages,
        });
        while (hasNextPage && page < maxPages) {
            try {
                const { items, pageInfo } = await this.adminClient.fetchProductsPage({
                    first: pageSize,
                    after,
                    sortKey: 'UPDATED_AT',
                    reverse: true,
                    query,
                });
                if (!items.length) {
                    console.log('[Catalog v2 Sync] No products in page, ending sync');
                    break;
                }
                // Transform and save products
                let pageSaved = 0;
                for (const adminProduct of items) {
                    try {
                        const product = (0, product_1.transformAdminProduct)(adminProduct);
                        await this.cache.setProduct(product);
                        pageSaved++;
                    }
                    catch (error) {
                        totalErrors++;
                        console.error('[Catalog v2 Sync] Failed to sync product', {
                            productId: adminProduct.id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                totalProcessed += items.length;
                totalSaved += pageSaved;
                if (onProgress) {
                    onProgress({ processed: totalProcessed, saved: totalSaved, errors: totalErrors });
                }
                console.log('[Catalog v2 Sync] Page completed', {
                    page: ++page,
                    itemsInPage: items.length,
                    savedInPage: pageSaved,
                    totalProcessed,
                    totalSaved,
                    totalErrors,
                    hasNextPage: pageInfo.hasNextPage,
                });
                hasNextPage = pageInfo.hasNextPage;
                after = pageInfo.endCursor || undefined;
            }
            catch (error) {
                totalErrors++;
                console.error('[Catalog v2 Sync] Page fetch failed', {
                    page,
                    error: error instanceof Error ? error.message : String(error),
                });
                if (totalErrors > 10) {
                    console.error('[Catalog v2 Sync] Too many errors, aborting');
                    break;
                }
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        return {
            processed: totalProcessed,
            saved: totalSaved,
            errors: totalErrors,
            hasNextPage,
            nextCursor: after,
            shopifyProductsCount,
        };
    }
    /**
     * Sync a single product by ID (webhook handler)
     */
    async syncProductById(adminProductId) {
        const adminProduct = await this.adminClient.fetchProductById(adminProductId);
        if (!adminProduct) {
            console.warn('[Catalog v2 Sync] Product not found in Shopify', { adminProductId });
            return;
        }
        const product = (0, product_1.transformAdminProduct)(adminProduct);
        await this.cache.setProduct(product);
        console.log('[Catalog v2 Sync] Single product synced', { handle: product.handle });
    }
    /**
     * Delete a product from cache
     */
    async deleteProduct(handle) {
        await this.cache.deleteProduct(handle);
        console.log('[Catalog v2 Sync] Product deleted from cache', { handle });
    }
    /**
     * Prune products not in the active set (after full sync)
     */
    async pruneProducts(activeHandles) {
        const allProducts = await this.cache.getAllProducts();
        const activeSet = new Set(activeHandles);
        let removed = 0;
        for (const product of allProducts) {
            if (!activeSet.has(product.handle)) {
                await this.cache.deleteProduct(product.handle);
                removed++;
            }
        }
        console.log('[Catalog v2 Sync] Pruned stale products', { removed });
        return removed;
    }
}
exports.ProductSyncService = ProductSyncService;
function createProductSyncService(adminClient, cache) {
    return new ProductSyncService(adminClient, cache);
}
//# sourceMappingURL=product-sync.js.map