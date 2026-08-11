/**
 * Centralized push notification configuration.
 *
 * ALL business thresholds for notification frequency / anti-spam live here and
 * are overridable via environment variables. Do not hardcode these values in
 * other files.
 */

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ═══ Complete notification taxonomy ═══════════════════════════════════
// Every notification type NOOD supports. Types are grouped by category for
// preferences + priority. Types with a real event source are wired to an
// actual trigger; the rest are structural (available for future sources).
// See push-delivery.js / notification-campaigns.js for the wired set.

const CATEGORY = {
  ARRIVALS: 'arrivals',
  DEALS: 'deals',
  WISHLIST: 'wishlist',
  RESTOCK: 'restock',
  CART: 'cart',
  GAMES: 'games',
  REWARDS: 'rewards',
  ORDERS: 'orders',
  RETURNS: 'returns',
  TRACKING: 'tracking',
  REFERRALS: 'referrals',
  SECURITY: 'security',
  SUPPORT: 'support',
  GENERAL: 'general',
};

const TYPE_TO_CATEGORY = {
  // Shopping / products
  new_product: CATEGORY.ARRIVALS,
  new_brand: CATEGORY.ARRIVALS,
  'new-category': CATEGORY.ARRIVALS,
  restock: CATEGORY.RESTOCK,
  'size-restock': CATEGORY.RESTOCK,
  'color-restock': CATEGORY.RESTOCK,
  'price-drop': CATEGORY.WISHLIST,
  'wishlist-sale': CATEGORY.WISHLIST,
  'wishlist-restock': CATEGORY.WISHLIST,
  'wishlist-low-stock': CATEGORY.WISHLIST,
  'low-stock': CATEGORY.WISHLIST,
  'hot-product': CATEGORY.ARRIVALS,
  'trending-product': CATEGORY.ARRIVALS,
  'personalized-pick': CATEGORY.ARRIVALS,
  'recently-viewed': CATEGORY.ARRIVALS,
  'similar-product': CATEGORY.ARRIVALS,
  'recommended-restock': CATEGORY.RESTOCK,

  // Deals / promotions
  'deal-live': CATEGORY.DEALS,
  'deal-ending': CATEGORY.DEALS,
  'deal-upgraded': CATEGORY.DEALS,
  'flash-live': CATEGORY.DEALS,
  'flash-ending': CATEGORY.DEALS,
  'coupon-ready': CATEGORY.DEALS,
  'coupon-expiring': CATEGORY.DEALS,
  'coupon-applied': CATEGORY.DEALS,
  'free-shipping': CATEGORY.DEALS,
  'free-shipping-close': CATEGORY.DEALS,
  'cart-discount': CATEGORY.DEALS,
  'brand-sale': CATEGORY.DEALS,
  'category-sale': CATEGORY.DEALS,
  'personalized-deal': CATEGORY.DEALS,

  // Games / rewards
  'spin-ready': CATEGORY.GAMES,
  'scratch-ready': CATEGORY.GAMES,
  'game-live': CATEGORY.GAMES,
  'game-ending': CATEGORY.GAMES,
  'streak-reminder': CATEGORY.REWARDS,
  'streak-at-risk': CATEGORY.REWARDS,
  'streak-completed': CATEGORY.REWARDS,
  'reward-unlocked': CATEGORY.REWARDS,
  'reward-expiring': CATEGORY.REWARDS,
  'reward-won': CATEGORY.REWARDS,
  'daily-reward': CATEGORY.REWARDS,
  'bonus-unlocked': CATEGORY.REWARDS,
  'points-earned': CATEGORY.REWARDS,
  'points-expiring': CATEGORY.REWARDS,
  'credit-earned': CATEGORY.REWARDS,
  'credit-expiring': CATEGORY.REWARDS,

  // Cart
  'cart-nudge': CATEGORY.CART,
  'cart-price-drop': CATEGORY.CART,
  'cart-low-stock': CATEGORY.CART,
  'cart-restock': CATEGORY.CART,
  'cart-reward-ready': CATEGORY.CART,
  'cart-coupon-ready': CATEGORY.CART,
  'cart-free-shipping-close': CATEGORY.CART,

  // Order + payment lifecycle — TRANSACTIONAL
  'order-confirmed': CATEGORY.ORDERS,
  'payment-confirmed': CATEGORY.ORDERS,
  'payment-failed': CATEGORY.ORDERS,
  'payment-action-needed': CATEGORY.ORDERS,
  'order-processing': CATEGORY.ORDERS,
  'order-packed': CATEGORY.ORDERS,
  'order-ready': CATEGORY.ORDERS,
  'order-shipped': CATEGORY.ORDERS,
  'order-in-transit': CATEGORY.TRACKING,
  'order-local-facility': CATEGORY.TRACKING,
  'order-out-for-delivery': CATEGORY.TRACKING,
  'delivery-attempted': CATEGORY.TRACKING,
  'order-delivered': CATEGORY.TRACKING,
  'order-delayed': CATEGORY.TRACKING,
  'order-exception': CATEGORY.TRACKING,
  'address-action-needed': CATEGORY.ORDERS,
  'pickup-ready': CATEGORY.ORDERS,
  'pickup-reminder': CATEGORY.ORDERS,
  'order-update': CATEGORY.ORDERS,

  // Returns / exchanges / refunds — TRANSACTIONAL
  'return-requested': CATEGORY.RETURNS,
  'return-approved': CATEGORY.RETURNS,
  'return-rejected': CATEGORY.RETURNS,
  'return-dropoff-reminder': CATEGORY.RETURNS,
  'return-in-transit': CATEGORY.RETURNS,
  'return-received': CATEGORY.RETURNS,
  'exchange-approved': CATEGORY.RETURNS,
  'exchange-shipped': CATEGORY.RETURNS,
  'refund-started': CATEGORY.RETURNS,
  'refund-processing': CATEGORY.RETURNS,
  'refund-completed': CATEGORY.RETURNS,
  'refund-failed': CATEGORY.RETURNS,

  // Account / service / security — SECURITY is transactional + high priority
  'support-reply': CATEGORY.SUPPORT,
  'support-case-update': CATEGORY.SUPPORT,
  'security-alert': CATEGORY.SECURITY,
  'new-login': CATEGORY.SECURITY,
  'password-changed': CATEGORY.SECURITY,
  'email-changed': CATEGORY.SECURITY,
  'phone-changed': CATEGORY.SECURITY,
  'account-warning': CATEGORY.SECURITY,
  broadcast: CATEGORY.GENERAL,
  general: CATEGORY.GENERAL,
  maintenance: CATEGORY.GENERAL,
  'service-update': CATEGORY.GENERAL,

  // Referrals / loyalty
  'referral-invite': CATEGORY.REFERRALS,
  'referral-joined': CATEGORY.REFERRALS,
  'referral-qualified': CATEGORY.REFERRALS,
  'referral-reward': CATEGORY.REFERRALS,
  'vip-tier-up': CATEGORY.REFERRALS,
  'loyalty-milestone': CATEGORY.REFERRALS,
};

