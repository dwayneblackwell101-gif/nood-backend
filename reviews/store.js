/**
 * Reviews state store — Redis when available, in-memory for tests/local.
 * Namespaces: {namespace}:reviews:{map}:{id}
 */

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
    async sadd(mapName, key, member) {
      const m = bag(mapName);
      const k = String(key);
      const set = m.get(k) instanceof Set ? m.get(k) : new Set(Array.isArray(m.get(k)) ? m.get(k) : []);
      set.add(String(member));
      m.set(k, set);
      return set.size;
    },
    async srem(mapName, key, member) {
      const m = bag(mapName);
      const k = String(key);
      const set = m.get(k) instanceof Set ? m.get(k) : new Set();
      set.delete(String(member));
      m.set(k, set);
      return set.size;
    },
    async smembers(mapName, key) {
      const raw = bag(mapName).get(String(key));
      if (raw instanceof Set) return Array.from(raw);
      if (Array.isArray(raw)) return raw.map(String);
      return [];
    },
    async scard(mapName, key) {
      const members = await this.smembers(mapName, key);
      return members.length;
    },
  };
}

function createRedisMapStore(redis, namespace) {
  const prefix = `${namespace}:reviews`;

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
    async sadd(mapName, id, member) {
      return redis.sadd(key(mapName, id), String(member));
    },
    async srem(mapName, id, member) {
      return redis.srem(key(mapName, id), String(member));
    },
    async smembers(mapName, id) {
      return redis.smembers(key(mapName, id));
    },
    async scard(mapName, id) {
      return redis.scard(key(mapName, id));
    },
  };
}

