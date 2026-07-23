/**
 * Redis cache implementation for catalog v2
 * Production-grade with connection pooling, pipelining, and graceful degradation
 */

import Redis from 'ioredis';
import { ICache, CacheConfig, IVersionedCache } from './interface';
import {
  Product,
  Collection,
  SyncState,
  CatalogVersionMeta,
  ValidationResult,
} from '../domain/models';

const KEY_PREFIX = 'nood:catalog:v2:';

export class RedisCache implements IVersionedCache {
  private client: Redis;
  private connected = false;
  private namespace: string;
  private versionPrefix: string;
  private versionId: string | null = null;

  constructor(config: CacheConfig) {
    this.namespace = config.namespace || 'nood';
    this.versionPrefix = `${KEY_PREFIX}${this.namespace}:versions:`;

    this.client = new Redis(config.redisUrl!, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) return null; // Stop retrying
        return Math.min(times * 200, 2000);
      },
    });

    this.client.on('connect', () => {
      this.connected = true;
      console.log('[Catalog v2 Redis] Connected');
    });

    this.client.on('error', (err) => {
      this.connected = false;
      console.error('[Catalog v2 Redis] Error:', err.message);
    });

    this.client.on('close', () => {
      this.connected = false;
      console.warn('[Catalog v2 Redis] Connection closed');
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.client.status === 'ready';
  }

  driver(): 'redis' {
    return 'redis';
  }

  // ============ Key Helpers ============

  private p(key: string): string {
    return `${KEY_PREFIX}${this.namespace}:${key}`;
  }

  private vp(versionId: string, part: string): string {
    return `${this.versionPrefix}${versionId}:${part}`;
  }

  private vpCurrent(part: string): string {
    if (!this.versionId) {
      throw new Error('No active version - call beginVersion() first');
    }
    return this.vp(this.versionId, part);
  }

  // ============ Products ============

  async getProduct(handle: string): Promise<Product | null> {
    const key = this.p(`products:${handle}`);
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async getProductById(gid: string): Promise<Product | null> {
    // Reverse lookup: we maintain a handle->gid index
    const handle = await this.client.get(this.p(`product-gid:${gid}`));
    if (!handle) return null;
    return this.getProduct(handle);
  }

  async getProductsByHandles(handles: string[]): Promise<Product[]> {
    if (!handles.length) return [];

    const keys = handles.map(h => this.p(`products:${h}`));
    const values = await this.client.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map(v => JSON.parse(v));
  }

  async getAllProducts(): Promise<Product[]> {
    const products: Product[] = [];
    const pattern = this.p('products:*');

    for await (const key of this.client.scanStream({ match: pattern, count: 100 })) {
      const data = await this.client.get(key);
      if (data) products.push(JSON.parse(data));
    }
    return products;
  }

  async getProductCount(): Promise<number> {
    return this.client.scard(this.p('product-handles'));
  }

  async setProduct(product: Product): Promise<void> {
    await this.setProducts([product]);
  }

  async setProducts(products: Product[]): Promise<number> {
    if (!products.length) return 0;

    const pipeline = this.client.pipeline();
    let saved = 0;

    for (const product of products) {
      const key = this.p(`products:${product.handle}`);
      pipeline.set(key, JSON.stringify(product));
      pipeline.sadd(this.p('product-handles'), product.handle);
      pipeline.set(this.p(`product-gid:${product.id}`), product.handle);
      saved++;
    }

    await pipeline.exec();
    return saved;
  }

  async deleteProduct(handle: string): Promise<boolean> {
    const key = this.p(`products:${handle}`);
    const gidKey = this.p(`product-gid:${handle}`); // Also delete gid mapping if exists
    const result = await this.client.del(key, gidKey);
    await this.client.srem(this.p('product-handles'), handle);
    return result > 0;
  }

  async deleteProducts(handles: string[]): Promise<number> {
    if (!handles.length) return 0;

    const keys = handles.map(h => this.p(`products:${h}`));
    const gidKeys = handles.map(h => this.p(`product-gid:${h}`));
    const allKeys = [...keys, ...gidKeys];

    const deleted = await this.client.del(...allKeys);
    await this.client.srem(this.p('product-handles'), ...handles);
    return deleted;
  }

  async hasProduct(handle: string): Promise<boolean> {
    return this.client.exists(this.p(`products:${handle}`)) === 1;
  }

  // ============ Collections ============

  async getCollection(handle: string): Promise<Collection | null> {
    const key = this.p(`collections:${handle}`);
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async getCollectionById(gid: string): Promise<Collection | null> {
    const handle = await this.client.get(this.p(`collection-gid:${gid}`));
    if (!handle) return null;
    return this.getCollection(handle);
  }

  async getAllCollections(): Promise<Collection[]> {
    const collections: Collection[] = [];
    const pattern = this.p('collections:*');

    for await (const key of this.client.scanStream({ match: pattern, count: 100 })) {
      const data = await this.client.get(key);
      if (data) collections.push(JSON.parse(data));
    }
    return collections;
  }

  async getCollectionCount(): Promise<number> {
    return this.client.scard(this.p('collection-handles'));
  }

  async setCollection(collection: Collection): Promise<void> {
    await this.setCollections([collection]);
  }

  async setCollections(collections: Collection[]): Promise<number> {
    if (!collections.length) return 0;

    const pipeline = this.client.pipeline();
    let saved = 0;

    for (const collection of collections) {
      const key = this.p(`collections:${collection.handle}`);
      pipeline.set(key, JSON.stringify(collection));
      pipeline.sadd(this.p('collection-handles'), collection.handle);
      pipeline.set(this.p(`collection-gid:${collection.id}`), collection.handle);
      saved++;
    }

    await pipeline.exec();
    return saved;
  }

  async deleteCollection(handle: string): Promise<boolean> {
    const key = this.p(`collections:${handle}`);
    const result = await this.client.del(key);
    await this.client.srem(this.p('collection-handles'), handle);
    return result > 0;
  }

  async hasCollection(handle: string): Promise<boolean> {
    return this.client.exists(this.p(`collections:${handle}`)) === 1;
  }

  // ============ Sync State ============

  async getSyncState(): Promise<SyncState> {
    const data = await this.client.get(this.p('sync-state'));
    if (!data) return this.defaultSyncState();
    return JSON.parse(data);
  }

  async setSyncState(state: Partial<SyncState>): Promise<SyncState> {
    const current = await this.getSyncState();
    const next = { ...current, ...state, updatedAt: new Date().toISOString() };
    await this.client.set(this.p('sync-state'), JSON.stringify(next));
    return next;
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
    this.versionId = versionId;

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

    const pipeline = this.client.pipeline();
    pipeline.set(this.vp(versionId, 'meta'), JSON.stringify(meta));
    pipeline.sadd(this.p('versions'), versionId);
    await pipeline.exec();
  }

  async setProductInVersion(versionId: string, product: Product): Promise<void> {
    const key = this.vp(versionId, `products:${product.handle}`);
    await this.client.set(key, JSON.stringify(product));
    await this.client.sadd(this.vp(versionId, 'product-handles'), product.handle);
  }

  async setCollectionInVersion(versionId: string, collection: Collection): Promise<void> {
    const key = this.vp(versionId, `collections:${collection.handle}`);
    await this.client.set(key, JSON.stringify(collection));
    await this.client.sadd(this.vp(versionId, 'collection-handles'), collection.handle);
  }

  async getProductsFromVersion(versionId: string): Promise<Product[]> {
    const handles = await this.client.smembers(this.vp(versionId, 'product-handles'));
    if (!handles.length) return [];

    const keys = handles.map(h => this.vp(versionId, `products:${h}`));
    const values = await this.client.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map(v => JSON.parse(v));
  }

  async getCollectionsFromVersion(versionId: string): Promise<Collection[]> {
    const handles = await this.client.smembers(this.vp(versionId, 'collection-handles'));
    if (!handles.length) return [];

    const keys = handles.map(h => this.vp(versionId, `collections:${h}`));
    const values = await this.client.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map(v => JSON.parse(v));
  }

  async getProductCountForVersion(versionId: string): Promise<number> {
    return this.client.scard(this.vp(versionId, 'product-handles'));
  }

  async getCollectionCountForVersion(versionId: string): Promise<number> {
    return this.client.scard(this.vp(versionId, 'collection-handles'));
  }

  async getCatalogVersionMeta(versionId: string): Promise<CatalogVersionMeta | null> {
    const data = await this.client.get(this.vp(versionId, 'meta'));
    return data ? JSON.parse(data) : null;
  }

  async setCatalogVersionMeta(versionId: string, meta: Partial<CatalogVersionMeta>): Promise<CatalogVersionMeta> {
    const current = await this.getCatalogVersionMeta(versionId);
    const next = { ...(current || { versionId }), ...meta, updatedAt: new Date().toISOString() };
    await this.client.set(this.vp(versionId, 'meta'), JSON.stringify(next));
    return next as CatalogVersionMeta;
  }

  async finalizeVersion(versionId: string, hasNextPage: boolean): Promise<void> {
    const count = await this.getProductCountForVersion(versionId);
    const colCount = await this.getCollectionCountForVersion(versionId);

    await this.setCatalogVersionMeta(versionId, {
      status: 'validated',
      productCount: count,
      collectionCount: colCount,
      hasNextPage,
      validatedAt: new Date().toISOString(),
    });
  }

  async activateVersion(versionId: string): Promise<void> {
    const currentActive = await this.getActiveVersionId();

    const pipeline = this.client.pipeline();
    pipeline.set(this.p('active-version'), versionId);
    pipeline.set(this.p('previous-version'), currentActive || '');

    // Update meta status
    const versionMeta = await this.getCatalogVersionMeta(versionId);
    if (versionMeta) {
      pipeline.set(
        this.vp(versionId, 'meta'),
        JSON.stringify({
          ...versionMeta,
          status: 'active',
          activatedAt: new Date().toISOString(),
        })
      );
    }

    // Mark previous as superseded
    if (currentActive) {
      const prevMeta = await this.getCatalogVersionMeta(currentActive);
      if (prevMeta) {
        pipeline.set(
          this.vp(currentActive, 'meta'),
          JSON.stringify({ ...prevMeta, status: 'superseded', supersededAt: new Date().toISOString() })
        );
      }
    }

    await pipeline.exec();
  }

  async rollbackVersion(): Promise<void> {
    const previous = await this.client.get(this.p('previous-version'));
    if (!previous) throw new Error('No previous version available for rollback');

    const currentActive = await this.getActiveVersionId();
    await this.activateVersion(previous);
  }

  async cleanupVersions(retentionCount: number): Promise<void> {
    const versions = await this.client.smembers(this.p('versions'));
    const metas = await Promise.all(
      versions.map(v => this.getCatalogVersionMeta(v))
    );

    const valid = metas.filter(m => m !== null).sort(
      (a, b) => new Date(b.activatedAt || b.startedAt).getTime() - new Date(a.activatedAt || a.startedAt).getTime()
    );

    const toDelete = valid.slice(retentionCount);
    for (const meta of toDelete) {
      if (meta && meta.status !== 'active') {
        const pipeline = this.client.pipeline();
        pipeline.del(
          this.vp(meta.versionId, 'meta'),
          this.vp(meta.versionId, 'products:*'),
          this.vp(meta.versionId, 'collections:*'),
          this.vp(meta.versionId, 'product-handles'),
          this.vp(meta.versionId, 'collection-handles')
        );
        pipeline.srem(this.p('versions'), meta.versionId);
        await pipeline.exec();
      }
    }
  }

  async getActiveVersionId(): Promise<string | null> {
    return this.client.get(this.p('active-version'));
  }

  async setActiveVersionId(versionId: string): Promise<void> {
    await this.client.set(this.p('active-version'), versionId);
  }

  async listCatalogVersions(): Promise<string[]> {
    return this.client.smembers(this.p('versions'));
  }

  // ============ Menus ============

  async getMenu(handle: string): Promise<any | null> {
    const data = await this.client.get(this.p(`menus:${handle}`));
    return data ? JSON.parse(data) : null;
  }

  async setMenu(handle: string, menu: any): Promise<void> {
    await this.client.set(this.p(`menus:${handle}`), JSON.stringify(menu));
  }

  // ============ Meta ============

  async getMeta(): Promise<Record<string, any>> {
    const data = await this.client.get(this.p('meta'));
    return data ? JSON.parse(data) : {};
  }

  async setMeta(meta: Record<string, any>): Promise<void> {
    await this.client.set(this.p('meta'), JSON.stringify(meta));
  }

  // ============ Validation ============

  async setValidationResult(versionId: string, result: ValidationResult): Promise<void> {
    await this.client.set(this.vp(versionId, 'validation'), JSON.stringify(result));
  }

  async getValidationResult(versionId: string): Promise<ValidationResult | null> {
    const data = await this.client.get(this.vp(versionId, 'validation'));
    return data ? JSON.parse(data) : null;
  }

  // ============ Low-level ============

  async flush(): Promise<void> {
    await this.client.flushall();
  }

  async persist(): Promise<void> {
    // Redis persists automatically
  }

  // ============ Menus ============
  async getMenu(handle: string): Promise<any | null> {
    const data = await this.client.get(this.p(`menus:${handle}`));
    return data ? JSON.parse(data) : null;
  }

  async setMenu(handle: string, menu: any): Promise<void> {
    await this.client.set(this.p(`menus:${handle}`), JSON.stringify(menu));
  }
}