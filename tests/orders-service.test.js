const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createOrdersStore,
  createOrdersService,
  getOrdersConfig,
  ORDER_EVENT_TYPES,
  ORDER_STATUS,
} = require('../orders');

function createService(overrides = {}) {
  const store = createOrdersStore();
  const config = {
    ...getOrdersConfig(),
    pushEnabled: true,
    allowCustomerCancel: true,
    cancelWindowHours: 24,
    timelineCacheTtlSeconds: 30,
    defaultDeliveryDaysMin: 5,
    defaultDeliveryDaysMax: 14,
    ...overrides.config,
  };
  const pushCalls = [];
  const pushNotifier = {
    async notifyOrderEvent(payload) {
      pushCalls.push(payload);
      return { sent: 1 };
    },
  };
  const service = createOrdersService({
    store,
    config,
    pushNotifier,
    loadCustomerOrders: overrides.loadCustomerOrders || null,
    nowFn: overrides.nowFn || (() => new Date('2026-07-16T12:00:00.000Z')),
    ...overrides.serviceOpts,
  });
  return { service, store, pushCalls, config };
}

test('register order seeds placed + payment timeline events', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/100';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderId: 'gid://shopify/Order/1',
    shopifyOrderName: '#1001',
    total: 49.99,
    currency: 'USD',
    financialStatus: 'paid',
    items: [{ title: 'Wig', quantity: 1 }],
    notify: false,
  });
  assert.equal(reg.success, true);

  const timeline = await service.getTimeline(customerId, reg.orderId);
  assert.equal(timeline.success, true);
  assert.equal(timeline.order.status, ORDER_STATUS.PAID);
  assert.ok(timeline.eventsTotal >= 2);
  const types = timeline.events.map((e) => e.type);
  assert.ok(types.includes(ORDER_EVENT_TYPES.ORDER_PLACED));
  assert.ok(types.includes(ORDER_EVENT_TYPES.PAYMENT_CAPTURED));
  assert.ok(timeline.order.estimatedDelivery);
  assert.ok(timeline.order.deliveryWindow);
});

test('partial shipments and multi-package tracking', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/200';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#2001',
    financialStatus: 'paid',
    notify: false,
  });

  await service.createShipment(
    'admin',
    reg.orderId,
    {
      trackingNumber: 'DHL111',
      carrier: 'dhl',
      items: [{ title: 'Item A' }],
    },
    { asAdmin: true, notify: false }
  );
  await service.createShipment(
    'admin',
    reg.orderId,
    {
      trackingNumber: 'DHL222',
      carrier: 'dhl',
      items: [{ title: 'Item B' }],
      status: 'awaiting_carrier',
    },
    { asAdmin: true, notify: false }
  );

  // second package not in transit yet — mark first delivered only
  await service.addShipmentEvent(reg.orderId, {
    type: ORDER_EVENT_TYPES.DELIVERED,
    trackingNumber: 'DHL111',
    dedupeKey: 'del-1',
  });

  const timeline = await service.getTimeline(customerId, reg.orderId);
  assert.equal(timeline.shipments.length, 2);
  assert.ok(
    [ORDER_STATUS.PARTIALLY_SHIPPED, ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED].includes(
      timeline.order.status
    )
  );

  const track = await service.trackingLookup(customerId, 'DHL111');
  assert.equal(track.success, true);
  assert.match(track.trackingUrl, /dhl/i);
});

test('event deduplication is concurrent-safe for same dedupe key', async () => {
  const { service, store } = createService();
  const customerId = 'gid://shopify/Customer/300';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#3001',
    financialStatus: 'paid',
    notify: false,
  });
  const order = await store.getOrder(reg.orderId);

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      service.appendTimelineEvent(order, {
        type: ORDER_EVENT_TYPES.IN_TRANSIT,
        trackingNumber: 'X1',
        dedupeKey: 'same-key',
        description: 'In transit',
      }, { notify: false })
    )
  );
  const created = results.filter((r) => !r.duplicate).length;
  const dupes = results.filter((r) => r.duplicate).length;
  assert.equal(created, 1);
  assert.equal(dupes, 7);
});

test('ownership enforcement blocks other customers', async () => {
  const { service } = createService();
  const owner = 'gid://shopify/Customer/401';
  const other = 'gid://shopify/Customer/402';
  const reg = await service.adminRegisterOrder({
    customerId: owner,
    shopifyOrderName: '#401',
    financialStatus: 'paid',
    notify: false,
  });

  await assert.rejects(() => service.getTimeline(other, reg.orderId), /access|forbidden/i);
  await assert.rejects(
    () => service.requestCancellation(other, reg.orderId, { reason: 'nope' }),
    /access|forbidden/i
  );
});

