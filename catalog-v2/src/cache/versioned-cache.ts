/**
 * Versioned Cache Wrapper
 * Adds catalog versioning support on top of any ICache implementation
 */

import { ICache, CacheConfig } from './interface';
import {
  Product,
  Collection,
  SyncState,
  CatalogVersionMeta,
  ValidationResult,
} from '../domain/models';

export interface VersionedCacheConfig extends CacheConfig {
  versionRetentionCount?: number;
}

export class VersionedCache implements ICache {
  private baseCache: ICache;
  private config: VersionedCacheConfig;
  private currentVersionId: string | null = null;
  private isStaging = false;

  constructor(baseCache: ICache, config: VersionedCacheConfig) {
    this.baseCache = baseCache;
    this.config = config;
  }

  // Delegate all standard operations to base cache
  async connect(): Promise<void> {
    return this.baseCache.connect();
  }

  async disconnect(): Promise<void> {
    return this.baseCache.disconnect();
  }

  async ping(): Promise<boolean> {
    return this.baseCache.ping();
  }

  isConnected(): boolean {
    return this.baseCache.isConnected();
  }

  driver(): string {
    return `versioned:${this.baseCache.driver()}`;
  }

  // ============ Products ============

  async getProduct(handle: string): Promise<Product | null> {
    return this.baseCache.getProduct(handle);
  }

  async getProductById(gid: string): Promise<Product | null> {
    return this.baseCache.getProductById(gid);
  }

  async getProductsByHandles(handles: string[]): Promise<Product[]> {
    return this.baseCache.getProductsByHandles(handles);
  }

  async getAllProducts(): Promise<Product[]> {
    return this.baseCache.getAllProducts();
  }

  async getProductCount(): Promise<number> {
    return this.baseCache.getProductCount();
  }

  async setProduct(product: Product): Promise<void> {
    if (this.isStaging && this.currentVersionId) {
      await this.setProductInVersion(this.currentVersionId, product);
    } else {
      await this.baseCache.setProduct(product);
    }
  }

  async setProducts(products: Product[]): Promise<number> {
    if (this.isStaging && this.currentVersionId) {
      let saved = 0;
      for (const product of products) {
        await this.setProductInVersion(this.currentVersionId!, product);
        saved++;
      }
      return saved;
    }
    return this.baseCache.setProducts(products);
  }

  async deleteProduct(handle: string): Promise<boolean> {
    if (this.isStaging && this.currentVersionId) {
      // In staging, we don't delete - we just don't include in next version
      return true;
    }
    return this.baseCache.deleteProduct(handle);
  }

  async deleteProducts(handles: string[]): Promise<number> {
    if (this.isStaging) return handles.length; // No-op in staging
    return this.baseCache.deleteProducts(handles);
  }

  async hasProduct(handle: string): Promise<boolean> {
    return this.baseCache.hasProduct(handle);
  }

  // ============ Collections ============

  async getCollection(handle: string): Promise<Collection | null> {
    return this.baseCache.getCollection(handle);
  }

  async getCollectionById(gid: string): Promise<Collection | null> {
    return this.baseCache.getCollectionById(gid);
  }

  async getAllCollections(): Promise<Collection[]> {
    return this.baseCache.getAllCollections();
  }

  async getCollectionCount(): Promise<number> {
    return this.baseCache.getCollectionCount();
  }

  async setCollection(collection: Collection): Promise<void> {
    if (this.isStaging && this.currentVersionId) {
      await this.setCollectionInVersion(this.currentVersionId, collection);
    } else {
      await this.baseCache.setCollection(collection);
    }
  }

  async setCollections(collections: Collection[]): Promise<number> {
    if (this.isStaging && this.currentVersionId) {
      let saved = 0;
      for (const collection of collections) {
        await this.setCollectionInVersion(this.currentVersionId!, collection);
        saved++;
      }
      return saved;
    }
    return this.baseCache.setCollections(collections);
  }

