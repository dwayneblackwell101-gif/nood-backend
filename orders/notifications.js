/**
 * Event-driven order push notifications (configurable per event class).
 * Uses Expo push tokens from storage.pushTokens when available.
 */

const axios = require('axios');
const { EVENT_CATALOG } = require('./events');

const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isValidExpoPushToken(token) {
  const trimmed = safeString(token);
  return /^ExponentPushToken\[/.test(trimmed) || /^ExpoPushToken\[/.test(trimmed);
}

function notifyEnabledForKey(config, notifyKey) {
  if (!config.pushEnabled) return false;
  if (!notifyKey) return false;
  const map = {
    order_confirmation: config.pushOrderConfirmation,
    payment: config.pushPayment,
    shipment: config.pushShipment,
    out_for_delivery: config.pushOutForDelivery,
    delivered: config.pushDelivered,
    refund: config.pushRefund,
    return: config.pushReturn,
    cancel: config.pushCancel,
  };
  return Boolean(map[notifyKey]);
}

function createOrderPushNotifier({
  pushTokens = null,
  config,
  sendFn = null,
  metrics = null,
} = {}) {
  async function sendExpo(messages) {
    if (typeof sendFn === 'function') {
      return sendFn(messages);
    }
    const response = await axios.post(EXPO_PUSH_SEND_URL, messages, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (response.status >= 400) {
      throw new Error(`Expo push failed: ${response.status}`);
    }
    return response.data;
  }

  function tokensForCustomer(customerId) {
    if (!pushTokens || typeof pushTokens.values !== 'function') return [];
    const id = safeString(customerId);
    const tokens = [];
    for (const entry of pushTokens.values()) {
      const token = safeString(entry?.token);
      const userId = safeString(entry?.userId || entry?.customerId);
      if (!isValidExpoPushToken(token)) continue;
      // Match by userId when set; also allow device-level tokens without user (skip)
      if (id && userId && (userId === id || userId.endsWith(id.match(/(\d+)$/)?.[1] || '___'))) {
        tokens.push(token);
      }
    }
    return Array.from(new Set(tokens));
  }

  async function notifyOrderEvent({ customerId, orderId, eventType, title, body, data = {} }) {
    const started = Date.now();
    const meta = EVENT_CATALOG[eventType] || {};
    const notifyKey = meta.notifyKey;
    if (!notifyEnabledForKey(config, notifyKey)) {
      return { sent: 0, skipped: true, reason: 'disabled' };
    }

    const tokens = tokensForCustomer(customerId);
    if (!tokens.length) {
      if (metrics?.incrMetric) await metrics.incrMetric('push_no_tokens');
      return { sent: 0, skipped: true, reason: 'no_tokens' };
    }

    const safeTitle = safeString(title || meta.label, 'Order update').slice(0, 120);
    const safeBody = safeString(body || meta.description, 'Your order was updated.').slice(0, 500);
    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      title: safeTitle,
      body: safeBody,
      data: {
        type: 'order_event',
        orderId: safeString(orderId),
        eventType: safeString(eventType),
        ...Object.fromEntries(
          Object.entries(data || {})
            .slice(0, 10)
            .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 200)])
        ),
      },
    }));

    try {
      const result = await sendExpo(messages);
      const tickets = Array.isArray(result?.data) ? result.data : [];
      const ok = tickets.filter((t) => t?.status === 'ok').length || (tickets.length ? 0 : tokens.length);
      if (metrics?.incrMetric) {
        await metrics.incrMetric('push_success');
        await metrics.incrMetric(`push_event:${eventType}`);
      }
      console.log('[ORDERS PUSH]', {
        orderId,
        eventType,
        attempted: tokens.length,
        ok,
        latencyMs: Date.now() - started,
      });
      return { sent: ok || tokens.length, attempted: tokens.length, latencyMs: Date.now() - started };
    } catch (error) {
      if (metrics?.incrMetric) await metrics.incrMetric('push_failure');
      console.warn('[ORDERS PUSH FAIL]', {
        orderId,
        eventType,
        message: error.message,
        latencyMs: Date.now() - started,
      });
      return { sent: 0, error: error.message, latencyMs: Date.now() - started };
    }
  }

  return {
    notifyOrderEvent,
    notifyEnabledForKey,
    tokensForCustomer,
  };
}

module.exports = {
  createOrderPushNotifier,
  notifyEnabledForKey,
};
