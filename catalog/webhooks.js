const crypto = require('crypto');
const express = require('express');
const { safeString } = require('./transform');
const { createRedisClient } = require('../storage/redis-collection');
const {
  syncProductByAdminId,
  deleteProductFromCache,
  syncCollectionByAdminId,
  deleteCollectionFromCache,
  syncCollectionsAndMenusLight,
} = require('./sync');
const { fetchProductGidByInventoryItemId } = require('./shopify');

function parsePositiveInteger(name, fallback) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const WEBHOOK_BODY_LIMIT = process.env.SHOPIFY_WEBHOOK_BODY_LIMIT || '2mb';
const REDIS_NAMESPACE = safeString(process.env.REDIS_NAMESPACE, 'nood');
const WEBHOOK_JOB_LEASE_SECONDS = parsePositiveInteger('WEBHOOK_JOB_LEASE_SECONDS', 60);
const WEBHOOK_RETRY_BASE_SECONDS = parsePositiveInteger('WEBHOOK_RETRY_BASE_SECONDS', 5);
const WEBHOOK_RETRY_MAX_SECONDS = parsePositiveInteger('WEBHOOK_RETRY_MAX_SECONDS', 900);
const WEBHOOK_MAX_ATTEMPTS = parsePositiveInteger('WEBHOOK_MAX_ATTEMPTS', 8);
const WEBHOOK_WORKER_POLL_MS = parsePositiveInteger('WEBHOOK_WORKER_POLL_MS', 1000);
const WEBHOOK_WORKER_HEARTBEAT_SECONDS = parsePositiveInteger('WEBHOOK_WORKER_HEARTBEAT_SECONDS', 15);
const WEBHOOK_WORKER_STALE_SECONDS = parsePositiveInteger('WEBHOOK_WORKER_STALE_SECONDS', 60);
const WEBHOOK_COMPLETED_RETENTION_SECONDS = parsePositiveInteger('WEBHOOK_COMPLETED_RETENTION_SECONDS', 604800);
const WEBHOOK_DEAD_LETTER_RETENTION_SECONDS = parsePositiveInteger('WEBHOOK_DEAD_LETTER_RETENTION_SECONDS', 2592000);

const SUPPORTED_TOPICS = new Set([
  'products/create',
  'products/update',
  'products/delete',
  'collections/create',
  'collections/update',
  'collections/delete',
  'inventory_levels/update',
]);

const workerState = {
  running: false,
  workerId: '',
  lastHeartbeatAt: null,
  lastSafeError: '',
  timer: null,
  activeJob: null,
  queue: null,
};

function nowMs() {
  return Date.now();
}

function iso(ms = nowMs()) {
  return new Date(ms).toISOString();
}

