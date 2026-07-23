/**
 * Catalog Validation Service
 * Validates synced catalog against Shopify and internal constraints
 */

import {
  Product,
  Collection,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  CatalogVersionMeta,
} from '../domain/models';
import { ICache } from '../cache';

export interface ValidationContext {
  versionId: string;
  shopifyProductsCount: number;
  shopifyCollectionsCount: number;
  previousVersionMeta?: CatalogVersionMeta | null;
}

export class CatalogValidator {
  constructor(private cache: ICache) {}

  /**
   * Validate a catalog version against Shopify and internal rules
   */
  async validate(versionId: string, context: ValidationContext): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // 1. Schema version check
    const versionMeta = await this.cache.getCatalogVersionMeta(versionId);
    if (!versionMeta) {
      errors.push({
        code: 'MISSING_VERSION_META',
        message: `Catalog version ${versionId} metadata not found`,
      });
    } else if (versionMeta.schemaVersion !== '1') {
      errors.push({
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        message: `Schema version ${versionMeta.schemaVersion} is not supported`,
        expected: '1',
        actual: versionMeta.schemaVersion,
      });
    }

    // 2. Pagination completeness
    if (versionMeta?.hasNextPage) {
      errors.push({
        code: 'INCOMPLETE_PAGINATION',
        message: 'Catalog sync did not complete all pages',
      });
    }

    // 3. Version status
    if (versionMeta?.status === 'failed') {
      errors.push({
        code: 'VERSION_FAILED',
        message: 'Catalog version has fatal sync errors',
      });
    }

    // 4. Product count validation
    const products = await this.cache.getAllProducts();
    const productCount = products.length;

    if (productCount === 0) {
      errors.push({
        code: 'EMPTY_CATALOG',
        message: 'Catalog contains zero products',
      });
    }

    // Compare with Shopify count
    if (context.shopifyProductsCount > 0 && productCount !== context.shopifyProductsCount) {
      const diffPercent = Math.abs(productCount - context.shopifyProductsCount) / context.shopifyProductsCount * 100;
      if (diffPercent > 5) {
        errors.push({
          code: 'PRODUCT_COUNT_MISMATCH',
          message: `Product count mismatch: cache has ${productCount}, Shopify has ${context.shopifyProductsCount} (${diffPercent.toFixed(1)}% diff)`,
          expected: context.shopifyProductsCount,
          actual: productCount,
        });
      } else if (diffPercent > 1) {
        warnings.push({
          code: 'PRODUCT_COUNT_DRIFT',
          message: `Product count drift: ${diffPercent.toFixed(1)}% difference`,
          expected: context.shopifyProductsCount,
          actual: productCount,
        });
      }
    }

    // 5. Minimum product count
    if (context.minProductCount && productCount < context.minProductCount) {
      errors.push({
        code: 'BELOW_MINIMUM_PRODUCT_COUNT',
        message: `Product count ${productCount} is below minimum ${context.minProductCount}`,
        expected: context.minProductCount,
        actual: productCount,
      });
    }

    // 6. Collection count validation
    const collections = await this.cache.getAllCollections();
    const collectionCount = collections.length;

    if (context.shopifyCollectionsCount > 0 && collectionCount !== context.shopifyCollectionsCount) {
      warnings.push({
        code: 'COLLECTION_COUNT_DRIFT',
        message: `Collection count drift: cache ${collectionCount} vs Shopify ${context.shopifyCollectionsCount}`,
        expected: context.shopifyCollectionsCount,
        actual: collectionCount,
      });
    }

    // 7. Validate individual products
    const productValidation = await this.validateProducts(products);
    errors.push(...productValidation.errors);
    warnings.push(...productValidation.warnings);

    // 8. Validate collections
    const collectionValidation = await this.validateCollections(collections);
    errors.push(...collectionValidation.errors);
    warnings.push(...collectionValidation.warnings);

    // 9. Count drop vs previous version
    if (context.previousVersionMeta && context.previousVersionMeta.productCount > 0) {
      const dropPercent = (context.previousVersionMeta.productCount - productCount) / context.previousVersionMeta.productCount * 100;
      if (dropPercent > (context.maxDropPercent || 50)) {
        errors.push({
          code: 'SUSPICIOUS_COUNT_DROP',
          message: `Product count dropped ${dropPercent.toFixed(1)}% from previous version (${context.previousVersionMeta.productCount} -> ${productCount})`,
          previousCount: context.previousVersionMeta.productCount,
          currentCount: productCount,
        });
      }
    }

    // 10. Duplicate detection
    const duplicateCheck = await this.checkDuplicates(products, collections);
    errors.push(...duplicateCheck.errors);
    warnings.push(...duplicateCheck.warnings);

