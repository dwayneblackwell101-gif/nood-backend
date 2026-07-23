const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  calculateRetryDelaySeconds,
  classifyWebhookError,
  createNormalizedJob,
  createWebhookHandler,
  createWebhookQueue,
  processOneWebhookJob,
  verifyShopifyWebhook,
} = require('../catalog/webhooks');

function createFakeRedis() {
  const strings = new Map();
  const lists = new Map();
  const sets = new Map();
  const zsets = new Map();

  function list(key) {
    if (!lists.has(key)) lists.set(key, []);
    return lists.get(key);
  }
  function set(key) {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key);
  }
  function zset(key) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }

  const redis = {
    async get(key) {
      return strings.get(key) || null;
    },
    async set(key, value, ...args) {
      if (args.includes('NX') && strings.has(key)) return null;
      strings.set(key, String(value));
      return 'OK';
    },
    async del(key) {
      strings.delete(key);
      lists.delete(key);
      sets.delete(key);
      zsets.delete(key);
      return 1;
    },
    async rpush(key, value) {
      list(key).push(String(value));
      return list(key).length;
    },
    async lpop(key) {
      return list(key).shift() || null;
    },
    async llen(key) {
      return list(key).length;
    },
    async sadd(key, value) {
      set(key).add(String(value));
      return 1;
    },
    async srem(key, value) {
      set(key).delete(String(value));
      return 1;
    },
    async scard(key) {
      return set(key).size;
    },
    async smembers(key) {
      return Array.from(set(key));
    },
    async zadd(key, score, value) {
      zset(key).set(String(value), Number(score));
      return 1;
    },
    async zrem(key, value) {
      zset(key).delete(String(value));
      return 1;
    },
    async zcard(key) {
      return zset(key).size;
    },
    async zrangebyscore(key, min, max, _limit, offset, count) {
      const rows = Array.from(zset(key).entries())
        .filter(([, score]) => score >= Number(min) && score <= Number(max))
        .sort((a, b) => a[1] - b[1])
        .map(([value]) => value);
      if (_limit === 'LIMIT') return rows.slice(Number(offset), Number(offset) + Number(count));
      return rows;
    },
    multi() {
      const commands = [];
      const chain = {
        set(...args) { commands.push(['set', args]); return chain; },
        rpush(...args) { commands.push(['rpush', args]); return chain; },
        sadd(...args) { commands.push(['sadd', args]); return chain; },
        srem(...args) { commands.push(['srem', args]); return chain; },
        zadd(...args) { commands.push(['zadd', args]); return chain; },
        zrem(...args) { commands.push(['zrem', args]); return chain; },
        del(...args) { commands.push(['del', args]); return chain; },
        async exec() {
          const out = [];
          for (const [name, args] of commands) {
            out.push([null, await redis[name](...args)]);
          }
          return out;
        },
      };
      return chain;
    },
  };
  return redis;
}

