/**
 * In-memory cache implementation for catalog v2
 * Used for development, testing, and CI environments without Redis
 */

import { ICache, CacheConfig, IVersionedCache } from './interface';
import {
  Product,
  Collection,
  SyncState,
  CatalogVersionMeta,
  ValidationResult,
} from '../domain/models';

const KEY_PREFIX = 'nood:catalog:v2:';

interface VersionData {
  products: Map<string, Product>;
  collections: Map<string, Collection>;
  productHandles: Set<string>;
  collectionHandles: Set<string>;
  meta: CatalogVersionMeta;
}

export class MemoryCache implements IVersionedCache {
  private products = new Map<string, Product>();
  private productGidIndex = new Map<string, string>(); // gid -> handle
  private collections = new Map<string, Collection>();
  private collectionGidIndex = new Map<string, string>();
  private productHandles = new Set<string>();
  private collectionHandles = new Set<string>();
  private menus = new Map<string, any>();

  private syncState: SyncState;
  private meta: Record<string, any> = {};

  private versions = new Map<string, VersionData>();
  private versionIds = new Set<string>();
  private activeVersionId: string | null = null;
  private previousVersionId: string | null = null;
  private currentVersionId: string | null = null;

  private validationResults = new Map<string, ValidationResult>();

  constructor(config: CacheConfig) {
    this.syncState = this.defaultSyncState();
  }

  async connect(): Promise<void> {
    // No-op for memory
  }

  async disconnect(): Promise<void> {
    // No-op
  }

  async ping(): Promise<boolean> {
    return true;
  }

  isConnected(): boolean {
    return true;
  }

  driver(): 'memory' {
    return 'memory';
  }

  private p(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }

  private vp(versionId: string, part: string): string {
    return `v:${versionId}:${part}`;
  }

  // ============ Products ============

  async getProduct(handle: string): Promise<Product | null> {
    return this.products.get(handle) || null;
  }

  async getProductById(gid: string): Promise<Product | null> {
    const handle = this.productGidIndex.get(gid);
    if (!handle) return null;
    return this.products.get(handle) || null;
  }

  async getProductsByHandles(handles: string[]): Promise<Product[]> {
    return handles.map(h => this.products.get(h)).filter((p): p is Product => p !== undefined);
  }

  async getAllProducts(): Promise<Product[]> {
    return Array.from(this.products.values());
  }

  async getProductCount(): Promise<number> {
    return this.products.size;
  }

  async setProduct(product: Product): Promise<void> {
    await this.setProducts([product]);
  }

  async setProducts(products: Product[]): Promise<number> {
    let saved = 0;
    for (const product of products) {
      this.products.set(product.handle, product);
      this.productGidIndex.set(product.id, product.handle);
      this.productHandles.add(product.handle);
      saved++;
    }
    return saved;
  }

  async deleteProduct(handle: string): Promise<boolean> {
    const product = this.products.get(handle);
    if (!product) return false;

    this.products.delete(handle);
    this.productGidIndex.delete(product.id);
    this.productHandles.delete(handle);
    return true;
  }

  async deleteProducts(handles: string[]): Promise<number> {
    let deleted = 0;
    for (const handle of handles) {
      if (await this.deleteProduct(handle)) deleted++;
    }
    return deleted;
  }

  async hasProduct(handle: string): Promise<boolean> {
    return this.products.has(handle);
  }

  // ============ Collections ============

  async getCollection(handle: string): Promise<Collection | null> {
    return this.collections.get(handle) || null;
  }

  async getCollectionById(gid: string): Promise<Collection | null> {
    const handle = this.collectionGidIndex.get(gid);
    if (!handle) return null;
    return this.collections.get(handle) || null;
  }

  async getAllCollections(): Promise<Collection[]> {
    return Array.from(this.collections.values());
  }

  async getCollectionCount(): Promise<number> {
    return this.collections.size;
  }

