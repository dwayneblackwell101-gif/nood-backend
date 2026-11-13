/**
 * NOOD campaign engine — Temu-style automated pushes with frequency control.
 *
 * One place to create + send every campaign type:
 *   new_product, hot-product, price-drop, flash-live,
 *   cart-nudge, order-update, broadcast, general
 *
 * All sends go through utils/push-delivery.js (single Expo integration point).
 * Duplicate protection, per-device frequency caps and quiet hours are enforced
 * by the delivery service + push-state-db + push-config.
 */

const { sendPush, loadAllRecipients } = require('../utils/push-delivery');
const { config, isTransactionalType } = require('../utils/push-config');
const { allowCartNudge } = require('../utils/push-state-db');
const { supabase } = require('../utils/supabase');

function log(message, extra) {
  const detail = extra && Object.keys(extra).length ? ` | ${JSON.stringify(extra)}` : '';
  console.log(`[CAMPAIGN] ${message}${detail}`);
}

/** Generate a deterministic campaign id. */
function makeCampaignId(type, seed) {
  const safeSeed = String(seed || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return `noo_${type}_${safeSeed}_${Date.now().toString(36)}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Campaign templates ─────────────────────────────────────────────────

function templateFor(type, ctx) {
  switch (type) {
    case 'new_product':
      return {
        title: ctx.batched
          ? '🔥 New Drop'
          : '👟 Fresh on NOOD',
        body: ctx.batched
          ? `${ctx.productCount} new styles just landed on NOOD. See what's new.`
          : `${ctx.productTitle} is now available.`,
        data: {
          type: 'new_product',
          route: ctx.batched ? '/collection/new-arrivals' : `/product/${ctx.productHandle}`,
          productHandle: ctx.batched ? undefined : ctx.productHandle,
          screen: ctx.batched ? 'collection' : 'product',
        },
      };
    case 'hot-product':
      return {
        title: '🔥 This one is moving fast',
        body: `Customers are checking out ${ctx.productTitle}. Shop it now.`,
        data: {
          type: 'hot-product',
          route: `/product/${ctx.productHandle}`,
          productHandle: ctx.productHandle,
          screen: 'product',
        },
      };
    case 'price-drop':
      return {
        title: '⬇️ Price Drop',
        body: `${ctx.productTitle} just dropped from $${ctx.oldPrice} to $${ctx.newPrice}.`,
        data: {
          type: 'price-drop',
          route: `/product/${ctx.productHandle}`,
          productHandle: ctx.productHandle,
          screen: 'product',
        },
      };
    case 'flash-live':
      return {
        title: '⚡ Flash Deal',
        body: 'Your deal is live now — prices go back up when the timer hits zero.',
        data: { type: 'flash-live', screen: 'modal', route: '/modal' },
      };
    case 'cart-nudge':
      return {
        title: '👀 Still thinking about it?',
        body: 'Your NOOD cart is waiting.',
        data: { type: 'cart-nudge', route: '/(tabs)/cart', screen: 'cart' },
      };
    case 'order-update':
      return {
        title: '📦 Order update',
        body: ctx.body || 'Your NOOD order has an update.',
        data: {
          type: 'order-update',
          route: '/account/orders',
          orderId: ctx.orderId,
          screen: 'orders',
        },
      };
    case 'broadcast':
    case 'general':
    default:
      return {
        title: ctx.title || 'NOOD',
        body: ctx.body || 'Something great is waiting for you!',
        data: ctx.data && typeof ctx.data === 'object' ? ctx.data : { type: 'general' },
      };
  }
}

// ─── New product campaign ───────────────────────────────────────────────

/**
 * Build + send a new-product campaign from a list of genuinely new products.
 *
 * Batching rule: if products.length >= config.newProductBatchThreshold, send a
 * SINGLE batched push (deep-links to New Arrivals). Otherwise send one push
 * per product (deduped per product via dedupeKey).
 */
async function sendNewProductCampaign({ products, campaignId }) {
  if (!Array.isArray(products) || !products.length) {
    return { sent: 0, failed: 0, skipped: 0 };
  }

  const recipients = await loadAllRecipients();
  if (!recipients.length) {
    log('new_product campaign — no recipients', { products: products.length });
    return { sent: 0, failed: 0, skipped: 0 };
  }

  const batched = products.length >= config.newProductBatchThreshold;
  const batchCampaignId =
    campaignId || makeCampaignId('new_product', `batch_${todayKey()}_${products.length}`);

  log('Sending new_product campaign', {
    batched,
    products: products.length,
    campaignId: batchCampaignId,
  });

  if (batched) {
    const template = templateFor('new_product', {
      batched: true,
      productCount: products.length,
    });
    const result = await sendPush({
      recipients,
      title: template.title,
      body: template.body,
      data: template.data,
      campaignId: batchCampaignId,
      campaignType: 'new_product',
      dedupeKey: `batch_${todayKey()}_${products.map((p) => p.handle).sort().join('|')}`,
      frequency: { check: true },
    });
    return result;
  }

  // Individual product pushes, deduped per product.
  let totalSent = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  for (const product of products) {
    const template = templateFor('new_product', {
      batched: false,
      productTitle: product.title,
      productHandle: product.handle,
    });
    const result = await sendPush({
      recipients,
      title: template.title,
      body: template.body,
      data: template.data,
      campaignId: makeCampaignId('new_product', `p_${product.handle}`),
      campaignType: 'new_product',
      dedupeKey: `product_${product.handle}`,
      frequency: { check: true },
    });
    totalSent += result.sent || 0;
    totalFailed += result.failed || 0;
    totalSkipped += result.skipped || 0;
  }
  return { sent: totalSent, failed: totalFailed, skipped: totalSkipped };
}

