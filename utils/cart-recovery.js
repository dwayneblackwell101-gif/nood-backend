/**
 * Cart recovery utilities — find abandoned carts and track recovery emails.
 */

const { supabase } = require('./supabase');

async function fetchAbandonedCarts(hoursThreshold = 2) {
  const cutoff = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000).toISOString();

  // Fetch carts that were updated before cutoff, have items, and haven't had recovery email sent
  const { data, error } = await supabase
    .from('carts')
    .select('id, email, items, name, updated_at, recovery_email_sent_at, recovery_discount_code')
    .lt('updated_at', cutoff)
    .not('email', 'is', null)
    .neq('items', '[]')
    .is('recovery_email_sent_at', null);

  if (error) {
    console.error('[CART RECOVERY] Fetch error:', error.message);
    return [];
  }

  return data || [];
}

async function markCartRecoveryEmailSent(cartId, discountCode) {
  const { error } = await supabase
    .from('carts')
    .update({
      recovery_email_sent_at: new Date().toISOString(),
      recovery_discount_code: discountCode,
    })
    .eq('id', cartId);

  if (error) {
    console.error('[CART RECOVERY] Mark sent error:', error.message);
    return false;
  }
  return true;
}

module.exports = { fetchAbandonedCarts, markCartRecoveryEmailSent };