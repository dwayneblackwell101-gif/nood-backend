/**
 * Catalog v2 - Main Entry Point
 *
 * This module provides the new catalog implementation that runs alongside v1.
 * It uses TypeScript for domain models but can be consumed by JavaScript.
 */

// Cache
export { createCache, ICache, CacheConfig, VersionedCacheConfig } from './cache';
export { ProductSyncService } from './sync/product-sync';

// Domain
export type {
  Product,
  ProductVariant,
  Image,
  Media,
  Collection,
  SyncState,
  CatalogVersionMeta,
  ValidationResult,
  ShopifyConfig,
  CacheConfig,
  VersionedCacheConfig,
} from './domain/models';

// Transformers
export { transformAdminProduct, transformAdminCollection } from './transform';

// Shopify Clients
export { ShopifyAdminClient, createShopifyAdminClient } from './shopify/admin-client';
export { ShopifyStorefrontClient, createShopifyStorefrontClient } from './shopify/storefront-client';

// API Routes (for Express)
export { createCatalogRouter } from './api/routes';

// Validation
export { CatalogValidator, ValidationContext } from './validation/catalog-validator';

// Re-export cache implementations
export { RedisCache, createRedisCache } from './cache/redis-cache';
export { MemoryCache, createMemoryCache } from './cache/memory-cache';
export { VersionedCache } from './cache/versioned-cache';

// Factory
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
import { createCache, ICache, CacheConfig } from './cache';
import { ShopifyAdminClient, createShopifyAdminClient } from './shopify/admin-client';
import { ShopifyStorefrontClient, createShopifyStorefrontClient } from './shopify/storefront-client';
import { ProductSyncService } from './sync/product-sync';
import { CatalogValidator } from './validation/catalog-validator';
import { createCatalogRouter } from './api/routes';
import { ShopifyConfig, SyncState } from './domain/models';

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
  runFullSync(): Promise<{ saved: number; errors: number }>;

  /** Shutdown */
  shutdown(): Promise<void>;
}

export async function createCatalog(options: CreateCatalogOptions): Promise<CatalogInstance> {
  // Validate required config
  if (!options.shopify?.storeDomain || !options.shopify?.adminToken) {
    throw new Error('Missing required Shopify config: storeDomain and adminToken');
  }
  if (!options.shopify?.storefrontToken) {
    throw new Error('Missing required Shopify config: storefrontToken');
  }

  // Create cache
  const cacheConfig: CacheConfig = {
    driver: options.cache.driver,
    redisUrl: options.cache.redisUrl,
    namespace: options.cache.namespace || 'nood',
    environment: process.env.NODE_ENV || 'development',
  };

  const cache = await createCache(cacheConfig);
  await cache.connect();

  // Create Shopify clients
  const shopifyConfig: ShopifyConfig = {
    storeDomain: options.shopify.storeDomain,
    adminToken: options.shopify.adminToken,
    adminApiVersion: options.shopify.adminApiVersion || '2025-10',
    storefrontToken: options.shopify.storefrontToken,
    storefrontApiVersion: options.shopify.storefrontApiVersion || '2025-10',
    currencyCode: 'USD',
    catalogCurrencyCode: 'USD',
  };

  const adminClient = createShopifyAdminClient(shopifyConfig);
  const storefrontClient = createShopifyStorefrontClient(shopifyConfig);

  // Create services
  const productSync = new ProductSyncService(adminClient, cache);
  const validator = new CatalogValidator(cache);

  // Create API router
  const router = createCatalogRouter({ cache, requireAdminApiKey: () => (req, res, next) => next() });

  // Create catalog instance
  const catalog: CatalogInstance = {
    cache,
    adminClient,
    storefrontClient,
    productSync,
    validator,
    router,

    async startSync() {
      console.log('[Catalog v2] Starting background sync...');
      const result = await productSync.syncAllProducts({
        pageSize: options.sync?.pageSize || 100,
        maxPages: options.sync?.maxPages || 200,
        onProgress: (stats) => {
          console.log('[Catalog v2 Sync]', stats);
        }
      });
      console.log('[Catalog v2] Initial sync completed', result);
    },

    async getSyncStatus() {
      return cache.getSyncState();
    },

    async runFullSync() {
      return productSync.syncAllProducts({
        pageSize: options.sync?.pageSize || 100,
        maxPages: options.sync?.maxPages || 200,
      });
    },

    async shutdown() {
      console.log('[Catalog v2] Shutting down...');
      await cache.disconnect();
      console.log('[Catalog v2] Shutdown complete');
    },
  };

  return catalog;
}