/**
 * Cache abstraction layer for catalog v2
 * Supports both Redis (production) and Memory (development/testing)
 */
import { Product, Collection, SyncState, CatalogVersionMeta, ValidationResult } from '../domain/models';
/**
 * Core cache interface - minimal operations needed by catalog
 */
export interface ICache {
    driver(): 'redis' | 'memory';
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    ping(): Promise<boolean>;
    isConnected(): boolean;
    /** Get a single product by handle */
    getProduct(handle: string): Promise<Product | null>;
    /** Get a single product by Shopify GID */
    getProductById(gid: string): Promise<Product | null>;
    /** Get multiple products by handles */
    getProductsByHandles(handles: string[]): Promise<Product[]>;
    /** Get all products (for validation, search indexing) */
    getAllProducts(): Promise<Product[]>;
    /** Get product count */
    getProductCount(): Promise<number>;
    /** Save/update a product */
    setProduct(product: Product): Promise<void>;
    /** Save multiple products */
    setProducts(products: Product[]): Promise<number>;
    /** Delete a product */
    deleteProduct(handle: string): Promise<boolean>;
    /** Delete multiple products */
    deleteProducts(handles: string[]): Promise<number>;
    /** Check if product exists */
    hasProduct(handle: string): Promise<boolean>;
    /** Get a single collection by handle */
    getCollection(handle: string): Promise<Collection | null>;
    /** Get a single collection by Shopify GID */
    getCollectionById(gid: string): Promise<Collection | null>;
    /** Get all collections */
    getAllCollections(): Promise<Collection[]>;
    /** Get collection count */
    getCollectionCount(): Promise<number>;
    /** Save/update a collection */
    setCollection(collection: Collection): Promise<void>;
    /** Save multiple collections */
    setCollections(collections: Collection[]): Promise<number>;
    /** Delete a collection */
    deleteCollection(handle: string): Promise<boolean>;
    /** Check if collection exists */
    hasCollection(handle: string): Promise<boolean>;
    /** Get sync state */
    getSyncState(): Promise<SyncState>;
    /** Update sync state */
    setSyncState(state: Partial<SyncState>): Promise<SyncState>;
    /** Get active catalog version ID */
    getActiveVersionId(): Promise<string | null>;
    /** Set active catalog version ID */
    setActiveVersionId(versionId: string): Promise<void>;
    /** Get catalog version metadata */
    getCatalogVersionMeta(versionId: string): Promise<CatalogVersionMeta | null>;
    /** Set catalog version metadata */
    setCatalogVersionMeta(versionId: string, meta: Partial<CatalogVersionMeta>): Promise<CatalogVersionMeta>;
    /** List all catalog version IDs */
    listCatalogVersions(): Promise<string[]>;
    /** Get a menu by handle */
    getMenu(handle: string): Promise<any | null>;
    /** Save a menu */
    setMenu(handle: string, menu: any): Promise<void>;
    /** Get catalog meta (legacy compatibility) */
    getMeta(): Promise<Record<string, any>>;
    /** Set catalog meta (legacy compatibility) */
    setMeta(meta: Record<string, any>): Promise<void>;
    /** Store validation result */
    setValidationResult(versionId: string, result: ValidationResult): Promise<void>;
    /** Get validation result */
    getValidationResult(versionId: string): Promise<ValidationResult | null>;
    /** Flush pending writes */
    flush?(): Promise<void>;
    /** Persist (for file-based caches) */
    persist?(): Promise<void>;
}
/**
 * Extended cache interface for versioned operations
 */
export interface IVersionedCache extends ICache {
    /** Begin a new catalog version for staging writes */
    beginVersion(versionId: string): Promise<void>;
    /** Write product to specific version */
    setProductInVersion(versionId: string, product: Product): Promise<void>;
    /** Write collection to specific version */
    setCollectionInVersion(versionId: string, collection: Collection): Promise<void>;
    /** Get products from specific version */
    getProductsFromVersion(versionId: string): Promise<Product[]>;
    /** Get collections from specific version */
    getCollectionsFromVersion(versionId: string): Promise<Collection[]>;
    /** Get product count for version */
    getProductCountForVersion(versionId: string): Promise<number>;
    /** Get collection count for version */
    getCollectionCountForVersion(versionId: string): Promise<number>;
    /** Finalize version (mark as ready for validation) */
    finalizeVersion(versionId: string, hasNextPage: boolean): Promise<void>;
    /** Activate version (swap active pointer) */
    activateVersion(versionId: string): Promise<void>;
    /** Rollback to previous version */
    rollbackVersion(): Promise<void>;
    /** Clean up old versions */
    cleanupVersions(retentionCount: number): Promise<void>;
}
/**
 * Cache factory type
 */
export type CacheFactory = (config: CacheConfig) => Promise<ICache>;
export interface CacheConfig {
    driver: 'redis' | 'memory';
    redisUrl?: string;
    namespace?: string;
    keyPrefix?: string;
}
//# sourceMappingURL=interface.d.ts.map