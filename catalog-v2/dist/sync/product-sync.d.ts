/**
 * Product Sync Service for Catalog v2
 * Handles syncing products from Shopify Admin API to cache
 */
import { ShopifyAdminClient } from '../shopify/admin-client';
import { ICache } from '../cache/interface';
interface SyncProductOptions {
    pageSize?: number;
    maxPages?: number;
    query?: string;
    onProgress?: (stats: {
        processed: number;
        saved: number;
        errors: number;
    }) => void;
}
interface SyncProductsResult {
    processed: number;
    saved: number;
    errors: number;
    hasNextPage: boolean;
    nextCursor?: string;
    shopifyProductsCount?: number;
}
export declare class ProductSyncService {
    private adminClient;
    private cache;
    constructor(adminClient: ShopifyAdminClient, cache: ICache);
    /**
     * Sync all products from Shopify
     */
    syncAllProducts(options?: SyncProductOptions): Promise<SyncProductsResult>;
    /**
     * Sync a single product by ID (webhook handler)
     */
    syncProductById(adminProductId: string): Promise<void>;
    /**
     * Delete a product from cache
     */
    deleteProduct(handle: string): Promise<void>;
    /**
     * Prune products not in the active set (after full sync)
     */
    pruneProducts(activeHandles: string[]): Promise<number>;
}
export declare function createProductSyncService(adminClient: ShopifyAdminClient, cache: ICache): ProductSyncService;
export {};
//# sourceMappingURL=product-sync.d.ts.map