// ─── Cart nudge ─────────────────────────────────────────────────────────

/**
 * Send cart-nudge push for users with non-empty, abandoned carts.
 * Uses persisted cooldown via push-state-db. Only nudges users with a
 * registered push token. If a cart already received a recovery EMAIL, the
 * push nudge is suppressed (already engaged).
 */
async function runCartNudges() {
  if (!supabase) {
    log('cart-nudge — Supabase not configured, skipping');
    return;
  }

  const cutoff = new Date(
    Date.now() - Number(process.env.PUSH_CART_NUDGE_MIN_AGE_MINUTES || 60) * 60 * 1000
  ).toISOString();

  const { data: carts, error } = await supabase
    .from('carts')
    .select('id, email, name, profile_id, items, updated_at, recovery_email_sent_at, recovery_discount_code')
    .lt('updated_at', cutoff)
    .not('email', 'is', null)
    .neq('items', '[]');

  if (error) {
    log('cart-nudge — fetch failed', { error: error.message });
    return { sent: 0 };
  }

  const tokens = await loadAllRecipients();
  if (!tokens.length) return { sent: 0 };

  // Map tokens by email (best signal we have) then by user id.
  const tokensByEmail = new Map();
  const tokensByUserId = new Map();
  for (const t of tokens) {
    if (t.email) {
      if (!tokensByEmail.has(t.email)) tokensByEmail.set(t.email, []);
      tokensByEmail.get(t.email).push(t);
    }
    if (t.userId) {
      if (!tokensByUserId.has(t.userId)) tokensByUserId.set(t.userId, []);
      tokensByUserId.get(t.userId).push(t);
    }
  }

  const cooldownHours = Number(process.env.PUSH_CART_NUDGE_COOLDOWN_HOURS || 48);
  let nudged = 0;

  for (const cart of carts || []) {
    // Skip carts already engaged via recovery email (or discounted).
    if (cart.recovery_email_sent_at || cart.recovery_discount_code) continue;

    const scopeKey = cart.email || cart.profile_id || cart.id;
    const allowed = await allowCartNudge(scopeKey, cooldownHours);
    if (!allowed) continue;

    const cartTokens = [
      ...(tokensByEmail.get(cart.email) || []),
      ...(tokensByUserId.get(cart.profile_id) || []),
    ];
    const unique = [...new Map(cartTokens.map((t) => [t.token, t])).values()];
    if (!unique.length) continue;

    const template = templateFor('cart-nudge', {});
    const result = await sendPush({
      recipients: unique,
      title: template.title,
      body: template.body,
      data: template.data,
      campaignId: makeCampaignId('cart-nudge', `cart_${cart.id}`),
      campaignType: 'cart-nudge',
      dedupeKey: `cart_${cart.id}_${todayKey()}`,
      frequency: { check: true },
    });

    if ((result.sent || 0) > 0) {
      nudged += 1;
      log('cart-nudge sent', { cartId: cart.id, sent: result.sent });
    }
  }

  log('cart-nudge run complete', { nudged });
  return { nudged };
}

// ─── Scheduled engagement campaigns ─────────────────────────────────────

/**
 * Daily reward reminder + flash sale live — time-windowed, once per day.
 * Runs on the 15-minute interval.
 */
async function runScheduledEngagementCampaigns() {
  const recipients = await loadAllRecipients();
  if (!recipients.length) return;

  const hour = new Date().getHours();
  const day = todayKey();

  // Flash sale — once per day during an active flash window.
  const flashStart = Number(process.env.PUSH_FLASH_WINDOW_START ?? 6);
  const flashEnd = Number(process.env.PUSH_FLASH_WINDOW_END ?? 10);
  const flashActive = hour >= flashStart && hour < flashEnd;
  if (flashActive) {
    const template = templateFor('flash-live', {});
    await sendPush({
      recipients,
      title: template.title,
      body: template.body,
      data: template.data,
      campaignId: makeCampaignId('flash-live', `day_${day}`),
      campaignType: 'flash-live',
      dedupeKey: `flash_live_${day}`,
      frequency: { check: true },
    });
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Run ALL scheduled campaign work. Called on the interval + startup.
 * Exposed for tests/manual triggers.
 */
async function runCampaigns() {
  await runScheduledEngagementCampaigns();
  await runCartNudges();
  return { success: true };
}

/**
 * Send a single manual/generated campaign with a fully-specified payload.
 * Used by admin broadcast + internal events (price-drop, hot-product).
 */
async function sendCampaign({
  campaignId,
  campaignType = 'general',
  title,
  body,
  data = {},
  recipients,
  dedupeKey,
  frequency = { check: true },
}) {
  const recipientList =
    recipients || (await loadAllRecipients());
  const safeType = campaignTypes().includes(campaignType) ? campaignType : 'general';

  return sendPush({
    recipients: recipientList,
    title,
    body,
    data: { ...data, type: data.type || safeType },
    campaignId:
      campaignId || makeCampaignId(safeType, `manual_${Date.now().toString(36)}`),
    campaignType: safeType,
    dedupeKey,
    frequency,
  });
}

function campaignTypes() {
  return config.campaignTypes;
}

module.exports = {
  runCampaigns,
  runCartNudges,
  runScheduledEngagementCampaigns,
  sendNewProductCampaign,
  sendCampaign,
  templateFor,
  makeCampaignId,
  campaignTypes,
  isTransactionalType,
};
