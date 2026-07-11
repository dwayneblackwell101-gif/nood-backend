const crypto = require('crypto');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

const RENEW_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
  end
  return 0
`;

const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

function createCatalogSyncLock({ redis, namespace = 'nood' } = {}) {
  const key = `${namespace}:catalog:sync-lock`;
  const auditKey = `${namespace}:catalog:sync-lock:audit`;
  const ttlSeconds = Number(process.env.CATALOG_SYNC_LOCK_TTL_SECONDS || 900);
  const renewSeconds = Number(process.env.CATALOG_SYNC_LOCK_RENEW_SECONDS || 300);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('CATALOG_SYNC_LOCK_TTL_SECONDS must be a positive integer.');
  if (!Number.isSafeInteger(renewSeconds) || renewSeconds <= 0 || renewSeconds >= ttlSeconds) {
    throw new Error('CATALOG_SYNC_LOCK_RENEW_SECONDS must be positive and lower than CATALOG_SYNC_LOCK_TTL_SECONDS.');
  }

  async function acquire(owner = '') {
    if (!redis) return { acquired: true, ownerToken: '', localOnly: true, renew: async () => true, release: async () => true };
    const ownerToken = `${safeString(owner, 'catalog_sync')}_${process.pid}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const result = await redis.set(key, ownerToken, 'NX', 'EX', ttlSeconds);
    if (result !== 'OK') return { acquired: false };
    return {
      acquired: true,
      ownerToken,
      key,
      async renew() {
        const renewed = await redis.eval(RENEW_SCRIPT, 1, key, ownerToken, ttlSeconds);
        if (Number(renewed) !== 1) {
          const error = new Error('Catalog sync lock ownership was lost.');
          error.code = 'CATALOG_SYNC_LOCK_LOST';
          throw error;
        }
        return true;
      },
      async release() {
        await redis.eval(RELEASE_SCRIPT, 1, key, ownerToken);
      },
    };
  }

  async function forceUnlock({ actor = 'admin', reason = '' } = {}) {
    if (!redis) return { unlocked: false, reason: 'redis_unavailable' };
    const previous = await redis.get(key);
    await redis.del(key);
    const audit = {
      actor: safeString(actor, 'admin'),
      reason: safeString(reason, 'manual_force_unlock'),
      previousLockPresent: Boolean(previous),
      at: new Date().toISOString(),
    };
    await redis.lpush(auditKey, JSON.stringify(audit));
    return { unlocked: Boolean(previous), audit };
  }

  return {
    acquire,
    forceUnlock,
    key,
    ttlSeconds,
    renewSeconds,
  };
}

module.exports = {
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
  createCatalogSyncLock,
};
