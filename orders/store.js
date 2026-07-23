/**
 * Orders & shipment tracking store — Redis preferred, memory for tests.
 * Namespace: {namespace}:orders:{map}:{id}
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
    async set(mapName, key, value, _ttl) {
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
        setTimeout(() => {
          m.delete(k);
          m.delete(`${k}:ttl`);
        }, ttlSeconds * 1000).unref?.();
        m.set(`${k}:ttl`, Date.now() + ttlSeconds * 1000);
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
  };
}

function createRedisMapStore(redis, namespace) {
  const prefix = `${namespace}:orders`;

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
      if (ttlSeconds && next === 1) await redis.expire(k, ttlSeconds);
      return next;
    },
    async lpush(mapName, id, value, maxLen) {
      const k = key(mapName, id);
      const payload = typeof value === 'string' ? value : JSON.stringify(value);
      await redis.lpush(k, payload);
      if (maxLen > 0) await redis.ltrim(k, 0, maxLen - 1);
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
  };
}

function createOrdersStore({ redis = null, namespace = 'nood' } = {}) {
  const backend = redis ? createRedisMapStore(redis, namespace) : createMemoryMapStore();

  async function getOrder(orderId) {
    return backend.get('order', orderId);
  }

  async function saveOrder(order) {
    const next = { ...order, updatedAt: new Date().toISOString() };
    await backend.set('order', next.id, next);
    if (next.customerId) {
      await backend.sadd('customer_orders', next.customerId, next.id);
    }
    if (next.shopifyOrderId) {
      await backend.set('shopify_index', next.shopifyOrderId, { orderId: next.id });
    }
    if (next.shopifyOrderName) {
      await backend.set('name_index', next.shopifyOrderName, { orderId: next.id });
    }
    return next;
  }

  async function getOrderIdByShopify(shopifyOrderId) {
    const row = await backend.get('shopify_index', shopifyOrderId);
    return safeString(row?.orderId);
  }

  async function getOrderIdByName(name) {
    const row = await backend.get('name_index', name);
    return safeString(row?.orderId);
  }

  async function listCustomerOrderIds(customerId) {
    return backend.smembers('customer_orders', customerId);
  }

  async function getShipment(shipmentId) {
    return backend.get('shipment', shipmentId);
  }

  async function saveShipment(shipment) {
    const next = { ...shipment, updatedAt: new Date().toISOString() };
    await backend.set('shipment', next.id, next);
    await backend.sadd('order_shipments', next.orderId, next.id);
    if (next.trackingNumber) {
      await backend.set('tracking_index', next.trackingNumber.toUpperCase(), {
        shipmentId: next.id,
        orderId: next.orderId,
      });
    }
    return next;
  }

  async function listShipmentIds(orderId) {
    return backend.smembers('order_shipments', orderId);
  }

  async function getByTracking(trackingNumber) {
    return backend.get('tracking_index', safeString(trackingNumber).toUpperCase());
  }

  // Events stored newest-first as list + dedupe set
  async function appendEvent(orderId, event, maxLen = 500) {
    await backend.lpush('events', orderId, event, maxLen);
    if (event.dedupeKey) {
      await backend.set('event_dedupe', `${orderId}:${event.dedupeKey}`, { eventId: event.id }, 60 * 60 * 24 * 90);
    }
    return event;
  }

  async function hasDedupe(orderId, dedupeKey) {
    if (!dedupeKey) return false;
    const row = await backend.get('event_dedupe', `${orderId}:${dedupeKey}`);
    return Boolean(row?.eventId);
  }

  async function listEvents(orderId, start = 0, end = 99) {
    return backend.lrange('events', orderId, start, end);
  }

  async function getCancellation(orderId) {
    return backend.get('cancellation', orderId);
  }

  async function saveCancellation(record) {
    await backend.set('cancellation', record.orderId, record);
    return record;
  }

  async function getReturnRecord(returnId) {
    return backend.get('return', returnId);
  }

  async function saveReturnRecord(record) {
    await backend.set('return', record.id, record);
    await backend.sadd('order_returns', record.orderId, record.id);
    return record;
  }

  async function listReturnIds(orderId) {
    return backend.smembers('order_returns', orderId);
  }

  async function getRefundStatus(orderId) {
    return backend.get('refund_status', orderId);
  }

  async function saveRefundStatus(record) {
    await backend.set('refund_status', record.orderId, record);
    return record;
  }

  async function getTimelineCache(orderId) {
    return backend.get('timeline_cache', orderId);
  }

  async function setTimelineCache(orderId, payload, ttlSeconds) {
    await backend.set('timeline_cache', orderId, payload, ttlSeconds);
    return payload;
  }

  async function invalidateTimelineCache(orderId) {
    await backend.del('timeline_cache', orderId);
  }

  async function getPushPrefs(customerId) {
    return backend.get('push_prefs', customerId);
  }

  async function savePushPrefs(customerId, prefs) {
    await backend.set('push_prefs', customerId, prefs);
    return prefs;
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

  return {
    driver: backend.driver,
    getOrder,
    saveOrder,
    getOrderIdByShopify,
    getOrderIdByName,
    listCustomerOrderIds,
    getShipment,
    saveShipment,
    listShipmentIds,
    getByTracking,
    appendEvent,
    hasDedupe,
    listEvents,
    getCancellation,
    saveCancellation,
    getReturnRecord,
    saveReturnRecord,
    listReturnIds,
    getRefundStatus,
    saveRefundStatus,
    getTimelineCache,
    setTimelineCache,
    invalidateTimelineCache,
    getPushPrefs,
    savePushPrefs,
    incrRate,
    pushAudit,
    getAudit,
    incrMetric,
    getMetric,
  };
}

module.exports = {
  createOrdersStore,
};
