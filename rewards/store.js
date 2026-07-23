/**
 * Rewards state store — Redis when available, in-memory for tests/local.
 * All reward eligibility and claims are stored server-side.
 */

const crypto = require('crypto');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createMemoryMapStore() {
  const maps = new Map();

  function bag(name) {
    if (!maps.has(name)) maps.set(name, new Map());
    return maps.get(name);
  }

  return {
    driver: 'memory',
    async get(mapName, key) {
      return bag(mapName).get(String(key)) ?? null;
    },
    async set(mapName, key, value, _ttlSeconds) {
      bag(mapName).set(String(key), value);
      return value;
    },
    async del(mapName, key) {
      return bag(mapName).delete(String(key));
    },
    async incr(mapName, key, ttlSeconds) {
      const m = bag(mapName);
      const k = String(key);
      const next = Number(m.get(k) || 0) + 1;
      m.set(k, next);
      if (ttlSeconds && !m.has(`${k}:ttl`)) {
        m.set(`${k}:ttl`, Date.now() + ttlSeconds * 1000);
        setTimeout(() => {
          m.delete(k);
          m.delete(`${k}:ttl`);
        }, ttlSeconds * 1000).unref?.();
      }
      return next;
    },
    async lpush(mapName, key, value, maxLen) {
      const m = bag(mapName);
      const k = String(key);
      const list = Array.isArray(m.get(k)) ? m.get(k) : [];
      list.unshift(value);
      if (maxLen && list.length > maxLen) list.length = maxLen;
      m.set(k, list);
      return list.length;
    },
    async lrange(mapName, key, start, end) {
      const list = bag(mapName).get(String(key)) || [];
      if (!Array.isArray(list)) return [];
      const stop = end < 0 ? list.length + end + 1 : end + 1;
      return list.slice(start, stop);
    },
  };
}

function createRedisMapStore(redis, namespace) {
  const prefix = `${namespace}:rewards`;

  function key(mapName, id) {
    return `${prefix}:${mapName}:${safeString(id)}`;
  }

  return {
    driver: 'redis',
    async get(mapName, id) {
      const raw = await redis.get(key(mapName, id));
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    async set(mapName, id, value, ttlSeconds) {
      const payload = typeof value === 'string' ? value : JSON.stringify(value);
      const k = key(mapName, id);
      if (ttlSeconds && ttlSeconds > 0) {
        await redis.set(k, payload, 'EX', ttlSeconds);
      } else {
        await redis.set(k, payload);
      }
      return value;
    },
    async del(mapName, id) {
      await redis.del(key(mapName, id));
      return true;
    },
    async incr(mapName, id, ttlSeconds) {
      const k = key(mapName, id);
      const next = await redis.incr(k);
      if (ttlSeconds && next === 1) {
        await redis.expire(k, ttlSeconds);
      }
      return next;
    },
    async lpush(mapName, id, value, maxLen) {
      const k = key(mapName, id);
      const payload = typeof value === 'string' ? value : JSON.stringify(value);
      await redis.lpush(k, payload);
      if (maxLen && maxLen > 0) {
        await redis.ltrim(k, 0, maxLen - 1);
      }
      return redis.llen(k);
    },
    async lrange(mapName, id, start, end) {
      const rows = await redis.lrange(key(mapName, id), start, end);
      return rows.map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      });
    },
  };
}

function createRewardsStore({ redis = null, namespace = 'nood' } = {}) {
  const backend = redis ? createRedisMapStore(redis, namespace) : createMemoryMapStore();

  function createEmptyProfile(customerId) {
    const now = new Date().toISOString();
    return {
      customerId: safeString(customerId),
      referralCode: '',
      challenge: null,
      luckySpin: {
        usedAt: null,
        prizeId: null,
        amountUsd: null,
        unlockRequirementUsd: null,
        label: null,
        walletTransactionId: null,
      },
      scratch: {
        completedAt: null,
        amountUsd: null,
        walletTransactionId: null,
      },
      daily: {
        lastCheckInDate: null,
        streak: 0,
        totalCheckIns: 0,
      },
      missions: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async function getProfile(customerId) {
    const id = safeString(customerId);
    if (!id) return null;
    return backend.get('profile', id);
  }

  async function saveProfile(profile) {
    const next = {
      ...profile,
      updatedAt: new Date().toISOString(),
    };
    await backend.set('profile', next.customerId, next);
    return next;
  }

  async function getOrCreateProfile(customerId) {
    const existing = await getProfile(customerId);
    if (existing) return existing;
    const created = createEmptyProfile(customerId);
    return saveProfile(created);
  }

  async function setReferralCodeIndex(code, customerId) {
    await backend.set('referral_code', safeString(code).toUpperCase(), {
      customerId: safeString(customerId),
      code: safeString(code).toUpperCase(),
    });
  }

  async function getCustomerIdByReferralCode(code) {
    const row = await backend.get('referral_code', safeString(code).toUpperCase());
    return safeString(row?.customerId || '');
  }

  async function getAttribution(referredCustomerId) {
    return backend.get('attribution', referredCustomerId);
  }

  async function saveAttribution(record) {
    await backend.set('attribution', record.referredCustomerId, record);
    return record;
  }

  async function getIdempotency(customerId, idempotencyKey) {
    return backend.get('idempotency', `${safeString(customerId)}:${safeString(idempotencyKey)}`);
  }

  async function saveIdempotency(customerId, idempotencyKey, result, ttlSeconds) {
    await backend.set(
      'idempotency',
      `${safeString(customerId)}:${safeString(idempotencyKey)}`,
      result,
      ttlSeconds
    );
    return result;
  }

  async function pushHistory(customerId, entry, maxLen) {
    await backend.lpush('history', customerId, entry, maxLen);
  }

  async function listHistory(customerId, limit = 50) {
    return backend.lrange('history', customerId, 0, Math.max(0, limit - 1));
  }

  async function pushAudit(entry, maxLen = 5000) {
    await backend.lpush('audit', 'global', entry, maxLen);
  }

  async function incrMetric(name, ttlSeconds = 60 * 60 * 24) {
    return backend.incr('metrics', name, ttlSeconds);
  }

  async function incrRate(bucket, ttlSeconds) {
    return backend.incr('rate', bucket, ttlSeconds);
  }

  function createActionId(prefix = 'reward') {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  return {
    driver: backend.driver,
    createEmptyProfile,
    getProfile,
    saveProfile,
    getOrCreateProfile,
    setReferralCodeIndex,
    getCustomerIdByReferralCode,
    getAttribution,
    saveAttribution,
    getIdempotency,
    saveIdempotency,
    pushHistory,
    listHistory,
    pushAudit,
    incrMetric,
    incrRate,
    createActionId,
  };
}

module.exports = {
  createRewardsStore,
  createMemoryMapStore,
};
