/**
 * Shopify Storefront GraphQL Client for Catalog v2
 * Used for real-time product hydrate fallback
 */

import axios, { AxiosInstance } from 'axios';
import { ShopifyConfig, GraphQLResponse, PageInfo } from '../domain/models';
import * as fragments from './fragments';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code: string } }>;
}

interface ProductByHandleResponse {
  productByHandle: any;
}

interface CollectionByHandleResponse {
  collectionByHandle: any;
}

interface CollectionsResponse {
  collections: {
    pageInfo: PageInfo;
    edges: Array<{ cursor: string; node: any }>;
  };
}

interface MenuResponse {
  menu: any;
}

interface ProductRecommendationsResponse {
  productRecommendations: any[];
}

export class ShopifyStorefrontClient {
  private client: AxiosInstance;
  private config: ShopifyConfig;

  constructor(config: ShopifyConfig) {
    this.config = config;

    this.client = axios.create({
      baseURL: `https://${config.storeDomain}/api/${config.storefrontApiVersion}/graphql.json`,
      headers: {
        'X-Shopify-Storefront-Access-Token': config.storefrontToken,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    this.client.interceptors.response.use(
      (res) => res,
      (error) => {
        if (error.response?.status === 429) {
          console.warn('[Shopify Storefront] Rate limited');
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Execute a Storefront GraphQL query
   */
  async query<T>(
    query: string,
    variables: Record<string, any> = {}
  ): Promise<GraphQLResponse<T>> {
    const response = await this.client.post<GraphQLResponse<T>>('', {
      query,
      variables,
    });

    const payload = response.data;

    if (payload.errors?.length) {
      const error = new Error(payload.errors[0].message);
      (error as any).extensions = payload.errors[0].extensions;
      throw error;
    }

    return payload;
  }

  /**
   * Fetch a single product by handle (for hydrate fallback)
   */
  async fetchProductByHandle(handle: string): Promise<any | null> {
    const response = await this.query<ProductByHandleResponse>(
      fragments.STOREFRONT_PRODUCT_BY_HANDLE_QUERY,
      { handle }
    );

    return response.data?.productByHandle || null;
  }

  /**
   * Fetch collection by handle with products
   */
  async fetchCollectionByHandle(
    handle: string,
    first = 24,
    after?: string
  ): Promise<any | null> {
    const response = await this.query<CollectionByHandleResponse>(
      fragments.STOREFRONT_COLLECTION_BY_HANDLE_QUERY,
      { handle, first: Math.min(first, 250), after }
    );

    return response.data?.collectionByHandle || null;
  }

  /**
   * Fetch all collections (for browser)
   */
  async fetchCollections(first = 24, after?: string): Promise<{
    items: any[];
    pageInfo: PageInfo;
  }> {
    const response = await this.query<CollectionsResponse>(
      fragments.STOREFRONT_COLLECTIONS_QUERY,
      { first: Math.min(first, 250), after }
    );

    const connection = response.data?.collections;
    const edges = connection?.edges || [];

    return {
      items: edges.map((edge: any) => edge.node).filter(Boolean),
      pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
    };
  }

  /**
   * Fetch menu by handle
   */
  async fetchMenu(handle: string): Promise<any | null> {
    const response = await this.query<MenuResponse>(
      fragments.STOREFRONT_MENU_QUERY,
      { handle }
    );

    return response.data?.menu || null;
  }

  /**
   * Fetch product recommendations
   */
  async fetchRecommendations(productId: string): Promise<any[]> {
    const response = await this.query<ProductRecommendationsResponse>(
      fragments.STOREFRONT_RECOMMENDATIONS_QUERY,
      { productId }
    );

    return response.data?.productRecommendations || [];
  }
}

export function createShopifyStorefrontClient(config: ShopifyConfig): ShopifyStorefrontClient {
  return new ShopifyStorefrontClient(config);
}