require('../config/env').loadEnv();

const { createCatalogCache } = require('../catalog/cache/redis-cache');
const { createCatalogSyncLock } = require('../catalog/catalog-lock');

function hasFlag(name) {
  return process.argv.includes(name);
}

(async () => {
  if (!hasFlag('--confirm-catalog-force-unlock')) {
    throw new Error('Catalog force unlock requires --confirm-catalog-force-unlock.');
  }

  const cache = await createCatalogCache();
  const lock = createCatalogSyncLock({
    redis: cache?.client || null,
    namespace: String(process.env.REDIS_NAMESPACE || 'nood').trim() || 'nood',
  });
  const result = await lock.forceUnlock({
    actor: 'catalog-force-unlock-cli',
    reason: 'manual_stale_lock_recovery',
  });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
