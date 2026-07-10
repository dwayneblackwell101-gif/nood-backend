const fs = require('fs');
const path = require('path');

let RedisCollection;
let createRedisClient;
try {
  console.log('[REDIS LOAD 2] requiring ./storage/redis-collection');
  ({ RedisCollection, createRedisClient } = require('./storage/redis-collection'));
} catch (error) {
  console.error('[REDIS LOAD 2] failed:', error.code || error.name, error.message);
  throw error;
}

const STORAGE_DRIVER = String(process.env.STORAGE_DRIVER || 'json').trim().toLowerCase();
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const USE_REDIS_PAYMENT_STORAGE = STORAGE_DRIVER === 'redis' || Boolean(REDIS_URL);
const LOCAL_STATE_FALLBACK_ENABLED = ['1', 'true', 'yes'].includes(
  String(process.env.LOCAL_STATE_FALLBACK_ENABLED || '').trim().toLowerCase()
);

// Local development storage only. These JSON files are convenient for testing,
// but production should use Redis for payment recovery state so records survive deploys.
class JsonCollection {
  constructor({ name, fileName, keyField }) {
    this.name = name;
    this.filePath = path.join(__dirname, fileName);
    this.keyField = keyField;
    this.items = new Map();
    this.ready = Promise.resolve(this.load());
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return;
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return;

      for (const row of rows) {
        const key = row?.[this.keyField];
        if (key) this.items.set(String(key), row);
      }
    } catch (error) {
      console.error(`[NOOD storage] failed to load ${this.name}:`, error.message);
    }
  }

  persist() {
    const rows = Array.from(this.items.values());
    fs.writeFileSync(this.filePath, JSON.stringify(rows, null, 2));
  }

  get(key) {
    return this.items.get(String(key));
  }

  has(key) {
    return this.items.has(String(key));
  }

  set(key, value) {
    this.items.set(String(key), value);
    this.persist();
    return value;
  }

  delete(key) {
    const changed = this.items.delete(String(key));
    if (changed) this.persist();
    return changed;
  }

  values() {
    return Array.from(this.items.values());
  }

  entries() {
    return Array.from(this.items.entries());
  }
}