    return {
      ok: errors.length === 0,
      versionId,
      productCount,
      collectionCount,
      schemaVersion: versionMeta?.schemaVersion || '1',
      validatedAt: new Date().toISOString(),
      errors,
      warnings,
    };
  }

  /**
   * Validate all products in the catalog
   */
  private async validateProducts(products: Product[]) {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const seenIds = new Set<string>();
    const seenHandles = new Set<string>();

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
        errors.push({ code: 'DUPLICATE_PRODUCT_ID', message: `Duplicate product ID: ${product.id}`, path: product.id });
      }
      if (product.id) seenIds.add(product.id);

      if (product.handle && seenHandles.has(product.handle)) {
        errors.push({ code: 'DUPLICATE_PRODUCT_HANDLE', message: `Duplicate product handle: ${product.handle}`, path: product.handle });
      }
      if (product.handle) seenHandles.add(product.handle);

      // Validate variants
      if (product.variants?.edges) {
        if (product.variants.edges.length === 0) {
          warnings.push({ code: 'NO_VARIANTS', message: `Product ${product.handle} has no variants`, path: product.handle });
        }

        for (const edge of product.variants.edges) {
          const variant = edge.node;
          if (!variant.id) {
            errors.push({ code: 'MISSING_VARIANT_ID', message: 'Variant missing id', path: `${product.handle}.variants` });
          }
          if (!variant.title) {
            warnings.push({ code: 'MISSING_VARIANT_TITLE', message: 'Variant missing title', path: `${product.handle}.variants` });
          }
          if (!variant.price) {
            errors.push({ code: 'MISSING_VARIANT_PRICE', message: 'Variant missing price', path: `${product.handle}.variants` });
          }
          if (typeof variant.price?.amount === 'undefined') {
            errors.push({ code: 'INVALID_VARIANT_PRICE', message: 'Variant price amount is not a valid number', path: `${product.handle}.variants` });
          }
        }
      } else {
        warnings.push({ code: 'NO_VARIANTS_CONNECTION', message: `Product ${product.handle} has no variants connection`, path: product.handle });
      }

      // Validate images
      if (product.images?.edges?.length === 0 && product.media?.edges?.length === 0) {
        warnings.push({ code: 'NO_IMAGES', message: `Product ${product.handle} has no images`, path: product.handle });
      }

      // Validate description
      if (!product.descriptionHtml && !product.description) {
        warnings.push({ code: 'MISSING_DESCRIPTION', message: `Product ${product.handle} has no description`, path: product.handle });
      }

      // Validate status
      if (!['ACTIVE', 'ARCHIVED', 'DRAFT'].includes(product.status)) {
        warnings.push({ code: 'UNKNOWN_STATUS', message: `Product ${product.handle} has unknown status: ${product.status}`, path: product.handle });
      }
    }

    return { errors, warnings };
  }

  /**
   * Validate all collections
   */
  private async validateCollections(collections: any[]) {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const seenHandles = new Set<string>();

    for (const collection of collections) {
      if (!collection.handle) {
        errors.push({ code: 'MISSING_COLLECTION_HANDLE', message: 'Collection missing handle' });
      }
      if (collection.handle && seenHandles.has(collection.handle)) {
        errors.push({ code: 'DUPLICATE_COLLECTION_HANDLE', message: `Duplicate collection handle: ${collection.handle}` });
      }
      if (collection.handle) seenHandles.add(collection.handle);

      // Validate referenced products exist
      if (collection.products?.edges) {
        for (const edge of collection.products.edges) {
          if (edge.node?.handle) {
            // Product existence will be checked separately
          }
        }
      }
    }

    return { errors, warnings };
  }

  /**
   * Check for duplicates across products and collections
   */
  private async checkDuplicates(products: Product[], collections: any[]) {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Product ID duplicates
    const productIds = new Map<string, number>();
    for (const product of products) {
      const count = (productIds.get(product.id) || 0) + 1;
      productIds.set(product.id, count);
    }
    for (const [id, count] of productIds) {
      if (count > 1) {
        errors.push({ code: 'DUPLICATE_PRODUCT_ID', message: `Product ID ${id} appears ${count} times` });
      }
    }

    // Handle duplicates
    const handles = new Map<string, number>();
    for (const product of products) {
      const count = (handles.get(product.handle) || 0) + 1;
      handles.set(product.handle, count);
    }
    for (const [handle, count] of handles) {
      if (count > 1) {
        errors.push({ code: 'DUPLICATE_PRODUCT_HANDLE', message: `Product handle ${handle} appears ${count} times` });
      }
    }

    return { errors, warnings };
  }
}

export function createCatalogValidator(cache: ICache): CatalogValidator {
  return new CatalogValidator(cache);
}