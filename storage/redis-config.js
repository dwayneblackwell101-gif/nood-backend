let Redis;

try {
  Redis = require('ioredis');
} catch (error) {
  console.error('[NOOD redis] failed to load ioredis:', error.code || error.name, error.message);
  throw error;
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveRedisUrl(explicitUrl) {
  const fromArg = trim(explicitUrl);
  const fromEnv = trim(process.env.REDIS_URL);
  const url = fromArg || fromEnv;

  if (url) {
    return {
      url,
      driver: 'redis',
      source: fromArg ? 'argument' : 'env',
    };
  }

  return {
    url: '',
    driver: 'memory',
    source: 'none',
  };
}

async function connectRedisClient(redisUrl, options = {}) {
  const url = trim(redisUrl);
  if (!url) {
    throw new Error('Redis URL is required.');
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  await client.ping();
  return client;
}

function logRedisStatus(component, details = {}) {
  const payload = {
    component,
    driver: details.driver || null,
    connected: Boolean(details.connected),
    source: details.source || null,
  };

  if (details.error) {
    payload.error = String(details.error.message || details.error);
  }

  console.log('[NOOD redis]', payload);
}

module.exports = {
  resolveRedisUrl,
  connectRedisClient,
  logRedisStatus,
};