  async deleteCollection(handle: string): Promise<boolean> {
    if (this.isStaging) return true;
    return this.baseCache.deleteCollection(handle);
  }

  async hasCollection(handle: string): Promise<boolean> {
    return this.baseCache.hasCollection(handle);
  }

  // ============ Sync State ============

  async getSyncState(): Promise<SyncState> {
    return this.baseCache.getSyncState();
  }

  async setSyncState(state: Partial<SyncState>): Promise<SyncState> {
    return this.baseCache.setSyncState(state);
  }

  // ============ Catalog Versioning ============

  async beginVersion(versionId: string): Promise<void> {
    this.currentVersionId = versionId;
    this.isStaging = true;
  }

  async setProductInVersion(versionId: string, product: Product): Promise<void> {
    // Store in a version-specific namespace
    const key = `version:${versionId}:products:${product.handle}`;
    // We'll use a separate storage mechanism for versioned data
    // For now, store with version prefix
    await this.setVersionedProduct(versionId, product);
  }

  async setCollectionInVersion(versionId: string, collection: Collection): Promise<void> {
    await this.setVersionedCollection(versionId, collection);
  }

  async getProductsFromVersion(versionId: string): Promise<Product[]> {
    return this.getVersionedProducts(versionId);
  }

  async getCollectionsFromVersion(versionId: string): Promise<Collection[]> {
    return this.getVersionedCollections(versionId);
  }

  async getProductCountForVersion(versionId: string): Promise<number> {
    const products = await this.getVersionedProducts(versionId);
    return products.length;
  }

  async getCollectionCountForVersion(versionId: string): Promise<number> {
    const collections = await this.getVersionedCollections(versionId);
    return collections.length;
  }

  async getCatalogVersionMeta(versionId: string): Promise<CatalogVersionMeta | null> {
    return this.getVersionMeta(versionId);
  }

  async setCatalogVersionMeta(versionId: string, meta: Partial<CatalogVersionMeta>): Promise<CatalogVersionMeta> {
    return this.setVersionMeta(versionId, meta);
  }

  async finalizeVersion(versionId: string, hasNextPage: boolean): Promise<void> {
    await this.setVersionMeta(versionId, {
      status: 'validated',
      hasNextPage,
      validatedAt: new Date().toISOString(),
    });
  }

  async activateVersion(versionId: string): Promise<void> {
    // Move version data to active storage
    const products = await this.getVersionedProducts(versionId);
    const collections = await this.getVersionedCollections(versionId);

    // Save to active storage
    for (const product of products) {
      await this.baseCache.setProduct(product);
    }
    for (const collection of collections) {
      await this.baseCache.setCollection(collection);
    }

    // Update active version pointer
    await this.setActiveVersionId(versionId);
  }

  async rollbackVersion(): Promise<void> {
    // Implementation depends on previous version tracking
    const previous = await this.getPreviousVersionId();
    if (!previous) throw new Error('No previous version available');
    await this.activateVersion(previous);
  }

  async cleanupVersions(retentionCount: number): Promise<void> {
    // Implementation for cleaning old versions
  }

  async getActiveVersionId(): Promise<string | null> {
    // Use base cache or internal storage
    return this.getActiveVersionIdInternal();
  }

  async setActiveVersionId(versionId: string): Promise<void> {
    await this.setActiveVersionIdInternal(versionId);
  }

  async listCatalogVersions(): Promise<string[]> {
    return this.getVersionListInternal();
  }

  // ============ Menus ============

  async getMenu(handle: string): Promise<any | null> {
    return this.baseCache.getMenu(handle);
  }

  async setMenu(handle: string, menu: any): Promise<void> {
    return this.baseCache.setMenu(handle, menu);
  }

  // ============ Meta ============

  async getMeta(): Promise<Record<string, any>> {
    return this.baseCache.getMeta();
  }

  async setMeta(meta: Record<string, any>): Promise<void> {
    return this.baseCache.setMeta(meta);
  }

