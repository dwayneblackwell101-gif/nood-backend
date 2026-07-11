require('../config/env').loadEnv();

process.env.CATALOG_LEGACY_FALLBACK_ENABLED = 'true';

const { createCatalogCache } = require('../catalog/cache/redis-cache');
const { validateCatalogVersion } = require('../catalog/catalog-validator');

function hasFlag(name) {
  return process.argv.includes(name);
}

(async () => {
  const apply = hasFlag('--apply');
  if (apply && !hasFlag('--confirm-catalog-migration')) {
    throw new Error('Migration apply mode requires --confirm-catalog-migration.');
  }

  const cache = await createCatalogCache();
  if (typeof cache.beginCatalogStaging !== 'function') {
    throw new Error('Catalog migration requires versioned Redis catalog storage.');
  }

  const existingActive = await cache.getActiveVersionId();
  const products = typeof cache.getAllProducts === 'function' ? await cache.getAllProducts() : [];
  const collections = typeof cache.getAllCollections === 'function' ? await cache.getAllCollections() : [];
  const summary = {
    apply,
    existingActiveVersion: existingActive || null,
    productCount: products.length,
    collectionCount: collections.length,
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (existingActive) {
    throw new Error('Active catalog version already exists; migration refused.');
  }
  if (!products.length) {
    throw new Error('Legacy catalog has no products; migration refused.');
  }

  const { versionId } = await cache.beginCatalogStaging({ syncId: `migration_${Date.now()}` });
  await cache.replaceAll({
    products,
    collections,
    menus: {},
    meta: {
      source: 'legacy-migration',
      productCount: products.length,
      collectionCount: collections.length,
      syncInProgress: false,
      lastSyncAt: new Date().toISOString(),
    },
  });
  await cache.finalizeCatalogStaging({ versionId, hasNextPage: false, status: 'validating' });
  const validation = await validateCatalogVersion(cache, versionId, { allowCountDropOverride: true });
  await cache.finalizeCatalogStaging({ versionId, hasNextPage: false, status: 'validated', validation });
  const activeMeta = await cache.activateCatalogVersion(versionId, {
    actor: 'catalog-migration-cli',
    reason: 'legacy_catalog_migration',
    validation,
  });
  console.log(JSON.stringify({ ...summary, versionId, activatedAt: activeMeta.activatedAt }, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
