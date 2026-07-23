/**
 * Transform Shopify Admin API Collection to Catalog v2 Domain Model
 */

import { Collection, Image, Product } from '../domain/models';
import { transformImage } from './product';

/**
 * Transform Shopify Admin Collection to Catalog Collection
 */
export function transformAdminCollection(adminCollection: any): Collection {
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
    .map((edge: any) => edge.node?.handle)
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
    rules: adminCollection.ruleSet?.rules?.map((rule: any) => ({
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
export function transformAdminCollections(adminCollections: any[]): Collection[] {
  return adminCollections.map(transformAdminCollection).filter(Boolean);
}

/**
 * Transform Storefront collection (for fallback/hydrate)
 */
export function transformStorefrontCollection(storefrontCollection: any): Collection {
  // Similar to admin but uses Storefront API field names
  throw new Error('Not implemented - use transformAdminCollection for sync');
}