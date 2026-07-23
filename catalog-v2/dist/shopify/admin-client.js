"use strict";
/**
 * Shopify Admin GraphQL Client for Catalog v2
 * Handles authentication, rate limiting, and query execution
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyAdminClient = void 0;
exports.createShopifyAdminClient = createShopifyAdminClient;
const axios_1 = __importDefault(require("axios"));
const fragments = __importStar(require("./fragments"));
class ShopifyAdminClient {
    client;
    config;
    lastThrottleStatus = null;
    constructor(config) {
        this.config = config;
        this.client = axios_1.default.create({
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
        this.client.interceptors.response.use((res) => res, (error) => {
            if (error.response?.status === 429) {
                console.warn('[Shopify Admin] Rate limited (429)');
            }
            else if (error.response?.status && error.response.status >= 500) {
                console.warn(`[Shopify Admin] Server error: ${error.response.status}`);
            }
            return Promise.reject(error);
        });
    }
    /**
     * Execute a GraphQL query with retry logic and rate limiting
     */
    async query(query, variables = {}, options = {}) {
        const { requestedCost = 50, maxRetries = 15 } = options;
        // Pre-request throttle wait
        await this.waitForThrottleBucket(requestedCost);
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (attempt > 1) {
                await this.delay(400 * attempt); // Inter-page delay
            }
            try {
                const response = await this.client.post('', {
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
                    error.extensions = payload.errors[0].extensions;
                    throw error;
                }
                // Post-request throttle wait
                const postWaitMs = this.getLowBucketWait(requestedCost);
                if (postWaitMs > 0) {
                    await this.delay(postWaitMs);
                }
                return payload;
            }
            catch (error) {
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
    async fetchProductsPage(variables = {}) {
        const pageSize = Math.min(variables.first || 50, 250);
        const response = await this.query(fragments.ADMIN_PRODUCTS_QUERY, {
            first: pageSize,
            after: variables.after,
            sortKey: variables.sortKey || 'UPDATED_AT',
            reverse: variables.reverse !== false,
            query: variables.query,
        }, { requestedCost: 50 });
        const connection = response.data?.products;
        const edges = connection?.edges || [];
        return {
            items: edges.map((edge) => edge.node).filter(Boolean),
            pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
        };
    }
    /**
     * Fetch a page of collections
     */
    async fetchCollectionsPage(variables = {}) {
        const pageSize = Math.min(variables.first || 50, 250);
        const response = await this.query(fragments.ADMIN_COLLECTIONS_QUERY, {
            first: pageSize,
            after: variables.after,
            sortKey: variables.sortKey || 'UPDATED_AT',
            reverse: variables.reverse !== false,
            query: variables.query,
        }, { requestedCost: 50 });
        const connection = response.data?.collections;
        const edges = connection?.edges || [];
        return {
            items: edges.map((edge) => edge.node).filter(Boolean),
            pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
        };
    }
    /**
     * Fetch a single product by ID
     */
    async fetchProductById(id) {
        const response = await this.query(fragments.ADMIN_PRODUCT_BY_ID_QUERY, { id }, { requestedCost: 10 });
        return response.data?.product || null;
    }
    /**
     * Fetch a single collection by ID
     */
    async fetchCollectionById(id) {
        const response = await this.query(fragments.ADMIN_COLLECTION_BY_ID_QUERY, { id }, { requestedCost: 10 });
        return response.data?.collection || null;
    }
    /**
     * Get total product count
     */
    async getProductsCount() {
        try {
            const response = await this.query(`
        query CatalogProductsCount {
          productsCount {
            count
          }
        }
      `, {}, { requestedCost: 10 });
            const count = Number(response.data?.productsCount?.count);
            return Number.isFinite(count) && count >= 0 ? count : null;
        }
        catch (error) {
            console.warn('[Shopify Admin] productsCount unavailable', {
                message: error?.message || error,
            });
            return null;
        }
    }
    /**
     * Fetch all products (with pagination)
     */
    async fetchAllProducts(options = {}) {
        const { pageSize = 100, maxPages = 200 } = options;
        const products = [];
        let after = null;
        let page = 0;
        while (page < maxPages) {
            const { items, pageInfo } = await this.fetchProductsPage({
                first: pageSize,
                after,
            });
            products.push(...items);
            after = pageInfo.endCursor;
            if (!pageInfo.hasNextPage || !after)
                break;
            page++;
        }
        return products;
    }
    /**
     * Fetch all collections (with pagination)
     */
    async fetchAllCollections(options = {}) {
        const { pageSize = 50, maxPages = 100 } = options;
        const collections = [];
        let after = null;
        let page = 0;
        while (page < maxPages) {
            const { items, pageInfo } = await this.fetchCollectionsPage({
                first: pageSize,
                after,
            });
            collections.push(...items);
            after = pageInfo.endCursor;
            if (!pageInfo.hasNextPage || !after)
                break;
            page++;
        }
        return collections;
    }
    // ============ Throttle Management ============
    isThrottled(payload) {
        const errors = Array.isArray(payload.errors) ? payload.errors : [];
        return errors.some((entry) => String(entry?.message || '').toLowerCase().includes('throttl'));
    }
    getLowBucketWait(requestedQueryCost = 50) {
        if (!this.lastThrottleStatus)
            return 0;
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
    calculateThrottleWait(throttleStatus, requestedQueryCost = 50, attempt = 1) {
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
    waitForThrottleBucket(requestedQueryCost = 50) {
        const waitMs = this.getLowBucketWait(requestedQueryCost);
        if (waitMs > 0) {
            console.log(`[Shopify Admin] throttled waiting ${waitMs} ms`);
            return this.delay(waitMs);
        }
        return Promise.resolve();
    }
    isRetryableError(error) {
        const retryable = error?.code === 'ECONNABORTED' ||
            error?.response?.status === 429 ||
            (error?.response?.status >= 500 && error?.response?.status < 600);
        return retryable;
    }
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.ShopifyAdminClient = ShopifyAdminClient;
function createShopifyAdminClient(config) {
    return new ShopifyAdminClient(config);
}
//# sourceMappingURL=admin-client.js.map