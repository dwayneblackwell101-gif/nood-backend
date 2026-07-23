"use strict";
/**
 * Catalog v2 Validation Module
 * Post-sync validation with comprehensive rules
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatalogValidator = void 0;
exports.createCatalogValidator = createCatalogValidator;
class CatalogValidator {
    cache;
    constructor(cache) {
        this.cache = cache;
    }
    /**
     * Validate a catalog version against Shopify and internal rules
     */
    async validate(versionId, context) {
        const errors = [];
        const warnings = [];
        // Get version metadata
        const versionMeta = await this.cache.getCatalogVersionMeta(versionId);
        if (!versionMeta) {
            return {
                ok: false,
                versionId,
                productCount: 0,
                collectionCount: 0,
                schemaVersion: '1',
                validatedAt: new Date().toISOString(),
                errors: [{
                        code: 'MISSING_VERSION_META',
                        message: `Catalog version ${versionId} metadata not found`,
                    }],
                warnings: [],
            };
        }
        // 1. Schema version check
        if (versionMeta.schemaVersion !== '1') {
            return this.failedValidation(versionId, [{
                    code: 'UNSUPPORTED_SCHEMA_VERSION',
                    message: `Schema version ${versionMeta.schemaVersion} is not supported`,
                    expected: '1',
                    actual: versionMeta.schemaVersion,
                }]);
        }
        // 2. Pagination completeness
        if (versionMeta.hasNextPage) {
            return this.failedValidation(versionId, [{
                    code: 'INCOMPLETE_PAGINATION',
                    message: 'Catalog sync did not complete all pages',
                }]);
        }
        // 3. Version status
        if (versionMeta.status === 'failed') {
            return this.failedValidation(versionId, [{
                    code: 'VERSION_FAILED',
                    message: 'Catalog version has fatal sync errors',
                }]);
        }
        // Get all products and collections
        const products = await this.cache.getAllProducts();
        const collections = await this.cache.getAllCollections();
        const productCount = products.length;
        const collectionCount = collections.length;
        // 4. Empty catalog check
        if (productCount === 0) {
            return this.failedValidation(versionId, [{
                    code: 'EMPTY_CATALOG',
                    message: 'Catalog contains zero products',
                }]);
        }
        // 5. Product count vs Shopify
        if (context.shopifyProductsCount > 0 && productCount !== context.shopifyProductsCount) {
            const diffPercent = Math.abs(productCount - context.shopifyProductsCount) / context.shopifyProductsCount * 100;
            if (diffPercent > 5) {
                return this.failedValidation(versionId, [{
                        code: 'PRODUCT_COUNT_MISMATCH',
                        message: `Product count mismatch: cache has ${productCount}, Shopify has ${context.shopifyProductsCount} (${diffPercent.toFixed(1)}% diff)`,
                        expected: context.shopifyProductsCount,
                        actual: productCount,
                    }]);
            }
            else if (diffPercent > 1) {
                return this.warnedValidation(versionId, {
                    code: 'PRODUCT_COUNT_DRIFT',
                    message: `Product count drift: ${diffPercent.toFixed(1)}% difference`,
                    expected: context.shopifyProductsCount,
                    actual: productCount,
                });
            }
        }
        // 6. Minimum product count
        if (context.minProductCount && productCount < context.minProductCount) {
            return this.failedValidation(versionId, [{
                    code: 'BELOW_MINIMUM_PRODUCT_COUNT',
                    message: `Product count ${productCount} is below minimum ${context.minProductCount}`,
                    expected: context.minProductCount,
                    actual: productCount,
                }]);
        }
        // 7. Collection count validation
        if (context.shopifyCollectionsCount > 0 && collectionCount !== context.shopifyCollectionsCount) {
            return this.warnedValidation(versionId, {
                code: 'COLLECTION_COUNT_DRIFT',
                message: `Collection count drift: cache ${collectionCount} vs Shopify ${context.shopifyCollectionsCount}`,
                expected: context.shopifyCollectionsCount,
                actual: collectionCount,
            });
        }
        // 8. Validate individual products
        const productValidation = await this.validateProducts(products);
        if (productValidation.errors.length > 0) {
            return this.failedValidation(versionId, productValidation.errors);
        }
        // 9. Validate collections
        const collectionValidation = await this.validateCollections(collections);
        if (collectionValidation.errors.length > 0) {
            return this.failedValidation(versionId, collectionValidation.errors);
        }
        // 10. Count drop vs previous version
        if (context.previousVersionMeta && context.previousVersionMeta.productCount > 0) {
            const dropPercent = (context.previousVersionMeta.productCount - productCount) / context.previousVersionMeta.productCount * 100;
            if (dropPercent > (context.maxDropPercent || 50)) {
                return this.failedValidation(versionId, [{
                        code: 'SUSPICIOUS_COUNT_DROP',
                        message: `Product count dropped ${dropPercent.toFixed(1)}% from previous version (${context.previousVersionMeta.productCount} -> ${productCount})`,
                        previousCount: context.previousVersionMeta.productCount,
                        currentCount: productCount,
                    }]);
            }
        }
        // 11. Duplicate detection
        const duplicateCheck = this.checkDuplicates(products, collections);
        if (duplicateCheck.errors.length > 0) {
            return this.failedValidation(versionId, duplicateCheck.errors);
        }
        return {
            ok: true,
            versionId,
            productCount,
            collectionCount,
            schemaVersion: versionMeta.schemaVersion || '1',
            validatedAt: new Date().toISOString(),
            errors: [],
            warnings: [],
        };
    }
    failedValidation(versionId, errors) {
        return {
            ok: false,
            versionId,
            productCount: 0,
            collectionCount: 0,
            schemaVersion: '1',
            validatedAt: new Date().toISOString(),
            errors,
            warnings: [],
        };
    }
    warnedValidation(versionId, warning) {
        return {
            ok: true,
            versionId,
            productCount: 0,
            collectionCount: 0,
            schemaVersion: '1',
            validatedAt: new Date().toISOString(),
            errors: [],
            warnings: [warning],
        };
    }
    /**
     * Validate all products in the catalog
     */
    async validateProducts(products) {
        const errors = [];
        const warnings = [];
        const seenIds = new Set();
        const seenHandles = new Set();
        for (const product of products) {
            // Check required fields
            if (!product.id) {
                errors.push({ code: 'MISSING_PRODUCT_ID', message: 'Product missing id', path: product.handle });
            }
            if (!product.handle) {
                errors.push({ code: 'MISSING_PRODUCT_HANDLE', message: 'Product missing handle', path: product.id });
            }
            // Check duplicates
            if (product.id && seenIds.has(product.id)) {
                return { errors: [{ code: 'DUPLICATE_PRODUCT_ID', message: `Duplicate product ID: ${product.id}`, path: product.id }], warnings: [] };
            }
            if (product.id)
                seenIds.add(product.id);
            if (product.handle && seenHandles.has(product.handle)) {
                return { errors: [{ code: 'DUPLICATE_PRODUCT_HANDLE', message: `Duplicate product handle: ${product.handle}`, path: product.handle }], warnings: [] };
            }
            if (product.handle)
                seenHandles.add(product.handle);
            // Validate variants
            if (product.variants?.edges) {
                if (product.variants.edges.length === 0) {
                    // Warning only - some products may legitimately have 0 variants in cache
                }
                for (const edge of product.variants.edges) {
                    const variant = edge.node;
                    if (!variant.id) {
                        return { errors: [{ code: 'MISSING_VARIANT_ID', message: 'Variant missing id', path: `${product.handle}.variants` }], warnings: [] };
                    }
                    if (!variant.title) {
                        // Warning only
                    }
                    if (!variant.price || !variant.price.amount) {
                        return { errors: [{ code: 'INVALID_VARIANT_PRICE', message: 'Variant price amount is not a valid number', path: `${product.handle}.variants` }], warnings: [] };
                    }
                }
            }
            else {
                // Warning only - some products may not have variants loaded
            }
            // Validate images
            if (product.images?.edges?.length === 0 && product.media?.edges?.length === 0) {
                // Warning only - some products may not have images
            }
            // Validate description
            if (!product.descriptionHtml && !product.description) {
                // Warning only
            }
            // Validate status
            if (!['ACTIVE', 'ARCHIVED', 'DRAFT'].includes(product.status)) {
                // Warning only
            }
        }
        return { errors: [], warnings: [] };
    }
    /**
     * Validate all collections
     */
    async validateCollections(collections) {
        const errors = [];
        const warnings = [];
        const seenHandles = new Set();
        for (const collection of collections) {
            if (!collection.handle) {
                return { errors: [{ code: 'MISSING_COLLECTION_HANDLE', message: 'Collection missing handle' }], warnings: [] };
            }
            if (seenHandles.has(collection.handle)) {
                return { errors: [{ code: 'DUPLICATE_COLLECTION_HANDLE', message: `Duplicate collection handle: ${collection.handle}` }], warnings: [] };
            }
            seenHandles.add(collection.handle);
        }
        return { errors: [], warnings: [] };
    }
    /**
     * Check for duplicates across products and collections
     */
    checkDuplicates(products, collections) {
        const errors = [];
        const warnings = [];
        // Product ID duplicates
        const productIds = new Map();
        for (const product of products) {
            const count = (productIds.get(product.id) || 0) + 1;
            productIds.set(product.id, count);
        }
        for (const [id, count] of productIds) {
            if (count > 1) {
                return { errors: [{ code: 'DUPLICATE_PRODUCT_ID', message: `Product ID ${id} appears ${count} times` }], warnings: [] };
            }
        }
        // Handle duplicates
        const handles = new Map();
        for (const product of products) {
            const count = (handles.get(product.handle) || 0) + 1;
            handles.set(product.handle, count);
        }
        for (const [handle, count] of handles) {
            if (count > 1) {
                return { errors: [{ code: 'DUPLICATE_PRODUCT_HANDLE', message: `Product handle ${handle} appears ${count} times` }], warnings: [] };
            }
        }
        return { errors: [], warnings: [] };
    }
}
exports.CatalogValidator = CatalogValidator;
function createCatalogValidator(cache) {
    return new CatalogValidator(cache);
}
//# sourceMappingURL=catalog-validator.js.map