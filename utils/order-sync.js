/**
 * Order sync utilities — update local order data from Shopify webhooks.
 */

const { supabase } = require('./supabase');

async function upsertOrder(order, userId = null) {
  if (!supabase || !order?.id) return { ok: false, reason: 'database_unavailable' };
  const items = Array.isArray(order.items)
    ? order.items
    : Array.isArray(order.line_items)
      ? order.line_items.map((item) => ({
          id: String(item.id || ''),
          variantId: item.variant_id ? `gid://shopify/ProductVariant/${item.variant_id}` : '',
          title: String(item.title || item.name || 'Product'),
          quantity: Math.max(1, Number(item.quantity || 1)),
          price: Math.max(
            0,
            (Number(item.price || 0) * Math.max(1, Number(item.quantity || 1)) - Number(item.total_discount || 0)) /
              Math.max(1, Number(item.quantity || 1))
          ).toFixed(2),
          currency: String(order.currency || 'USD').toUpperCase(),
          image: String(item.image?.src || ''),
        }))
      : [];
  const row = {
    shopify_order_id: String(order.id),
    email: String(order.email || '').trim().toLowerCase() || null,
    user_id: userId || order.user_id || null,
    name: String(order.name || ''),
    total: Number(order.total || order.total_price || 0),
    currency: String(order.currency || 'USD').toUpperCase(),
    status: String(order.status || order.financial_status || 'paid').toLowerCase(),
    fulfillment_status: order.fulfillment_status || null,
    payment_provider: String(order.payment_provider || order.gateway || '').toLowerCase() || null,
    payment_transaction_id: order.payment_transaction_id || null,
    items,
    created_at: order.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('orders').upsert(row, { onConflict: 'shopify_order_id' });
  if (error) throw error;
  return { ok: true };
}

async function updateOrderFromFulfillment(fulfillment) {
  if (!supabase) {
    console.warn('[ORDER SYNC] Supabase not configured');
    return;
  }

  const orderId = fulfillment.order_id;
  const trackingNumber = fulfillment.tracking_number;
  const trackingUrl = fulfillment.tracking_url;
  const trackingCompany = fulfillment.tracking_company;
  const status = fulfillment.status;

  try {
    const { error } = await supabase
      .from('orders')
      .update({
        fulfillment_status: status,
        tracking_number: trackingNumber,
        tracking_url: trackingUrl,
        tracking_company: trackingCompany,
        updated_at: new Date().toISOString(),
      })
      .eq('shopify_order_id', orderId);

    if (error) {
      console.error('[ORDER SYNC] Update failed:', error.message);
    } else {
      console.log(`[ORDER SYNC] Updated order ${orderId} tracking`);
    }
  } catch (error) {
    console.error('[ORDER SYNC] Error:', error.message);
  }
}

async function updateOrderStatus(orderId, updates) {
  if (!supabase) {
    console.warn('[ORDER SYNC] Supabase not configured');
    return;
  }

  try {
    const { error } = await supabase
      .from('orders')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('shopify_order_id', orderId);

    if (error) {
      console.error('[ORDER SYNC] Status update failed:', error.message);
    } else {
      console.log(`[ORDER SYNC] Updated order ${orderId} status`);
    }
  } catch (error) {
    console.error('[ORDER SYNC] Error:', error.message);
  }
}

module.exports = { upsertOrder, updateOrderFromFulfillment, updateOrderStatus };
