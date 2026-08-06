/**
 * Order sync utilities — update local order data from Shopify webhooks.
 */

const { supabase } = require('./supabase');

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

module.exports = { updateOrderFromFulfillment, updateOrderStatus };