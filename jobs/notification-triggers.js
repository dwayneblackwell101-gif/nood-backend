/**
 * Notification trigger engine — scheduled scans that turn persisted backend
 * data into REAL notifications.
 *
 * Runs every 15 minutes (PUSH_TRIGGER_INTERVAL_MINUTES).
 *   - Wishlist triggers: price-drop / restock / low-stock
 *   - Cart triggers:     price-drop / restock / low-stock / free-shipping-close
 *
 * Every notification goes through utils/push-delivery.js (the unified
 * pipeline): registry metadata → target → preference → priority → frequency /
 * quiet hours → dedupe → Inbox persistence → push → analytics.
 */

const {
  runWishlistTriggers,
  runCartTriggers,
  buildRecipientIndex,
} = require('../utils/notification-triggers');

const TRIGGER_INTERVAL_MINUTES = Number(process.env.PUSH_TRIGGER_INTERVAL_MINUTES || 15);

async function runNotificationTriggers() {
  console.log('[TRIGGERS] Starting...');

  try {
    // Build the recipient index once (userId/email → Expo tokens).
    const index = await buildRecipientIndex();
    if (!index.byUserId.size && !index.byEmail.size) {
      console.log('[TRIGGERS] No registered devices — skipping scans');
      return { wishlist: 0, cart: 0 };
    }

    const wishlist = await runWishlistTriggers(index);
    console.log(`[TRIGGERS] Wishlist scan complete | fired: ${wishlist.wishlist}`);

    const cart = await runCartTriggers(index);
    console.log(`[TRIGGERS] Cart scan complete | fired: ${cart.cart}`);

    console.log('[TRIGGERS] Completed');
    return { wishlist: wishlist.wishlist, cart: cart.cart };
  } catch (error) {
    console.error('[TRIGGERS] Failed:', error.message);
    return { wishlist: 0, cart: 0 };
  }
}

if (process.env.NOOD_TRIGGER_ENGINE_DISABLED !== '1') {
  // First run after startup (delay so DB/supabase is ready).
  setTimeout(() => {
    console.log('[TRIGGERS] Running initial scan...');
    runNotificationTriggers();
  }, 20000);

  // Periodic scans.
  setInterval(() => {
    console.log('[TRIGGERS] Running scheduled scan...');
    runNotificationTriggers();
  }, TRIGGER_INTERVAL_MINUTES * 60 * 1000);
}

module.exports = { runNotificationTriggers };
