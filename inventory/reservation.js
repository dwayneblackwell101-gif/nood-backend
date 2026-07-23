/**
 * Inventory reservation — server-side holds to prevent overselling.
 *
 * Available = catalog quantityAvailable - sum(active reservations)
 * CONTINUE inventoryPolicy variants are not reserved (Shopify allow-oversell).
 *
 * Redis (preferred) or in-memory for tests. Production should use Redis.
 */

const crypto = require('crypto');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errorWithStatus(message, statusCode = 400, code = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function getReservationConfig(env = process.env) {
  return {
    ttlSeconds: Math.max(60, Number(env.INVENTORY_RESERVATION_TTL_SECONDS || 900)),
    namespace: safeString(env.REDIS_NAMESPACE, 'nood'),
    enabled: String(env.INVENTORY_RESERVATION_ENABLED || 'true').toLowerCase() !== 'false',
  };
}

const RESERVE_LUA = `
  local reservedKey = KEYS[1]
  local reservationKey = KEYS[2]
  local indexKey = KEYS[3]
  local qty = tonumber(ARGV[1])
  local available = tonumber(ARGV[2])
  local reservationId = ARGV[3]
  local ttl = tonumber(ARGV[4])
  local payload = ARGV[5]
  local now = tonumber(ARGV[6])

  local existing = redis.call("GET", reservationKey)
  if existing then
    return existing
  end

  local currentlyReserved = tonumber(redis.call("GET", reservedKey) or "0")
  if currentlyReserved + qty > available then
    return cjson.encode({ ok = false, error = "insufficient", currentlyReserved = currentlyReserved, available = available })
  end

  redis.call("INCRBY", reservedKey, qty)
  redis.call("SET", reservationKey, payload, "EX", ttl)
  redis.call("ZADD", indexKey, now + ttl, reservationId)
  return cjson.encode({ ok = true, reservationId = reservationId, reserved = currentlyReserved + qty })
`;

const RELEASE_LUA = `
  local reservedKey = KEYS[1]
  local reservationKey = KEYS[2]
  local indexKey = KEYS[3]
  local reservationId = ARGV[1]
  local qty = tonumber(ARGV[2])

  local existing = redis.call("GET", reservationKey)
  if not existing then
    return cjson.encode({ ok = true, duplicate = true })
  end

  local current = tonumber(redis.call("GET", reservedKey) or "0")
  local next = current - qty
  if next < 0 then next = 0 end
  redis.call("SET", reservedKey, tostring(next))
  redis.call("DEL", reservationKey)
  redis.call("ZREM", indexKey, reservationId)
  return cjson.encode({ ok = true, reserved = next })
`;

function createMemoryReservationService({ ttlSeconds = 900 } = {}) {
  const reservedByVariant = new Map();
  const reservations = new Map();

  function getReserved(variantId) {
    return Number(reservedByVariant.get(variantId) || 0);
  }

  async function reserveLines({ reservationId, lines, getAvailableQty, customerId, checkoutSessionId }) {
    const id = safeString(reservationId) || `res_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    if (reservations.has(id)) {
      return { ...reservations.get(id), duplicate: true };
    }

    // Validate all lines first (all-or-nothing)
    for (const line of lines) {
      const variantId = safeString(line.variantId);
      const qty = Number(line.quantity);
      const available = await getAvailableQty(variantId, line);
      if (available == null) continue; // policy CONTINUE / untracked
      const reserved = getReserved(variantId);
      if (reserved + qty > available) {
        throw errorWithStatus(
          `Insufficient inventory for ${variantId}.`,
          409,
          'inventory_insufficient'
        );
      }
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const held = [];
    for (const line of lines) {
      const variantId = safeString(line.variantId);
      const qty = Number(line.quantity);
      const available = await getAvailableQty(variantId, line);
      if (available == null) continue;
      reservedByVariant.set(variantId, getReserved(variantId) + qty);
      held.push({ variantId, quantity: qty });
    }

    const record = {
      reservationId: id,
      customerId: safeString(customerId),
      checkoutSessionId: safeString(checkoutSessionId),
      lines: held,
      status: 'active',
      expiresAt,
      createdAt: new Date().toISOString(),
    };
    reservations.set(id, record);

    // Auto-release timer for memory mode
    setTimeout(() => {
      void releaseReservation(id).catch(() => {});
    }, ttlSeconds * 1000).unref?.();

    return { ...record, duplicate: false };
  }

  async function releaseReservation(reservationId) {
    const id = safeString(reservationId);
    const record = reservations.get(id);
    if (!record || record.status !== 'active') {
      return { ok: true, duplicate: true };
    }
    for (const line of record.lines || []) {
      const next = getReserved(line.variantId) - Number(line.quantity || 0);
      reservedByVariant.set(line.variantId, Math.max(0, next));
    }
    record.status = 'released';
    record.releasedAt = new Date().toISOString();
    reservations.set(id, record);
    return { ok: true, duplicate: false, record };
  }

  async function commitReservation(reservationId) {
    const id = safeString(reservationId);
    const record = reservations.get(id);
    if (!record) return { ok: true, duplicate: true };
    if (record.status === 'committed') return { ok: true, duplicate: true, record };
    // Keep hold until release after order success, or convert to committed and drop from available pool permanently until catalog sync
    record.status = 'committed';
    record.committedAt = new Date().toISOString();
    reservations.set(id, record);
    return { ok: true, record };
  }

  async function getReservedQuantity(variantId) {
    return getReserved(variantId);
  }

  async function purgeExpired() {
    const now = Date.now();
    for (const [id, record] of reservations.entries()) {
      if (record.status === 'active' && new Date(record.expiresAt).getTime() <= now) {
        await releaseReservation(id);
      }
    }
  }

  return {
    driver: 'memory',
    reserveLines,
    releaseReservation,
    commitReservation,
    getReservedQuantity,
    purgeExpired,
    ttlSeconds,
  };
}

function createRedisReservationService({ redis, namespace = 'nood', ttlSeconds = 900 } = {}) {
  if (!redis) {
    throw new Error('redis is required for Redis reservation service');
  }

  function reservedKey(variantId) {
    return `${namespace}:inventory:reserved:${safeString(variantId)}`;
  }
  function reservationKey(reservationId) {
    return `${namespace}:inventory:reservation:${safeString(reservationId)}`;
  }
  function indexKey() {
    return `${namespace}:inventory:reservation_index`;
  }

  async function getReservedQuantity(variantId) {
    const raw = await redis.get(reservedKey(variantId));
    return Number(raw || 0) || 0;
  }

  async function purgeExpired() {
    const now = Date.now();
    const expiredIds = await redis.zrangebyscore(indexKey(), 0, now);
    for (const reservationId of expiredIds || []) {
      const raw = await redis.get(reservationKey(reservationId));
      if (!raw) {
        await redis.zrem(indexKey(), reservationId);
        continue;
      }
      try {
        const record = JSON.parse(raw);
        await releaseReservation(reservationId, record);
      } catch {
        await redis.zrem(indexKey(), reservationId);
      }
    }
  }

  async function reserveLines({ reservationId, lines, getAvailableQty, customerId, checkoutSessionId }) {
    await purgeExpired();
    const id = safeString(reservationId) || `res_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const existingRaw = await redis.get(reservationKey(id));
    if (existingRaw) {
      try {
        return { ...JSON.parse(existingRaw), duplicate: true };
      } catch {
        /* continue */
      }
    }

    // Pre-check availability (best-effort); atomic path is per-variant
    const holdable = [];
    for (const line of lines) {
      const variantId = safeString(line.variantId);
      const qty = Number(line.quantity);
      const available = await getAvailableQty(variantId, line);
      if (available == null) continue;
      const reserved = await getReservedQuantity(variantId);
      if (reserved + qty > available) {
        throw errorWithStatus(
          `Insufficient inventory for ${variantId}.`,
          409,
          'inventory_insufficient'
        );
      }
      holdable.push({ variantId, quantity: qty, available });
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const record = {
      reservationId: id,
      customerId: safeString(customerId),
      checkoutSessionId: safeString(checkoutSessionId),
      lines: holdable.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      status: 'active',
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    // Reserve each variant; roll back on failure
    const applied = [];
    try {
      for (const line of holdable) {
        const payload = JSON.stringify({
          ...record,
          singleVariant: line.variantId,
        });
        const raw = await redis.eval(
          RESERVE_LUA,
          3,
          reservedKey(line.variantId),
          `${reservationKey(id)}:${line.variantId}`,
          indexKey(),
          String(line.quantity),
          String(line.available),
          id,
          String(ttlSeconds),
          payload,
          String(Date.now())
        );
        const result = JSON.parse(raw);
        if (!result?.ok) {
          throw errorWithStatus(
            `Insufficient inventory for ${line.variantId}.`,
            409,
            'inventory_insufficient'
          );
        }
        applied.push(line);
      }
      await redis.set(reservationKey(id), JSON.stringify(record), 'EX', ttlSeconds);
      await redis.zadd(indexKey(), Date.now() + ttlSeconds * 1000, id);
      return { ...record, duplicate: false };
    } catch (error) {
      for (const line of applied) {
        await redis.eval(
          RELEASE_LUA,
          3,
          reservedKey(line.variantId),
          `${reservationKey(id)}:${line.variantId}`,
          indexKey(),
          id,
          String(line.quantity)
        );
      }
      await redis.del(reservationKey(id));
      throw error;
    }
  }

  async function releaseReservation(reservationId, knownRecord = null) {
    const id = safeString(reservationId);
    const raw = knownRecord ? null : await redis.get(reservationKey(id));
    const record = knownRecord || (raw ? JSON.parse(raw) : null);
    if (!record || record.status === 'released') {
      return { ok: true, duplicate: true };
    }

    for (const line of record.lines || []) {
      await redis.eval(
        RELEASE_LUA,
        3,
        reservedKey(line.variantId),
        `${reservationKey(id)}:${line.variantId}`,
        indexKey(),
        id,
        String(line.quantity)
      );
    }
    record.status = 'released';
    record.releasedAt = new Date().toISOString();
    await redis.set(reservationKey(id), JSON.stringify(record), 'EX', 3600);
    await redis.zrem(indexKey(), id);
    return { ok: true, duplicate: false, record };
  }

  async function commitReservation(reservationId) {
    const id = safeString(reservationId);
    const raw = await redis.get(reservationKey(id));
    if (!raw) return { ok: true, duplicate: true };
    const record = JSON.parse(raw);
    record.status = 'committed';
    record.committedAt = new Date().toISOString();
    // Keep reserved counts until catalog reflects sold units; release holds after short grace
    await redis.set(reservationKey(id), JSON.stringify(record), 'EX', ttlSeconds);
    return { ok: true, record };
  }

  return {
    driver: 'redis',
    reserveLines,
    releaseReservation,
    commitReservation,
    getReservedQuantity,
    purgeExpired,
    ttlSeconds,
  };
}

function createInventoryReservationService({ redis = null, namespace = 'nood', env = process.env } = {}) {
  const config = getReservationConfig(env);
  if (!config.enabled) {
    return {
      driver: 'disabled',
      enabled: false,
      async reserveLines() {
        return { reservationId: null, lines: [], status: 'disabled', duplicate: false };
      },
      async releaseReservation() {
        return { ok: true, duplicate: true };
      },
      async commitReservation() {
        return { ok: true, duplicate: true };
      },
      async getReservedQuantity() {
        return 0;
      },
      async purgeExpired() {},
      ttlSeconds: config.ttlSeconds,
    };
  }

  if (redis) {
    return {
      enabled: true,
      ...createRedisReservationService({
        redis,
        namespace: config.namespace || namespace,
        ttlSeconds: config.ttlSeconds,
      }),
    };
  }

  return {
    enabled: true,
    ...createMemoryReservationService({ ttlSeconds: config.ttlSeconds }),
  };
}

/**
 * Build getAvailableQty from catalog cache + pricing helpers.
 */
function createCatalogAvailabilityResolver(cache, { getReservedQuantity }) {
  return async function getAvailableQty(variantId, lineHint = {}) {
    if (!cache?.getAllProducts) return null;
    const products = await cache.getAllProducts();
    for (const product of products || []) {
      for (const edge of product?.variants?.edges || []) {
        const variant = edge?.node;
        if (safeString(variant?.id) !== safeString(variantId)) continue;

        const policy = safeString(variant.inventoryPolicy).toUpperCase();
        if (policy === 'CONTINUE') return null; // do not reserve unlimited policy

        const catalogQty = Number(variant.quantityAvailable ?? variant.inventoryQuantity);
        if (!Number.isFinite(catalogQty) || catalogQty < 0) return null;

        const reserved = getReservedQuantity ? await getReservedQuantity(variantId) : 0;
        // available for NEW reservations already subtracts reserved in reserve Lua via `available` catalog qty
        // We pass catalog qty as ceiling; reserved is tracked separately.
        return catalogQty;
      }
    }
    // Unknown variant — let priceCart fail later
    return lineHint?.quantityAvailable != null ? Number(lineHint.quantityAvailable) : 0;
  };
}

module.exports = {
  createInventoryReservationService,
  createCatalogAvailabilityResolver,
  getReservationConfig,
  RESERVE_LUA,
  RELEASE_LUA,
};
