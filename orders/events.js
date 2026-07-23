/**
 * Canonical shipment / order lifecycle event catalog.
 * Customer-visible descriptions are marketing-safe; internal codes are stable.
 */

const ORDER_EVENT_TYPES = Object.freeze({
  ORDER_PLACED: 'order_placed',
  PAYMENT_AUTHORIZED: 'payment_authorized',
  PAYMENT_CAPTURED: 'payment_captured',
  PREPARING_ORDER: 'preparing_order',
  PACKED: 'packed',
  AWAITING_CARRIER: 'awaiting_carrier',
  PICKED_UP: 'picked_up',
  IN_TRANSIT: 'in_transit',
  CUSTOMS: 'customs',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  DELIVERY_FAILED: 'delivery_failed',
  RETURNED: 'returned',
  REFUND_REQUESTED: 'refund_requested',
  REFUND_APPROVED: 'refund_approved',
  REFUNDED: 'refunded',
  CANCELLATION_REQUESTED: 'cancellation_requested',
  CANCELLED: 'cancelled',
  EXCHANGE_REQUESTED: 'exchange_requested', // future-ready
  NOTE_ADDED: 'note_added',
  STATUS_UPDATED: 'status_updated',
  SHIPMENT_CREATED: 'shipment_created',
  CARRIER_UPDATE: 'carrier_update',
});

const EVENT_CATALOG = Object.freeze({
  [ORDER_EVENT_TYPES.ORDER_PLACED]: {
    label: 'Order placed',
    description: 'We received your order.',
    customerVisible: true,
    notifyKey: 'order_confirmation',
  },
  [ORDER_EVENT_TYPES.PAYMENT_AUTHORIZED]: {
    label: 'Payment authorized',
    description: 'Your payment was authorized.',
    customerVisible: true,
    notifyKey: 'payment',
  },
  [ORDER_EVENT_TYPES.PAYMENT_CAPTURED]: {
    label: 'Payment confirmed',
    description: 'Your payment was successfully captured.',
    customerVisible: true,
    notifyKey: 'payment',
  },
  [ORDER_EVENT_TYPES.PREPARING_ORDER]: {
    label: 'Preparing order',
    description: 'Your order is being prepared.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.PACKED]: {
    label: 'Packed',
    description: 'Your items have been packed.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.AWAITING_CARRIER]: {
    label: 'Awaiting carrier',
    description: 'Your package is waiting for carrier pickup.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.PICKED_UP]: {
    label: 'Picked up',
    description: 'The carrier picked up your package.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.IN_TRANSIT]: {
    label: 'In transit',
    description: 'Your package is on the way.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.CUSTOMS]: {
    label: 'Customs',
    description: 'Your package is clearing customs.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.OUT_FOR_DELIVERY]: {
    label: 'Out for delivery',
    description: 'Your package is out for delivery today.',
    customerVisible: true,
    notifyKey: 'out_for_delivery',
  },
  [ORDER_EVENT_TYPES.DELIVERED]: {
    label: 'Delivered',
    description: 'Your package was delivered.',
    customerVisible: true,
    notifyKey: 'delivered',
  },
  [ORDER_EVENT_TYPES.DELIVERY_FAILED]: {
    label: 'Delivery failed',
    description: 'Delivery was attempted but not completed.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.RETURNED]: {
    label: 'Returned',
    description: 'Your package was returned.',
    customerVisible: true,
    notifyKey: 'return',
  },
  [ORDER_EVENT_TYPES.REFUND_REQUESTED]: {
    label: 'Refund requested',
    description: 'A refund request was submitted.',
    customerVisible: true,
    notifyKey: 'refund',
  },
  [ORDER_EVENT_TYPES.REFUND_APPROVED]: {
    label: 'Return approved',
    description: 'Your return/refund request was approved.',
    customerVisible: true,
    notifyKey: 'return',
  },
  [ORDER_EVENT_TYPES.REFUNDED]: {
    label: 'Refunded',
    description: 'Your refund was processed.',
    customerVisible: true,
    notifyKey: 'refund',
  },
  [ORDER_EVENT_TYPES.CANCELLATION_REQUESTED]: {
    label: 'Cancellation requested',
    description: 'You requested to cancel this order.',
    customerVisible: true,
    notifyKey: 'cancel',
  },
  [ORDER_EVENT_TYPES.CANCELLED]: {
    label: 'Cancelled',
    description: 'This order was cancelled.',
    customerVisible: true,
    notifyKey: 'cancel',
  },
  [ORDER_EVENT_TYPES.EXCHANGE_REQUESTED]: {
    label: 'Exchange requested',
    description: 'An exchange request was submitted.',
    customerVisible: true,
    notifyKey: null,
  },
  [ORDER_EVENT_TYPES.NOTE_ADDED]: {
    label: 'Order note',
    description: 'A note was added to your order.',
    customerVisible: true,
    notifyKey: null,
  },
  [ORDER_EVENT_TYPES.STATUS_UPDATED]: {
    label: 'Status updated',
    description: 'Order status was updated.',
    customerVisible: true,
    notifyKey: null,
  },
  [ORDER_EVENT_TYPES.SHIPMENT_CREATED]: {
    label: 'Shipment created',
    description: 'A shipment was created for your order.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
  [ORDER_EVENT_TYPES.CARRIER_UPDATE]: {
    label: 'Carrier update',
    description: 'The carrier provided a tracking update.',
    customerVisible: true,
    notifyKey: 'shipment',
  },
});

/** High-level order status derived from latest events / fields */
const ORDER_STATUS = Object.freeze({
  PLACED: 'placed',
  PAID: 'paid',
  PREPARING: 'preparing',
  PARTIALLY_SHIPPED: 'partially_shipped',
  SHIPPED: 'shipped',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  RETURNED: 'returned',
  DELIVERY_FAILED: 'delivery_failed',
});

function describeEvent(type, overrideDescription) {
  const meta = EVENT_CATALOG[type] || {
    label: type,
    description: 'Order update',
    customerVisible: true,
  };
  return {
    type,
    label: meta.label,
    description: overrideDescription || meta.description,
    customerVisible: meta.customerVisible !== false,
    notifyKey: meta.notifyKey || null,
  };
}

function isKnownEventType(type) {
  return Boolean(EVENT_CATALOG[type]);
}

module.exports = {
  ORDER_EVENT_TYPES,
  EVENT_CATALOG,
  ORDER_STATUS,
  describeEvent,
  isKnownEventType,
};
