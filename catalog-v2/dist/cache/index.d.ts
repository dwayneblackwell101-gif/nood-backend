/**
 * Cache Factory for Catalog v2
 * Creates the appropriate cache implementation based on environment
 */
import { ICache, CacheConfig, VersionedCacheConfig } from './interface';
import { RedisCache } from './redis-cache';
import { MemoryCache } from './memory-cache';
export interface CacheFactoryOptions extends VersionedCacheConfig {
}
/**
 * Create the appropriate cache implementation based on configuration
 */
export declare function createCache(config: CacheFactoryOptions): Promise<ICache>;
/**
 * Create a MemoryCache directly (for tests)
 */
export declare function createMemoryCache(config: CacheConfig): MemoryCache;
/**
 * Create a RedisCache directly (for production)
 */
export declare function createRedisCache(config: CacheConfig): Promise<RedisCache>;
export { ICache } from './interface';
export { RedisCache } from './redis-cache';
export { MemoryCache } from './memory-cache';
export { VersionedCache } from './versioned-cache';
//# sourceMappingURL=index.d.ts.map