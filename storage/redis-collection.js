const fs = require('fs');
const path = require('path');

let Redis;
try {
  console.log('[REDIS LOAD 3] requiring ioredis');
  Redis = require('ioredis');
} catch (error) {
  console.error('[REDIS LOAD 3] failed:', error.code || error.name, error.message);
  throw error;
}

class RedisCollection {
  constructor({ name, keyPrefix, keyField, redis, migrateFileName = '' }) {
    this.name = name;
    this.keyPrefix = keyPrefix;
    this.keyField = keyField;
    this.redis = redis;
    this.migrateFilePath = migrateFileName ? path.join(__dirname, '..', migrateFileName) : '';
    this.items = new Map();
  }

  async init() {
    await this.migrateFromJsonIfPresent();
    await this.loadFromRedis();
  }

  async migrateFromJsonIfPresent() {
    if (!this.migrateFilePath || !fs.existsSync(this.migrateFilePath)) {
      return;
    }

    let rows = [];
    try {
      const raw = fs.readFileSync(this.migrateFilePath, 'utf8');
      rows = JSON.parse(raw);
    } catch (error) {
      console.error(`[NOOD storage] failed to read ${this.name} migration file:`, error.message);
      return;
    }

    if (!Array.isArray(rows) || !rows.length) {
      return;
    }

    const indexKey = this.getIndexKey();
    const existingCount = await this.redis.scard(indexKey);
    if (existingCount > 0) {
      return;
    }

    const pipeline = this.redis.pipeline();
    let migrated = 0;

    for (const row of rows) {
      const key = row?.[this.keyField];
      if (!key) {
        continue;
      }

      const normalizedKey = String(key);
      pipeline.set(this.getRecordKey(normalizedKey), JSON.stringify(row));
      pipeline.sadd(indexKey, normalizedKey);
      this.items.set(normalizedKey, row);
      migrated += 1;
    }

    if (migrated > 0) {
      await pipeline.exec();
      console.log(`[NOOD storage] migrated ${migrated} ${this.name} record(s) from JSON to Redis`);
    }
  }

  async loadFromRedis() {
    const keys = await this.redis.smembers(this.getIndexKey());
    if (!keys.length) {
      return;
    }

    const pipeline = this.redis.pipeline();
    keys.forEach((key) => pipeline.get(this.getRecordKey(key)));
    const results = await pipeline.exec();

    results.forEach((entry, index) => {
      const error = entry?.[0];
      const raw = entry?.[1];
      if (error || !raw) {
        return;
      }

      try {
        const row = JSON.parse(raw);
        const key = row?.[this.keyField] || keys[index];
        if (key) {
          this.items.set(String(key), row);
        }
      } catch (parseError) {
        console.error(`[NOOD storage] failed to parse ${this.name} record:`, parseError.message);
      }
    });
  }

  getIndexKey() {
    return `${this.keyPrefix}__index`;
  }

  getRecordKey(key) {
    return `${this.keyPrefix}${String(key)}`;
  }

  persist() {
    // Write-through persistence happens in set/delete.
  }

  get(key) {
    return this.items.get(String(key));
  }

  has(key) {
    return this.items.has(String(key));
  }

  set(key, value) {
    const normalizedKey = String(key);
    this.items.set(normalizedKey, value);

    void this.redis
      .multi()
      .set(this.getRecordKey(normalizedKey), JSON.stringify(value))
      .sadd(this.getIndexKey(), normalizedKey)
      .exec()
      .catch((error) => {
        console.error(`[NOOD storage] failed to persist ${this.name} record:`, error.message);
      });

    return value;
  }

  delete(key) {
    const normalizedKey = String(key);
    const changed = this.items.delete(normalizedKey);

    if (changed) {
      void this.redis
        .multi()
        .del(this.getRecordKey(normalizedKey))
        .srem(this.getIndexKey(), normalizedKey)
        .exec()
        .catch((error) => {
          console.error(`[NOOD storage] failed to delete ${this.name} record:`, error.message);
        });
    }

    return changed;
  }

  values() {
    return Array.from(this.items.values());
  }

  entries() {
    return Array.from(this.items.entries());
  }
}

function createRedisClient(redisUrl) {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  return client;
}

module.exports = {
  RedisCollection,
  createRedisClient,
};