test('cancellation within window and blocked after ship', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/500';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#5001',
    financialStatus: 'paid',
    notify: false,
  });

  const cancel = await service.requestCancellation(customerId, reg.orderId, {
    reason: 'Ordered by mistake',
  });
  assert.equal(cancel.success, true);
  assert.equal(cancel.cancellation.status, 'requested');

  const reg2 = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#5002',
    financialStatus: 'paid',
    notify: false,
  });
  await service.createShipment(
    'admin',
    reg2.orderId,
    { trackingNumber: 'SHIP1', carrier: 'ups' },
    { asAdmin: true, notify: false }
  );
  await assert.rejects(
    () => service.requestCancellation(customerId, reg2.orderId, { reason: 'too late' }),
    /shipped/i
  );
});

test('refund status updates timeline and order flags', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/600';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#6001',
    financialStatus: 'paid',
    notify: false,
  });

  await service.updateRefundStatus(reg.orderId, {
    status: 'completed',
    amount: 20,
    currency: 'USD',
  });
  const timeline = await service.getTimeline(customerId, reg.orderId);
  assert.equal(timeline.order.refunded, true);
  assert.equal(timeline.order.status, ORDER_STATUS.REFUNDED);
  assert.equal(timeline.refundStatus.status, 'completed');
});

test('return request is future-ready for exchange flag', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/700';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#7001',
    financialStatus: 'paid',
    notify: false,
  });
  const ret = await service.requestReturn(customerId, reg.orderId, {
    reason: 'Wrong size',
    exchangeRequested: true,
  });
  assert.equal(ret.returnRequest.exchangeRequested, true);
  assert.equal(ret.returnRequest.status, 'requested');
});

test('push notifier fires on shipment events when enabled', async () => {
  const { service, pushCalls } = createService();
  const customerId = 'gid://shopify/Customer/800';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#8001',
    financialStatus: 'paid',
    notify: false,
  });
  pushCalls.length = 0;
  await service.createShipment(
    'admin',
    reg.orderId,
    { trackingNumber: 'PUSH1', carrier: 'fedex' },
    { asAdmin: true, notify: true }
  );
  assert.ok(pushCalls.length >= 1);
  assert.equal(pushCalls[0].customerId, customerId);
});

test('carrier webhook maps delivered and rejects bad secret when configured', async () => {
  const { service } = createService({
    config: { carrierWebhookSecret: 'secret-xyz' },
  });
  const customerId = 'gid://shopify/Customer/900';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#9001',
    financialStatus: 'paid',
    notify: false,
  });
  await service.createShipment(
    'admin',
    reg.orderId,
    { trackingNumber: 'WH123', carrier: 'dhl' },
    { asAdmin: true, notify: false }
  );

  await assert.rejects(
    () =>
      service.ingestCarrierWebhook(
        { trackingNumber: 'WH123', status: 'delivered' },
        { secret: 'wrong' }
      ),
    /secret|unauthorized/i
  );

  const ok = await service.ingestCarrierWebhook(
    { trackingNumber: 'WH123', status: 'delivered', timestamp: '2026-07-17T10:00:00.000Z' },
    { secret: 'secret-xyz' }
  );
  assert.equal(ok.success, true);

  const timeline = await service.getTimeline(customerId, reg.orderId);
  assert.ok(timeline.events.some((e) => e.type === ORDER_EVENT_TYPES.DELIVERED));
});

test('shopify sync imports customer orders', async () => {
  const customerId = 'gid://shopify/Customer/1000';
  const { service } = createService({
    loadCustomerOrders: async () => [
      {
        id: '#A1',
        shopifyOrderId: 'gid://shopify/Order/99',
        shopifyOrderName: '#A1',
        total: 10,
        currency: 'USD',
        financialStatus: 'PAID',
        status: 'Paid',
        items: [{ title: 'Hat', quantity: 1 }],
        date: '2026-07-01T00:00:00.000Z',
      },
    ],
  });
  const sync = await service.syncFromShopify(customerId);
  assert.equal(sync.imported, 1);
  const list = await service.listCustomerOrders(customerId);
  assert.equal(list.total, 1);
  assert.equal(list.orders[0].shopifyOrderName, '#A1');
});

test('timeline cache hit after first load', async () => {
  const { service, store } = createService({
    config: { timelineCacheTtlSeconds: 60 },
  });
  const customerId = 'gid://shopify/Customer/1100';
  const reg = await service.adminRegisterOrder({
    customerId,
    shopifyOrderName: '#1101',
    financialStatus: 'paid',
    notify: false,
  });
  await service.getTimeline(customerId, reg.orderId);
  await service.getTimeline(customerId, reg.orderId);
  const hits = await store.getMetric('timeline_cache_hit');
  assert.ok(hits >= 1);
});
