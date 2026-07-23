/**
 * Catalog v2 - Main Entry Point
 *
 * This module provides the new catalog implementation that runs alongside v1.
 * It uses TypeScript for domain models but can be consumed by JavaScript.
 */
export { createCache, ICache, CacheConfig, VersionedCacheConfig } from './cache';
export { ProductSyncService } from './sync/product-sync';
export type { Product, ProductVariant, Image, Media, Collection, SyncState, CatalogVersionMeta, ValidationResult, ShopifyConfig, CacheConfig, VersionedCacheConfig, } from './domain/models';
export { transformAdminProduct, transformAdminCollection } from './transform';
export { ShopifyAdminClient, createShopifyAdminClient } from './shopify/admin-client';
export { ShopifyStorefrontClient, createShopifyStorefrontClient } from './shopify/storefront-client';
export { createCatalogRouter } from './api/routes';
export { CatalogValidator, ValidationContext } from './validation/catalog-validator';
export { RedisCache, createRedisCache } from './cache/redis-cache';
export { MemoryCache, createMemoryCache } from './cache/memory-cache';
export { VersionedCache } from './cache/versioned-cache';
export { createCatalog } from './factory';
/**
 * Create a complete catalog v2 instance
 */
export interface CreateCatalogOptions {
    /** Shopify configuration */
    shopify: {
        storeDomain: string;
        adminToken: string;
        adminApiVersion?: string;
        storefrontToken: string;
        storefrontApiVersion?: string;
    };
    /** Cache configuration */
    cache: {
        driver: 'redis' | 'memory';
        redisUrl?: string;
        namespace?: string;
    };
    /** Sync configuration */
    sync?: {
        pageSize?: number;
        maxPages?: number;
        syncMenus?: boolean;
    };
}
/**
 * Main factory function to create catalog v2 instance
 */
import { ICache } from './cache';
import { ShopifyAdminClient } from './shopify/admin-client';
import { ShopifyStorefrontClient } from './shopify/storefront-client';
import { ProductSyncService } from './sync/product-sync';
import { CatalogValidator } from './validation/catalog-validator';
import { createCatalogRouter } from './api/routes';
import { SyncState } from './domain/models';
export interface CatalogInstance {
    cache: ICache;
    adminClient: ShopifyAdminClient;
    storefrontClient: ShopifyStorefrontClient;
    productSync: ProductSyncService;
    validator: CatalogValidator;
    router: ReturnType<typeof createCatalogRouter>;
    /** Start background sync */
    startSync(): Promise<void>;
    /** Get sync status */
    getSyncStatus(): Promise<SyncState>;
    /** Manually trigger full sync */
    runFullSync(): Promise<{
        saved: number;
        errors: number;
    }>;
    /** Shutdown */
    shutdown(): Promise<void>;
}
export declare function createCatalog(options: CreateCatalogOptions): Promise<CatalogInstance>;
//# sourceMappingURL=index.d.ts.map