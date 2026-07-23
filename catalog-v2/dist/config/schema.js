"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatalogV2ConfigSchema = void 0;
exports.loadConfig = loadConfig;
exports.resetConfig = resetConfig;
const zod_1 = require("zod");
exports.CatalogV2ConfigSchema = zod_1.z.object({
    // Shopify Admin API
    SHOPIFY_STORE_DOMAIN: zod_1.z.string().min(1),
    SHOPIFY_ADMIN_ACCESS_TOKEN: zod_1.z.string().min(1),
    SHOPIFY_ADMIN_API_VERSION: zod_1.z.string().default('2025-10'),
    // Shopify Storefront API (for hydrate fallback)
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: zod_1.z.string().min(1),
    SHOPIFY_STOREFRONT_API_VERSION: zod_1.z.string().default('2025-10'),
    // Cache
    REDIS_URL: zod_1.z.string().optional(),
    REDIS_NAMESPACE: zod_1.z.string().default('nood'),
    CATALOG_LEGACY_FALLBACK_ENABLED: zod_1.z.string().transform(v => v === 'true').default('true'),
    // Sync configuration
    SYNC_MAX_PRODUCTS: zod_1.z.string().transform(v => parseInt(v, 10)).optional(),
    SYNC_PAGE_SIZE: zod_1.z.string().transform(v => parseInt(v, 10)).default('100'),
    SYNC_INTER_PAGE_DELAY_MS: zod_1.z.string().transform(v => parseInt(v, 10)).default('400'),
    SYNC_MAX_GRAPHQL_ATTEMPTS: zod_1.z.string().transform(v => parseInt(v, 10)).default('15'),
    // Validation
    VALIDATION_ENABLED: zod_1.z.string().transform(v => v === 'true').default('true'),
    VALIDATION_MIN_PRODUCT_COUNT: zod_1.z.string().transform(v => parseInt(v, 10)).optional(),
    VALIDATION_MAX_COUNT_DROP_PERCENT: zod_1.z.string().transform(v => parseInt(v, 10)).default('50'),
    // Environment
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
});
let configCache = null;
function loadConfig() {
    if (configCache)
        return configCache;
    const result = exports.CatalogV2ConfigSchema.safeParse(process.env);
    if (!result.success) {
        const errors = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n');
        throw new Error(`Catalog v2 config validation failed:\n${errors}`);
    }
    configCache = result.data;
    return configCache;
}
function resetConfig() {
    configCache = null;
}
//# sourceMappingURL=schema.js.map