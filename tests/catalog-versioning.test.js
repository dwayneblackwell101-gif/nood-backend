const assert = require('node:assert/strict');
const test = require('node:test');

const { createCatalogSyncLock } = require('../catalog/catalog-lock');
const { validateCatalogVersion } = require('../catalog/catalog-validator');

function createFakeRedis() {
  const strings = new Map();
  const lists = new Map();

  return {
    async get(key) {
      return strings.get(key) || null;
    },
    async set(key, value, ...args) {
      if (args.includes('NX') && strings.has(key)) return null;
      strings.set(key, String(value));
      return 'OK';
    },
    async del(key) {
      const existed = strings.delete(key);
      return existed ? 1 : 0;
    },
    async lpush(key, value) {
      const list = lists.get(key) || [];
      list.unshift(String(value));
      lists.set(key, list);
      return list.length;
    },
    async eval(_script, _keyCount, key, ownerToken) {
      if (strings.get(key) !== ownerToken) return 0;
      if (_script.includes('EXPIRE')) return 1;
      strings.delete(key);
      return 1;
    },
  };
}

class FakeVersionedCatalog {
  constructor() {
    this.activeVersion = 'v1';
    this.previousVersion = '';
    this.metas = new Map([
      ['v1', {
        versionId: 'v1',
        status: 'active',
        schemaVersion: '1',
        productCount: 2,
        collectionCount: 1,
        hasNextPage: false,
      }],
    ]);
    this.products = new Map([
      ['v1', [
        product('gid://shopify/Product/1', 'hat'),
        product('gid://shopify/Product/2', 'shirt'),
      ]],
    ]);
    this.collections = new Map([
      ['v1', [{ handle: 'featured', productHandles: ['hat', 'shirt'] }]],
    ]);
  }

  async getCatalogVersionMeta(versionId) {
    return this.metas.get(versionId) || null;
  }

  async setCatalogVersionMeta(versionId, patch = {}) {
    const current = this.metas.get(versionId) || { versionId };
    const next = { ...current, ...patch, versionId };
    this.metas.set(versionId, next);
    return next;
  }

  async getActiveCatalogMeta() {
    return this.getCatalogVersionMeta(this.activeVersion);
  }

  async getAllProductsForVersion(versionId) {
    return this.products.get(versionId) || [];
  }

  async getAllCollectionsForVersion(versionId) {
    return this.collections.get(versionId) || [];
  }

  async getActiveVersionId() {
    return this.activeVersion;
  }

  async getPreviousVersionId() {
    return this.previousVersion;
  }

  async finalizeCatalogStaging({ versionId, status, hasNextPage, validation }) {
    return this.setCatalogVersionMeta(versionId, {
      status,
      hasNextPage,
      validation: validation || null,
      productCount: (this.products.get(versionId) || []).length,
      collectionCount: (this.collections.get(versionId) || []).length,
    });
  }

  async activateCatalogVersion(versionId) {
    const meta = await this.getCatalogVersionMeta(versionId);
    if (!meta || meta.status !== 'validated') {
      throw new Error('Catalog version must be validated before activation.');
    }
    const oldActive = this.activeVersion;
    this.previousVersion = oldActive;
    this.activeVersion = versionId;
    this.metas.set(versionId, { ...meta, status: 'active', activatedAt: new Date().toISOString() });
    this.metas.set(oldActive, { ...this.metas.get(oldActive), status: 'superseded' });
    return this.metas.get(versionId);
  }

  async rollbackCatalogVersion({ apply = false } = {}) {
    if (!this.previousVersion) throw new Error('No previous catalog version is available.');
    const summary = {
      apply,
      activeVersion: this.activeVersion,
      targetVersion: this.previousVersion,
    };
    if (!apply) return summary;
    const oldActive = this.activeVersion;
    this.activeVersion = this.previousVersion;
    this.previousVersion = oldActive;
    return { ...summary, rolledBack: true };
  }

  async cleanupCatalogVersions({ apply = false } = {}) {
    const deletableVersions = [];
    for (const [versionId, meta] of this.metas.entries()) {
      if ([this.activeVersion, this.previousVersion].includes(versionId)) continue;
      if (['failed', 'abandoned', 'rolled_back', 'superseded'].includes(meta.status)) {
        deletableVersions.push(versionId);
      }
    }
    if (apply) {
      for (const versionId of deletableVersions) this.metas.delete(versionId);
    }
    return { apply, deletableCount: deletableVersions.length, deletableVersions };
  }
}