  // ============ Validation ============

  async setValidationResult(versionId: string, result: ValidationResult): Promise<void> {
    await this.setVersionValidation(versionId, result);
  }

  async getValidationResult(versionId: string): Promise<ValidationResult | null> {
    return this.getVersionValidation(versionId);
  }

  // ============ Low-level ============

  async flush(): Promise<void> {
    await this.baseCache.flush();
  }

  async persist(): Promise<void> {
    return this.baseCache.persist();
  }

  // ============ Private methods for versioned storage ============

  private async setVersionedProduct(versionId: string, product: Product): Promise<void> {
    const key = `versioned:${versionId}:products:${product.handle}`;
    // Use base cache's low-level storage or maintain internal map
    if ('setVersioned' in this.baseCache) {
      return (this.baseCache as any).setVersioned(key, product);
    }
    // Fallback: store in base cache with version prefix
    await this.baseCache.setMeta({ [key]: product });
  }

  private async setVersionedCollection(versionId: string, collection: Collection): Promise<void> {
    if ('setVersioned' in this.baseCache) {
      return (this.baseCache as any).setVersioned(`versioned:${versionId}:collections:${collection.handle}`, collection);
    }
    await this.baseCache.setMeta({ [`versioned:${versionId}:collections:${collection.handle}`]: collection });
  }

  private async getVersionedProducts(versionId: string): Promise<Product[]> {
    // Implementation depends on base cache capabilities
    if ('getVersionedProducts' in this.baseCache) {
      return (this.baseCache as any).getVersionedProducts(versionId);
    }
    return [];
  }

  private async getVersionedCollections(versionId: string): Promise<Collection[]> {
    if ('getVersionedCollections' in this.baseCache) {
      return (this.baseCache as any).getVersionedCollections(versionId);
    }
    return [];
  }

  private async getVersionMeta(versionId: string): Promise<CatalogVersionMeta | null> {
    if ('getVersionMeta' in this.baseCache) {
      return (this.baseCache as any).getVersionMeta(versionId);
    }
    return null;
  }

  private async setVersionMeta(versionId: string, meta: Partial<CatalogVersionMeta>): Promise<CatalogVersionMeta> {
    if ('setVersionMeta' in this.baseCache) {
      return (this.baseCache as any).setVersionMeta(versionId, meta);
    }
    return meta as CatalogVersionMeta;
  }

  private async setVersionValidation(versionId: string, result: ValidationResult): Promise<void> {
    if ('setVersionValidation' in this.baseCache) {
      return (this.baseCache as any).setVersionValidation(versionId, result);
    }
  }

  private async getVersionValidation(versionId: string): Promise<ValidationResult | null> {
    if ('getVersionValidation' in this.baseCache) {
      return (this.baseCache as any).getVersionValidation(versionId);
    }
    return null;
  }

  // Internal methods for version management
  private async getActiveVersionIdInternal(): Promise<string | null> {
    if ('getActiveVersionIdInternal' in this.baseCache) {
      return (this.baseCache as any).getActiveVersionIdInternal();
    }
    return null;
  }

  private async setActiveVersionIdInternal(versionId: string): Promise<void> {
    if ('setActiveVersionIdInternal' in this.baseCache) {
      return (this.baseCache as any).setActiveVersionIdInternal(versionId);
    }
  }

  private async getPreviousVersionId(): Promise<string | null> {
    if ('getPreviousVersionId' in this.baseCache) {
      return (this.baseCache as any).getPreviousVersionId();
    }
    return null;
  }

  private async getVersionListInternal(): Promise<string[]> {
    if ('getVersionListInternal' in this.baseCache) {
      return (this.baseCache as any).getVersionListInternal();
    }
    return [];
  }

  private async setVersionedProduct(versionId: string, product: Product): Promise<void> {
    // Implemented by specific cache backends
  }

  private async setVersionedCollection(versionId: string, collection: Collection): Promise<void> {
    // Implemented by specific cache backends
  }
}