// ═══ Priority engine ══════════════════════════════════════════════════
// Higher value wins when multiple campaigns are eligible simultaneously.
const PRIORITY_CLASS = {
  CRITICAL: 1000, // security alerts, payment/action failures, delivery exceptions
  TRANSACTIONAL_HIGH: 800, // out for delivery, delivered, order/refund status, support reply
  PERSONAL_HIGH: 600, // wishlist price drop, restock, reward earned/expiring
  PROMOTIONAL: 400, // new products, deals, games, recommendations, trending
  LOW: 200, // generic engagement/reminders
};

const CRITICAL_TYPES = new Set([
  'security-alert',
  'account-warning',
  'payment-failed',
  'payment-action-needed',
  'order-exception',
  'delivery-exception',
  'refund-failed',
  'new-login',
]);

const TRANSACTIONAL_HIGH_TYPES = new Set([
  'order-update',
  'order-confirmed',
  'payment-confirmed',
  'order-processing',
  'order-packed',
  'order-ready',
  'order-shipped',
  'order-in-transit',
  'order-local-facility',
  'order-out-for-delivery',
  'delivery-attempted',
  'order-delivered',
  'order-delayed',
  'address-action-needed',
  'pickup-ready',
  'pickup-reminder',
  'return-requested',
  'return-approved',
  'return-rejected',
  'return-dropoff-reminder',
  'return-in-transit',
  'return-received',
  'exchange-approved',
  'exchange-shipped',
  'refund-started',
  'refund-processing',
  'refund-completed',
  'support-reply',
  'support-case-update',
]);

