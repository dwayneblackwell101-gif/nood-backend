/**
 * NOOD — Real notification triggers
 *
 * Converts persisted backend data (wishlist_items, carts, products,
 * referral-store) into REAL notifications via the unified pipeline
 * (utils/push-delivery.js sendPush → Inbox + push + analytics + dedupe +
 * preference + frequency checks).
 *
 * Trigger scans (run by jobs/notification-triggers.js):
 *   Wishlist: price-drop, restock, low-stock        (per-user)
 *   Cart:     price-drop, restock, low-stock,
 *             free-shipping-close                   (per-user, cooldown + dedupe)
 *   Referrals: joined / qualified / reward          (fired at the moment of the
 *             referral-store event in server.js handlers)
 *
 * Every notification flows through sendPush — no standalone push code.
 * Per-user recipients are resolved from push_tokens (by userId or email)
 * BEFORE sendPush; sendPush never sees token:null entries.
 */

const { sendPush, loadAllRecipients } = require('./push-delivery');
const { getAllWishlistItems, updateWishlistFlags } = require('./wishlist-db');
const { supabaseAdmin } = require('./supabase-admin');

// Free-shipping threshold (USD) — configurable via env. Used only for the
// cart-free-shipping-close trigger. No real shipping engine exists.
function freeShippingThreshold() {
  const n = Number(process.env.FREE_SHIPPING_THRESHOLD || 50);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// Low-stock threshold (quantityAvailable at or below this = low).
function lowStockThreshold() {
  const n = Number(process.env.LOW_STOCK_THRESHOLD || 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Recipient index ────────────────────────────────────────────────────

/**
 * Build a recipient index once per job run: userId → [tokens], email → [tokens].
 * Passed into trigger scans so per-user sends resolve real Expo tokens
 * without one DB query per user.
 */
async function buildRecipientIndex() {
  const tokens = await loadAllRecipients();
  const byUserId = new Map();
  const byEmail = new Map();
  for (const t of tokens) {
    if (t.active === false) continue;
    if (t.userId) {
      if (!byUserId.has(t.userId)) byUserId.set(t.userId, []);
      byUserId.get(t.userId).push(t);
    }
    if (t.email) {
      const key = String(t.email).toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key).push(t);
    }
  }
  return { byUserId, byEmail };
}

function recipientsFor(index, { userId, email }) {
  const out = [];
  if (userId && index.byUserId.has(userId)) out.push(...index.byUserId.get(userId));
  if (email && index.byEmail.has(String(email).toLowerCase())) {
    out.push(...index.byEmail.get(String(email).toLowerCase()));
  }
  // Dedupe by token.
  const seen = new Set();
  return out.filter((t) => {
    if (seen.has(t.token)) return false;
    seen.add(t.token);
    return true;
  });
}

// ─── Product helpers ────────────────────────────────────────────────────

/** Load products (handle → row) from the products table for a set of handles. */
async function loadProductsByHandle(handles) {
  const unique = Array.from(new Set(handles.filter(Boolean))).slice(0, 500);
  if (!unique.length || !supabaseAdmin) return new Map();

  const map = new Map();
  try {
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const { data, error } = await supabaseAdmin
        .from('products')
        .select('id, shopify_product_id, title, handle, available_for_sale, total_inventory, variants')
        .in('handle', chunk);
      if (error) throw error;
      for (const row of data || []) map.set(row.handle, row);
    }
  } catch (error) {
    console.error('[TRIGGERS] load products failed:', error.message);
  }
  return map;
}

/** Get the current (lowest) variant price for a product row. */
function currentPriceOf(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const prices = variants
    .map((v) => Number(v?.price))
    .filter((p) => Number.isFinite(p) && p > 0);
  return prices.length ? Math.min(...prices) : null;
}

/** Get minimum quantityAvailable across a product's variants (null when not tracked). */
function minQuantityOf(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const qtys = variants
    .map((v) => v?.quantityAvailable)
    .filter((q) => Number.isFinite(q) && q != null);
  return qtys.length ? Math.min(...qtys) : null;
}

function productAvailable(product) {
  return product?.available_for_sale !== false;
}

// ─── Wishlist triggers ──────────────────────────────────────────────────

/**
 * Scan wishlist_items against the products table.
 * Fires per-user:
 *   wishlist-price-drop — current price < snapshot price, dedupe by notified_price
 *   wishlist-restock    — product was unavailable, now available (dedupe flag)
 *   wishlist-low-stock  — quantityAvailable <= threshold (dedupe flag)
 */
async function runWishlistTriggers(index) {
  const items = await getAllWishlistItems();
  if (!items.length) return { wishlist: 0 };

  const productMap = await loadProductsByHandle(items.map((i) => i.handle));
  let fired = 0;

  for (const item of items) {
    const product = productMap.get(item.handle);
    if (!product) continue;

    const userId = item.user_id;
    const email = item.email || null;
    const recipients = recipientsFor(index, { userId, email });
    if (!recipients.length) continue; // no registered device for this user

    // ── Price drop ─────────────────────────────────────────────────────
    const currentPrice = currentPriceOf(product);
    const snapshotPrice = Number(item.price);
    const notifiedPrice = item.notified_price != null ? Number(item.notified_price) : null;

    if (
      currentPrice != null &&
      Number.isFinite(snapshotPrice) &&
      snapshotPrice > 0 &&
      currentPrice < snapshotPrice - 0.005 &&
      notifiedPrice !== currentPrice
    ) {
      const result = await sendPush({
        recipients,
        title: '⬇️ Wishlist price drop',
        body: `${item.title || product.title || item.handle} dropped from $${snapshotPrice.toFixed(2)} to $${currentPrice.toFixed(2)}.`,
        data: {
          type: 'wishlist-price-drop',
          route: `/product/${item.handle}`,
          productHandle: item.handle,
          screen: 'product',
        },
        campaignId: `noo_wishlist_pd_${userId}_${item.handle}_${Math.round(currentPrice * 100)}`,
        campaignType: 'wishlist-price-drop',
        dedupeKey: `wishlist_pd_${userId}_${item.handle}_${Math.round(currentPrice * 100)}`,
        frequency: { check: true },
      });
      await updateWishlistFlags(item.id, { notified_price: currentPrice });
      fired += result.sent || 0;
    }

    // ── Restock ────────────────────────────────────────────────────────
    if (!item.notified_restock && productAvailable(product)) {
      const result = await sendPush({
        recipients,
        title: '💜 Back in stock',
        body: `${item.title || product.title || item.handle} is available again.`,
        data: { type: 'wishlist-restock', route: `/product/${item.handle}`, productHandle: item.handle, screen: 'product' },
        campaignId: `noo_wishlist_rs_${userId}_${item.handle}_${todayKey()}`,
        campaignType: 'wishlist-restock',
        dedupeKey: `wishlist_rs_${userId}_${item.handle}_${todayKey()}`,
        frequency: { check: true },
      });
      await updateWishlistFlags(item.id, { notified_restock: true });
      fired += result.sent || 0;
    }

    // ── Low stock ──────────────────────────────────────────────────────
    const minQty = minQuantityOf(product);
    if (!item.notified_low_stock && minQty != null && minQty > 0 && minQty <= lowStockThreshold()) {
      const result = await sendPush({
        recipients,
        title: '⚠️ Almost gone',
        body: `${item.title || product.title || item.handle} is low in stock (${minQty} left).`,
        data: { type: 'wishlist-low-stock', route: `/product/${item.handle}`, productHandle: item.handle, screen: 'product' },
        campaignId: `noo_wishlist_ls_${userId}_${item.handle}_${todayKey()}`,
        campaignType: 'wishlist-low-stock',
        dedupeKey: `wishlist_ls_${userId}_${item.handle}_${todayKey()}`,
        frequency: { check: true },
      });
      await updateWishlistFlags(item.id, { notified_low_stock: true });
      fired += result.sent || 0;
    }
  }

  return { wishlist: fired };
}

// ─── Cart triggers ──────────────────────────────────────────────────────

/**
 * Scan the carts table against the products table.
 * Per-user (cart scope = email or profile_id). Cooldown + dedupe:
 *   cart-price-drop          — dedupe key includes price version
 *   cart-restock             — once per day per cart+handle
 *   cart-low-stock           — once per day per cart+handle
 *   cart-free-shipping-close — once per day per cart
 */
async function runCartTriggers(index) {
  if (!supabaseAdmin) return { cart: 0 };
  let fired = 0;

  let carts = [];
  try {
    const { data, error } = await supabaseAdmin
      .from('carts')
      .select('id, email, profile_id, items, updated_at');
    if (error) throw error;
    carts = data || [];
  } catch (error) {
    console.error('[TRIGGERS] load carts failed:', error.message);
    return { cart: 0 };
  }

  // Collect all handles across carts.
  const allHandles = [];
  for (const cart of carts) {
    const items = Array.isArray(cart.items) ? cart.items : [];
    for (const item of items) {
      const handle = String(item?.handle || '').trim();
      if (handle) allHandles.push(handle);
    }
  }
  const productMap = await loadProductsByHandle(allHandles);

  for (const cart of carts) {
    const items = Array.isArray(cart.items) ? cart.items : [];
    const scopeKey = String(cart.profile_id || cart.email || cart.id || '');
    if (!scopeKey) continue;
    const userId = cart.profile_id || null;
    const email = cart.email || null;
    const recipients = recipientsFor(index, { userId, email });
    if (!recipients.length) continue;

    // Free-shipping-close: compute cart total from snapshots.
    const total = items.reduce((sum, item) => sum + Number(item?.price || 0) * Number(item?.quantity || 1), 0);
    const threshold = freeShippingThreshold();
    const pct = total / threshold;
    if (pct >= 0.8 && pct < 1 && total > 0) {
      const result = await sendPush({
        recipients,
        title: '📦 Almost free shipping',
        body: `You're $${(threshold - total).toFixed(2)} from free shipping.`,
        data: { type: 'cart-free-shipping-close', route: '/(tabs)/cart', screen: 'cart' },
        campaignId: `noo_cart_fs_${scopeKey}_${todayKey()}`,
        campaignType: 'cart-free-shipping-close',
        dedupeKey: `cart_fs_${scopeKey}_${todayKey()}`,
        frequency: { check: true },
      });
      fired += result.sent || 0;
    }

    for (const item of items) {
      const handle = String(item?.handle || '').trim();
      if (!handle) continue;
      const product = productMap.get(handle);
      if (!product) continue;

      const currentPrice = currentPriceOf(product);
      const snapshotPrice = Number(item?.price);

      // Cart price drop (dedupe by price version).
      if (
        currentPrice != null &&
        Number.isFinite(snapshotPrice) &&
        snapshotPrice > 0 &&
        currentPrice < snapshotPrice - 0.005
      ) {
        const result = await sendPush({
          recipients,
          title: '📉 Cart price drop',
          body: `${item.title || product.title || handle} in your cart dropped to $${currentPrice.toFixed(2)}.`,
          data: { type: 'cart-price-drop', route: '/product/' + handle, productHandle: handle, screen: 'product' },
          campaignId: `noo_cart_pd_${scopeKey}_${handle}_${Math.round(currentPrice * 100)}`,
          campaignType: 'cart-price-drop',
          dedupeKey: `cart_pd_${scopeKey}_${handle}_${Math.round(currentPrice * 100)}`,
          frequency: { check: true },
        });
        fired += result.sent || 0;
      }

      // Cart restock (once/day). Only if cart had it while unavailable — the
      // inventory sync sets available_for_sale; treat any available product
      // as a restock event when the cart is still present.
      if (productAvailable(product)) {
        const result = await sendPush({
          recipients,
          title: '🔁 Cart restock',
          body: `${item.title || product.title || handle} in your cart is back in stock.`,
          data: { type: 'cart-restock', route: '/(tabs)/cart', screen: 'cart' },
          campaignId: `noo_cart_rs_${scopeKey}_${handle}_${todayKey()}`,
          campaignType: 'cart-restock',
          dedupeKey: `cart_rs_${scopeKey}_${handle}_${todayKey()}`,
          frequency: { check: true },
        });
        fired += result.sent || 0;
      }

      // Cart low stock (once/day).
      const minQty = minQuantityOf(product);
      if (minQty != null && minQty > 0 && minQty <= lowStockThreshold()) {
        const result = await sendPush({
          recipients,
          title: '⚠️ Cart low stock',
          body: `${item.title || product.title || handle} in your cart is low (${minQty} left).`,
          data: { type: 'cart-low-stock', route: '/(tabs)/cart', screen: 'cart' },
          campaignId: `noo_cart_ls_${scopeKey}_${handle}_${todayKey()}`,
          campaignType: 'cart-low-stock',
          dedupeKey: `cart_ls_${scopeKey}_${handle}_${todayKey()}`,
          frequency: { check: true },
        });
        fired += result.sent || 0;
      }
    }
  }

  return { cart: fired };
}

// ─── Reward / game / loyalty notifications (fired at event time) ────────

/**
 * Fire a reward/loyalty notification through the unified pipeline.
 * Surviving types: vip-tier-up, loyalty-milestone (loyalty engine).
 */
async function fireRewardNotification({ type, userId, email, amount, relatedId }) {
  const templates = {
    'vip-tier-up': {
      title: '👑 VIP tier unlocked!',
      body: 'You moved up a loyalty tier.',
      route: '/account/rewards',
    },
    'loyalty-milestone': {
      title: '🏅 Loyalty milestone',
      body: amount != null ? `$${Number(amount).toFixed(2)} added to your wallet.` : 'You hit a loyalty milestone.',
      route: '/account/rewards',
    },
  };
  const t = templates[type];
  if (!t) return { sent: 0 };

  const index = await buildRecipientIndex();
  const recipients = recipientsFor(index, { userId, email });
  if (!recipients.length) return { sent: 0, skipped: 1 };

  const result = await sendPush({
    recipients,
    title: t.title,
    body: t.body,
    data: { type, route: t.route, screen: 'rewards', relatedId: relatedId || null },
    campaignId: `noo_${type}_${userId || 'u'}_${relatedId || Date.now().toString(36)}`,
    campaignType: type,
    dedupeKey: `${type}_${userId || email || 'u'}_${relatedId || 'default'}`,
    frequency: { check: true },
  });
  return result;
}

// ─── Referral triggers (fired at event time, not scanned) ───────────────

/**
 * Fire a referral notification for a user at the moment the referral-store
 * event happens (called from server.js handlers).
 */
async function fireReferralNotification({ type, userId, email, extra = {} }) {
  const templates = {
    'referral-joined': {
      title: '👋 Friend joined',
      body: 'You\'re one step closer to $10 NOOD balance.',
      route: '/account/rewards',
    },
    'referral-qualified': {
      title: '🎉 You qualified!',
      body: 'Invite 5 friends to claim $10 — you\'re there!',
      route: '/account/rewards',
    },
    'referral-reward': {
      title: '💰 Referral reward',
      body: '$10 NOOD balance added to your wallet.',
      route: '/account/rewards',
    },
  };
  const t = templates[type];
  if (!t) return { sent: 0 };

  const index = await buildRecipientIndex();
  const recipients = recipientsFor(index, { userId, email });
  if (!recipients.length) return { sent: 0, skipped: 1 };

  const result = await sendPush({
    recipients,
    title: t.title,
    body: t.body,
    data: { type, route: t.route, screen: 'rewards', ...extra },
    campaignId: `noo_ref_${type}_${userId || email || Date.now().toString(36)}_${Date.now().toString(36)}`,
    campaignType: type,
    dedupeKey: `referral_${type}_${userId || email}`,
    frequency: { check: true },
  });
  return result;
}

module.exports = {
  runWishlistTriggers,
  runCartTriggers,
  fireReferralNotification,
  fireRewardNotification,
  buildRecipientIndex,
  recipientsFor,
  currentPriceOf,
  minQuantityOf,
  productAvailable,
  freeShippingThreshold,
  lowStockThreshold,
};
