function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envInt(name, fallback, env = process.env) {
  const raw = safeString(env[name]);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function envBool(name, fallback, env = process.env) {
  const raw = safeString(env[name]).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function getOrdersConfig(env = process.env) {
  return {
    enabled: envBool('ORDERS_TRACKING_ENABLED', true, env),
    timelineCacheTtlSeconds: envInt('ORDERS_TIMELINE_CACHE_TTL', 30, env),
    syncIntervalSeconds: envInt('ORDERS_SYNC_INTERVAL_SECONDS', 300, env),
    backgroundSyncEnabled: envBool('ORDERS_BACKGROUND_SYNC_ENABLED', true, env),
    pageSizeDefault: envInt('ORDERS_PAGE_SIZE_DEFAULT', 20, env),
    pageSizeMax: envInt('ORDERS_PAGE_SIZE_MAX', 50, env),
    eventsPageSizeDefault: envInt('ORDERS_EVENTS_PAGE_SIZE', 30, env),
    eventsPageSizeMax: envInt('ORDERS_EVENTS_PAGE_SIZE_MAX', 100, env),
    rateReadPerMin: envInt('ORDERS_RATE_READ_PER_MIN', 90, env),
    rateMutatePerHour: envInt('ORDERS_RATE_MUTATE_PER_HOUR', 30, env),
    rateCancelPerDay: envInt('ORDERS_RATE_CANCEL_PER_DAY', 5, env),
    rateReturnPerDay: envInt('ORDERS_RATE_RETURN_PER_DAY', 10, env),
    historyLimit: envInt('ORDERS_HISTORY_LIMIT', 500, env),
    auditLimit: envInt('ORDERS_AUDIT_LIMIT', 500, env),
    defaultDeliveryDaysMin: envInt('ORDERS_DEFAULT_DELIVERY_DAYS_MIN', 5, env),
    defaultDeliveryDaysMax: envInt('ORDERS_DEFAULT_DELIVERY_DAYS_MAX', 14, env),
    allowCustomerCancel: envBool('ORDERS_ALLOW_CUSTOMER_CANCEL', true, env),
    cancelWindowHours: envInt('ORDERS_CANCEL_WINDOW_HOURS', 2, env),
    // Push notifications for order events
    pushEnabled: envBool('ORDERS_PUSH_ENABLED', true, env),
    pushOrderConfirmation: envBool('ORDERS_PUSH_ORDER_CONFIRMATION', true, env),
    pushPayment: envBool('ORDERS_PUSH_PAYMENT', true, env),
    pushShipment: envBool('ORDERS_PUSH_SHIPMENT', true, env),
    pushOutForDelivery: envBool('ORDERS_PUSH_OUT_FOR_DELIVERY', true, env),
    pushDelivered: envBool('ORDERS_PUSH_DELIVERED', true, env),
    pushRefund: envBool('ORDERS_PUSH_REFUND', true, env),
    pushReturn: envBool('ORDERS_PUSH_RETURN', true, env),
    pushCancel: envBool('ORDERS_PUSH_CANCEL', true, env),
    // Carrier
    carriersEnabled: envBool('ORDERS_CARRIERS_ENABLED', true, env),
    carrierWebhookSecret: safeString(env.ORDERS_CARRIER_WEBHOOK_SECRET),
  };
}

module.exports = {
  getOrdersConfig,
};
