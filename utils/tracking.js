/**
 * Order tracking — normalized status mapping + persistence.
 *
 * Raw Shopify fulfillment/carrier strings are mapped to a small set of
 * normalized statuses that drive EVERYTHING downstream:
 *   tracking screen UI, NOOD Inbox item, push notification.
 *
 * Only meaningful status CHANGES trigger notifications (deduped by
 * last_notified_status) so webhook retries never duplicate.
 */

const { supabaseAdmin } = require('./supabase-admin');

// Normalized statuses (stable API consumed by the app + notifications).
const NORMALIZED = {
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  PACKED: 'packed',
  SHIPPED: 'shipped',
  IN_TRANSIT: 'in_transit',
  AT_LOCAL_FACILITY: 'at_local_facility',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERY_ATTEMPTED: 'delivery_attempted',
  DELIVERED: 'delivered',
  DELAYED: 'delayed',
  EXCEPTION: 'exception',
  RETURNED: 'returned',
};

const FRIENDLY_STATUS = {
  confirmed: 'Order confirmed',
  processing: 'Processing',
  packed: 'Packed',
  shipped: 'Shipped',
  in_transit: 'In transit',
  at_local_facility: 'At local facility',
  out_for_delivery: 'Out for delivery',
  delivery_attempted: 'Delivery attempted',
  delivered: 'Delivered',
  delayed: 'Delayed',
  exception: 'Delivery exception',
  returned: 'Returned to sender',
};

// Notification type per normalized status (transactional).
const STATUS_NOTIFICATION_TYPE = {
  confirmed: 'order-confirmed',
  processing: 'order-processing',
  packed: 'order-packed',
  shipped: 'order-shipped',
  in_transit: 'order-in-transit',
  at_local_facility: 'order-local-facility',
  out_for_delivery: 'order-out-for-delivery',
  delivery_attempted: 'delivery-attempted',
  delivered: 'order-delivered',
  delayed: 'order-delayed',
  exception: 'order-exception',
  returned: 'return-received',
};

// Progress step index for the animated tracker (0-5).
const PROGRESS_INDEX = {
  confirmed: 0,
  processing: 0,
  packed: 1,
  shipped: 2,
  in_transit: 3,
  at_local_facility: 3,
  out_for_delivery: 4,
  delivery_attempted: 4,
  delivered: 5,
  delayed: -1, // off-track
  exception: -1,
  returned: -1,
};

const TRACKER_STEPS = ['Ordered', 'Packed', 'Shipped', 'In Transit', 'Out for Delivery', 'Delivered'];

/**
 * Map a raw status string (Shopify fulfillment status, carrier text) to a
 * normalized status.
 */
function normalizeStatus(raw) {
  const text = String(raw || '').trim().toLowerCase();

  if (!text) return NORMALIZED.CONFIRMED;

  if (text.includes('return')) return NORMALIZED.RETURNED;
  if (text.includes('exception') || text.includes('issue') || text.includes('failed') || text.includes('error')) {
    return NORMALIZED.EXCEPTION;
  }
  if (text.includes('delay')) return NORMALIZED.DELAYED;
  // Check out-for-delivery BEFORE the generic "deliver" match.
  if (text.includes('out for delivery') || text.includes('out_for_delivery')) return NORMALIZED.OUT_FOR_DELIVERY;
  if (text.includes('deliver') && text.includes('attempt')) return NORMALIZED.DELIVERY_ATTEMPTED;
  if (text.includes('deliver')) return NORMALIZED.DELIVERED;
  if (text.includes('local') || text.includes('facility') || text.includes('depot')) return NORMALIZED.AT_LOCAL_FACILITY;
  if (text.includes('transit')) return NORMALIZED.IN_TRANSIT;
  if (text.includes('ship') || text.includes('fulfill')) return NORMALIZED.SHIPPED;
  if (text.includes('pack')) return NORMALIZED.PACKED;
  if (text.includes('process')) return NORMALIZED.PROCESSING;
  if (text.includes('confirm')) return NORMALIZED.CONFIRMED;

  return NORMALIZED.CONFIRMED;
}

function friendlyFor(status) {
  return FRIENDLY_STATUS[status] || 'Order confirmed';
}

function typeForStatus(status) {
  return STATUS_NOTIFICATION_TYPE[status] || 'order-update';
}

function progressIndexFor(status) {
  return PROGRESS_INDEX[status] != null ? PROGRESS_INDEX[status] : 0;
}

/**
 * Persist the latest tracking state for an order (upsert by shopify_order_id).
 * Returns { changed, status, previousStatus } — `changed` is true only when
 * the normalized status meaningfully differs from the last notified status.
 */
