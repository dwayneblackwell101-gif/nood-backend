/**
 * Catalog v2 Factory Module
 * Provides high-level factory functions for creating catalog instances
 */
import { ICache } from './cache';
import { ProductSyncService } from './sync/product-sync';
import { CatalogValidator } from './validation/catalog-validator';
import { ShopifyAdminClient } from './shopify/admin-client';
import { ShopifyStorefrontClient } from './shopify/storefront-client';
import { createCatalogRouter } from './api/routes';
import { SyncState } from './domain/models';
export interface CreateCatalogOptions {
    shopify: {
        storeDomain: string;
        adminToken: string;
        adminApiVersion?: string;
        storefrontToken: string;
        storefrontApiVersion?: string;
    };
    cache: {
        driver: 'redis' | 'memory';
        redisUrl?: string;
        namespace?: string;
    };
    sync?: {
        pageSize?: number;
        maxPages?: number;
        syncMenus?: boolean;
    };
}
export interface CatalogInstance {
    cache: ICache;
    adminClient: ShopifyAdminClient;
    storefrontClient: ShopifyStorefrontClient;
    productSync: ProductSyncService;
    validator: CatalogValidator;
    router: ReturnType<typeof createCatalogRouter>;
    startSync(): Promise<void>;
    getSyncStatus(): Promise<SyncState>;
    runFullSync(): Promise<{
        saved: number;
        errors: number;
    }>;
    shutdown(): Promise<void>;
}
export declare function createCatalog(options: CreateCatalogOptions): Promise<CatalogInstance>;
//# sourceMappingURL=factory.d.ts.map