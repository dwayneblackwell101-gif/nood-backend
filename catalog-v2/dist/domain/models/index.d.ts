/**
 * Core Domain Models for Catalog v2
 * These are the single source of truth for product data structures
 */
export interface Money {
    amount: string;
    currencyCode: string;
}
export interface PriceRange {
    minVariantPrice: Money;
    maxVariantPrice: Money;
}
export interface Weight {
    value: number;
    unit: 'g' | 'kg' | 'oz' | 'lb';
}
export interface Image {
    id: string;
    url: string;
    altText: string | null;
    width: number | null;
    height: number | null;
    src?: string;
}
export interface Media {
    id: string;
    mediaContentType: 'IMAGE' | 'VIDEO' | 'EXTERNAL_VIDEO' | 'MODEL_3D';
    image?: Image;
    previewImage?: Image;
    sources?: MediaSource[];
    embedUrl?: string;
    originUrl?: string;
    filesize?: number;
}
export interface MediaSource {
    url: string;
    mimeType: string;
    format: string;
    height?: number;
    width?: number;
}
export type MediaConnection = {
    edges: Array<{
        node: Media;
    }>;
    pageInfo: PageInfo;
};
export interface ImageConnection {
    edges: Array<{
        node: Image;
    }>;
    pageInfo: PageInfo;
}
export interface SelectedOption {
    name: string;
    value: string;
}
export interface ProductVariant {
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: Money;
    compareAtPrice: Money | null;
    availableForSale: boolean;
    quantityAvailable: number;
    currentlyNotInStock: boolean;
    selectedOptions: SelectedOption[];
    media?: MediaConnection;
    image?: Image;
    inventoryQuantity: number;
    inventoryPolicy: 'DENY' | 'CONTINUE';
    weight?: Weight;
    taxable: boolean;
    taxCode?: string;
    requiresShipping: boolean;
}
export interface ProductOption {
    id: string;
    name: string;
    values: string[];
}
export interface Product {
    id: string;
    title: string;
    handle: string;
    descriptionHtml: string;
    description: string;
    vendor: string;
    productType: string;
    tags: string[];
    status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
    availableForSale: boolean;
    featuredImage: Image | null;
    images: ImageConnection;
    media: MediaConnection;
    priceRange: PriceRange;
    compareAtPriceRange: PriceRange | null;
    variants: {
        edges: Array<{
            node: ProductVariant;
        }>;
    };
    collections: {
        edges: Array<{
            node: {
                id: string;
                handle: string;
                title: string;
            };
        }>;
    };
    options: ProductOption[];
    seo: {
        title: string | null;
        description: string | null;
    };
    totalInventory: number;
    createdAt: string;
    updatedAt: string;
    publishedAt: string | null;
    _syncedAt?: string;
    _version?: string;
}
export interface ProductConnection {
    edges: Array<{
        node: Product;
    }>;
    pageInfo: PageInfo;
}
export interface Collection {
    id: string;
    title: string;
    handle: string;
    descriptionHtml: string;
    description: string;
    image: Image | null;
    products: ProductConnection;
    updatedAt: string;
    seo: {
        title: string | null;
        description: string | null;
    };
    sortOrder: 'MANUAL' | 'BEST_SELLING' | 'TITLE_ASCENDING' | 'TITLE_DESCENDING' | 'PRICE_ASCENDING' | 'PRICE_DESCENDING' | 'CREATED' | 'CREATED_DESCENDING';
    rules?: CollectionRule[];
}
export interface CollectionRule {
    column: 'TITLE' | 'TYPE' | 'VENDOR' | 'PRICE' | 'TAG' | 'VARIANT_COMPARE_AT_PRICE' | 'VARIANT_INVENTORY' | 'VARIANT_PRICE';
    relation: 'EQUALS' | 'NOT_EQUALS' | 'GREATER_THAN' | 'LESS_THAN' | 'CONTAINS' | 'NOT_CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH';
    condition: string;
}
export interface CollectionConnection {
    edges: Array<{
        node: Collection;
    }>;
    pageInfo: PageInfo;
}
export interface InventoryItem {
    id: string;
    sku: string | null;
    tracked: boolean;
    unitCost: Money | null;
}
export interface InventoryLevel {
    id: string;
    available: number;
    location: {
        id: string;
        name: string;
    };
}
export interface PageInfo {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
}
export interface SyncState {
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'validating' | 'activating';
    phase?: 'products' | 'collections' | 'menus' | 'validating' | 'activating';
    productCursor?: string | null;
    collectionCursor?: string | null;
    productsCompleted?: boolean;
    syncedProductCount: number;
    syncedCollectionCount: number;
    shopifyProductsCount?: number | null;
    startedAt?: string | null;
    updatedAt?: string | null;
    completedAt?: string | null;
    lastError?: string | null;
    message?: string | null;
    chunkPages?: number | null;
    chunkPageSize?: number | null;
}
export interface CatalogVersionMeta {
    versionId: string;
    syncId: string;
    status: 'running' | 'validated' | 'active' | 'superseded' | 'failed' | 'abandoned';
    schemaVersion: string;
    startedAt: string;
    updatedAt: string;
    productCount: number;
    collectionCount: number;
    hasNextPage: boolean;
    source: string;
    validatedAt?: string;
    activatedAt?: string;
    supersededAt?: string;
    validation?: ValidationResult;
    previousActiveVersion?: string | null;
}
export interface ValidationResult {
    ok: boolean;
    versionId: string;
    productCount: number;
    collectionCount: number;
    schemaVersion: string;
    validatedAt: string;
    errors: ValidationError[];
    warnings: ValidationWarning[];
}
export interface ValidationError {
    code: string;
    message: string;
    path?: string;
}
export interface ValidationWarning {
    code: string;
    message: string;
    path?: string;
}
export interface ShopifyConfig {
    storeDomain: string;
    adminToken: string;
    adminApiVersion: string;
    storefrontToken: string;
    storefrontApiVersion: string;
    currencyCode: string;
    catalogCurrencyCode: string;
}
export interface AdminProductsPageVariables {
    first?: number;
    after?: string;
    sortKey?: 'UPDATED_AT' | 'CREATED_AT' | 'TITLE' | 'PRICE' | 'BEST_SELLING';
    reverse?: boolean;
    query?: string;
}
export interface AdminCollectionsPageVariables {
    first?: number;
    after?: string;
    sortKey?: 'UPDATED_AT' | 'CREATED_AT' | 'TITLE' | 'ID';
    reverse?: boolean;
    query?: string;
}
export interface CacheConfig {
    driver: 'redis' | 'memory';
    redisUrl?: string;
    namespace?: string;
    keyPrefix?: string;
    environment?: string;
}
export interface VersionedCacheConfig extends CacheConfig {
    versionRetentionCount?: number;
}
export interface SyncConfig {
    maxPages?: number;
    pageSize?: number;
    syncMenus?: boolean;
    fullSync?: boolean;
    forceResume?: boolean;
}
//# sourceMappingURL=index.d.ts.map