"use strict";
/**
 * Catalog v2 - Main Entry Point
 *
 * This module provides the new catalog implementation that runs alongside v1.
 * It uses TypeScript for domain models but can be consumed by JavaScript.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionedCache = exports.createMemoryCache = exports.MemoryCache = exports.createRedisCache = exports.RedisCache = exports.CatalogValidator = exports.createCatalogRouter = exports.createShopifyStorefrontClient = exports.ShopifyStorefrontClient = exports.createShopifyAdminClient = exports.ShopifyAdminClient = exports.transformAdminCollection = exports.transformAdminProduct = exports.ProductSyncService = exports.VersionedCacheConfig = exports.CacheConfig = exports.createCache = void 0;
exports.createCatalog = createCatalog;
// Cache
var cache_1 = require("./cache");
Object.defineProperty(exports, "createCache", { enumerable: true, get: function () { return cache_1.createCache; } });
Object.defineProperty(exports, "CacheConfig", { enumerable: true, get: function () { return cache_1.CacheConfig; } });
Object.defineProperty(exports, "VersionedCacheConfig", { enumerable: true, get: function () { return cache_1.VersionedCacheConfig; } });
var product_sync_1 = require("./sync/product-sync");
Object.defineProperty(exports, "ProductSyncService", { enumerable: true, get: function () { return product_sync_1.ProductSyncService; } });
// Transformers
var transform_1 = require("./transform");
Object.defineProperty(exports, "transformAdminProduct", { enumerable: true, get: function () { return transform_1.transformAdminProduct; } });
Object.defineProperty(exports, "transformAdminCollection", { enumerable: true, get: function () { return transform_1.transformAdminCollection; } });
// Shopify Clients
var admin_client_1 = require("./shopify/admin-client");
Object.defineProperty(exports, "ShopifyAdminClient", { enumerable: true, get: function () { return admin_client_1.ShopifyAdminClient; } });
Object.defineProperty(exports, "createShopifyAdminClient", { enumerable: true, get: function () { return admin_client_1.createShopifyAdminClient; } });
var storefront_client_1 = require("./shopify/storefront-client");
Object.defineProperty(exports, "ShopifyStorefrontClient", { enumerable: true, get: function () { return storefront_client_1.ShopifyStorefrontClient; } });
Object.defineProperty(exports, "createShopifyStorefrontClient", { enumerable: true, get: function () { return storefront_client_1.createShopifyStorefrontClient; } });
// API Routes (for Express)
var routes_1 = require("./api/routes");
Object.defineProperty(exports, "createCatalogRouter", { enumerable: true, get: function () { return routes_1.createCatalogRouter; } });
// Validation
var catalog_validator_1 = require("./validation/catalog-validator");
Object.defineProperty(exports, "CatalogValidator", { enumerable: true, get: function () { return catalog_validator_1.CatalogValidator; } });
// Re-export cache implementations
var redis_cache_1 = require("./cache/redis-cache");
Object.defineProperty(exports, "RedisCache", { enumerable: true, get: function () { return redis_cache_1.RedisCache; } });
Object.defineProperty(exports, "createRedisCache", { enumerable: true, get: function () { return redis_cache_1.createRedisCache; } });
var memory_cache_1 = require("./cache/memory-cache");
Object.defineProperty(exports, "MemoryCache", { enumerable: true, get: function () { return memory_cache_1.MemoryCache; } });
Object.defineProperty(exports, "createMemoryCache", { enumerable: true, get: function () { return memory_cache_1.createMemoryCache; } });
var versioned_cache_1 = require("./cache/versioned-cache");
Object.defineProperty(exports, "VersionedCache", { enumerable: true, get: function () { return versioned_cache_1.VersionedCache; } });
// Factory
var factory_1 = require("./factory");
Object.defineProperty(exports, "createCatalog", { enumerable: true, get: function () { return factory_1.createCatalog; } });
/**
 * Main factory function to create catalog v2 instance
 */
const cache_2 = require("./cache");
const admin_client_2 = require("./shopify/admin-client");
const storefront_client_2 = require("./shopify/storefront-client");
const product_sync_2 = require("./sync/product-sync");
const catalog_validator_2 = require("./validation/catalog-validator");
const routes_2 = require("./api/routes");
async function createCatalog(options) {
    // Validate required config
    if (!options.shopify?.storeDomain || !options.shopify?.adminToken) {
        throw new Error('Missing required Shopify config: storeDomain and adminToken');
    }
    if (!options.shopify?.storefrontToken) {
        throw new Error('Missing required Shopify config: storefrontToken');
    }
    // Create cache
    const cacheConfig = {
        driver: options.cache.driver,
        redisUrl: options.cache.redisUrl,
        namespace: options.cache.namespace || 'nood',
        environment: process.env.NODE_ENV || 'development',
    };
    const cache = await (0, cache_2.createCache)(cacheConfig);
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
    const adminClient = (0, admin_client_2.createShopifyAdminClient)(shopifyConfig);
    const storefrontClient = (0, storefront_client_2.createShopifyStorefrontClient)(shopifyConfig);
    // Create services
    const productSync = new product_sync_2.ProductSyncService(adminClient, cache);
    const validator = new catalog_validator_2.CatalogValidator(cache);
    // Create API router
    const router = (0, routes_2.createCatalogRouter)({ cache, requireAdminApiKey: () => (req, res, next) => next() });
    // Create catalog instance
    const catalog = {
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
//# sourceMappingURL=index.js.map