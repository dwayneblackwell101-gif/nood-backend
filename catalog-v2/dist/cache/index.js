"use strict";
/**
 * Cache Factory for Catalog v2
 * Creates the appropriate cache implementation based on environment
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionedCache = exports.MemoryCache = exports.RedisCache = void 0;
exports.createCache = createCache;
exports.createMemoryCache = createMemoryCache;
exports.createRedisCache = createRedisCache;
const redis_cache_1 = require("./redis-cache");
const memory_cache_1 = require("./memory-cache");
const versioned_cache_1 = require("./versioned-cache");
/**
 * Create the appropriate cache implementation based on configuration
 */
async function createCache(config) {
    const hasRedis = !!config.redisUrl;
    const isTest = config.environment === 'test';
    const forceMemory = process.env.NOOD_CATALOG_FORCE_JSON === '1';
    let baseCache;
    if (hasRedis && !isTest && !forceMemory) {
        console.log('[Catalog v2] Using Redis cache');
        baseCache = new redis_cache_1.RedisCache(config);
        await baseCache.connect();
    }
    else {
        console.log('[Catalog v2] Using Memory cache (Redis not configured, test mode, or forced)');
        baseCache = new memory_cache_1.MemoryCache(config);
        await baseCache.connect();
    }
    // Wrap with versioned cache for catalog versioning support
    return new versioned_cache_1.VersionedCache(baseCache, config);
}
/**
 * Create a MemoryCache directly (for tests)
 */
function createMemoryCache(config) {
    return new memory_cache_1.MemoryCache(config);
}
/**
 * Create a RedisCache directly (for production)
 */
async function createRedisCache(config) {
    const cache = new redis_cache_1.RedisCache(config);
    await cache.connect();
    return cache;
}
var redis_cache_2 = require("./redis-cache");
Object.defineProperty(exports, "RedisCache", { enumerable: true, get: function () { return redis_cache_2.RedisCache; } });
var memory_cache_2 = require("./memory-cache");
Object.defineProperty(exports, "MemoryCache", { enumerable: true, get: function () { return memory_cache_2.MemoryCache; } });
var versioned_cache_2 = require("./versioned-cache");
Object.defineProperty(exports, "VersionedCache", { enumerable: true, get: function () { return versioned_cache_2.VersionedCache; } });
//# sourceMappingURL=index.js.map