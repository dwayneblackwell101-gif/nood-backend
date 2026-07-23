/**
 * Catalog v2 Factory Module
 * Provides high-level factory functions for creating catalog instances
 */

import { ICache, CacheConfig, VersionedCacheConfig } from './cache';
import { ProductSyncService } from './sync/product-sync';
import { CatalogValidator } from './validation/catalog-validator';
import { ShopifyAdminClient, createShopifyAdminClient } from './shopify/admin-client';
import { ShopifyStorefrontClient, createShopifyStorefrontClient } from './shopify/storefront-client';
import { createCatalogRouter } from './api/routes';
import { ShopifyConfig, SyncState } from './domain/models';

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
  runFullSync(): Promise<{ saved: number; errors: number }>;
  shutdown(): Promise<void>;
}

import { ProductSyncService } from './sync/product-sync';
import { CatalogValidator } from './validation/catalog-validator';
import { createCatalogRouter } from './api/routes';

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

  const { createCache } = await import('./cache');
  const cache = await createCache(cacheConfig);
  await cache.connect();

  // Create Shopify clients
  const shopifyConfig = {
    storeDomain: options.shopify.storeDomain,
    adminToken: options.shopify.adminToken,
    adminApiVersion: options.shopify.adminApiVersion || '2025-10',
    storefrontToken: options.shopify.storefrontToken,
    storefrontApiVersion: options.shopify.storefrontApiVersion || '2025-10',
    currencyCode: 'USD',
    catalogCurrencyCode: 'USD',
  };

  const { createShopifyAdminClient } = await import('./shopify/admin-client');
  const { createShopifyStorefrontClient } = await import('./shopify/storefront-client');
  const adminClient = createShopifyAdminClient(shopifyConfig);
  const storefrontClient = createShopifyStorefrontClient(shopifyConfig);

  // Create services
  const { ProductSyncService } = await import('./sync/product-sync');
  const productSync = new ProductSyncService(adminClient, cache);

  const { CatalogValidator } = await import('./validation/catalog-validator');
  const validator = new CatalogValidator(cache);

  // Create API router
  const { createCatalogRouter } = await import('./api/routes');
  const router = createCatalogRouter({
    cache,
    requireAdminApiKey: () => (req: any, res: any, next: any) => next()
  });

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