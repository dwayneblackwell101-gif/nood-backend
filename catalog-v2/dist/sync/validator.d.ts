/**
 * Catalog Validation Service
 * Validates synced catalog against Shopify and internal constraints
 */
import { ValidationResult, CatalogVersionMeta } from '../domain/models';
import { ICache } from '../cache';
export interface ValidationContext {
    versionId: string;
    shopifyProductsCount: number;
    shopifyCollectionsCount: number;
    previousVersionMeta?: CatalogVersionMeta | null;
}
export declare class CatalogValidator {
    private cache;
    constructor(cache: ICache);
    /**
     * Validate a catalog version against Shopify and internal rules
     */
    validate(versionId: string, context: ValidationContext): Promise<ValidationResult>;
    /**
     * Validate all products in the catalog
     */
    private validateProducts;
    /**
     * Validate all collections
     */
    private validateCollections;
    /**
     * Check for duplicates across products and collections
     */
    private checkDuplicates;
}
export declare function createCatalogValidator(cache: ICache): CatalogValidator;
//# sourceMappingURL=validator.d.ts.map