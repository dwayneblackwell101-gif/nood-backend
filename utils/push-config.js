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

/**
 * Campaign types NOOD supports.
 *  - transactional: exempt from promotional frequency limits (e.g. order-update)
 *  - priority: higher wins when multiple campaigns are queued (not yet used by
 *    the engine, but part of the contract for future scheduling)
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

const TRANSACTIONAL_TYPES = new Set(['order-update']);

const CAMPAIGN_PRIORITY = {
  'order-update': 100,
  'daily-reward': 50,
  'hot-product': 40,
  'price-drop': 40,
  new_product: 35,
  'flash-live': 30,
  'cart-nudge': 20,
  broadcast: 25,
  general: 10,
};

/** Promotional types = every campaign type that is NOT transactional. */
const PROMOTIONAL_TYPES = CAMPAIGN_TYPES.filter((t) => !TRANSACTIONAL_TYPES.has(t));

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

module.exports = {
  config,
  isTransactionalType,
  isPromotionalType,
  campaignPriorityOf,
};
