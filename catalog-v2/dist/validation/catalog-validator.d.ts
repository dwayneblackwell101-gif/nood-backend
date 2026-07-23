/**
 * Catalog v2 Validation Module
 * Post-sync validation with comprehensive rules
 */
import { ValidationResult, CatalogVersionMeta } from '../domain/models';
export interface ValidationContext {
    versionId: string;
    shopifyProductsCount: number;
    shopifyCollectionsCount: number;
    minProductCount?: number;
    maxDropPercent?: number;
    previousVersionMeta?: CatalogVersionMeta | null;
}
export interface ValidationWarning {
    code: string;
    message: string;
    path?: string;
}
export declare class CatalogValidator {
    private cache;
    constructor(cache: any);
    /**
     * Validate a catalog version against Shopify and internal rules
     */
    validate(versionId: string, context: ValidationContext): Promise<ValidationResult>;
    private failedValidation;
    private warnedValidation;
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
export declare function createCatalogValidator(cache: any): CatalogValidator;
//# sourceMappingURL=catalog-validator.d.ts.map