  async setCollection(collection: Collection): Promise<void> {
    await this.setCollections([collection]);
  }

  async setCollections(collections: Collection[]): Promise<number> {
    let saved = 0;
    for (const collection of collections) {
      this.collections.set(collection.handle, collection);
      this.collectionGidIndex.set(collection.id, collection.handle);
      this.collectionHandles.add(collection.handle);
      saved++;
    }
    return saved;
  }

  async deleteCollection(handle: string): Promise<boolean> {
    const collection = this.collections.get(handle);
    if (!collection) return false;

    this.collections.delete(handle);
    this.collectionGidIndex.delete(collection.id);
    this.collectionHandles.delete(handle);
    return true;
  }

  async hasCollection(handle: string): Promise<boolean> {
    return this.collections.has(handle);
  }

  // ============ Sync State ============

  async getSyncState(): Promise<SyncState> {
    return { ...this.syncState };
  }

  async setSyncState(state: Partial<SyncState>): Promise<SyncState> {
    this.syncState = { ...this.syncState, ...state, updatedAt: new Date().toISOString() };
    return { ...this.syncState };
  }

  private defaultSyncState(): SyncState {
    return {
      status: 'idle',
      phase: undefined,
      productCursor: undefined,
      collectionCursor: undefined,
      productsCompleted: false,
      syncedProductCount: 0,
      syncedCollectionCount: 0,
    };
  }

  // ============ Catalog Versioning ============

  async beginVersion(versionId: string): Promise<void> {
    this.currentVersionId = versionId;
    const meta: CatalogVersionMeta = {
      versionId,
      syncId: `sync_${Date.now()}`,
      status: 'running',
      schemaVersion: '1',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      productCount: 0,
      collectionCount: 0,
      hasNextPage: true,
      source: 'shopify',
    };

    const versionData: VersionData = {
      products: new Map(),
      collections: new Map(),
      productHandles: new Set(),
      collectionHandles: new Set(),
      meta,
    };

    this.versions.set(versionId, versionData);
    this.versionIds.add(versionId);
  }

  async setProductInVersion(versionId: string, product: Product): Promise<void> {
    const version = this.versions.get(versionId);
    if (!version) throw new Error(`Version ${versionId} not found`);

    version.products.set(product.handle, product);
    version.productHandles.add(product.handle);
    version.meta.productCount = version.products.size;
    version.meta.updatedAt = new Date().toISOString();
  }

  async setCollectionInVersion(versionId: string, collection: Collection): Promise<void> {
    const version = this.versions.get(versionId);
    if (!version) throw new Error(`Version ${versionId} not found`);

    version.collections.set(collection.handle, collection);
    version.collectionHandles.add(collection.handle);
    version.meta.collectionCount = version.collections.size;
    version.meta.updatedAt = new Date().toISOString();
  }

  async getProductsFromVersion(versionId: string): Promise<Product[]> {
    const version = this.versions.get(versionId);
    if (!version) return [];
    return Array.from(version.products.values());
  }

  async getCollectionsFromVersion(versionId: string): Promise<Collection[]> {
    const version = this.versions.get(versionId);
    if (!version) return [];
    return Array.from(version.collections.values());
  }

  async getProductCountForVersion(versionId: string): Promise<number> {
    const version = this.versions.get(versionId);
    return version?.products.size || 0;
  }

  async getCollectionCountForVersion(versionId: string): Promise<number> {
    const version = this.versions.get(versionId);
    return version?.collections.size || 0;
  }

  async getCatalogVersionMeta(versionId: string): Promise<CatalogVersionMeta | null> {
    const version = this.versions.get(versionId);
    return version?.meta || null;
  }

  async setCatalogVersionMeta(versionId: string, meta: Partial<CatalogVersionMeta>): Promise<CatalogVersionMeta> {
    const version = this.versions.get(versionId);
    if (!version) throw new Error(`Version ${versionId} not found`);

    version.meta = { ...version.meta, ...meta, updatedAt: new Date().toISOString() };
    return version.meta;
  }