function createToken(prefix = 'worker') {
  return `${prefix}_${process.pid}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function createWebhookJobId(job) {
  return safeString(job.webhookId) || crypto.createHash('sha256').update(`${job.topic}:${job.dedupeKey}`).digest('hex');
}

function keys(namespace = REDIS_NAMESPACE) {
  return {
    job: (jobId) => `${namespace}:webhook:job:${jobId}`,
    dedupe: (webhookId) => `${namespace}:webhook:dedupe:${webhookId}`,
    lease: (jobId) => `${namespace}:webhook:lease:${jobId}`,
    pending: `${namespace}:webhook:pending`,
    processing: `${namespace}:webhook:processing`,
    retry: `${namespace}:webhook:retry`,
    deadLetter: `${namespace}:webhook:dead-letter`,
    completed: `${namespace}:webhook:completed`,
    heartbeat: `${namespace}:webhook:worker:heartbeat`,
  };
}

function createWebhookRedis() {
  const redisUrl = safeString(process.env.REDIS_URL);
  if (!redisUrl) return { client: null, ready: Promise.resolve(null) };
  const client = createRedisClient(redisUrl);
  const ready = client.connect().then(() => client.ping()).then(() => client);
  return { client, ready };
}

function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !rawBody) return false;
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digest = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('base64');
  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(String(hmacHeader), 'utf8');
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

function isShopifyWebhookRequest(req) {
  if (String(req.method || '').toUpperCase() !== 'POST') return false;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path === '/webhooks/shopify' || path === '/api/webhooks/shopify';
}

function mountShopifyWebhookBodyParser(app) {
  const rawParser = express.raw({ type: 'application/json', limit: WEBHOOK_BODY_LIMIT });
  app.use((req, res, next) => {
    if (!isShopifyWebhookRequest(req)) return next();
    return rawParser(req, res, (err) => {
      if (err) {
        const status = err.type === 'entity.too.large' || err.status === 413 ? 413 : 400;
        console.warn('[NOOD webhook] raw body rejected', {
          status,
          path: String(req.originalUrl || req.url || ''),
          limit: WEBHOOK_BODY_LIMIT,
        });
        return res.status(status).json({
          success: false,
          message: status === 413 ? 'Webhook payload too large.' : 'Invalid webhook body.',
        });
      }
      if (Buffer.isBuffer(req.body)) {
        req.rawBody = req.body;
        req._shopifyWebhookRawBody = true;
      }
      return next();
    });
  });
  console.log(`[NOOD webhook] raw body parser mounted limit=${WEBHOOK_BODY_LIMIT}`);
}

function getAdminProductGid(payload) {
  return safeString(payload?.admin_graphql_api_id) || (safeString(payload?.id) ? `gid://shopify/Product/${safeString(payload.id)}` : '');
}

function getAdminCollectionGid(payload) {
  return safeString(payload?.admin_graphql_api_id) || (safeString(payload?.id) ? `gid://shopify/Collection/${safeString(payload.id)}` : '');
}

function topicAction(topic) {
  const parts = String(topic || '').split('/');
  return parts[parts.length - 1] || 'unknown';
}

function sanitizePayload(topic, payload = {}) {
  const base = {
    id: payload.id || null,
    admin_graphql_api_id: safeString(payload.admin_graphql_api_id) || null,
    handle: safeString(payload.handle) || null,
  };
  if (topic === 'inventory_levels/update') {
    return {
      inventory_item_id: payload.inventory_item_id || null,
      location_id: payload.location_id || null,
      available: payload.available ?? null,
      updated_at: safeString(payload.updated_at) || null,
    };
  }
  return base;
}

function createNormalizedJob({ topic, shop, webhookId, apiVersion, payload }) {
  const action = topicAction(topic);
  const productGid = getAdminProductGid(payload);
  const collectionGid = getAdminCollectionGid(payload);
  const handle = safeString(payload?.handle);
  const resourceId = productGid || collectionGid || safeString(payload?.id);
  let dedupeKey = `${topic}:${resourceId || handle || webhookId}`;

  if (topic === 'products/create' || topic === 'products/update') {
    dedupeKey = `product:${productGid || handle}`;
  } else if (topic === 'products/delete') {
    dedupeKey = `product-delete:${productGid || handle || safeString(payload?.id)}`;
  } else if (topic === 'collections/create' || topic === 'collections/update') {
    dedupeKey = `collection:${collectionGid || handle}`;
  } else if (topic === 'collections/delete') {
    dedupeKey = `collection-delete:${collectionGid || handle || safeString(payload?.id)}`;
  } else if (topic === 'inventory_levels/update') {
    dedupeKey = `inventory:${safeString(payload?.inventory_item_id)}:${safeString(payload?.location_id)}`;
  }

  return {
    jobId: createWebhookJobId({ webhookId, topic, dedupeKey }),
    webhookId: safeString(webhookId),
    topic,
    action,
    shop: safeString(shop),
    apiVersion: safeString(apiVersion),
    dedupeKey,
    resourceId,
    handle,
    payload: sanitizePayload(topic, payload),
  };
}

