/**
 * Transform Shopify Admin API Product to Catalog v2 Domain Model
 * No truncation - preserves all data
 */
import { Product, ProductVariant, Image, Media } from '../domain/models';
/**
 * Transform Shopify Admin Product to Catalog Product
 * NO TRUNCATION - preserves all data
 */
export declare function transformAdminProduct(adminProduct: any): Product;
/**
 * Transform multiple admin products
 */
export declare function transformAdminProducts(adminProducts: any[]): Product[];
/**
 * Transform single admin variant
 */
export declare function transformAdminVariant(adminVariant: any): ProductVariant;
/**
 * Transform admin image
 */
export declare function transformAdminImage(adminImage: any): Image;
/**
 * Transform admin media
 */
export declare function transformAdminMedia(adminMedia: any): Media;
/**
 * Transform admin collection
 */
export declare function transformAdminCollection(adminCollection: any): {
    id: any;
    title: any;
    handle: any;
    descriptionHtml: any;
    description: any;
    image: {
        id: any;
        url: any;
        altText: any;
        width: any;
        height: any;
        src: any;
    } | null;
    products: {
        edges: never[];
    };
    updatedAt: any;
    seo: {
        title: any;
        description: any;
    };
    sortOrder: any;
    rules: any;
    productHandles: any;
} | null;
export declare function transformAdminCollections(adminCollections: any[]): ({
    id: any;
    title: any;
    handle: any;
    descriptionHtml: any;
    description: any;
    image: {
        id: any;
        url: any;
        altText: any;
        width: any;
        height: any;
        src: any;
    } | null;
    products: {
        edges: never[];
    };
    updatedAt: any;
    seo: {
        title: any;
        description: any;
    };
    sortOrder: any;
    rules: any;
    productHandles: any;
} | null)[];
//# sourceMappingURL=product.d.ts.map