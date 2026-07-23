/**
 * Shopify Admin GraphQL Client for Catalog v2
 * Handles authentication, rate limiting, and query execution
 */

import axios, { AxiosInstance } from 'axios';
import { ShopifyConfig, GraphQLResponse, PageInfo, AdminProductsPageVariables, AdminCollectionsPageVariables } from '../domain/models';
import * as fragments from './fragments';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code: string } }>;
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

interface AdminProductsPageResponse {
  products: {
    pageInfo: PageInfo;
    edges: Array<{ cursor: string; node: any }>;
  };
}

interface AdminCollectionsPageResponse {
  collections: {
    pageInfo: PageInfo;
    edges: Array<{ cursor: string; node: any }>;
  };
}

interface AdminProductByIdResponse {
  product: any;
}

interface AdminCollectionByIdResponse {
  collection: any;
}

export class ShopifyAdminClient {
  private client: AxiosInstance;
  private config: ShopifyConfig;
  private lastThrottleStatus: any = null;

  constructor(config: ShopifyConfig) {
    this.config = config;

    this.client = axios.create({
      baseURL: `https://${config.storeDomain}/admin/api/${config.adminApiVersion}/graphql.json`,
      headers: {
        'X-Shopify-Access-Token': config.adminToken,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    // Request interceptor for logging
    this.client.interceptors.request.use((req) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[Shopify Admin] ${req.method?.toUpperCase()} ${req.baseURL}`);
      }
      return req;
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (res) => res,
      (error) => {
        if (error.response?.status === 429) {
          console.warn('[Shopify Admin] Rate limited (429)');
        } else if (error.response?.status && error.response.status >= 500) {
          console.warn(`[Shopify Admin] Server error: ${error.response.status}`);
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Execute a GraphQL query with retry logic and rate limiting
   */
  async query<T>(
    query: string,
    variables: Record<string, any> = {},
    options: { requestedCost?: number; maxRetries?: number } = {}
  ): Promise<GraphQLResponse<T>> {
    const { requestedCost = 50, maxRetries = 15 } = options;

    // Pre-request throttle wait
    await this.waitForThrottleBucket(requestedCost);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) {
        await this.delay(400 * attempt); // Inter-page delay
      }

      try {
        const response = await this.client.post<GraphQLResponse<T>>('', {
          query,
          variables,
        });

        const payload = response.data;
        this.lastThrottleStatus = payload.extensions?.cost?.throttleStatus || null;

        // Check for throttle errors
        if (this.isThrottled(payload)) {
          const waitMs = this.calculateThrottleWait(payload, requestedCost, attempt);
          console.log(`[Shopify Admin] Throttled, waiting ${waitMs}ms (attempt ${attempt}/${maxRetries})`);
          await this.delay(waitMs);
          continue;
        }

        // Check for GraphQL errors
        if (payload.errors?.length) {
          const error = new Error(payload.errors[0].message);
          (error as any).extensions = payload.errors[0].extensions;
          throw error;
        }

        // Post-request throttle wait
        const postWaitMs = this.getLowBucketWait(requestedCost);
        if (postWaitMs > 0) {
          await this.delay(postWaitMs);
        }

        return payload;
      } catch (error: any) {
        const retryable = this.isRetryableError(error);

        if (retryable && attempt < maxRetries) {
          const waitMs = this.calculateThrottleWait(this.lastThrottleStatus, requestedCost, attempt);
          console.log(`[Shopify Admin] Retryable error, waiting ${waitMs}ms: ${error.message}`);
          await this.delay(waitMs);
          continue;
        }

        throw error;
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Fetch a page of products
   */
  async fetchProductsPage(variables: AdminProductsPageVariables = {}): Promise<{
    items: any[];
    pageInfo: PageInfo;
  }> {
    const pageSize = Math.min(variables.first || 50, 250);

    const response = await this.query<any>(
      fragments.ADMIN_PRODUCTS_QUERY,
      {
        first: pageSize,
        after: variables.after,
        sortKey: variables.sortKey || 'UPDATED_AT',
        reverse: variables.reverse !== false,
        query: variables.query,
      },
      { requestedCost: 50 }
    );

    const connection = response.data?.products;
    const edges = connection?.edges || [];

    return {
      items: edges.map((edge: any) => edge.node).filter(Boolean),
      pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
    };
  }

  /**
   * Fetch a page of collections
   */
  async fetchCollectionsPage(variables: AdminCollectionsPageVariables = {}): Promise<{
    items: any[];
    pageInfo: PageInfo;
  }> {
    const pageSize = Math.min(variables.first || 50, 250);

    const response = await this.query<any>(
      fragments.ADMIN_COLLECTIONS_QUERY,
      {
        first: pageSize,
        after: variables.after,
        sortKey: variables.sortKey || 'UPDATED_AT',
        reverse: variables.reverse !== false,
        query: variables.query,
      },
      { requestedCost: 50 }
    );

    const connection = response.data?.collections;
    const edges = connection?.edges || [];

    return {
      items: edges.map((edge: any) => edge.node).filter(Boolean),
      pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
    };
  }

  /**
   * Fetch a single product by ID
   */
  async fetchProductById(id: string): Promise<any | null> {
    const response = await this.query<any>(
      fragments.ADMIN_PRODUCT_BY_ID_QUERY,
      { id },
      { requestedCost: 10 }
    );

    return response.data?.product || null;
  }

  /**
   * Fetch a single collection by ID
   */
  async fetchCollectionById(id: string): Promise<any | null> {
    const response = await this.query<any>(
      fragments.ADMIN_COLLECTION_BY_ID_QUERY,
      { id },
      { requestedCost: 10 }
    );

    return response.data?.collection || null;
  }

  /**
   * Get total product count
   */
  async getProductsCount(): Promise<number | null> {
    try {
      const response = await this.query<any>(
        `
        query CatalogProductsCount {
          productsCount {
            count
          }
        }
      `,
        {},
        { requestedCost: 10 }
      );

      const count = Number(response.data?.productsCount?.count);
      return Number.isFinite(count) && count >= 0 ? count : null;
    } catch (error) {
      console.warn('[Shopify Admin] productsCount unavailable', {
        message: error?.message || error,
      });
      return null;
    }
  }

  /**
   * Fetch all products (with pagination)
   */
  async fetchAllProducts(options: { pageSize?: number; maxPages?: number } = {}): Promise<any[]> {
    const { pageSize = 100, maxPages = 200 } = options;
    const products: any[] = [];
    let after: string | null = null;
    let page = 0;

    while (page < maxPages) {
      const { items, pageInfo } = await this.fetchProductsPage({
        first: pageSize,
        after,
      });

      products.push(...items);
      after = pageInfo.endCursor;

      if (!pageInfo.hasNextPage || !after) break;
      page++;
    }

    return products;
  }

  /**
   * Fetch all collections (with pagination)
   */
  async fetchAllCollections(options: { pageSize?: number; maxPages?: number } = {}): Promise<any[]> {
    const { pageSize = 50, maxPages = 100 } = options;
    const collections: any[] = [];
    let after: string | null = null;
    let page = 0;

    while (page < maxPages) {
      const { items, pageInfo } = await this.fetchCollectionsPage({
        first: pageSize,
        after,
      });

      collections.push(...items);
      after = pageInfo.endCursor;

      if (!pageInfo.hasNextPage || !after) break;
      page++;
    }

    return collections;
  }

  // ============ Throttle Management ============

  private isThrottled(payload: GraphQLResponse<any>): boolean {
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    return errors.some((entry: any) =>
      String(entry?.message || '').toLowerCase().includes('throttl')
    );
  }

  private getLowBucketWait(requestedQueryCost = 50): number {
    if (!this.lastThrottleStatus) return 0;

    const available = Number(this.lastThrottleStatus.currentlyAvailable ?? 0);
    const restoreRate = Number(this.lastThrottleStatus.restoreRate ?? 50) || 50;
    const cost = Math.max(1, Number(requestedQueryCost ?? 50));

    if (available >= cost * 2) {
      return 0;
    }

    const target = cost * 2;
    const deficit = Math.max(0, target - available);
    return Math.ceil((deficit / restoreRate) * 1000) + 150;
  }

  private calculateThrottleWait(
    throttleStatus: any,
    requestedQueryCost = 50,
    attempt = 1
  ): number {
    const jitter = 2000 + Math.floor(Math.random() * 3001);

    if (!throttleStatus) {
      return Math.min(jitter * Math.pow(2, Math.max(0, attempt - 1)), 60000);
    }

    const available = Number(throttleStatus.currentlyAvailable ?? 0);
    const restoreRate = Number(throttleStatus.restoreRate ?? 50) || 50;
    const cost = Math.max(1, Number(requestedQueryCost ?? 50));

    if (available >= cost) {
      return Math.min(jitter * Math.pow(2, Math.max(0, attempt - 1)), 60000);
    }

    const deficit = Math.max(0, cost - available);
    const restoreMs = Math.ceil((deficit / restoreRate) * 1000) + 250;
    return Math.min(Math.max(restoreMs, jitter) * Math.pow(2, Math.max(0, attempt - 1)), 60000);
  }

  private waitForThrottleBucket(requestedQueryCost = 50): Promise<void> {
    const waitMs = this.getLowBucketWait(requestedQueryCost);
    if (waitMs > 0) {
      console.log(`[Shopify Admin] throttled waiting ${waitMs} ms`);
      return this.delay(waitMs);
    }
    return Promise.resolve();
  }

  private isRetryableError(error: any): boolean {
    const retryable =
      error?.code === 'ECONNABORTED' ||
      error?.response?.status === 429 ||
      (error?.response?.status >= 500 && error?.response?.status < 600);
    return retryable;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createShopifyAdminClient(config: ShopifyConfig): ShopifyAdminClient {
  return new ShopifyAdminClient(config);
}