function emptyAggregate(productKey) {
  return {
    productKey: safeString(productKey),
    averageRating: 0,
    reviewCount: 0,
    ratingHistogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    mediaReviewCount: 0,
    verifiedCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function createReviewsStore({ redis = null, namespace = 'nood' } = {}) {
  const backend = redis ? createRedisMapStore(redis, namespace) : createMemoryMapStore();

  function productIndexKey(productKey) {
    return safeString(productKey);
  }

  function customerIndexKey(customerId) {
    return safeString(customerId);
  }

  function uniqKey({ customerId, productKey, orderItemId }) {
    return `${safeString(customerId)}:${safeString(productKey)}:${safeString(orderItemId) || 'none'}`;
  }

  async function getReview(reviewId) {
    return backend.get('review', reviewId);
  }

  async function saveReview(review) {
    const next = {
      ...review,
      updatedAt: new Date().toISOString(),
    };
    await backend.set('review', next.id, next);
    return next;
  }

  async function deleteReviewRecord(reviewId) {
    await backend.del('review', reviewId);
    return true;
  }

  async function indexReview(review) {
    const productKey = productIndexKey(review.productKey || review.productId || review.productHandle);
    const customerKey = customerIndexKey(review.customerId);
    await backend.sadd('product_index', productKey, review.id);
    await backend.sadd('customer_index', customerKey, review.id);
    if (review.status === 'pending') {
      await backend.sadd('moderation_queue', 'pending', review.id);
    } else {
      await backend.srem('moderation_queue', 'pending', review.id);
    }
    await backend.set(
      'uniq',
      uniqKey({
        customerId: review.customerId,
        productKey,
        orderItemId: review.orderItemId,
      }),
      { reviewId: review.id }
    );
  }

  async function deindexReview(review) {
    const productKey = productIndexKey(review.productKey || review.productId || review.productHandle);
    const customerKey = customerIndexKey(review.customerId);
    await backend.srem('product_index', productKey, review.id);
    await backend.srem('customer_index', customerKey, review.id);
    await backend.srem('moderation_queue', 'pending', review.id);
  }

  async function getReviewIdsForProduct(productKey) {
    return backend.smembers('product_index', productIndexKey(productKey));
  }

  async function getReviewIdsForCustomer(customerId) {
    return backend.smembers('customer_index', customerIndexKey(customerId));
  }

  async function getPendingModerationIds() {
    return backend.smembers('moderation_queue', 'pending');
  }

  async function findExistingReviewId({ customerId, productKey, orderItemId }) {
    const row = await backend.get(
      'uniq',
      uniqKey({ customerId, productKey, orderItemId })
    );
    return safeString(row?.reviewId || '');
  }

  async function getAggregate(productKey) {
    const cached = await backend.get('aggregate', productIndexKey(productKey));
    if (cached) return cached;
    return emptyAggregate(productKey);
  }

  async function saveAggregate(aggregate, ttlSeconds = 0) {
    const next = {
      ...aggregate,
      updatedAt: new Date().toISOString(),
    };
    await backend.set('aggregate', productIndexKey(next.productKey), next, ttlSeconds || undefined);
    return next;
  }

  async function invalidateAggregate(productKey) {
    await backend.del('aggregate', productIndexKey(productKey));
  }

  // Votes: one vote per customer per review (helpful | not_helpful)
  async function getVote(reviewId, customerId) {
    return backend.get('vote', `${safeString(reviewId)}:${safeString(customerId)}`);
  }

  async function saveVote(vote) {
    await backend.set('vote', `${safeString(vote.reviewId)}:${safeString(vote.customerId)}`, vote);
    return vote;
  }

  async function deleteVote(reviewId, customerId) {
    await backend.del('vote', `${safeString(reviewId)}:${safeString(customerId)}`);
  }

  // Reports
  async function getReport(reviewId, customerId) {
    return backend.get('report', `${safeString(reviewId)}:${safeString(customerId)}`);
  }

  async function saveReport(report) {
    await backend.set('report', `${safeString(report.reviewId)}:${safeString(report.customerId)}`, report);
    await backend.sadd('reports_index', report.reviewId, report.id);
    await backend.sadd('reports_open', 'open', report.id);
    await backend.set('report_by_id', report.id, report);
    return report;
  }

  async function getReportById(reportId) {
    return backend.get('report_by_id', reportId);
  }

  async function updateReport(report) {
    await backend.set('report', `${safeString(report.reviewId)}:${safeString(report.customerId)}`, report);
    await backend.set('report_by_id', report.id, report);
    if (report.status !== 'open') {
      await backend.srem('reports_open', 'open', report.id);
    }
    return report;
  }

  async function getOpenReportIds() {
    return backend.smembers('reports_open', 'open');
  }

  // Media
  async function saveMedia(media) {
    await backend.set('media', media.id, media);
    if (media.reviewId) {
      await backend.sadd('media_index', media.reviewId, media.id);
    }
    return media;
  }

  async function getMedia(mediaId) {
    return backend.get('media', mediaId);
  }

  async function getMediaIdsForReview(reviewId) {
    return backend.smembers('media_index', reviewId);
  }

  // Q&A
  async function getQuestion(questionId) {
    return backend.get('question', questionId);
  }

  async function saveQuestion(question) {
    const next = { ...question, updatedAt: new Date().toISOString() };
    await backend.set('question', next.id, next);
    const productKey = productIndexKey(next.productKey || next.productId || next.productHandle);
    await backend.sadd('question_index', productKey, next.id);
    if (next.status === 'pending') {
      await backend.sadd('question_moderation', 'pending', next.id);
    } else {
      await backend.srem('question_moderation', 'pending', next.id);
    }
    return next;
  }

  async function getQuestionIdsForProduct(productKey) {
    return backend.smembers('question_index', productIndexKey(productKey));
  }

  async function getPendingQuestionIds() {
    return backend.smembers('question_moderation', 'pending');
  }

  async function getQaVote(targetType, targetId, customerId) {
    return backend.get('qa_vote', `${safeString(targetType)}:${safeString(targetId)}:${safeString(customerId)}`);
  }

  async function saveQaVote(vote) {
    await backend.set(
      'qa_vote',
      `${safeString(vote.targetType)}:${safeString(vote.targetId)}:${safeString(vote.customerId)}`,
      vote
    );
    return vote;
  }

  // Idempotency / rate / audit / metrics
  async function getIdempotency(customerId, key) {
    return backend.get('idempotency', `${safeString(customerId)}:${safeString(key)}`);
  }

  async function saveIdempotency(customerId, key, payload, ttlSeconds = 2592000) {
    await backend.set('idempotency', `${safeString(customerId)}:${safeString(key)}`, payload, ttlSeconds);
    return payload;
  }

  async function incrRate(bucket, windowSeconds) {
    return backend.incr('rate', bucket, windowSeconds);
  }

  async function pushAudit(entry, maxLen = 500) {
    await backend.lpush('audit', 'global', entry, maxLen);
  }

  async function getAudit(limit = 50) {
    return backend.lrange('audit', 'global', 0, Math.max(0, limit - 1));
  }

  async function incrMetric(name) {
    return backend.incr('metrics', name);
  }

  async function getMetric(name) {
    return Number((await backend.get('metrics', name)) || 0);
  }

  // Comment fingerprint for spam (customer + hash)
  async function incrSpamFingerprint(fingerprint, windowSeconds) {
    return backend.incr('spam', fingerprint, windowSeconds);
  }

  return {
    driver: backend.driver,
    emptyAggregate,
    getReview,
    saveReview,
    deleteReviewRecord,
    indexReview,
    deindexReview,
    getReviewIdsForProduct,
    getReviewIdsForCustomer,
    getPendingModerationIds,
    findExistingReviewId,
    getAggregate,
    saveAggregate,
    invalidateAggregate,
    getVote,
    saveVote,
    deleteVote,
    getReport,
    saveReport,
    getReportById,
    updateReport,
    getOpenReportIds,
    saveMedia,
    getMedia,
    getMediaIdsForReview,
    getQuestion,
    saveQuestion,
    getQuestionIdsForProduct,
    getPendingQuestionIds,
    getQaVote,
    saveQaVote,
    getIdempotency,
    saveIdempotency,
    incrRate,
    pushAudit,
    getAudit,
    incrMetric,
    getMetric,
    incrSpamFingerprint,
  };
}

module.exports = {
  createReviewsStore,
  emptyAggregate,
};
