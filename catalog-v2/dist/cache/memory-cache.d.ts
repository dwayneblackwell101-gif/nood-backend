/**
 * In-memory cache implementation for catalog v2
 * Used for development, testing, and CI environments without Redis
 */
import { CacheConfig, IVersionedCache } from './interface';
import { Product, Collection, SyncState, CatalogVersionMeta, ValidationResult } from '../domain/models';
export declare class MemoryCache implements IVersionedCache {
    private products;
    private productGidIndex;
    private collections;
    private collectionGidIndex;
    private productHandles;
    private collectionHandles;
    private menus;
    private syncState;
    private meta;
    private versions;
    private versionIds;
    private activeVersionId;
    private previousVersionId;
    private currentVersionId;
    private validationResults;
    constructor(config: CacheConfig);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    ping(): Promise<boolean>;
    isConnected(): boolean;
    driver(): 'memory';
    private p;
    private vp;
    getProduct(handle: string): Promise<Product | null>;
    getProductById(gid: string): Promise<Product | null>;
    getProductsByHandles(handles: string[]): Promise<Product[]>;
    getAllProducts(): Promise<Product[]>;
    getProductCount(): Promise<number>;
    setProduct(product: Product): Promise<void>;
    setProducts(products: Product[]): Promise<number>;
    deleteProduct(handle: string): Promise<boolean>;
    deleteProducts(handles: string[]): Promise<number>;
    hasProduct(handle: string): Promise<boolean>;
    getCollection(handle: string): Promise<Collection | null>;
    getCollectionById(gid: string): Promise<Collection | null>;
    getAllCollections(): Promise<Collection[]>;
    getCollectionCount(): Promise<number>;
    setCollection(collection: Collection): Promise<void>;
    setCollections(collections: Collection[]): Promise<number>;
    deleteCollection(handle: string): Promise<boolean>;
    hasCollection(handle: string): Promise<boolean>;
    getSyncState(): Promise<SyncState>;
    setSyncState(state: Partial<SyncState>): Promise<SyncState>;
    private defaultSyncState;
    beginVersion(versionId: string): Promise<void>;
    setProductInVersion(versionId: string, product: Product): Promise<void>;
    setCollectionInVersion(versionId: string, collection: Collection): Promise<void>;
    getProductsFromVersion(versionId: string): Promise<Product[]>;
    getCollectionsFromVersion(versionId: string): Promise<Collection[]>;
    getProductCountForVersion(versionId: string): Promise<number>;
    getCollectionCountForVersion(versionId: string): Promise<number>;
    getCatalogVersionMeta(versionId: string): Promise<CatalogVersionMeta | null>;
    setCatalogVersionMeta(versionId: string, meta: Partial<CatalogVersionMeta>): Promise<CatalogVersionMeta>;
    finalizeVersion(versionId: string, hasNextPage: boolean): Promise<void>;
    activateVersion(versionId: string): Promise<void>;
    rollbackVersion(): Promise<void>;
    cleanupVersions(retentionCount: number): Promise<void>;
    getActiveVersionId(): Promise<string | null>;
    setActiveVersionId(versionId: string): Promise<void>;
    listCatalogVersions(): Promise<string[]>;
    getMenu(handle: string): Promise<any | null>;
    setMenu(handle: string, menu: any): Promise<void>;
    getMeta(): Promise<Record<string, any>>;
    setMeta(meta: Record<string, any>): Promise<void>;
    setValidationResult(versionId: string, result: ValidationResult): Promise<void>;
    getValidationResult(versionId: string): Promise<ValidationResult | null>;
    flush(): Promise<void>;
    persist(): Promise<void>;
}
//# sourceMappingURL=memory-cache.d.ts.map