const PERSONAL_HIGH_TYPES = new Set([
  'price-drop',
  'wishlist-sale',
  'wishlist-restock',
  'wishlist-low-stock',
  'restock',
  'size-restock',
  'color-restock',
  'recommended-restock',
  'reward-unlocked',
  'reward-won',
  'reward-expiring',
  'coupon-ready',
  'coupon-applied',
]);

/**
 * Priority class for a notification type. Critical > transactional-high >
 * personal-high > promotional > low.
 */
function priorityClassForType(type) {
  const t = String(type || 'general');
  if (CRITICAL_TYPES.has(t)) return PRIORITY_CLASS.CRITICAL;
  if (TRANSACTIONAL_HIGH_TYPES.has(t)) return PRIORITY_CLASS.TRANSACTIONAL_HIGH;
  if (PERSONAL_HIGH_TYPES.has(t)) return PRIORITY_CLASS.PERSONAL_HIGH;
  if (['spin-ready', 'scratch-ready', 'game-live', 'game-ending'].includes(t)) {
    return PRIORITY_CLASS.PROMOTIONAL;
  }
  return PRIORITY_CLASS.PROMOTIONAL;
}

// ═══ Legacy type sets (kept for backward compat with the engine) ═══════

/**
 * Campaign types NOOD supports.
 *  - transactional: exempt from promotional frequency limits
 *  - priority: higher wins when multiple campaigns are queued
 */
const CAMPAIGN_TYPES = [
  'new_product',
  'hot-product',
  'price-drop',
  'flash-live',
  'daily-reward',
  'cart-nudge',
  'order-update',
  'broadcast',
  'general',
];

const TRANSACTIONAL_TYPES = new Set([
  ...TRANSACTIONAL_HIGH_TYPES,
  ...CRITICAL_TYPES,
]);

const CAMPAIGN_PRIORITY = {
  'order-update': PRIORITY_CLASS.TRANSACTIONAL_HIGH,
  'daily-reward': PRIORITY_CLASS.PERSONAL_HIGH,
  'hot-product': PRIORITY_CLASS.PROMOTIONAL,
  'price-drop': PRIORITY_CLASS.PERSONAL_HIGH,
  new_product: PRIORITY_CLASS.PROMOTIONAL,
  'flash-live': PRIORITY_CLASS.PROMOTIONAL,
  'cart-nudge': PRIORITY_CLASS.PROMOTIONAL,
  broadcast: PRIORITY_CLASS.PROMOTIONAL,
  general: PRIORITY_CLASS.PROMOTIONAL,
};

/** Promotional types = every campaign type that is NOT transactional. */
const PROMOTIONAL_TYPES = CAMPAIGN_TYPES.filter((t) => !TRANSACTIONAL_TYPES.has(t));

/** Preference categories exposed to users. */
const PREFERENCE_CATEGORIES = Object.values(CATEGORY);

// ═══ Runtime config ════════════════════════════════════════════════════

/**
 * Dynamic getters for frequency thresholds so runtime changes (e.g. tests,
 * or ops tweaking env vars without a redeploy of the object) take effect.
 */
