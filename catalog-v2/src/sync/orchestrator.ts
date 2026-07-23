/**
 * Catalog Sync Orchestrator for v2
 * Coordinates the full sync process: products -> collections -> validation -> activation
 */

import { ShopifyAdminClient, createShopifyAdminClient } from '../shopify';
import { ICache, createCache } from '../cache';
import { ProductSyncService, createProductSyncService } from './product-sync';
import { CatalogValidator, createCatalogValidator } from './validator';
import { transformAdminProduct, transformAdminCollection } from '../transform';
import {
  SyncState,
  CatalogVersionMeta,
  ValidationResult,
  Product,
  Collection,
} from '../domain/models';
import { ShopifyAdminClient } from '../shopify/admin-client';
import { ICache } from '../cache/interface';

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

export class CatalogSyncOrchestrator {
  private adminClient: ShopifyAdminClient;
  private cache: ICache;
  private productSync: ReturnType<typeof createProductSyncService>;
  private validator: ReturnType<typeof createCatalogValidator>;

  private currentVersionId: string | null = null;
  private syncId: string | null = null;
  private abortController = new AbortController();

  constructor(adminClient: ShopifyAdminClient, cache: ICache) {
    this.adminClient = adminClient;
    this.cache = cache;
    this.productSync = createProductSyncService(adminClient, cache);
    this.validator = createCatalogValidator(cache);
  }

  /**
   * Execute a full catalog sync
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const { pageSize = 100, maxPages = 200, forceFullSync = false } = options;

    try {
      // Check if sync is already running
      const currentState = await this.cache.getSyncState();
      if (currentState.status === 'running' && !forceFullSync) {
        return {
          success: false,
          versionId: '',
          productCount: 0,
          collectionCount: 0,
          error: 'Sync already in progress',
        };
      }

      // Begin new catalog version
      this.currentVersionId = `catalog_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      this.syncId = `sync_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

      console.log(`[Catalog v2 Sync] Starting sync ${this.syncId}`, {
        versionId: this.currentVersionId,
        pageSize,
        maxPages,
      });

      await this.cache.beginVersion(this.currentVersionId);

      // Initialize sync state
      await this.cache.setSyncState({
        status: 'running',
        phase: 'products',
        syncId: this.syncId,
        versionId: this.currentVersionId,
        startedAt: new Date().toISOString(),
      });

      // Phase 1: Sync Products
      const productResult = await this.syncProducts({ pageSize, maxPages });
      console.log(`[Catalog v2 Sync] Products phase complete`, productResult);

      // Phase 2: Sync Collections
      await this.cache.setSyncState({ phase: 'collections' });
      const collectionResult = await this.syncCollections();
      console.log(`[Catalog v2 Sync] Collections phase complete`, collectionResult);

      // Phase 3: Reconcile collection-product relationships
      await this.reconcileCollections();

      // Phase 4: Validate
      await this.cache.setSyncState({ phase: 'validating', status: 'validating' });
      const validation = await this.validate(this.currentVersionId!);

      if (!validation.ok) {
        await this.cache.setSyncState({
          status: 'failed',
          lastError: validation.errors.map(e => e.message).join('; '),
        });
        return {
          success: false,
          versionId: this.currentVersionId,
          productCount: validation.productCount,
          collectionCount: validation.collectionCount,
          validation,
          error: validation.errors.map(e => e.message).join('; '),
        };
      }

      // Phase 5: Finalize and activate
      await this.cache.finalizeVersion(this.currentVersionId!, false);
      await this.activateVersion(this.currentVersionId!);

      console.log(`[Catalog v2 Sync] Sync ${this.syncId} completed successfully`, {
        versionId: this.currentVersionId,
        products: validation.productCount,
        collections: validation.collectionCount,
      });

      await this.cache.setSyncState({
        status: 'completed',
        phase: 'completed',
        completedAt: new Date().toISOString(),
      });

      return {
        success: true,
        versionId: this.currentVersionId,
        productCount: validation.productCount,
        collectionCount: validation.collectionCount,
        validation,
      };
    } catch (error: any) {
      console.error(`[Catalog v2 Sync] Sync failed`, error);
      await this.cache.setSyncState({
        status: 'failed',
        lastError: error.message,
      });
      return {
        success: false,
        versionId: this.currentVersionId || '',
        productCount: 0,
        collectionCount: 0,
        error: error.message,
      };
    }
  }

  /**
   * Phase 1: Sync all products from Shopify
   */
  private async syncProducts(options: { pageSize: number; maxPages: number }): Promise<{
    synced: number;
    pages: number;
  }> {
    let synced = 0;
    let pages = 0;
    let after: string | null = null;
    let totalPages = 0;

    // Get total product count from Shopify for progress tracking
    const shopifyCount = await this.productSync.adminClient.getProductsCount();
    console.log(`[Catalog v2 Sync] Shopify reports ${shopifyCount} products`);

    while (totalPages < options.maxPages) {
      if (this.abortController.signal.aborted) {
        throw new Error('Sync aborted');
      }

      const { items: products, pageInfo } = await this.productSync.adminClient.fetchProductsPage({
        first: options.pageSize,
        after,
        sortKey: 'UPDATED_AT',
        reverse: true,
      });

      if (!products.length && !pageInfo.hasNextPage) break;

      // Transform and save products
      const transformedProducts = transformAdminProducts(products);
      await this.cache.setProducts(transformedProducts);

      // Save to versioned storage
      for (const product of transformedProducts) {
        await this.cache.setProductInVersion(this.currentVersionId!, product);
      }

      synced += transformedProducts.length;
      pages++;
      totalPages++;

      console.log(`[Catalog v2 Sync] Page ${pages}: synced ${transformedProducts.length} products (total: ${synced})`);

      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }

    return { synced, pages };
  }

