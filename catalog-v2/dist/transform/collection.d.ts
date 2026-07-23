/**
 * Transform Shopify Admin API Collection to Catalog v2 Domain Model
 */
import { Collection } from '../domain/models';
/**
 * Transform Shopify Admin Collection to Catalog Collection
 */
export declare function transformAdminCollection(adminCollection: any): Collection;
/**
 * Transform multiple admin collections
 */
export declare function transformAdminCollections(adminCollections: any[]): Collection[];
/**
 * Transform Storefront collection (for fallback/hydrate)
 */
export declare function transformStorefrontCollection(storefrontCollection: any): Collection;
//# sourceMappingURL=collection.d.ts.map