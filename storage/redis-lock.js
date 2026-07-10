const crypto = require('crypto');

const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createRedisLockService({ redis, namespace = 'nood' } = {}) {
  if (!redis) {
    return null;
  }

  async function acquireLock(key, ttlSeconds = 30) {
    const lockKey = `${namespace}:lock:${safeString(key)}`;
    const token = crypto.randomBytes(18).toString('hex');
    const result = await redis.set(lockKey, token, 'NX', 'EX', Math.max(1, Number(ttlSeconds) || 30));

    if (result !== 'OK') {
      const error = new Error('Operation is already in progress.');
      error.statusCode = 409;
      error.lockKey = lockKey;
      throw error;
    }

    return {
      key: lockKey,
      token,
      async release() {
        await redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
      },
    };
  }

  async function withLock(key, ttlSeconds, fn) {
    const lock = await acquireLock(key, ttlSeconds);
    try {
      return await fn(lock);
    } finally {
      await lock.release();
    }
  }

  return {
    acquireLock,
    withLock,
  };
}

module.exports = {
  createRedisLockService,
  RELEASE_SCRIPT,
};
