/**
 * Shopify Storefront GraphQL Client for Catalog v2
 * Used for real-time product hydrate fallback
 */
import { ShopifyConfig, GraphQLResponse, PageInfo } from '../domain/models';
interface GraphQLResponse<T> {
    data?: T;
    errors?: Array<{
        message: string;
        extensions?: {
            code: string;
        };
    }>;
}
export declare class ShopifyStorefrontClient {
    private client;
    private config;
    constructor(config: ShopifyConfig);
    /**
     * Execute a Storefront GraphQL query
     */
    query<T>(query: string, variables?: Record<string, any>): Promise<GraphQLResponse<T>>;
    /**
     * Fetch a single product by handle (for hydrate fallback)
     */
    fetchProductByHandle(handle: string): Promise<any | null>;
    /**
     * Fetch collection by handle with products
     */
    fetchCollectionByHandle(handle: string, first?: number, after?: string): Promise<any | null>;
    /**
     * Fetch all collections (for browser)
     */
    fetchCollections(first?: number, after?: string): Promise<{
        items: any[];
        pageInfo: PageInfo;
    }>;
    /**
     * Fetch menu by handle
     */
    fetchMenu(handle: string): Promise<any | null>;
    /**
     * Fetch product recommendations
     */
    fetchRecommendations(productId: string): Promise<any[]>;
}
export declare function createShopifyStorefrontClient(config: ShopifyConfig): ShopifyStorefrontClient;
export {};
//# sourceMappingURL=storefront-client.d.ts.map