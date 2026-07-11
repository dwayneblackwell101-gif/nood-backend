require('../config/env').loadEnv();

const { createCatalogCache } = require('../catalog/cache/redis-cache');

function hasFlag(name) {
  return process.argv.includes(name);
}

(async () => {
  const apply = hasFlag('--apply');
  if (apply && !hasFlag('--confirm-catalog-cleanup')) {
    throw new Error('Cleanup apply mode requires --confirm-catalog-cleanup.');
  }

  const cache = await createCatalogCache();
  if (typeof cache.cleanupCatalogVersions !== 'function') {
    throw new Error('Catalog cleanup requires versioned Redis catalog storage.');
  }

  const result = await cache.cleanupCatalogVersions({ apply });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
