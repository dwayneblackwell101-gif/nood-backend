require('../config/env').loadEnv();

const { createCatalogCache } = require('../catalog/cache/redis-cache');

function hasFlag(name) {
  return process.argv.includes(name);
}

(async () => {
  const apply = hasFlag('--apply');
  if (apply && !hasFlag('--confirm-catalog-rollback')) {
    throw new Error('Rollback apply mode requires --confirm-catalog-rollback.');
  }

  const cache = await createCatalogCache();
  if (typeof cache.rollbackCatalogVersion !== 'function') {
    throw new Error('Catalog rollback requires versioned Redis catalog storage.');
  }

  const result = await cache.rollbackCatalogVersion({
    apply,
    actor: 'catalog-rollback-cli',
    reason: apply ? 'manual_confirmed_rollback' : 'dry_run',
  });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
