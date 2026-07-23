/**
 * Cache Factory for Catalog v2
 * Creates the appropriate cache implementation based on environment
 */

import { ICache, CacheConfig, VersionedCacheConfig } from './interface';
import { RedisCache } from './redis-cache';
import { MemoryCache } from './memory-cache';
import { VersionedCache } from './versioned-cache';

export interface CacheFactoryOptions extends VersionedCacheConfig {
  // Additional options for cache creation
}

/**
 * Create the appropriate cache implementation based on configuration
 */
export async function createCache(config: CacheFactoryOptions): Promise<ICache> {
  const hasRedis = !!config.redisUrl;
  const isTest = config.environment === 'test';
  const forceMemory = process.env.NOOD_CATALOG_FORCE_JSON === '1';

  let baseCache: ICache;

  if (hasRedis && !isTest && !forceMemory) {
    console.log('[Catalog v2] Using Redis cache');
    baseCache = new RedisCache(config);
    await baseCache.connect();
  } else {
    console.log('[Catalog v2] Using Memory cache (Redis not configured, test mode, or forced)');
    baseCache = new MemoryCache(config);
    await baseCache.connect();
  }

  // Wrap with versioned cache for catalog versioning support
  return new VersionedCache(baseCache, config);
}

/**
 * Create a MemoryCache directly (for tests)
 */
export function createMemoryCache(config: CacheConfig): MemoryCache {
  return new MemoryCache(config);
}

/**
 * Create a RedisCache directly (for production)
 */
export async function createRedisCache(config: CacheConfig): Promise<RedisCache> {
  const cache = new RedisCache(config);
  await cache.connect();
  return cache;
}

// Re-export for convenience
export { ICache } from './interface';
export { RedisCache } from './redis-cache';
export { MemoryCache } from './memory-cache';
export { VersionedCache } from './versioned-cache';