  async finalizeVersion(versionId: string, hasNextPage: boolean): Promise<void> {
    const version = this.versions.get(versionId);
    if (!version) throw new Error(`Version ${versionId} not found`);

    version.meta.status = 'validated';
    version.meta.productCount = version.products.size;
    version.meta.collectionCount = version.collections.size;
    version.meta.hasNextPage = hasNextPage;
    version.meta.validatedAt = new Date().toISOString();
    version.meta.updatedAt = new Date().toISOString();
  }

  async activateVersion(versionId: string): Promise<void> {
    const version = this.versions.get(versionId);
    if (!version) throw new Error(`Version ${versionId} not found`);

    this.previousVersionId = this.activeVersionId || null;
    this.activeVersionId = versionId;
    version.meta.status = 'active';
    version.meta.activatedAt = new Date().toISOString();

    // Promote version data to main storage
    for (const [handle, product] of version.products) {
      this.products.set(handle, product);
      this.productGidIndex.set(product.id, handle);
      this.productHandles.add(handle);
    }
    for (const [handle, collection] of version.collections) {
      this.collections.set(handle, collection);
      this.collectionGidIndex.set(collection.id, handle);
      this.collectionHandles.add(handle);
    }
  }

  async rollbackVersion(): Promise<void> {
    if (!this.previousVersionId) throw new Error('No previous version available for rollback');
    await this.activateVersion(this.previousVersionId);
  }

  async cleanupVersions(retentionCount: number): Promise<void> {
    const versions = Array.from(this.versionIds);
    const metas = await Promise.all(versions.map(v => this.getCatalogVersionMeta(v)));

    const valid = metas
      .filter(m => m !== null)
      .sort((a, b) => new Date(b.activatedAt || b.startedAt).getTime() - new Date(a.activatedAt || a.startedAt).getTime());

    const toDelete = valid.slice(retentionCount);
    for (const meta of toDelete) {
      if (meta && meta.status !== 'active') {
        this.versions.delete(meta.versionId);
        this.versionIds.delete(meta.versionId);
      }
    }
  }

  async getActiveVersionId(): Promise<string | null> {
    return this.activeVersionId;
  }

  async setActiveVersionId(versionId: string): Promise<void> {
    this.activeVersionId = versionId;
  }

  async listCatalogVersions(): Promise<string[]> {
    return Array.from(this.versionIds);
  }

  // ============ Menus ============

  async getMenu(handle: string): Promise<any | null> {
    return this.menus.get(handle) || null;
  }

  async setMenu(handle: string, menu: any): Promise<void> {
    this.menus.set(handle, menu);
  }

  // ============ Meta ============

  async getMeta(): Promise<Record<string, any>> {
    return { ...this.meta };
  }

  async setMeta(meta: Record<string, any>): Promise<void> {
    this.meta = { ...this.meta, ...meta };
  }

  // ============ Validation ============

  async setValidationResult(versionId: string, result: ValidationResult): Promise<void> {
    this.validationResults.set(versionId, result);
  }

  async getValidationResult(versionId: string): Promise<ValidationResult | null> {
    return this.validationResults.get(versionId) || null;
  }

  // ============ Low-level ============

  async flush(): Promise<void> {
    this.products.clear();
    this.productGidIndex.clear();
    this.collections.clear();
    this.collectionGidIndex.clear();
    this.productHandles.clear();
    this.collectionHandles.clear();
    this.menus.clear();
    this.versions.clear();
    this.versionIds.clear();
    this.activeVersionId = null;
    this.previousVersionId = null;
    this.currentVersionId = null;
    this.syncState = this.defaultSyncState();
    this.meta = {};
    this.validationResults.clear();
  }

  async persist(): Promise<void> {
    // No-op for memory cache
  }
}