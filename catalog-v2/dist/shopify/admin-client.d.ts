/**
 * Shopify Admin GraphQL Client for Catalog v2
 * Handles authentication, rate limiting, and query execution
 */
import { ShopifyConfig, GraphQLResponse, PageInfo, AdminProductsPageVariables, AdminCollectionsPageVariables } from '../domain/models';
interface GraphQLResponse<T> {
    data?: T;
    errors?: Array<{
        message: string;
        extensions?: {
            code: string;
        };
    }>;
    extensions?: {
        cost: {
            requestedQueryCost: number;
            throttleStatus: {
                currentlyAvailable: number;
                restoreRate: number;
                maximumAvailable: number;
            };
        };
    };
}
export declare class ShopifyAdminClient {
    private client;
    private config;
    private lastThrottleStatus;
    constructor(config: ShopifyConfig);
    /**
     * Execute a GraphQL query with retry logic and rate limiting
     */
    query<T>(query: string, variables?: Record<string, any>, options?: {
        requestedCost?: number;
        maxRetries?: number;
    }): Promise<GraphQLResponse<T>>;
    /**
     * Fetch a page of products
     */
    fetchProductsPage(variables?: AdminProductsPageVariables): Promise<{
        items: any[];
        pageInfo: PageInfo;
    }>;
    /**
     * Fetch a page of collections
     */
    fetchCollectionsPage(variables?: AdminCollectionsPageVariables): Promise<{
        items: any[];
        pageInfo: PageInfo;
    }>;
    /**
     * Fetch a single product by ID
     */
    fetchProductById(id: string): Promise<any | null>;
    /**
     * Fetch a single collection by ID
     */
    fetchCollectionById(id: string): Promise<any | null>;
    /**
     * Get total product count
     */
    getProductsCount(): Promise<number | null>;
    /**
     * Fetch all products (with pagination)
     */
    fetchAllProducts(options?: {
        pageSize?: number;
        maxPages?: number;
    }): Promise<any[]>;
    /**
     * Fetch all collections (with pagination)
     */
    fetchAllCollections(options?: {
        pageSize?: number;
        maxPages?: number;
    }): Promise<any[]>;
    private isThrottled;
    private getLowBucketWait;
    private calculateThrottleWait;
    private waitForThrottleBucket;
    private isRetryableError;
    private delay;
}
export declare function createShopifyAdminClient(config: ShopifyConfig): ShopifyAdminClient;
export {};
//# sourceMappingURL=admin-client.d.ts.map