async function upsertOrderTracking({
  shopifyOrderId,
  orderName,
  email,
  userId,
  carrier,
  trackingNumber,
  trackingUrl,
  rawStatus,
  latestEvent = {},
  estimatedDelivery,
}) {
  const status = normalizeStatus(rawStatus);
  const friendly = friendlyFor(status);
  const now = new Date().toISOString();
  const previous = await getOrderTracking(shopifyOrderId);

  const changed =
    !previous || !previous.last_notified_status || previous.last_notified_status !== status;

  const entry = {
    shopify_order_id: shopifyOrderId,
    order_name: orderName || previous?.order_name || null,
    email: email || previous?.email || null,
    user_id: userId || previous?.user_id || null,
    carrier: carrier || previous?.carrier || null,
    tracking_number: trackingNumber || previous?.tracking_number || null,
    tracking_url: trackingUrl || previous?.tracking_url || null,
    status,
    friendly_status: friendly,
    latest_event_title: latestEvent.title || previous?.latest_event_title || null,
    latest_event_description: latestEvent.description || previous?.latest_event_description || null,
    latest_event_location: latestEvent.location || previous?.latest_event_location || null,
    latest_event_at: latestEvent.at || previous?.latest_event_at || now,
    estimated_delivery: estimatedDelivery || previous?.estimated_delivery || null,
    updated_at: now,
  };

  // Append to tracking history (cap at 20 meaningful events).
  const history = Array.isArray(previous?.tracking_history) ? previous.tracking_history : [];
  if (changed) {
    history.push({
      status,
      title: latestEvent.title || friendly,
      description: latestEvent.description || '',
      location: latestEvent.location || '',
      at: latestEvent.at || now,
    });
  }
  const trimmedHistory = history.slice(-20);
  entry.tracking_history = trimmedHistory;

  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from('order_tracking').upsert(entry, {
      onConflict: 'shopify_order_id',
    });
    if (error) {
      console.error('[TRACKING] upsert failed:', error.message);
    }
  }

  return {
    changed,
    status,
    previousStatus: previous?.status || null,
    friendly,
    entry,
  };
}

async function getOrderTracking(shopifyOrderId) {
  if (!shopifyOrderId) return null;
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('order_tracking')
        .select('*')
        .eq('shopify_order_id', shopifyOrderId)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('[TRACKING] get failed:', error.message);
      return null;
    }
  }
  return null;
}

async function listTrackingForUser(userId) {
  if (!userId) return [];
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('order_tracking')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('[TRACKING] list failed:', error.message);
      return [];
    }
  }
  return [];
}

/**
 * After upsertOrderTracking: if status changed, create inbox + push.
 * Transactional — bypasses promotional caps.
 */
async function notifyTrackingChange(shopifyOrderId, recipients, { userId }) {
  const tracking = await getOrderTracking(shopifyOrderId);
  if (!tracking || !tracking.status) return { sent: 0, created: false };

  const status = tracking.status;
  const type = typeForStatus(status);
  const friendly = friendlyFor(status);

  const data = {
    type,
    route: `/account/tracking?orderId=${encodeURIComponent(shopifyOrderId)}`,
    orderId: shopifyOrderId,
    screen: 'tracking',
  };

  // Create inbox item first (exists even if delivery fails).
  const { createInboxItem } = require('./inbox-db');
  const inboxResult = await createInboxItem({
    campaignId: `noo_track_${shopifyOrderId}_${status}_${Date.now().toString(36)}`,
    type,
    title: `📦 ${friendly}`,
    body:
      tracking.latest_event_description ||
      `Your order ${tracking.order_name || shopifyOrderId} is ${friendly.toLowerCase()}.`,
    data,
    route: data.route,
    orderId: shopifyOrderId,
    userId: userId || tracking.user_id || null,
  });

  if (recipients && recipients.length) {
    const { sendPush } = require('./push-delivery');
    await sendPush({
      recipients,
      title: `📦 ${friendly}`,
      body:
        tracking.latest_event_description ||
        `Your order ${tracking.order_name || shopifyOrderId} is ${friendly.toLowerCase()}.`,
      data,
      campaignId: `noo_track_${shopifyOrderId}_${status}_${Date.now().toString(36)}`,
      campaignType: type,
      frequency: { check: false }, // transactional
      saveInbox: false, // already created above
    });
  }

  return { sent: 1, created: inboxResult.created };
}

module.exports = {
  NORMALIZED,
  TRACKER_STEPS,
  normalizeStatus,
  friendlyFor,
  typeForStatus,
  progressIndexFor,
  upsertOrderTracking,
  getOrderTracking,
  listTrackingForUser,
  notifyTrackingChange,
};