  /**
   * Phase 2: Sync all collections from Shopify
   */
  private async syncCollections(): Promise<{ synced: number; pages: number }> {
    let synced = 0;
    let pages = 0;
    let after: string | null = null;

    while (true) {
      const { items: collections, pageInfo } = await this.productSync.adminClient.fetchCollectionsPage({
        first: 100,
        after,
        sortKey: 'UPDATED_AT',
        reverse: true,
      });

      if (!collections.length && !pageInfo.hasNextPage) break;

      // Transform and save
      const transformed = collections.map(transformAdminCollection);
      await this.cache.setCollections(transformed);

      // Save to versioned storage
      for (const collection of transformed) {
        await this.cache.setCollectionInVersion(this.currentVersionId!, collection);
      }

      synced += transformed.length;
      pages++;

      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }

    return { synced, pages };
  }

  /**
   * Phase 3: Reconcile collection-product relationships
   */
  private async reconcileCollections(): Promise<void> {
    const collections = await this.cache.getAllCollections();
    const products = await this.cache.getAllProducts();
    const productHandleSet = new Set(products.map(p => p.handle));

    for (const collection of collections) {
      // Filter product handles to only those that exist
      const validHandles = collection.productHandles?.filter((h: string) =>
        productHandleSet.has(h)
      ) || [];

      if (validHandles.length !== (collection.productHandles?.length || 0)) {
        await this.cache.setCollection({
          ...collection,
          productHandles: validHandles,
        });
      }
    }
  }

  /**
   * Phase 4: Validate the catalog
   */
  private async validate(versionId: string): Promise<ValidationResult> {
    const products = await this.cache.getAllProducts();
    const collections = await this.cache.getAllCollections();

    return this.validator.validate(versionId, {
      versionId,
      shopifyProductsCount: await this.productSync.adminClient.getProductsCount(),
      shopifyCollectionsCount: await this.productSync.adminClient.getProductsCount(), // TODO: get collections count
      minProductCount: 1,
      maxDropPercent: 50,
    });
  }

  /**
   * Phase 5: Activate the version
   */
  private async activateVersion(versionId: string): Promise<void> {
    await this.cache.activateVersion(versionId);
  }

  /**
   * Abort the current sync
   */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Get current sync status
   */
  async getStatus(): Promise<SyncState & { versionId?: string }> {
    const state = await this.cache.getSyncState();
    return { ...state, versionId: this.currentVersionId || undefined };
  }
}

export function createCatalogSyncOrchestrator(adminClient: ShopifyAdminClient, cache: ICache): CatalogSyncOrchestrator {
  return new CatalogSyncOrchestrator(adminClient, cache);
}