function classifyWebhookError(error) {
  if (error?.permanent) return 'permanent';
  const status = Number(error?.response?.status || error?.statusCode || 0);
  const code = safeString(error?.code);
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return 'retryable';
  if (status === 429 || (status >= 500 && status < 600)) return 'retryable';
  if (status >= 400 && status < 500) return 'permanent';
  return 'retryable';
}

function calculateRetryDelaySeconds(attempt) {
  const exp = WEBHOOK_RETRY_BASE_SECONDS * Math.pow(2, Math.max(0, Number(attempt) - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, WEBHOOK_RETRY_BASE_SECONDS));
  return Math.min(WEBHOOK_RETRY_MAX_SECONDS, exp + jitter);
}

function parseJob(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeError(error) {
  return safeString(error?.message || error).slice(0, 300);
}

function createWebhookQueue({ redis, namespace = REDIS_NAMESPACE, time = { now: nowMs }, requireRedis = true } = {}) {
  const k = keys(namespace);

  async function getRedis() {
    if (redis) return redis;
    if (!requireRedis) return null;
    throw new Error('Redis webhook queue storage is unavailable.');
  }

  async function enqueue(jobInput) {
    const client = await getRedis();
    if (!client) throw new Error('Redis webhook queue storage is unavailable.');
    const job = {
      ...jobInput,
      status: 'pending',
      retryCount: 0,
      receivedAt: iso(time.now()),
      updatedAt: iso(time.now()),
      nextAttemptAt: iso(time.now()),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastSafeError: '',
    };

    if (job.webhookId) {
      const claimed = await client.set(k.dedupe(job.webhookId), job.jobId, 'NX', 'EX', WEBHOOK_DEAD_LETTER_RETENTION_SECONDS);
      if (claimed !== 'OK') return { accepted: true, duplicate: true, jobId: await client.get(k.dedupe(job.webhookId)) };
    }

    const existing = await client.get(k.job(job.jobId));
    if (existing) return { accepted: true, duplicate: true, jobId: job.jobId };

    await client.multi().set(k.job(job.jobId), JSON.stringify(job)).rpush(k.pending, job.jobId).exec();
    return { accepted: true, duplicate: false, jobId: job.jobId };
  }

  async function claimDueRetry(client) {
    const due = await client.zrangebyscore(k.retry, 0, time.now(), 'LIMIT', 0, 1);
    const jobId = due?.[0];
    if (!jobId) return null;
    await client.zrem(k.retry, jobId);
    return jobId;
  }

  async function claimNext(workerId = createToken('worker')) {
    const client = await getRedis();
    const jobId = (await client.lpop(k.pending)) || (await claimDueRetry(client));
    if (!jobId) return null;

    const token = createToken('lease');
    const lock = await client.set(k.lease(jobId), token, 'NX', 'EX', WEBHOOK_JOB_LEASE_SECONDS);
    if (lock !== 'OK') return null;

    const raw = await client.get(k.job(jobId));
    const job = parseJob(raw);
    if (!job || job.status === 'completed' || job.status === 'dead_letter') {
      await client.del(k.lease(jobId));
      return null;
    }

    const next = {
      ...job,
      status: 'processing',
      leaseOwner: token,
      workerId,
      processingStartedAt: iso(time.now()),
      leaseExpiresAt: iso(time.now() + WEBHOOK_JOB_LEASE_SECONDS * 1000),
      updatedAt: iso(time.now()),
    };
    await client.multi().set(k.job(jobId), JSON.stringify(next)).sadd(k.processing, jobId).exec();
    return next;
  }

  async function assertOwner(client, jobId, token) {
    const owner = await client.get(k.lease(jobId));
    if (owner !== token) {
      const error = new Error('Webhook job lease owner mismatch.');
      error.statusCode = 409;
      throw error;
    }
  }

  async function complete(job) {
    const client = await getRedis();
    await assertOwner(client, job.jobId, job.leaseOwner);
    const next = {
      ...job,
      status: 'completed',
      completedAt: iso(time.now()),
      updatedAt: iso(time.now()),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await client
      .multi()
      .set(k.job(job.jobId), JSON.stringify(next), 'EX', WEBHOOK_COMPLETED_RETENTION_SECONDS)
      .srem(k.processing, job.jobId)
      .zadd(k.completed, time.now(), job.jobId)
      .del(k.lease(job.jobId))
      .exec();
    return next;
  }

  async function moveToDeadLetter(job, error, manualReplayAllowed = true) {
    const client = await getRedis();
    if (job.leaseOwner) await assertOwner(client, job.jobId, job.leaseOwner);
    const next = {
      ...job,
      status: 'dead_letter',
      retryCount: Number(job.retryCount || 0),
      finalSafeError: safeError(error),
      deadLetterAt: iso(time.now()),
      manualReplayAllowed,
      updatedAt: iso(time.now()),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await client
      .multi()
      .set(k.job(job.jobId), JSON.stringify(next), 'EX', WEBHOOK_DEAD_LETTER_RETENTION_SECONDS)
      .srem(k.processing, job.jobId)
      .sadd(k.deadLetter, job.jobId)
      .del(k.lease(job.jobId))
      .exec();
    return next;
  }

  async function fail(job, error) {
    const client = await getRedis();
    await assertOwner(client, job.jobId, job.leaseOwner);
    const nextAttempt = Number(job.retryCount || 0) + 1;
    const kind = classifyWebhookError(error);
    if (kind === 'permanent' || nextAttempt >= WEBHOOK_MAX_ATTEMPTS) {
      return moveToDeadLetter({ ...job, retryCount: nextAttempt }, error, true);
    }
    const delaySeconds = calculateRetryDelaySeconds(nextAttempt);
    const next = {
      ...job,
      status: 'retry_scheduled',
      retryCount: nextAttempt,
      lastSafeError: safeError(error),
      nextAttemptAt: iso(time.now() + delaySeconds * 1000),
      updatedAt: iso(time.now()),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await client
      .multi()
      .set(k.job(job.jobId), JSON.stringify(next))
      .srem(k.processing, job.jobId)
      .zadd(k.retry, time.now() + delaySeconds * 1000, job.jobId)
      .del(k.lease(job.jobId))
      .exec();
    return next;
  }

  async function release(job, reason = 'released') {
    const client = await getRedis();
    await assertOwner(client, job.jobId, job.leaseOwner);
    const next = {
      ...job,
      status: 'retry_scheduled',
      retryCount: Number(job.retryCount || 0) + 1,
      lastSafeError: reason,
      nextAttemptAt: iso(time.now()),
      updatedAt: iso(time.now()),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await client.multi().set(k.job(job.jobId), JSON.stringify(next)).srem(k.processing, job.jobId).zadd(k.retry, time.now(), job.jobId).del(k.lease(job.jobId)).exec();
    return next;
  }

  async function recoverExpiredLeases() {
    const client = await getRedis();
    const ids = await client.smembers(k.processing);
    let recovered = 0;
    for (const jobId of ids) {
      const job = parseJob(await client.get(k.job(jobId)));
      if (!job) {
        await client.srem(k.processing, jobId);
        continue;
      }
      const expires = Date.parse(job.leaseExpiresAt || 0);
      if (Number.isFinite(expires) && expires > time.now()) continue;
      await client.del(k.lease(jobId));
      const retryCount = Number(job.retryCount || 0) + 1;
      const next = {
        ...job,
        status: 'retry_scheduled',
        retryCount,
        lastSafeError: 'expired_processing_lease_recovered',
        nextAttemptAt: iso(time.now()),
        updatedAt: iso(time.now()),
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      await client.multi().set(k.job(jobId), JSON.stringify(next)).srem(k.processing, jobId).zadd(k.retry, time.now(), jobId).exec();
      recovered += 1;
    }
    return { recovered };
  }

  async function getJob(jobId) {
    const client = await getRedis();
    return parseJob(await client.get(k.job(jobId)));
  }

  async function getStats() {
    const client = await getRedis();
    const [pending, processing, retry, deadLetter, completed] = await Promise.all([
      client.llen(k.pending),
      client.scard(k.processing),
      client.zcard(k.retry),
      client.scard(k.deadLetter),
      client.zcard(k.completed),
    ]);
    return {
      driver: 'redis',
      pending,
      processing,
      retryScheduled: retry,
      deadLetter,
      completedRecently: completed,
      workerRunning: workerState.running,
      workerLastHeartbeatAt: workerState.lastHeartbeatAt,
      workerLastSafeError: workerState.lastSafeError,
    };
  }

  async function listDeadLetters(limit = 50) {
    const client = await getRedis();
    const ids = (await client.smembers(k.deadLetter)).slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)));
    const jobs = [];
    for (const id of ids) {
      const job = await getJob(id);
      if (job) {
        jobs.push({
          jobId: job.jobId,
          webhookId: job.webhookId,
          topic: job.topic,
          receivedAt: job.receivedAt,
          retryCount: job.retryCount,
          finalSafeError: job.finalSafeError,
          deadLetterAt: job.deadLetterAt,
          manualReplayAllowed: Boolean(job.manualReplayAllowed),
          payload: job.payload,
        });
      }
    }
    return jobs;
  }

  async function replayDeadLetter(jobId, actor = 'admin') {
    const client = await getRedis();
    const job = await getJob(jobId);
    if (!job || job.status !== 'dead_letter' || !job.manualReplayAllowed) {
      throw new Error('Dead-letter webhook job is not replayable.');
    }
    const replay = {
      ...job,
      jobId: `${job.jobId}:replay:${Date.now()}`,
      status: 'pending',
      retryCount: 0,
      replayOf: job.jobId,
      replayedBy: safeString(actor),
      replayedAt: iso(time.now()),
      updatedAt: iso(time.now()),
      nextAttemptAt: iso(time.now()),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await client.multi().set(k.job(replay.jobId), JSON.stringify(replay)).rpush(k.pending, replay.jobId).exec();
    return replay;
  }

  return {
    enqueue,
    claimNext,
    complete,
    fail,
    release,
    recoverExpiredLeases,
    getJob,
    getStats,
    listDeadLetters,
    replayDeadLetter,
    keys: k,
  };
}

async function resolveInventoryProductGid(payload) {
  const directGid = getAdminProductGid(payload);
  if (directGid) return directGid;
  const inventoryItemId = safeString(payload?.inventory_item_id);
  if (!inventoryItemId) return '';
  return fetchProductGidByInventoryItemId(inventoryItemId);
}

function createWebhookBusinessHandlers({ cache }) {
  return async function run(job) {
    const payload = job.payload || {};
    if (job.topic === 'products/create' || job.topic === 'products/update') {
      const productGid = getAdminProductGid(payload);
      if (!productGid) {
        const error = new Error('Missing product ID in webhook payload.');
        error.permanent = true;
        throw error;
      }
      return syncProductByAdminId(cache, productGid, { reason: `webhook:${job.topic}` });
    }
    if (job.topic === 'products/delete') return deleteProductFromCache(cache, payload);
    if (job.topic === 'collections/create' || job.topic === 'collections/update') {
      const collectionGid = getAdminCollectionGid(payload);
      if (!collectionGid) {
        const error = new Error('Missing collection ID in webhook payload.');
        error.permanent = true;
        throw error;
      }
      await syncCollectionByAdminId(cache, collectionGid, { reason: `webhook:${job.topic}` });
      return syncCollectionsAndMenusLight(cache);
    }
    if (job.topic === 'collections/delete') {
      const deleted = await deleteCollectionFromCache(cache, payload);
      const menus = await syncCollectionsAndMenusLight(cache);
      return { ...deleted, menus };
    }
    if (job.topic === 'inventory_levels/update') {
      const productGid = await resolveInventoryProductGid(payload);
      if (!productGid) {
        const error = new Error('Missing product for inventory update.');
        error.permanent = true;
        throw error;
      }
      return syncProductByAdminId(cache, productGid, { reason: 'webhook:inventory_levels/update' });
    }
    const error = new Error(`Unsupported Shopify webhook topic: ${job.topic}`);
    error.permanent = true;
    throw error;
  };
}

async function processOneWebhookJob(queue, handler, workerId = workerState.workerId || createToken('worker')) {
  await queue.recoverExpiredLeases();
  const job = await queue.claimNext(workerId);
  if (!job) return { processed: false };
  workerState.activeJob = job;
  try {
    await handler(job);
    await queue.complete(job);
    workerState.activeJob = null;
    return { processed: true, status: 'completed', jobId: job.jobId };
  } catch (error) {
    workerState.lastSafeError = safeError(error);
    await queue.fail(job, error);
    workerState.activeJob = null;
    return { processed: true, status: 'failed', jobId: job.jobId };
  }
}

function startWebhookWorker({ queue, handler, pollMs = WEBHOOK_WORKER_POLL_MS } = {}) {
  if (!queue || !handler) return null;
  if (workerState.running) return workerState;
  workerState.running = true;
  workerState.queue = queue;
  workerState.workerId = createToken('webhook_worker');
  workerState.lastHeartbeatAt = iso();

  const tick = async () => {
    if (!workerState.running) return;
    workerState.lastHeartbeatAt = iso();
    try {
      await processOneWebhookJob(queue, handler, workerState.workerId);
    } catch (error) {
      workerState.lastSafeError = safeError(error);
    } finally {
      if (workerState.running) {
        workerState.timer = setTimeout(tick, pollMs);
      }
    }
  };
  workerState.timer = setTimeout(tick, 0);
  return workerState;
}

async function stopWebhookWorker() {
  workerState.running = false;
  if (workerState.timer) clearTimeout(workerState.timer);
  workerState.timer = null;
  if (workerState.activeJob && workerState.queue) {
    await workerState.queue.release(workerState.activeJob, 'worker_shutdown').catch((error) => {
      workerState.lastSafeError = safeError(error);
    });
  }
  workerState.activeJob = null;
}

function getWebhookWorkerHealth() {
  const heartbeatMs = Date.parse(workerState.lastHeartbeatAt || 0);
  const stale = workerState.running && (!Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > WEBHOOK_WORKER_STALE_SECONDS * 1000);
  return {
    running: workerState.running,
    workerId: workerState.workerId,
    lastHeartbeatAt: workerState.lastHeartbeatAt,
    stale,
    lastSafeError: workerState.lastSafeError,
  };
}

function createWebhookHandler({ queue }) {
  const webhookSecret = safeString(process.env.SHOPIFY_WEBHOOK_SECRET);
  return async function handleShopifyWebhook(req, res) {
    const topic = safeString(req.get('X-Shopify-Topic'));
    const shop = safeString(req.get('X-Shopify-Shop-Domain'));
    const webhookId = safeString(req.get('X-Shopify-Webhook-Id'));
    const apiVersion = safeString(req.get('X-Shopify-API-Version'));
    const hmac = safeString(req.get('X-Shopify-Hmac-Sha256'));
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.isBuffer(req.body) ? req.body : null;

    if (!webhookSecret) return res.status(401).json({ success: false, message: 'Webhook secret is not configured.' });
    if (!rawBody) return res.status(401).json({ success: false, message: 'Missing raw webhook body.' });
    if (!verifyShopifyWebhook(rawBody, hmac, webhookSecret)) {
      console.warn('[NOOD webhook] rejected invalid HMAC', { topic, shop, webhookId });
      return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
    }
    if (!SUPPORTED_TOPICS.has(topic)) {
      return res.status(202).json({ success: true, topic, ignored: true, message: 'Unsupported topic ignored.' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return res.status(400).json({ success: false, message: 'Malformed webhook JSON.' });
    }

    try {
      const job = createNormalizedJob({ topic, shop, webhookId, apiVersion, payload });
      const queued = await queue.enqueue(job);
      return res.status(200).json({
        success: true,
        topic,
        webhookId,
        duplicate: Boolean(queued.duplicate),
        queued: !queued.duplicate,
        jobId: queued.jobId,
      });
    } catch (error) {
      console.error('[NOOD webhook] enqueue failed', { topic, shop, webhookId, message: error.message });
      return res.status(503).json({ success: false, message: 'Webhook could not be persisted.' });
    }
  };
}

function createWebhookRouter({ cache, requireAdminApiKey, redis = null, autoStartWorker = false }) {
  const router = express.Router();
  const redisSource = redis ? { ready: Promise.resolve(redis) } : createWebhookRedis();
  let queuePromise = null;
  async function getQueue() {
    if (!queuePromise) {
      queuePromise = redisSource.ready.then((client) => createWebhookQueue({ redis: client }));
    }
    return queuePromise;
  }
  const handler = createWebhookBusinessHandlers({ cache });

  router.post('/shopify', async (req, res) => createWebhookHandler({ queue: await getQueue() })(req, res));

  if (requireAdminApiKey) {
    router.get('/admin/queue/status', requireAdminApiKey, async (_req, res) => {
      const queue = await getQueue();
      res.json({ success: true, queue: await queue.getStats(), worker: getWebhookWorkerHealth() });
    });
    router.get('/admin/dead-letter', requireAdminApiKey, async (req, res) => {
      const queue = await getQueue();
      res.json({ success: true, jobs: await queue.listDeadLetters(req.query.limit) });
    });
    router.post('/admin/dead-letter/:jobId/replay', requireAdminApiKey, async (req, res) => {
      const queue = await getQueue();
      const replay = await queue.replayDeadLetter(req.params.jobId, req.get('x-nood-admin-id') || 'admin');
      res.json({ success: true, job: { jobId: replay.jobId, replayOf: replay.replayOf, topic: replay.topic } });
    });
  }

  if (autoStartWorker) {
    void getQueue().then((queue) => startWebhookWorker({ queue, handler })).catch((error) => {
      workerState.lastSafeError = safeError(error);
    });
  }

  router.getQueue = getQueue;
  router.startWorker = async () => startWebhookWorker({ queue: await getQueue(), handler });
  return router;
}

async function getWebhookReadiness() {
  const webhookSecretConfigured = Boolean(safeString(process.env.SHOPIFY_WEBHOOK_SECRET));
  const webhooksRequired = ['1', 'true', 'yes'].includes(safeString(process.env.SHOPIFY_WEBHOOKS_REQUIRED, 'true').toLowerCase());
  if (!webhooksRequired) {
    return { ready: true, required: false, webhookSecretConfigured, worker: getWebhookWorkerHealth() };
  }
  const redisUrl = safeString(process.env.REDIS_URL);
  const worker = getWebhookWorkerHealth();
  const production = safeString(process.env.NODE_ENV) === 'production';
  return {
    ready: Boolean(redisUrl && webhookSecretConfigured && (!production || (worker.running && !worker.stale))),
    required: true,
    redisConfigured: Boolean(redisUrl),
    webhookSecretConfigured,
    worker,
  };
}

module.exports = {
  SUPPORTED_TOPICS,
  calculateRetryDelaySeconds,
  classifyWebhookError,
  createNormalizedJob,
  createWebhookHandler,
  createWebhookBusinessHandlers,
  createWebhookQueue,
  createWebhookRouter,
  getWebhookReadiness,
  getWebhookWorkerHealth,
  isShopifyWebhookRequest,
  mountShopifyWebhookBodyParser,
  processOneWebhookJob,
  startWebhookWorker,
  stopWebhookWorker,
  verifyShopifyWebhook,
};