function minPromoIntervalMinutes() {
  return numberFromEnv('PUSH_MIN_INTERVAL_MINUTES', 60);
}
function maxPromoPerDay() {
  return numberFromEnv('PUSH_MAX_PROMO_PER_DAY', 3);
}
function quietHoursEnabled() {
  return String(process.env.PUSH_QUIET_HOURS_ENABLED || 'true').toLowerCase() !== 'false';
}
function newProductBatchThreshold() {
  return numberFromEnv('PUSH_NEW_PRODUCT_BATCH_THRESHOLD', 3);
}

const config = {
  // ── Frequency / anti-spam (dynamic — see getters below) ───────────────
  /** Minimum minutes between promotional pushes to the SAME device. */
  get minPromoIntervalMinutes() {
    return minPromoIntervalMinutes();
  },

  /** Max promotional pushes per device per day (UTC day boundary). */
  get maxPromoPerDay() {
    return maxPromoPerDay();
  },

  /** Quiet hours (server local time, 0-23). Promo pushes are skipped; transactional still send. */
  quietHoursStart: numberFromEnv('PUSH_QUIET_HOURS_START', 22),
  quietHoursEnd: numberFromEnv('PUSH_QUIET_HOURS_END', 8),

  /** If quietHoursStart === quietHoursEnd, quiet hours are disabled. */
  get quietHoursEnabled() {
    return quietHoursEnabled();
  },

  // ── Delivery ──────────────────────────────────────────────────────────
  /** Expo's recommended max messages per request. */
  chunkSize: numberFromEnv('PUSH_CHUNK_SIZE', 100),

  /** How long a batch may take before individual message attempts are abandoned. */
  sendTimeoutMs: numberFromEnv('PUSH_SEND_TIMEOUT_MS', 20000),

  // ── New product batching ──────────────────────────────────────────────
  /**
   * If a single catalog sync discovers >= this many genuinely new products,
   * send ONE batched "N new styles just dropped" push instead of one push per
   * product. Individual product pushes are sent when fewer new products are
   * discovered.
   */
  get newProductBatchThreshold() {
    return newProductBatchThreshold();
  },

  /** Dedupe window for promoting the same product again (hours). */
  productDedupeWindowHours: numberFromEnv('PUSH_PRODUCT_DEDUPE_WINDOW_HOURS', 24),

  // ── Misc ──────────────────────────────────────────────────────────────
  /** Max tokens fetched per recipient query (safety). */
  maxRecipientsPerSend: numberFromEnv('PUSH_MAX_RECIPIENTS_PER_SEND', 5000),

  logLevel: String(process.env.PUSH_LOG_LEVEL || 'info'),

  // ── Type sets ─────────────────────────────────────────────────────────
  campaignTypes: CAMPAIGN_TYPES,
  transactionalTypes: Array.from(TRANSACTIONAL_TYPES),
  promotionalTypes: PROMOTIONAL_TYPES,
  campaignPriority: CAMPAIGN_PRIORITY,

  // ── Full taxonomy ─────────────────────────────────────────────────────
  allTypes: Object.keys(TYPE_TO_CATEGORY),
  typeToCategory: TYPE_TO_CATEGORY,
  preferenceCategories: PREFERENCE_CATEGORIES,
  priorityClass: PRIORITY_CLASS,
  priorityClassForType,
};

/** Is a campaign type transactional (exempt from promo frequency limits)? */
function isTransactionalType(type) {
  return TRANSACTIONAL_TYPES.has(String(type || ''));
}

/** Is a campaign type promotional (subject to frequency limits)? */
function isPromotionalType(type) {
  return !isTransactionalType(type);
}

/** Get priority for a campaign type (defaults to general). */
function campaignPriorityOf(type) {
  return CAMPAIGN_PRIORITY[type] != null ? CAMPAIGN_PRIORITY[type] : CAMPAIGN_PRIORITY.general;
}

/** Map a notification type to its preference category. */
function categoryForType(type) {
  return TYPE_TO_CATEGORY[String(type || 'general')] || CATEGORY.GENERAL;
}

module.exports = {
  config,
  isTransactionalType,
  isPromotionalType,
  campaignPriorityOf,
  categoryForType,
  priorityClassForType,
  CATEGORY,
  PREFERENCE_CATEGORIES,
};