function product(id, handle) {
  return {
    id,
    handle,
    variants: { edges: [{ node: { price: { amount: '10.00', currencyCode: 'USD' } } }] },
    images: { edges: [{ node: { url: `https://cdn.example.test/${handle}.jpg` } }] },
  };
}

test('catalog lock enforces ownership for acquire, renew, and release', async () => {
  process.env.CATALOG_SYNC_LOCK_TTL_SECONDS = '30';
  process.env.CATALOG_SYNC_LOCK_RENEW_SECONDS = '10';
  const lock = createCatalogSyncLock({ redis: createFakeRedis(), namespace: 'test' });

  const first = await lock.acquire('first');
  assert.equal(first.acquired, true);
  const second = await lock.acquire('second');
  assert.equal(second.acquired, false);
  assert.equal(await first.renew(), true);
  await first.release();
  const third = await lock.acquire('third');
  assert.equal(third.acquired, true);
});

test('catalog validator rejects incomplete, malformed, and suspicious staging versions', async () => {
  const cache = new FakeVersionedCatalog();
  cache.metas.set('v2', { versionId: 'v2', status: 'running', schemaVersion: '1', productCount: 1, collectionCount: 0, hasNextPage: true });
  cache.products.set('v2', [product('gid://shopify/Product/3', 'pants')]);
  cache.collections.set('v2', []);
  await assert.rejects(() => validateCatalogVersion(cache, 'v2'), /pagination is incomplete/);

  cache.metas.set('v3', { versionId: 'v3', status: 'validating', schemaVersion: '1', productCount: 1, collectionCount: 0, hasNextPage: false });
  cache.products.set('v3', [{ ...product('gid://shopify/Product/4', 'bad'), variants: { edges: [{ node: { price: { amount: 'nope', currencyCode: 'USD' } } }] } }]);
  cache.collections.set('v3', []);
  await assert.rejects(() => validateCatalogVersion(cache, 'v3'), /price is malformed/);

  process.env.CATALOG_MAX_COUNT_DROP_PERCENT = '10';
  cache.metas.set('v4', { versionId: 'v4', status: 'validating', schemaVersion: '1', productCount: 1, collectionCount: 0, hasNextPage: false });
  cache.products.set('v4', [product('gid://shopify/Product/5', 'sock')]);
  cache.collections.set('v4', []);
  await assert.rejects(() => validateCatalogVersion(cache, 'v4'), /count drop exceeds/);
});

test('valid staging activation swaps active pointer and rollback preserves versions', async () => {
  process.env.CATALOG_MAX_COUNT_DROP_PERCENT = '100';
  const cache = new FakeVersionedCatalog();
  cache.metas.set('v2', { versionId: 'v2', status: 'validating', schemaVersion: '1', productCount: 2, collectionCount: 1, hasNextPage: false });
  cache.products.set('v2', [
    product('gid://shopify/Product/3', 'pants'),
    product('gid://shopify/Product/4', 'socks'),
  ]);
  cache.collections.set('v2', [{ handle: 'new', productHandles: ['pants', 'socks'] }]);

  const validation = await validateCatalogVersion(cache, 'v2');
  assert.equal(validation.ok, true);
  await cache.finalizeCatalogStaging({ versionId: 'v2', status: 'validated', hasNextPage: false, validation });
  await cache.activateCatalogVersion('v2');
  assert.equal(await cache.getActiveVersionId(), 'v2');
  assert.equal(await cache.getPreviousVersionId(), 'v1');

  const dryRun = await cache.rollbackCatalogVersion();
  assert.equal(dryRun.apply, false);
  assert.equal(await cache.getActiveVersionId(), 'v2');
  await cache.rollbackCatalogVersion({ apply: true });
  assert.equal(await cache.getActiveVersionId(), 'v1');
});

test('cleanup dry run preserves active and previous catalog versions', async () => {
  const cache = new FakeVersionedCatalog();
  cache.previousVersion = 'v0';
  cache.metas.set('v0', { versionId: 'v0', status: 'superseded' });
  cache.metas.set('old-failed', { versionId: 'old-failed', status: 'failed' });
  const dryRun = await cache.cleanupCatalogVersions();
  assert.deepEqual(dryRun.deletableVersions, ['old-failed']);
  assert.equal(cache.metas.has('old-failed'), true);
  await cache.cleanupCatalogVersions({ apply: true });
  assert.equal(cache.metas.has('old-failed'), false);
  assert.equal(cache.metas.has('v1'), true);
  assert.equal(cache.metas.has('v0'), true);
});