function makeJob(id = 'WEBHOOK-1', topic = 'products/update') {
  return createNormalizedJob({
    topic,
    shop: 'test.myshopify.com',
    webhookId: id,
    apiVersion: '2025-10',
    payload: {
      id: 123,
      admin_graphql_api_id: 'gid://shopify/Product/123',
      handle: 'shirt',
    },
  });
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function signedReq({ body = '{"id":123,"admin_graphql_api_id":"gid://shopify/Product/123"}', secret = 'secret', hmac } = {}) {
  const raw = Buffer.from(body);
  return {
    rawBody: raw,
    body: raw,
    get(name) {
      const headers = {
        'X-Shopify-Topic': 'products/update',
        'X-Shopify-Shop-Domain': 'test.myshopify.com',
        'X-Shopify-Webhook-Id': 'WEBHOOK-HTTP-1',
        'X-Shopify-Hmac-Sha256': hmac !== undefined ? hmac : crypto.createHmac('sha256', secret).update(raw).digest('base64'),
        'X-Shopify-API-Version': '2025-10',
      };
      return headers[name] || '';
    },
  };
}

test('Shopify webhook HMAC accepts valid and rejects invalid or missing signatures', () => {
  const body = Buffer.from('{"ok":true}');
  const hmac = crypto.createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(verifyShopifyWebhook(body, hmac, 'secret'), true);
  assert.equal(verifyShopifyWebhook(body, 'bad', 'secret'), false);
  assert.equal(verifyShopifyWebhook(body, '', 'secret'), false);
});

test('verified webhook is persisted before success and duplicate ID is not duplicated', async () => {
  process.env.SHOPIFY_WEBHOOK_SECRET = 'secret';
  const queue = createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_webhook_http' });
  const handler = createWebhookHandler({ queue });
  const first = mockRes();
  await handler(signedReq(), first);
  const second = mockRes();
  await handler(signedReq(), second);

  assert.equal(first.statusCode, 200);
  assert.equal(first.body.queued, true);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  const stats = await queue.getStats();
  assert.equal(stats.pending, 1);
});

test('invalid HMAC, missing HMAC, malformed body, and persistence failure reject safely', async () => {
  process.env.SHOPIFY_WEBHOOK_SECRET = 'secret';
  const handler = createWebhookHandler({ queue: createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_webhook_bad' }) });
  const bad = mockRes();
  await handler(signedReq({ hmac: 'bad' }), bad);
  assert.equal(bad.statusCode, 401);

  const missing = mockRes();
  await handler(signedReq({ hmac: '' }), missing);
  assert.equal(missing.statusCode, 401);

  const malformed = mockRes();
  await handler(signedReq({ body: '{bad json' }), malformed);
  assert.equal(malformed.statusCode, 400);

  const fail = mockRes();
  await createWebhookHandler({ queue: { enqueue: async () => { throw new Error('redis down'); } } })(signedReq(), fail);
  assert.equal(fail.statusCode, 503);
});

test('one worker claims a job and a second worker cannot claim the same job', async () => {
  const queue = createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_claim' });
  await queue.enqueue(makeJob());
  const first = await queue.claimNext('worker-a');
  const second = await queue.claimNext('worker-b');
  assert.equal(first.jobId, 'WEBHOOK-1');
  assert.equal(second, null);
});

test('only lease owner completes or releases a webhook job', async () => {
  const queue = createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_owner' });
  await queue.enqueue(makeJob());
  const job = await queue.claimNext('worker-a');
  await assert.rejects(() => queue.complete({ ...job, leaseOwner: 'wrong' }), /owner mismatch/);
  await assert.rejects(() => queue.release({ ...job, leaseOwner: 'wrong' }), /owner mismatch/);
  const completed = await queue.complete(job);
  assert.equal(completed.status, 'completed');
});

test('expired processing lease is recovered after crash and can be replayed', async () => {
  let current = 1000000;
  const redis = createFakeRedis();
  const queue = createWebhookQueue({ redis, namespace: 'test_recover', time: { now: () => current } });
  await queue.enqueue(makeJob());
  const job = await queue.claimNext('worker-a');
  current += 120000;
  const recovered = await queue.recoverExpiredLeases();
  assert.equal(recovered.recovered, 1);
  const replayed = await queue.claimNext('worker-b');
  assert.equal(replayed.jobId, job.jobId);
  assert.equal(replayed.retryCount, 1);
});

test('retryable failure schedules bounded retry and permanent failure dead-letters', async () => {
  let current = 2000000;
  const queue = createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_retry', time: { now: () => current } });
  await queue.enqueue(makeJob('WEBHOOK-RETRY'));
  const job = await queue.claimNext('worker-a');
  const retryError = new Error('timeout');
  retryError.code = 'ETIMEDOUT';
  await queue.fail(job, retryError);
  assert.equal((await queue.getStats()).retryScheduled, 1);
  assert.equal(await queue.claimNext('worker-b'), null);
  current += 600000;
  assert.equal((await queue.claimNext('worker-b')).jobId, job.jobId);

  await queue.enqueue(makeJob('WEBHOOK-PERMANENT', 'products/update'));
  const permanentJob = await queue.claimNext('worker-c');
  const permanent = new Error('schema invalid');
  permanent.permanent = true;
  await queue.fail(permanentJob, permanent);
  assert.equal((await queue.getStats()).deadLetter, 1);
});

test('max attempts moves retryable job to dead-letter', async () => {
  const queue = createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_max_attempts' });
  await queue.enqueue(makeJob());
  const job = await queue.claimNext('worker-a');
  await queue.fail({ ...job, retryCount: 7 }, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
  assert.equal((await queue.getStats()).deadLetter, 1);
});

test('dead-letter list is safe and manual replay creates one new pending attempt', async () => {
  const queue = createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_dead_letter' });
  await queue.enqueue(makeJob());
  const job = await queue.claimNext('worker-a');
  const permanent = new Error('bad payload');
  permanent.permanent = true;
  await queue.fail(job, permanent);
  const rows = await queue.listDeadLetters();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, 'products/update');
  await assert.rejects(() => queue.replayDeadLetter('missing'), /not replayable/);
  const replay = await queue.replayDeadLetter(job.jobId, 'admin');
  assert.equal(replay.replayOf, job.jobId);
  assert.equal((await queue.getStats()).pending, 1);
});

test('handler processing is idempotent for duplicate delivery because dedupe blocks second job', async () => {
  const queue = createWebhookQueue({ redis: createFakeRedis(), namespace: 'test_idempotent' });
  await queue.enqueue(makeJob());
  await queue.enqueue(makeJob());
  let calls = 0;
  await processOneWebhookJob(queue, async () => { calls += 1; }, 'worker-a');
  await processOneWebhookJob(queue, async () => { calls += 1; }, 'worker-a');
  assert.equal(calls, 1);
});

test('retry delay grows and is capped; error classification is stable', () => {
  const first = calculateRetryDelaySeconds(1);
  const later = calculateRetryDelaySeconds(8);
  assert.ok(first >= 5);
  assert.ok(later <= 900);
  assert.equal(classifyWebhookError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 'retryable');
  assert.equal(classifyWebhookError(Object.assign(new Error('bad'), { permanent: true })), 'permanent');
});
