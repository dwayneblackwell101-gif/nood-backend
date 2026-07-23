"use strict";
/**
 * Shopify Storefront GraphQL Client for Catalog v2
 * Used for real-time product hydrate fallback
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
exports.ShopifyStorefrontClient = void 0;
exports.createShopifyStorefrontClient = createShopifyStorefrontClient;
const axios_1 = __importDefault(require("axios"));
const fragments = __importStar(require("./fragments"));
class ShopifyStorefrontClient {
    client;
    config;
    constructor(config) {
        this.config = config;
        this.client = axios_1.default.create({
            baseURL: `https://${config.storeDomain}/api/${config.storefrontApiVersion}/graphql.json`,
            headers: {
                'X-Shopify-Storefront-Access-Token': config.storefrontToken,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });
        this.client.interceptors.response.use((res) => res, (error) => {
            if (error.response?.status === 429) {
                console.warn('[Shopify Storefront] Rate limited');
            }
            return Promise.reject(error);
        });
    }
    /**
     * Execute a Storefront GraphQL query
     */
    async query(query, variables = {}) {
        const response = await this.client.post('', {
            query,
            variables,
        });
        const payload = response.data;
        if (payload.errors?.length) {
            const error = new Error(payload.errors[0].message);
            error.extensions = payload.errors[0].extensions;
            throw error;
        }
        return payload;
    }
    /**
     * Fetch a single product by handle (for hydrate fallback)
     */
    async fetchProductByHandle(handle) {
        const response = await this.query(fragments.STOREFRONT_PRODUCT_BY_HANDLE_QUERY, { handle });
        return response.data?.productByHandle || null;
    }
    /**
     * Fetch collection by handle with products
     */
    async fetchCollectionByHandle(handle, first = 24, after) {
        const response = await this.query(fragments.STOREFRONT_COLLECTION_BY_HANDLE_QUERY, { handle, first: Math.min(first, 250), after });
        return response.data?.collectionByHandle || null;
    }
    /**
     * Fetch all collections (for browser)
     */
    async fetchCollections(first = 24, after) {
        const response = await this.query(fragments.STOREFRONT_COLLECTIONS_QUERY, { first: Math.min(first, 250), after });
        const connection = response.data?.collections;
        const edges = connection?.edges || [];
        return {
            items: edges.map((edge) => edge.node).filter(Boolean),
            pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
        };
    }
    /**
     * Fetch menu by handle
     */
    async fetchMenu(handle) {
        const response = await this.query(fragments.STOREFRONT_MENU_QUERY, { handle });
        return response.data?.menu || null;
    }
    /**
     * Fetch product recommendations
     */
    async fetchRecommendations(productId) {
        const response = await this.query(fragments.STOREFRONT_RECOMMENDATIONS_QUERY, { productId });
        return response.data?.productRecommendations || [];
    }
}
exports.ShopifyStorefrontClient = ShopifyStorefrontClient;
function createShopifyStorefrontClient(config) {
    return new ShopifyStorefrontClient(config);
}
//# sourceMappingURL=storefront-client.js.map