function createStorage() {
  let redis = null;
  const storageState = {
    paymentStorageDriver: 'json',
    paymentStorageRedisReady: false,
    redisConfigured: false,
    failedPaidOrdersDriver: 'json',
    paymentRecordsDriver: 'json',
  };

  if (process.env.NODE_ENV === 'production' && STORAGE_DRIVER !== 'redis') {
    throw new Error('Production requires STORAGE_DRIVER=redis. Local JSON state is not allowed.');
  }

  if (process.env.NODE_ENV === 'production' && !REDIS_URL) {
    throw new Error('Production requires REDIS_URL for critical backend state.');
  }

  if (STORAGE_DRIVER === 'json' && !LOCAL_STATE_FALLBACK_ENABLED) {
    console.warn(
      '[NOOD storage] local JSON fallback is disabled. Set LOCAL_STATE_FALLBACK_ENABLED=true for local development only.'
    );
  }

  if (STORAGE_DRIVER === 'redis' && !REDIS_URL) {
    throw new Error(
      'STORAGE_DRIVER=redis requires REDIS_URL. Configure a Redis instance for payment recovery storage.'
    );
  }

  if (USE_REDIS_PAYMENT_STORAGE) {
    if (!REDIS_URL) {
      throw new Error(
        'Payment recovery Redis storage requires REDIS_URL. Configure a Redis instance on Render.'
      );
    }

    redis = createRedisClient(REDIS_URL);
    storageState.paymentStorageDriver = 'redis';
    storageState.redisConfigured = true;
    storageState.failedPaidOrdersDriver = 'redis';
    storageState.paymentRecordsDriver = 'redis';
  }

  const pendingOrders = redis
    ? new RedisCollection({
        name: 'pending orders',
        keyPrefix: 'nood:storage:pendingOrders:',
        keyField: 'orderId',
        redis,
        migrateFileName: 'pending-orders.json',
      })
    : new JsonCollection({
        name: 'pending orders',
        fileName: 'pending-orders.json',
        keyField: 'orderId',
      });

  const walletTransactions = redis
    ? new RedisCollection({
        name: 'wallet transactions',
        keyPrefix: 'nood:storage:walletTransactions:',
        keyField: 'walletTransactionId',
        redis,
        migrateFileName: 'wallet-transactions.json',
      })
    : new JsonCollection({
        name: 'wallet transactions',
        fileName: 'wallet-transactions.json',
        keyField: 'walletTransactionId',
      });

  const failedPaidOrders = redis
    ? new RedisCollection({
        name: 'failed paid orders',
        keyPrefix: 'nood:storage:failedPaidOrders:',
        keyField: 'recoveryId',
        redis,
        migrateFileName: 'failed-paid-orders.json',
      })
    : new JsonCollection({
        name: 'failed paid orders',
        fileName: 'failed-paid-orders.json',
        keyField: 'recoveryId',
      });

  const paymentRecords = redis
    ? new RedisCollection({
        name: 'payment records',
        keyPrefix: 'nood:storage:paymentRecords:',
        keyField: 'paymentKey',
        redis,
        migrateFileName: 'payment-records.json',
      })
    : new JsonCollection({
        name: 'payment records',
        fileName: 'payment-records.json',
        keyField: 'paymentKey',
      });

  const refundRequests = redis
    ? new RedisCollection({
        name: 'refund requests',
        keyField: 'request_id',
        keyPrefix: 'nood:storage:refundRequests:',
        redis,
        migrateFileName: 'refund-requests.json',
      })
    : new JsonCollection({
        name: 'refund requests',
        fileName: 'refund-requests.json',
        keyField: 'request_id',
      });

  const pushTokens = redis
    ? new RedisCollection({
        name: 'push tokens',
        keyPrefix: 'nood:storage:pushTokens:',
        keyField: 'token',
        redis,
        migrateFileName: 'push-tokens.json',
      })
    : new JsonCollection({
        name: 'push tokens',
        fileName: 'push-tokens.json',
        keyField: 'token',
      });

  const ready = (async () => {
    if (redis) {
      await redis.connect();
      await redis.ping();
      await pendingOrders.init();
      await walletTransactions.init();
      await failedPaidOrders.init();
      await paymentRecords.init();
      await refundRequests.init();
      await pushTokens.init();
      storageState.paymentStorageRedisReady = true;
      console.log('[NOOD storage] payment recovery storage ready (redis)', {
        storageDriver: STORAGE_DRIVER,
        failedPaidOrdersDriver: storageState.failedPaidOrdersDriver,
        paymentRecordsDriver: storageState.paymentRecordsDriver,
      });
      return;
    }

    await Promise.all([
      pendingOrders.ready,
      walletTransactions.ready,
      failedPaidOrders.ready,
      paymentRecords.ready,
      refundRequests.ready,
      pushTokens.ready,
    ]);
    console.log('[NOOD storage] payment recovery storage ready (json)', {
      storageDriver: STORAGE_DRIVER,
    });
  })();

  return {
    pendingOrders,
    failedPaidOrders,
    paymentRecords,
    refundRequests,
    walletTransactions,
    pushTokens,
    redis,
    ready,
    storageDriver: STORAGE_DRIVER,
    get paymentStorageDriver() {
      return storageState.paymentStorageDriver;
    },
    get paymentStorageRedisReady() {
      return storageState.paymentStorageRedisReady;
    },
    get redisConfigured() {
      return storageState.redisConfigured;
    },
    get failedPaidOrdersDriver() {
      return storageState.failedPaidOrdersDriver;
    },
    get paymentRecordsDriver() {
      return storageState.paymentRecordsDriver;
    },
  };
}

module.exports = {
  createStorage,
  STORAGE_DRIVER,
  USE_REDIS_PAYMENT_STORAGE,
};
