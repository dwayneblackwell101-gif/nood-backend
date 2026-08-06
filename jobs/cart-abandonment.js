/**
 * Cart abandonment recovery job.
 * Runs periodically to find abandoned carts and send recovery emails.
 */

const { sendEmail } = require('../services/email');
const { fetchAbandonedCarts, markCartRecoveryEmailSent } = require('../utils/cart-recovery');

const CART_ABANDONMENT_THRESHOLD_HOURS = 2;
const RECOVERY_DISCOUNT_CODE_PREFIX = 'COMEBACK';
const DISCOUNT_EXPIRY_HOURS = 24;
const DISCOUNT_PERCENT = 15;

// Generate a unique discount code
function generateDiscountCode() {
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${RECOVERY_DISCOUNT_CODE_PREFIX}${random}`;
}

async function runCartAbandonmentRecovery() {
  console.log('[CART RECOVERY] Starting job...');

  try {
    const abandonedCarts = await fetchAbandonedCarts(CART_ABANDONMENT_THRESHOLD_HOURS);

    if (!abandonedCarts.length) {
      console.log('[CART RECOVERY] No abandoned carts found');
      return;
    }

    console.log(`[CART RECOVERY] Found ${abandonedCarts.length} abandoned carts`);

    for (const cart of abandonedCarts) {
      try {
        const discountCode = generateDiscountCode();
        const expiresAt = new Date(Date.now() + DISCOUNT_EXPIRY_HOURS * 60 * 60 * 1000).toLocaleDateString();

        const items = cart.items.map(item => ({
          title: item.title,
          image: item.image || item.featuredImage?.url || 'https://via.placeholder.com/600x600',
          price: item.formattedPrice || `$${Number(item.price || 0).toFixed(2)}`,
          quantity: item.quantity,
        }));

        const cartUrl = `https://noodcaribbean.com/(tabs)/cart?recovery=${cart.id}&discount=${discountCode}`;

        const result = await sendEmail({
          to: cart.email,
          templateName: 'cart_abandonment',
          data: {
            name: cart.name || 'there',
            items: cart.items,
            cartUrl,
            discountCode,
            expiresAt,
          },
        });

        if (result.success) {
          await markCartRecoveryEmailSent(cart.id, discountCode);
          console.log(`[CART RECOVERY] Sent to ${cart.email} with code ${discountCode}`);
        } else {
          console.warn('[CART RECOVERY] Failed to send:', result.reason);
        }
      } catch (error) {
        console.error('[CART RECOVERY] Error processing cart:', error.message);
      }
    }

    console.log('[CART RECOVERY] Job completed');
  } catch (error) {
    console.error('[CART RECOVERY] Job failed:', error.message);
  }
}

// Schedule: every hour at minute 15 (using setInterval — no external deps)
function scheduleCartAbandonment() {
  // Run every 60 minutes.
  setInterval(() => {
    console.log('[JOB] Running cart abandonment recovery...');
    runCartAbandonmentRecovery();
  }, 60 * 60 * 1000);
}

// Also run immediately on startup for testing
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    console.log('[STARTUP] Running initial cart abandonment check...');
    runCartAbandonmentRecovery();
  }, 10000);

  scheduleCartAbandonment();
}

module.exports = { runCartAbandonmentRecovery };