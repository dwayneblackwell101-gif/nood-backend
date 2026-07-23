/**
 * Server-authoritative Orders & Shipment Tracking service.
 * Additive overlay: does not replace Shopify order creation or existing refund APIs.
 */

const crypto = require('crypto');
const { getOrdersConfig } = require('./config');
const {
  ORDER_EVENT_TYPES,
  ORDER_STATUS,
  describeEvent,
  isKnownEventType,
} = require('./events');
const {
  normalizeCarrierCode,
  getCarrier,
  buildTrackingUrl,
  createCarrierClient,
} = require('./carriers');
const { normalizeShopifyCustomerId } = require('../auth/customer-auth');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errorWithCode(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sanitizeText(input, maxLen = 500) {
  let text = String(input || '');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/javascript:/gi, '');
  text = text.replace(/on\w+\s*=/gi, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) text = text.slice(0, maxLen);
  return text;
}

function addDaysIso(fromDate, days) {
  const d = new Date(fromDate.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function hoursSince(iso, now) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / (60 * 60 * 1000);
}

function createOrdersService({
  store,
  config = getOrdersConfig(),
  lockService = null,
  pushNotifier = null,
  carrierClient = null,
  loadCustomerOrders = null,
  refundService = null,
  nowFn = () => new Date(),
} = {}) {
  if (!store) throw new Error('Orders store is required.');

  const carriers = carrierClient || createCarrierClient();
  /** In-process lock chains for concurrent event dedupe when Redis lock is absent. */
  const localLockChains = new Map();

  async function audit(event, detail = {}) {
    const entry = { event, at: nowFn().toISOString(), ...detail, token: undefined };
    await store.pushAudit(entry, config.auditLimit);
    await store.incrMetric(`event:${event}`);
    console.log('[ORDERS AUDIT]', {
      event,
      orderId: detail.orderId || null,
      customerId: detail.customerId || null,
      code: detail.code || null,
      success: detail.success,
    });
  }

  async function withLocalChain(key, fn) {
    const k = safeString(key) || 'global';
    const prev = localLockChains.get(k) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chained = prev.catch(() => {}).then(() => gate);
    localLockChains.set(k, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function withLock(key, fn) {
    if (lockService?.withLock) {
      return lockService.withLock(`orders:${safeString(key)}`, 20, fn);
    }
    return withLocalChain(key, fn);
  }

  async function checkRate(bucket, limit, windowSeconds) {
    const count = await store.incrRate(bucket, windowSeconds);
    if (count > limit) {
      throw errorWithCode('Too many order requests. Please try again later.', 429, 'rate_limited');
    }
  }

  function publicEvent(event, { includeInternal = false } = {}) {
    if (!event) return null;
    if (!includeInternal && event.customerVisible === false) return null;
    return {
      id: event.id,
      type: event.type,
      status: event.status || event.type,
      label: event.label,
      description: event.description,
      timestamp: event.timestamp,
      location: event.location || null,
      trackingNumber: event.trackingNumber || null,
      shipmentId: event.shipmentId || null,
      carrier: event.carrier || null,
      carrierMetadata: event.carrierMetadata || null,
      source: event.source || null,
    };
  }

  function publicShipment(shipment) {
    if (!shipment) return null;
    const carrier = getCarrier(shipment.carrier);
    return {
      id: shipment.id,
      orderId: shipment.orderId,
      status: shipment.status,
      trackingNumber: shipment.trackingNumber || null,
      trackingUrl: shipment.trackingUrl || buildTrackingUrl(shipment.carrier, shipment.trackingNumber),
      carrier: {
        code: carrier.code,
        name: shipment.carrierName || carrier.name,
      },
      items: Array.isArray(shipment.items) ? shipment.items : [],
      estimatedDelivery: shipment.estimatedDelivery || null,
      deliveryWindow: shipment.deliveryWindow || null,
      shippedAt: shipment.shippedAt || null,
      deliveredAt: shipment.deliveredAt || null,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
    };
  }

  function deriveStatus(order, shipments = [], events = []) {
    if (order.statusOverride) return order.statusOverride;
    if (order.cancelledAt || order.status === ORDER_STATUS.CANCELLED) return ORDER_STATUS.CANCELLED;
    if (order.refunded || order.status === ORDER_STATUS.REFUNDED) return ORDER_STATUS.REFUNDED;

    const types = new Set(events.map((e) => e.type));
    if (shipments.length && shipments.every((s) => s.status === 'delivered')) {
      return ORDER_STATUS.DELIVERED;
    }
    if (types.has(ORDER_EVENT_TYPES.DELIVERED) && shipments.length === 0) {
      return ORDER_STATUS.DELIVERED;
    }
    if (types.has(ORDER_EVENT_TYPES.OUT_FOR_DELIVERY)) return ORDER_STATUS.OUT_FOR_DELIVERY;
    if (types.has(ORDER_EVENT_TYPES.DELIVERY_FAILED)) return ORDER_STATUS.DELIVERY_FAILED;
    if (types.has(ORDER_EVENT_TYPES.RETURNED)) return ORDER_STATUS.RETURNED;

    const shippedCount = shipments.filter((s) =>
      ['in_transit', 'out_for_delivery', 'picked_up', 'shipped', 'delivered'].includes(s.status)
    ).length;
    if (shipments.length > 1 && shippedCount > 0 && shippedCount < shipments.length) {
      return ORDER_STATUS.PARTIALLY_SHIPPED;
    }
    if (shippedCount > 0 || types.has(ORDER_EVENT_TYPES.IN_TRANSIT) || types.has(ORDER_EVENT_TYPES.PICKED_UP)) {
      return ORDER_STATUS.SHIPPED;
    }
    if (types.has(ORDER_EVENT_TYPES.PREPARING_ORDER) || types.has(ORDER_EVENT_TYPES.PACKED)) {
      return ORDER_STATUS.PREPARING;
    }
    if (types.has(ORDER_EVENT_TYPES.PAYMENT_CAPTURED) || order.financialStatus === 'paid') {
      return ORDER_STATUS.PAID;
    }
    return order.status || ORDER_STATUS.PLACED;
  }

  function estimateDelivery(order, shipments = []) {
    const fromShipments = shipments
      .map((s) => s.estimatedDelivery)
      .filter(Boolean)
      .sort();
    if (fromShipments.length) {
      return {
        estimatedDelivery: fromShipments[0],
        deliveryWindow: shipments.find((s) => s.deliveryWindow)?.deliveryWindow || null,
        source: 'shipment',
      };
    }
    if (order.estimatedDelivery) {
      return {
        estimatedDelivery: order.estimatedDelivery,
        deliveryWindow: order.deliveryWindow || null,
        source: 'order',
      };
    }
    const base = new Date(order.createdAt || nowFn().toISOString());
    const min = addDaysIso(base, config.defaultDeliveryDaysMin);
    const max = addDaysIso(base, config.defaultDeliveryDaysMax);
    return {
      estimatedDelivery: max,
      deliveryWindow: { start: min, end: max },
      source: 'default',
    };
  }

  async function loadShipments(orderId) {
    const ids = await store.listShipmentIds(orderId);
    const list = [];
    for (const id of ids) {
      const s = await store.getShipment(id);
      if (s) list.push(s);
    }
    return list;
  }

  async function appendTimelineEvent(order, input = {}, { notify = true } = {}) {
    return withLock(`event:${order.id}`, async () => {
      const type = safeString(input.type);
      if (!type || !isKnownEventType(type)) {
        throw errorWithCode('Unknown event type.', 400, 'validation_error');
      }
      const dedupeKey = safeString(
        input.dedupeKey || `${type}:${input.trackingNumber || ''}:${input.timestamp || ''}`
      );
      if (dedupeKey && (await store.hasDedupe(order.id, dedupeKey))) {
        await store.incrMetric('event_deduped');
        return { duplicate: true, event: null };
      }

      const meta = describeEvent(type, sanitizeText(input.description, 500));
      const event = {
        id: `evt_${crypto.randomBytes(10).toString('hex')}`,
        orderId: order.id,
        type,
        status: safeString(input.status, type),
        label: meta.label,
        description: meta.description,
        timestamp: safeString(input.timestamp) || nowFn().toISOString(),
        location: sanitizeText(input.location, 120) || null,
        trackingNumber: safeString(input.trackingNumber) || null,
        shipmentId: safeString(input.shipmentId) || null,
        carrier: input.carrier ? normalizeCarrierCode(input.carrier) : null,
        carrierMetadata:
          input.carrierMetadata && typeof input.carrierMetadata === 'object'
            ? input.carrierMetadata
            : null,
        customerVisible: input.customerVisible !== false && meta.customerVisible,
        source: safeString(input.source, 'system'),
        actor: safeString(input.actor, 'system'),
        dedupeKey: dedupeKey || null,
        createdAt: nowFn().toISOString(),
      };

      await store.appendEvent(order.id, event, config.historyLimit);
      await store.invalidateTimelineCache(order.id);
      await store.incrMetric('event_appended');

      if (notify && pushNotifier && event.customerVisible) {
        await pushNotifier.notifyOrderEvent({
          customerId: order.customerId,
          orderId: order.id,
          eventType: type,
          title: `${meta.label}`,
          body: `Order ${order.shopifyOrderName || order.id}: ${meta.description}`,
          data: {
            orderId: order.id,
            shopifyOrderName: order.shopifyOrderName || '',
            trackingNumber: event.trackingNumber || '',
          },
        });
      }

      await audit('event_append', {
        orderId: order.id,
        customerId: order.customerId,
        eventType: type,
        success: true,
      });

      return { duplicate: false, event };
    });
  }

  async function upsertOrderFromPayload(payload = {}, { seedEvents = true } = {}) {
    const customerId =
      normalizeShopifyCustomerId(payload.customerId) || safeString(payload.customerId);
    const shopifyOrderId = safeString(payload.shopifyOrderId || payload.id);
    const shopifyOrderName = safeString(payload.shopifyOrderName || payload.name || payload.id);
    if (!customerId) {
      throw errorWithCode('customerId is required.', 400, 'validation_error');
    }
    if (!shopifyOrderId && !shopifyOrderName) {
      throw errorWithCode('Order identifier is required.', 400, 'validation_error');
    }

    let existingId =
      (shopifyOrderId && (await store.getOrderIdByShopify(shopifyOrderId))) ||
      (shopifyOrderName && (await store.getOrderIdByName(shopifyOrderName))) ||
      '';
    let order = existingId ? await store.getOrder(existingId) : null;

    const now = nowFn().toISOString();
    if (!order) {
      order = {
        id: `ord_${crypto.randomBytes(12).toString('hex')}`,
        customerId,
        shopifyOrderId: shopifyOrderId || null,
        shopifyOrderName: shopifyOrderName || null,
        status: ORDER_STATUS.PLACED,
        financialStatus: safeString(payload.financialStatus || payload.displayFinancialStatus, 'pending'),
        fulfillmentStatus: safeString(payload.fulfillmentStatus, ''),
        currency: safeString(payload.currency, 'USD'),
        total: Number(payload.total || 0),
        items: Array.isArray(payload.items) ? payload.items : [],
        shippingAddress: payload.shippingAddress || null,
        paymentMethod: safeString(payload.paymentMethod, ''),
        trackingNumber: safeString(payload.trackingNumber) || null,
        trackingUrl: safeString(payload.trackingUrl) || null,
        carrier: payload.carrier ? normalizeCarrierCode(payload.carrier) : null,
        estimatedDelivery: payload.estimatedDelivery || null,
        deliveryWindow: payload.deliveryWindow || null,
        cancelledAt: payload.cancelledAt || null,
        cancelReason: payload.cancelReason || null,
        refunded: Boolean(payload.refunded),
        refundedAmount: Number(payload.refundedAmount || 0),
        notes: [],
        createdAt: safeString(payload.date || payload.createdAt) || now,
        updatedAt: now,
        source: safeString(payload.source, 'import'),
      };
      await store.saveOrder(order);

      if (seedEvents) {
        await appendTimelineEvent(
          order,
          {
            type: ORDER_EVENT_TYPES.ORDER_PLACED,
            timestamp: order.createdAt,
            dedupeKey: `order_placed:${order.id}`,
            source: 'import',
          },
          { notify: false }
        );
        const paidLike = /paid|captured|authorized/i.test(order.financialStatus);
        if (paidLike) {
          await appendTimelineEvent(
            order,
            {
              type: ORDER_EVENT_TYPES.PAYMENT_CAPTURED,
              timestamp: order.createdAt,
              dedupeKey: `payment_captured:${order.id}`,
              source: 'import',
            },
            { notify: false }
          );
        }
        if (order.trackingNumber) {
          await createShipment(order.customerId, order.id, {
            trackingNumber: order.trackingNumber,
            trackingUrl: order.trackingUrl,
            carrier: order.carrier || 'other',
            status: 'in_transit',
            items: order.items,
          }, { asAdmin: true, notify: false, actor: 'import' });
        }
      }
    } else {
      order.financialStatus = safeString(payload.financialStatus || order.financialStatus);
      order.fulfillmentStatus = safeString(payload.fulfillmentStatus || order.fulfillmentStatus);
      order.total = payload.total != null ? Number(payload.total) : order.total;
      order.items = Array.isArray(payload.items) ? payload.items : order.items;
      order.trackingNumber = safeString(payload.trackingNumber) || order.trackingNumber;
      order.trackingUrl = safeString(payload.trackingUrl) || order.trackingUrl;
      order.carrier = payload.carrier ? normalizeCarrierCode(payload.carrier) : order.carrier;
      order.cancelledAt = payload.cancelledAt || order.cancelledAt;
      order.refunded = payload.refunded != null ? Boolean(payload.refunded) : order.refunded;
      order.refundedAmount =
        payload.refundedAmount != null ? Number(payload.refundedAmount) : order.refundedAmount;
      await store.saveOrder(order);
      await store.invalidateTimelineCache(order.id);
    }

    return order;
  }

  async function createShipment(customerId, orderId, body = {}, opts = {}) {
    const order = await assertOrderAccess(customerId, orderId, { asAdmin: opts.asAdmin });
    const trackingNumber = safeString(body.trackingNumber);
    const carrierCode = normalizeCarrierCode(body.carrier || body.carrierCode || 'other');
    const carrier = getCarrier(carrierCode);
    const now = nowFn().toISOString();
    const shipment = {
      id: `shp_${crypto.randomBytes(10).toString('hex')}`,
      orderId: order.id,
      status: safeString(body.status, 'awaiting_carrier'),
      trackingNumber: trackingNumber || null,
      trackingUrl: buildTrackingUrl(carrierCode, trackingNumber, body.trackingUrl),
      carrier: carrierCode,
      carrierName: safeString(body.carrierName, carrier.name),
      items: Array.isArray(body.items) ? body.items : [],
      estimatedDelivery: body.estimatedDelivery || null,
      deliveryWindow: body.deliveryWindow || null,
      shippedAt: body.shippedAt || now,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await store.saveShipment(shipment);

    await appendTimelineEvent(
      order,
      {
        type: ORDER_EVENT_TYPES.SHIPMENT_CREATED,
        description: trackingNumber
          ? `Shipment created with tracking ${trackingNumber}.`
          : 'Shipment created.',
        trackingNumber,
        shipmentId: shipment.id,
        carrier: carrierCode,
        dedupeKey: `shipment_created:${shipment.id}`,
        source: opts.actor || 'admin',
      },
      { notify: opts.notify !== false }
    );

    if (trackingNumber) {
      await appendTimelineEvent(
        order,
        {
          type: ORDER_EVENT_TYPES.IN_TRANSIT,
          trackingNumber,
          shipmentId: shipment.id,
          carrier: carrierCode,
          dedupeKey: `in_transit:${shipment.id}:${trackingNumber}`,
          source: opts.actor || 'admin',
        },
        { notify: opts.notify !== false }
      );
      shipment.status = 'in_transit';
      await store.saveShipment(shipment);
    }

    order.trackingNumber = order.trackingNumber || trackingNumber;
    order.trackingUrl = order.trackingUrl || shipment.trackingUrl;
    order.carrier = order.carrier || carrierCode;
    await store.saveOrder(order);

    return { success: true, shipment: publicShipment(shipment) };
  }

  async function assertOrderAccess(customerId, orderId, { asAdmin = false } = {}) {
    const order = await store.getOrder(orderId);
    if (!order) {
      // try resolve by shopify name/id
      const byName = await store.getOrderIdByName(orderId);
      const byShopify = await store.getOrderIdByShopify(orderId);
      const resolved = byName || byShopify;
      if (resolved) {
        const o = await store.getOrder(resolved);
        if (o) return assertOrderAccess(customerId, o.id, { asAdmin });
      }
      throw errorWithCode('Order not found.', 404, 'not_found');
    }
    if (asAdmin) return order;
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    if (order.customerId !== id) {
      throw errorWithCode('You do not have access to this order.', 403, 'forbidden');
    }
    return order;
  }

  async function getTimeline(customerId, orderId, { page = 1, pageSize, asAdmin = false } = {}) {
    await checkRate(
      `read:${safeString(customerId)}`,
      config.rateReadPerMin,
      60
    );
    const order = await assertOrderAccess(customerId, orderId, { asAdmin });

    const cached = await store.getTimelineCache(order.id);
    if (cached && cached.cachedAt) {
      const age = nowFn().getTime() - new Date(cached.cachedAt).getTime();
      if (age < config.timelineCacheTtlSeconds * 1000) {
        await store.incrMetric('timeline_cache_hit');
        return paginateTimeline(cached, page, pageSize);
      }
    }
    await store.incrMetric('timeline_cache_miss');

    const events = await store.listEvents(order.id, 0, config.historyLimit - 1);
    const shipments = await loadShipments(order.id);
    const status = deriveStatus(order, shipments, events);
    const eta = estimateDelivery(order, shipments);
    const cancellation = await store.getCancellation(order.id);
    const refundStatus = await store.getRefundStatus(order.id);
    const returnIds = await store.listReturnIds(order.id);
    const returns = [];
    for (const rid of returnIds) {
      const r = await store.getReturnRecord(rid);
      if (r) returns.push(r);
    }

    const payload = {
      success: true,
      order: {
        id: order.id,
        shopifyOrderId: order.shopifyOrderId,
        shopifyOrderName: order.shopifyOrderName,
        customerId: asAdmin ? order.customerId : undefined,
        status,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        currency: order.currency,
        total: order.total,
        items: order.items,
        paymentMethod: order.paymentMethod,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        cancelledAt: order.cancelledAt,
        cancelReason: order.cancelReason,
        refunded: order.refunded,
        refundedAmount: order.refundedAmount,
        estimatedDelivery: eta.estimatedDelivery,
        deliveryWindow: eta.deliveryWindow,
        notes: Array.isArray(order.notes)
          ? order.notes.filter((n) => n.customerVisible !== false)
          : [],
      },
      shipments: shipments.map(publicShipment),
      events: events
        .filter((e) => e.customerVisible !== false)
        .map((e) => publicEvent(e))
        .filter(Boolean),
      cancellation: cancellation
        ? {
            status: cancellation.status,
            reason: cancellation.reason,
            requestedAt: cancellation.requestedAt,
            resolvedAt: cancellation.resolvedAt || null,
          }
        : null,
      refundStatus: refundStatus
        ? {
            status: refundStatus.status,
            amount: refundStatus.amount,
            currency: refundStatus.currency,
            updatedAt: refundStatus.updatedAt,
            externalRequestId: refundStatus.externalRequestId || null,
          }
        : null,
      returns: returns.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      cachedAt: nowFn().toISOString(),
    };

    await store.setTimelineCache(order.id, payload, config.timelineCacheTtlSeconds);
    return paginateTimeline(payload, page, pageSize);
  }

  function paginateTimeline(payload, page, pageSize) {
    const size = Math.min(
      config.eventsPageSizeMax,
      Math.max(1, Number(pageSize) || config.eventsPageSizeDefault)
    );
    const pageNum = Math.max(1, Number(page) || 1);
    const all = Array.isArray(payload.events) ? payload.events : [];
    // events stored newest-first; for timeline UI reverse to chronological for page
    const chronological = [...all].reverse();
    const total = chronological.length;
    const start = (pageNum - 1) * size;
    const slice = chronological.slice(start, start + size);
    return {
      ...payload,
      events: slice,
      eventsPage: pageNum,
      eventsPageSize: size,
      eventsTotal: total,
      eventsTotalPages: Math.max(1, Math.ceil(total / size)),
      eventsHasMore: start + size < total,
    };
  }

  async function listCustomerOrders(customerId, { page = 1, pageSize } = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`list:${id}`, config.rateReadPerMin, 60);
    const size = Math.min(config.pageSizeMax, Math.max(1, Number(pageSize) || config.pageSizeDefault));
    const pageNum = Math.max(1, Number(page) || 1);
    const ids = await store.listCustomerOrderIds(id);
    const orders = [];
    for (const oid of ids) {
      const order = await store.getOrder(oid);
      if (!order) continue;
      const shipments = await loadShipments(order.id);
      const events = await store.listEvents(order.id, 0, 20);
      const status = deriveStatus(order, shipments, events);
      const eta = estimateDelivery(order, shipments);
      orders.push({
        id: order.id,
        shopifyOrderId: order.shopifyOrderId,
        shopifyOrderName: order.shopifyOrderName,
        status,
        total: order.total,
        currency: order.currency,
        createdAt: order.createdAt,
        estimatedDelivery: eta.estimatedDelivery,
        trackingNumber: order.trackingNumber || shipments[0]?.trackingNumber || null,
        shipmentCount: shipments.length,
      });
    }
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const total = orders.length;
    const start = (pageNum - 1) * size;
    return {
      success: true,
      page: pageNum,
      pageSize: size,
      total,
      orders: orders.slice(start, start + size),
    };
  }

  async function trackingLookup(customerId, trackingNumber, { asAdmin = false } = {}) {
    const number = safeString(trackingNumber);
    if (!number) throw errorWithCode('trackingNumber is required.', 400, 'validation_error');
    const idx = await store.getByTracking(number);
    if (!idx?.orderId) throw errorWithCode('Tracking number not found.', 404, 'not_found');
    const order = await assertOrderAccess(customerId, idx.orderId, { asAdmin });
    const shipment = await store.getShipment(idx.shipmentId);
    const carrierResult = config.carriersEnabled
      ? await carriers.fetchTracking({
          carrier: shipment?.carrier,
          trackingNumber: number,
        })
      : { ok: false, events: [] };

    return {
      success: true,
      orderId: order.id,
      shopifyOrderName: order.shopifyOrderName,
      shipment: publicShipment(shipment),
      trackingUrl: buildTrackingUrl(shipment?.carrier, number, shipment?.trackingUrl),
      carrierLookup: {
        ok: Boolean(carrierResult.ok),
        provider: carrierResult.provider,
        message: carrierResult.message || null,
        status: carrierResult.status || null,
        estimatedDelivery: carrierResult.estimatedDelivery || null,
        events: carrierResult.events || [],
      },
    };
  }

  async function addShipmentEvent(orderId, body = {}, { asAdmin = true, actor = 'admin' } = {}) {
    const order = await assertOrderAccess('admin', orderId, { asAdmin: true });
    let shipment = null;
    if (body.shipmentId) {
      shipment = await store.getShipment(body.shipmentId);
      if (!shipment || shipment.orderId !== order.id) {
        throw errorWithCode('Shipment not found on order.', 404, 'not_found');
      }
    }

    const type = safeString(body.type || body.status);
    const result = await appendTimelineEvent(order, {
      type,
      description: body.description,
      location: body.location,
      trackingNumber: body.trackingNumber || shipment?.trackingNumber,
      shipmentId: shipment?.id,
      carrier: body.carrier || shipment?.carrier,
      carrierMetadata: body.carrierMetadata || body.metadata,
      timestamp: body.timestamp,
      dedupeKey: body.dedupeKey,
      source: actor,
      status: body.status,
    });

    if (shipment && !result.duplicate) {
      if (type === ORDER_EVENT_TYPES.DELIVERED) {
        shipment.status = 'delivered';
        shipment.deliveredAt = body.timestamp || nowFn().toISOString();
      } else if (type === ORDER_EVENT_TYPES.OUT_FOR_DELIVERY) {
        shipment.status = 'out_for_delivery';
      } else if (type === ORDER_EVENT_TYPES.IN_TRANSIT || type === ORDER_EVENT_TYPES.PICKED_UP) {
        shipment.status = 'in_transit';
      } else if (type === ORDER_EVENT_TYPES.DELIVERY_FAILED) {
        shipment.status = 'delivery_failed';
      }
      if (body.estimatedDelivery) shipment.estimatedDelivery = body.estimatedDelivery;
      if (body.deliveryWindow) shipment.deliveryWindow = body.deliveryWindow;
      await store.saveShipment(shipment);
    }

    return {
      success: true,
      duplicate: Boolean(result.duplicate),
      event: publicEvent(result.event),
    };
  }

  async function requestCancellation(customerId, orderId, body = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`cancel:${id}`, config.rateCancelPerDay, 86400);
    if (!config.allowCustomerCancel) {
      throw errorWithCode('Cancellations are disabled.', 403, 'cancel_disabled');
    }

    return withLock(orderId, async () => {
      const order = await assertOrderAccess(id, orderId);
      if (order.cancelledAt) {
        throw errorWithCode('Order is already cancelled.', 409, 'already_cancelled');
      }
      const age = hoursSince(order.createdAt, nowFn());
      if (age > config.cancelWindowHours) {
        throw errorWithCode(
          `Cancellations are only allowed within ${config.cancelWindowHours} hours of placement.`,
          403,
          'cancel_window_expired'
        );
      }
      const shipments = await loadShipments(order.id);
      if (shipments.some((s) => ['in_transit', 'out_for_delivery', 'delivered', 'picked_up'].includes(s.status))) {
        throw errorWithCode('Order already shipped and cannot be cancelled.', 403, 'already_shipped');
      }

      const existing = await store.getCancellation(order.id);
      if (existing && existing.status === 'requested') {
        return { success: true, cancellation: existing, duplicate: true };
      }

      const reason = sanitizeText(body.reason, 300) || 'Customer requested cancellation';
      const record = {
        orderId: order.id,
        customerId: id,
        status: 'requested',
        reason,
        requestedAt: nowFn().toISOString(),
        resolvedAt: null,
      };
      await store.saveCancellation(record);
      await appendTimelineEvent(order, {
        type: ORDER_EVENT_TYPES.CANCELLATION_REQUESTED,
        description: reason,
        dedupeKey: `cancel_req:${order.id}`,
        source: 'customer',
        actor: id,
      });

      await audit('cancellation_request', { orderId: order.id, customerId: id, success: true });
      return { success: true, cancellation: record, duplicate: false };
    });
  }

  async function resolveCancellation(orderId, { action, note, adminId } = {}) {
    const order = await assertOrderAccess('admin', orderId, { asAdmin: true });
    const act = safeString(action).toLowerCase();
    if (!['approve', 'reject'].includes(act)) {
      throw errorWithCode('action must be approve or reject.', 400, 'validation_error');
    }
    const record = (await store.getCancellation(order.id)) || {
      orderId: order.id,
      customerId: order.customerId,
      status: 'requested',
      reason: 'admin',
      requestedAt: nowFn().toISOString(),
    };

    if (act === 'approve') {
      record.status = 'approved';
      record.resolvedAt = nowFn().toISOString();
      record.resolvedBy = safeString(adminId, 'admin');
      record.note = sanitizeText(note, 300) || null;
      order.cancelledAt = record.resolvedAt;
      order.cancelReason = record.reason;
      order.statusOverride = ORDER_STATUS.CANCELLED;
      await store.saveOrder(order);
      await store.saveCancellation(record);
      await appendTimelineEvent(order, {
        type: ORDER_EVENT_TYPES.CANCELLED,
        description: sanitizeText(note, 300) || 'Order cancelled.',
        dedupeKey: `cancelled:${order.id}`,
        source: 'admin',
        actor: safeString(adminId, 'admin'),
      });
    } else {
      record.status = 'rejected';
      record.resolvedAt = nowFn().toISOString();
      record.resolvedBy = safeString(adminId, 'admin');
      record.note = sanitizeText(note, 300) || null;
      await store.saveCancellation(record);
    }

    await store.invalidateTimelineCache(order.id);
    return { success: true, cancellation: record };
  }

  async function requestReturn(customerId, orderId, body = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`return:${id}`, config.rateReturnPerDay, 86400);
    const order = await assertOrderAccess(id, orderId);
    const reason = sanitizeText(body.reason, 400);
    if (!reason) throw errorWithCode('Return reason is required.', 400, 'validation_error');

    const record = {
      id: `ret_${crypto.randomBytes(10).toString('hex')}`,
      orderId: order.id,
      customerId: id,
      status: 'requested',
      reason,
      items: Array.isArray(body.items) ? body.items : [],
      // future-ready exchange flag
      exchangeRequested: Boolean(body.exchangeRequested),
      createdAt: nowFn().toISOString(),
      updatedAt: nowFn().toISOString(),
    };
    await store.saveReturnRecord(record);
    await appendTimelineEvent(order, {
      type: record.exchangeRequested
        ? ORDER_EVENT_TYPES.EXCHANGE_REQUESTED
        : ORDER_EVENT_TYPES.RETURNED,
      description: reason,
      dedupeKey: `return:${record.id}`,
      source: 'customer',
      actor: id,
    });

    // Bridge to existing refund service when available (additive, non-breaking)
    let external = null;
    if (refundService?.submitCustomerRequest && body.forwardToRefundService) {
      try {
        external = await refundService.submitCustomerRequest({
          body: {
            orderId: order.shopifyOrderName || order.shopifyOrderId || order.id,
            reason,
            ...body.refundPayload,
          },
          customer: { id },
        });
      } catch (error) {
        external = { error: error.message };
      }
    }

    await audit('return_request', { orderId: order.id, customerId: id, returnId: record.id, success: true });
    return { success: true, returnRequest: record, refundBridge: external };
  }

  async function updateRefundStatus(orderId, body = {}, { adminId = 'admin' } = {}) {
    const order = await assertOrderAccess('admin', orderId, { asAdmin: true });
    const status = safeString(body.status, 'processing');
    const record = {
      orderId: order.id,
      status,
      amount: body.amount != null ? Number(body.amount) : order.refundedAmount || 0,
      currency: safeString(body.currency, order.currency || 'USD'),
      externalRequestId: safeString(body.externalRequestId) || null,
      updatedAt: nowFn().toISOString(),
      updatedBy: safeString(adminId),
    };
    await store.saveRefundStatus(record);

    if (status === 'approved') {
      await appendTimelineEvent(order, {
        type: ORDER_EVENT_TYPES.REFUND_APPROVED,
        dedupeKey: `refund_approved:${order.id}:${record.updatedAt}`,
        source: 'admin',
      });
    }
    if (status === 'completed' || status === 'refunded') {
      order.refunded = true;
      order.refundedAmount = record.amount;
      order.statusOverride = ORDER_STATUS.REFUNDED;
      await store.saveOrder(order);
      await appendTimelineEvent(order, {
        type: ORDER_EVENT_TYPES.REFUNDED,
        dedupeKey: `refunded:${order.id}:${record.updatedAt}`,
        source: 'admin',
      });
    }
    if (status === 'requested') {
      await appendTimelineEvent(order, {
        type: ORDER_EVENT_TYPES.REFUND_REQUESTED,
        dedupeKey: `refund_requested:${order.id}:${record.updatedAt}`,
        source: 'admin',
      });
    }

    return { success: true, refundStatus: record };
  }

  async function addOrderNote(orderId, body = {}, { asAdmin = false, customerId = null } = {}) {
    const order = await assertOrderAccess(customerId || 'admin', orderId, { asAdmin });
    const text = sanitizeText(body.note || body.body || body.text, 1000);
    if (!text) throw errorWithCode('Note text is required.', 400, 'validation_error');
    const note = {
      id: `note_${crypto.randomBytes(8).toString('hex')}`,
      body: text,
      customerVisible: body.customerVisible !== false,
      authorType: asAdmin ? 'admin' : 'customer',
      authorId: safeString(asAdmin ? body.adminId || 'admin' : customerId),
      createdAt: nowFn().toISOString(),
    };
    order.notes = Array.isArray(order.notes) ? order.notes : [];
    order.notes.push(note);
    await store.saveOrder(order);
    if (note.customerVisible) {
      await appendTimelineEvent(order, {
        type: ORDER_EVENT_TYPES.NOTE_ADDED,
        description: text,
        dedupeKey: `note:${note.id}`,
        source: note.authorType,
      });
    }
    return { success: true, note };
  }

  async function registerPushPreferences(customerId, body = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    const prefs = {
      customerId: id,
      enabled: body.enabled !== false,
      orderConfirmation: body.orderConfirmation !== false,
      payment: body.payment !== false,
      shipment: body.shipment !== false,
      outForDelivery: body.outForDelivery !== false,
      delivered: body.delivered !== false,
      refund: body.refund !== false,
      return: body.return !== false,
      cancel: body.cancel !== false,
      updatedAt: nowFn().toISOString(),
    };
    await store.savePushPrefs(id, prefs);
    return { success: true, preferences: prefs };
  }

  async function syncFromShopify(customerId) {
    if (typeof loadCustomerOrders !== 'function') {
      throw errorWithCode('Shopify order sync is unavailable.', 503, 'sync_unavailable');
    }
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`sync:${id}`, 10, 3600);
    const started = Date.now();
    let orders;
    try {
      orders = await loadCustomerOrders(id);
    } catch (error) {
      await store.incrMetric('sync_failure');
      throw errorWithCode(error.message || 'Sync failed.', 502, 'sync_failed');
    }
    const list = Array.isArray(orders) ? orders : [];
    let imported = 0;
    for (const row of list) {
      await upsertOrderFromPayload(
        {
          ...row,
          customerId: id,
          shopifyOrderId: row.shopifyOrderId || row.id,
          shopifyOrderName: row.shopifyOrderName || row.id,
          date: row.date || row.createdAt,
        },
        { seedEvents: true }
      );
      imported += 1;
    }
    await store.incrMetric('sync_success');
    await audit('shopify_sync', {
      customerId: id,
      success: true,
      imported,
      latencyMs: Date.now() - started,
    });
    return {
      success: true,
      imported,
      latencyMs: Date.now() - started,
    };
  }

  async function ingestCarrierWebhook(payload = {}, { secret } = {}) {
    if (config.carrierWebhookSecret) {
      if (safeString(secret) !== config.carrierWebhookSecret) {
        throw errorWithCode('Invalid carrier webhook secret.', 401, 'unauthorized');
      }
    }
    const trackingNumber = safeString(payload.trackingNumber || payload.tracking_number);
    if (!trackingNumber) throw errorWithCode('trackingNumber required.', 400, 'validation_error');
    const idx = await store.getByTracking(trackingNumber);
    if (!idx?.orderId) {
      await store.incrMetric('carrier_webhook_unknown_tracking');
      return { success: false, code: 'unknown_tracking' };
    }
    const order = await store.getOrder(idx.orderId);
    const type = mapCarrierStatusToEvent(payload.status || payload.eventType || payload.event);
    const result = await appendTimelineEvent(order, {
      type,
      description: sanitizeText(payload.description || payload.message, 500),
      location: payload.location,
      trackingNumber,
      shipmentId: idx.shipmentId,
      carrier: payload.carrier,
      carrierMetadata: payload.metadata || payload.raw || null,
      timestamp: payload.timestamp || payload.eventTime,
      dedupeKey:
        payload.dedupeKey ||
        `carrier:${trackingNumber}:${payload.status || ''}:${payload.timestamp || payload.eventTime || ''}`,
      source: 'carrier_webhook',
    });
    if (result.duplicate) await store.incrMetric('carrier_webhook_deduped');
    else await store.incrMetric('carrier_webhook_applied');
    return { success: true, duplicate: Boolean(result.duplicate), orderId: order.id };
  }

  function mapCarrierStatusToEvent(status) {
    const s = safeString(status).toLowerCase();
    if (s.includes('deliver') && s.includes('fail')) return ORDER_EVENT_TYPES.DELIVERY_FAILED;
    if (s.includes('delivered')) return ORDER_EVENT_TYPES.DELIVERED;
    if (s.includes('out_for') || s.includes('out for')) return ORDER_EVENT_TYPES.OUT_FOR_DELIVERY;
    if (s.includes('customs')) return ORDER_EVENT_TYPES.CUSTOMS;
    if (s.includes('pick')) return ORDER_EVENT_TYPES.PICKED_UP;
    if (s.includes('transit') || s.includes('ship')) return ORDER_EVENT_TYPES.IN_TRANSIT;
    if (s.includes('return')) return ORDER_EVENT_TYPES.RETURNED;
    return ORDER_EVENT_TYPES.CARRIER_UPDATE;
  }

  async function getMetrics() {
    const keys = [
      'event:event_append',
      'event:cancellation_request',
      'event:return_request',
      'event:shopify_sync',
      'timeline_cache_hit',
      'timeline_cache_miss',
      'event_deduped',
      'event_appended',
      'push_success',
      'push_failure',
      'push_no_tokens',
      'sync_success',
      'sync_failure',
      'carrier_webhook_applied',
      'carrier_webhook_deduped',
      'carrier_webhook_unknown_tracking',
    ];
    const metrics = {};
    for (const key of keys) {
      metrics[key.replace(/^event:/, '')] = await store.getMetric(key);
    }
    return {
      success: true,
      metrics,
      storeDriver: store.driver,
      pushEnabled: config.pushEnabled,
      carriersEnabled: config.carriersEnabled,
    };
  }

  // Admin create order record (post paid) without replacing Shopify create
  async function adminRegisterOrder(body = {}) {
    const order = await upsertOrderFromPayload(
      {
        ...body,
        customerId: body.customerId,
        source: 'admin',
      },
      { seedEvents: true }
    );
    // Optionally re-notify confirmation
    if (body.notify !== false && pushNotifier) {
      await pushNotifier.notifyOrderEvent({
        customerId: order.customerId,
        orderId: order.id,
        eventType: ORDER_EVENT_TYPES.ORDER_PLACED,
        title: 'Order confirmed',
        body: `Order ${order.shopifyOrderName || order.id} is confirmed.`,
      });
    }
    return { success: true, orderId: order.id, shopifyOrderName: order.shopifyOrderName };
  }

  return {
    upsertOrderFromPayload,
    createShipment,
    getTimeline,
    listCustomerOrders,
    trackingLookup,
    addShipmentEvent,
    requestCancellation,
    resolveCancellation,
    requestReturn,
    updateRefundStatus,
    addOrderNote,
    registerPushPreferences,
    syncFromShopify,
    ingestCarrierWebhook,
    getMetrics,
    adminRegisterOrder,
    appendTimelineEvent,
    assertOrderAccess,
    config,
    // test helpers
    deriveStatus,
    estimateDelivery,
    mapCarrierStatusToEvent,
  };
}

module.exports = {
  createOrdersService,
  sanitizeText,
};
