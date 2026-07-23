"use strict";
/**
 * Transform Shopify Admin API Collection to Catalog v2 Domain Model
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformAdminCollection = transformAdminCollection;
exports.transformAdminCollections = transformAdminCollections;
exports.transformStorefrontCollection = transformStorefrontCollection;
/**
 * Transform Shopify Admin Collection to Catalog Collection
 */
function transformAdminCollection(adminCollection) {
    if (!adminCollection) {
        throw new Error('Admin collection is null or undefined');
    }
    // Transform image
    const image = adminCollection.image
        ? {
            id: adminCollection.image.id,
            url: adminCollection.image.url,
            altText: adminCollection.image.altText,
            width: adminCollection.image.width,
            height: adminCollection.image.height,
            src: adminCollection.image.url, // Alias for compatibility
        }
        : null;
    // Product handles from products connection
    const productHandles = (adminCollection.products?.edges || [])
        .map((edge) => edge.node?.handle)
        .filter(Boolean);
    // SEO
    const seo = {
        title: adminCollection.seo?.title || null,
        description: adminCollection.seo?.description || null,
    };
    return {
        id: adminCollection.id,
        title: adminCollection.title,
        handle: adminCollection.handle,
        descriptionHtml: adminCollection.descriptionHtml || '',
        description: adminCollection.descriptionHtml
            ? adminCollection.descriptionHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
            : '',
        image,
        products: { edges: [] }, // Will be populated when needed
        updatedAt: adminCollection.updatedAt,
        seo,
        sortOrder: adminCollection.sortOrder || 'MANUAL',
        rules: adminCollection.ruleSet?.rules?.map((rule) => ({
            column: rule.column,
            relation: rule.relation,
            condition: rule.condition,
        })) || [],
        productHandles, // For fast lookup without resolving products
    };
}
/**
 * Transform multiple admin collections
 */
function transformAdminCollections(adminCollections) {
    return adminCollections.map(transformAdminCollection).filter(Boolean);
}
/**
 * Transform Storefront collection (for fallback/hydrate)
 */
function transformStorefrontCollection(storefrontCollection) {
    // Similar to admin but uses Storefront API field names
    throw new Error('Not implemented - use transformAdminCollection for sync');
}
//# sourceMappingURL=collection.js.map