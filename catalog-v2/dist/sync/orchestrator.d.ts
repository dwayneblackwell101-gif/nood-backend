/**
 * Catalog Sync Orchestrator for v2
 * Coordinates the full sync process: products -> collections -> validation -> activation
 */
import { ShopifyAdminClient } from '../shopify';
import { ICache } from '../cache';
import { SyncState, ValidationResult } from '../domain/models';
interface SyncOptions {
    pageSize?: number;
    maxPages?: number;
    forceFullSync?: boolean;
    resumeFromVersion?: string;
}
interface SyncResult {
    success: boolean;
    versionId: string;
    productCount: number;
    collectionCount: number;
    validation?: ValidationResult;
    error?: string;
}
export declare class CatalogSyncOrchestrator {
    private adminClient;
    private cache;
    private productSync;
    private validator;
    private currentVersionId;
    private syncId;
    private abortController;
    constructor(adminClient: ShopifyAdminClient, cache: ICache);
    /**
     * Execute a full catalog sync
     */
    sync(options?: SyncOptions): Promise<SyncResult>;
    /**
     * Phase 1: Sync all products from Shopify
     */
    private syncProducts;
    /**
     * Phase 2: Sync all collections from Shopify
     */
    private syncCollections;
    /**
     * Phase 3: Reconcile collection-product relationships
     */
    private reconcileCollections;
    /**
     * Phase 4: Validate the catalog
     */
    private validate;
    /**
     * Phase 5: Activate the version
     */
    private activateVersion;
    /**
     * Abort the current sync
     */
    abort(): void;
    /**
     * Get current sync status
     */
    getStatus(): Promise<SyncState & {
        versionId?: string;
    }>;
}
export declare function createCatalogSyncOrchestrator(adminClient: ShopifyAdminClient, cache: ICache): CatalogSyncOrchestrator;
export {};
//# sourceMappingURL=orchestrator.d.ts.map