const { getOrdersConfig } = require('./config');
const { createOrdersStore } = require('./store');
const { createOrdersService } = require('./service');
const { createOrdersRouter } = require('./routes');
const { createOrderPushNotifier } = require('./notifications');
const { createCarrierClient } = require('./carriers');
const { ORDER_EVENT_TYPES, ORDER_STATUS, EVENT_CATALOG } = require('./events');

function mountOrders({
  app,
  redis = null,
  lockService = null,
  requireCustomerAuth,
  requireAdminApiKey,
  namespace = 'nood',
  isProduction = false,
  pushTokens = null,
  loadCustomerOrders = null,
  refundService = null,
  carrierFetchTrackingFn = null,
} = {}) {
  if (!app) throw new Error('app is required to mount orders routes');
  if (!requireCustomerAuth) throw new Error('requireCustomerAuth is required');
  if (!requireAdminApiKey) throw new Error('requireAdminApiKey is required');

  const config = getOrdersConfig();
  const store = createOrdersStore({ redis, namespace });
  const pushNotifier = createOrderPushNotifier({
    pushTokens,
    config,
    metrics: store,
  });
  const carrierClient = createCarrierClient({
    fetchTrackingFn: carrierFetchTrackingFn || null,
  });

  const ordersService = createOrdersService({
    store,
    config,
    lockService,
    pushNotifier,
    carrierClient,
    loadCustomerOrders,
    refundService,
  });

  const router = createOrdersRouter({
    ordersService,
    requireCustomerAuth,
    requireAdminApiKey,
    isProduction,
  });

  app.use('/api/orders', router);
  console.log('[ORDERS] tracking routes mounted at /api/orders', {
    storeDriver: store.driver,
    pushEnabled: config.pushEnabled,
    carriersEnabled: config.carriersEnabled,
    backgroundSyncEnabled: config.backgroundSyncEnabled,
  });

  // Optional lightweight background sync tick (no-op without multi-tenant job queue)
  let syncTimer = null;
  if (config.backgroundSyncEnabled && config.syncIntervalSeconds > 0) {
    // Placeholder: per-customer sync is on-demand via POST /api/orders/me/sync
    // Interval only emits a heartbeat metric for ops dashboards.
    syncTimer = setInterval(() => {
      store.incrMetric('background_heartbeat').catch(() => {});
    }, Math.max(60, config.syncIntervalSeconds) * 1000);
    if (typeof syncTimer.unref === 'function') syncTimer.unref();
  }

  return {
    ordersService,
    store,
    config,
    pushNotifier,
    stopBackground() {
      if (syncTimer) clearInterval(syncTimer);
    },
  };
}

module.exports = {
  mountOrders,
  getOrdersConfig,
  createOrdersStore,
  createOrdersService,
  createOrdersRouter,
  createOrderPushNotifier,
  createCarrierClient,
  ORDER_EVENT_TYPES,
  ORDER_STATUS,
  EVENT_CATALOG,
};
