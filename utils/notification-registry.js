/**
 * NOOD — Master Notification Registry
 *
 * Single source of truth for EVERY notification type in the app.
 * Backend engine (push-delivery.js) + Campaign Center + tests read from this
 * registry so type metadata never drifts.
 *
 * Status legend:
 *   REAL        — wired to a real trigger, delivered via the unified pipeline
 *   PARTIAL     — template/config exists, no real event source yet
 *   NOT WIRED   — taxonomy entry only, no send path
 */

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

// Priority classes (see push-config.js).
const PRIORITY = {
  CRITICAL: 'critical',
  TRANSACTIONAL_HIGH: 'transactional_high',
  PERSONAL_HIGH: 'personal_high',
  PROMOTIONAL: 'promotional',
  LOW: 'low',
};

/**
 * Full registry.
 * Each entry:
 *   type, category, scope ('global'|'personal'), status ('REAL'|'PARTIAL'|'NOT WIRED'),
 *   trigger, dataSource, targeting, preference (category the user can toggle),
 *   priority, freqCapped (bool — subject to promo frequency limits),
 *   dedupeKey, inboxStyle, template, deepLink
 */
const REGISTRY = [
  // ═══════════════════════ SHOPPING / ARRIVALS ═══════════════════════
  {
    type: 'new_product', category: CATEGORY.ARRIVALS, scope: 'global',
    status: 'REAL', trigger: 'inventory sync detects genuinely new product (after baseline)',
    dataSource: 'products table (Shopify sync)', targeting: 'all devices (batched when >= threshold)',
    preference: CATEGORY.ARRIVALS, priority: PRIORITY.PROMOTIONAL, freqCapped: true,
    dedupeKey: 'product_<handle> or batch_<day>_<count>', inboxStyle: 'New Arrival',
    template: { title: '👟 Fresh on NOOD / 🔥 New Drop', body: '<product> is now available / N new styles' },
    deepLink: '/product/<handle> or /collection/new-arrivals',
  },
  {
    type: 'new_brand', category: CATEGORY.ARRIVALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: '—', preference: CATEGORY.ARRIVALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'brand_<id>',
    inboxStyle: 'New Arrival', template: { title: '🆕 New Brand', body: '<brand> just landed' },
    deepLink: '/collection/new-arrivals',
  },
  {
    type: 'new-category', category: CATEGORY.ARRIVALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: '—', preference: CATEGORY.ARRIVALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'category_<id>',
    inboxStyle: 'New Arrival', template: { title: '🆕 New Category', body: '<category> is here' },
    deepLink: '/collection/<handle>',
  },
  {
    type: 'restock', category: CATEGORY.RESTOCK, scope: 'personal', status: 'PARTIAL',
    trigger: 'inventory sync detects previously-sold-out product back in stock (targeted to watchers)',
    dataSource: 'products table inventory delta', targeting: 'users who watched / wishlisted the product',
    preference: CATEGORY.RESTOCK, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'restock_<productId>_<day>', inboxStyle: 'Restocked',
    template: { title: '🔄 Back in stock', body: '<product> is available again' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'size-restock', category: CATEGORY.RESTOCK, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'variant inventory delta', targeting: 'watchers of that size',
    preference: CATEGORY.RESTOCK, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'size_restock_<variantId>', inboxStyle: 'Restocked',
    template: { title: '📏 Your size is back', body: '<product> size <size> restocked' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'color-restock', category: CATEGORY.RESTOCK, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'variant inventory delta', targeting: 'watchers of that color',
    preference: CATEGORY.RESTOCK, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'color_restock_<variantId>', inboxStyle: 'Restocked',
    template: { title: '🎨 Your color is back', body: '<product> in <color> restocked' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'price-drop', category: CATEGORY.WISHLIST, scope: 'personal', status: 'PARTIAL',
    trigger: 'wishlist price-drop scan (trigger engine) — alias for wishlist-price-drop',
    dataSource: 'wishlist_items table + products table', targeting: 'wishlist owners (per-user)',
    preference: CATEGORY.WISHLIST, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'price_drop_<productId>_<day>', inboxStyle: 'Price Drop',
    template: { title: '⬇️ Price Drop', body: '<product> dropped from $<old> to $<new>' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'wishlist-sale', category: CATEGORY.WISHLIST, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'wishlist + sale events', targeting: 'wishlist owners',
    preference: CATEGORY.WISHLIST, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'wishlist_sale_<productId>', inboxStyle: 'Wishlist Sale',
    template: { title: '💜 Wishlist Sale', body: 'An item you saved just dropped in price' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'wishlist-restock', category: CATEGORY.WISHLIST, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (wishlist_items + products availability)',
    dataSource: 'wishlist_items table + products table', targeting: 'wishlist owners (per-user)',
    preference: CATEGORY.WISHLIST, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'wishlist_rs_<userId>_<handle>_<day>', inboxStyle: 'Wishlist Restock',
    template: { title: '💜 Back on your list', body: '<product> is back in stock' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'wishlist-low-stock', category: CATEGORY.WISHLIST, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (wishlist_items + variant quantityAvailable)',
    dataSource: 'wishlist_items table + products table', targeting: 'wishlist owners (per-user)',
    preference: CATEGORY.WISHLIST, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'wishlist_ls_<userId>_<handle>_<day>', inboxStyle: 'Wishlist Low Stock',
    template: { title: '⚠️ Almost gone', body: '<product> is low in stock' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'low-stock', category: CATEGORY.WISHLIST, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'inventory levels', targeting: 'watchers',
    preference: CATEGORY.WISHLIST, priority: PRIORITY.PERSONAL_HIGH, freqCapped: true,
    dedupeKey: 'low_stock_<productId>', inboxStyle: 'Low Stock',
    template: { title: '⚠️ Low stock', body: '<product> is almost sold out' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'hot-product', category: CATEGORY.ARRIVALS, scope: 'global', status: 'PARTIAL',
    trigger: 'manual/admin campaign only — no automated hot-product detector',
    dataSource: '—', targeting: 'all devices', preference: CATEGORY.ARRIVALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'hot_<productId>_<day>',
    inboxStyle: 'Hot Product', template: { title: '🔥 This one is moving fast', body: 'Customers are checking out <product>' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'trending-product', category: CATEGORY.ARRIVALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'all', preference: CATEGORY.ARRIVALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'trending_<productId>',
    inboxStyle: 'Trending', template: { title: '📈 Trending now', body: '<product> is trending' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'personalized-pick', category: CATEGORY.ARRIVALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'recommendation signals', targeting: 'per-user signals',
    preference: CATEGORY.ARRIVALS, priority: PRIORITY.PROMOTIONAL, freqCapped: true,
    dedupeKey: 'pick_<userId>_<productId>', inboxStyle: 'For You',
    template: { title: '✨ For you', body: '<product> picked for you' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'recently-viewed', category: CATEGORY.ARRIVALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'view history', targeting: 'per-user', preference: CATEGORY.ARRIVALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'recent_<userId>_<productId>',
    inboxStyle: 'Recently Viewed', template: { title: '👀 Back to it', body: 'You viewed <product>' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'similar-product', category: CATEGORY.ARRIVALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'product similarity', targeting: 'per-user', preference: CATEGORY.ARRIVALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'similar_<userId>_<productId>',
    inboxStyle: 'Similar Picks', template: { title: '🔗 You might like', body: '<product> similar to what you viewed' },
    deepLink: '/product/<handle>',
  },
  {
    type: 'recommended-restock', category: CATEGORY.RESTOCK, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'recommendations + inventory', targeting: 'per-user', preference: CATEGORY.RESTOCK,
    priority: PRIORITY.PERSONAL_HIGH, freqCapped: true, dedupeKey: 'rec_restock_<productId>',
    inboxStyle: 'Back in Stock', template: { title: '🔁 Back in stock', body: 'A pick for you is available again' },
    deepLink: '/product/<handle>',
  },

  // ═══════════════════════ DEALS ═══════════════════════
  {
    type: 'deal-live', category: CATEGORY.DEALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'deals engine', targeting: 'all', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'deal_<id>', inboxStyle: 'Deal Live',
    template: { title: '🔥 Deal Live', body: "Up to 40% off today's picks" }, deepLink: '/(tabs)/deals',
  },
  {
    type: 'deal-ending', category: CATEGORY.DEALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'deals engine', targeting: 'all', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'deal_end_<id>', inboxStyle: 'Deal Ending',
    template: { title: '⏰ Deal ending', body: 'Your deal ends soon' }, deepLink: '/(tabs)/deals',
  },
  {
    type: 'deal-upgraded', category: CATEGORY.DEALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'deals engine', targeting: 'all', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'deal_up_<id>', inboxStyle: 'Deal Upgraded',
    template: { title: '📈 Deal upgraded', body: 'Even better price' }, deepLink: '/(tabs)/deals',
  },
  {
    type: 'flash-live', category: CATEGORY.DEALS, scope: 'global', status: 'REAL',
    trigger: 'scheduled window (PUSH_FLASH_WINDOW_START/END), once per day',
    dataSource: 'time-window campaign', targeting: 'all devices', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'flash_live_<day>', inboxStyle: 'Flash Sale',
    template: { title: '⚡ Flash Deal', body: 'Your deal is live now' }, deepLink: '/flash-sale',
  },
  {
    type: 'flash-ending', category: CATEGORY.DEALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'flash timer', targeting: 'all', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'flash_end_<day>', inboxStyle: 'Flash Ending',
    template: { title: '⚡ Flash ending', body: 'Prices go back up soon' }, deepLink: '/flash-sale',
  },
  {
    type: 'coupon-ready', category: CATEGORY.DEALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'coupon engine', targeting: 'eligible users', preference: CATEGORY.DEALS,
    priority: PRIORITY.PERSONAL_HIGH, freqCapped: true, dedupeKey: 'coupon_ready_<userId>_<code>',
    inboxStyle: 'Coupon Ready', template: { title: '🎟️ Coupon ready', body: '<code> is waiting' },
    deepLink: '/(tabs)/deals',
  },
  {
    type: 'coupon-expiring', category: CATEGORY.DEALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'coupon expiry', targeting: 'coupon holders', preference: CATEGORY.DEALS,
    priority: PRIORITY.PERSONAL_HIGH, freqCapped: true, dedupeKey: 'coupon_exp_<userId>_<code>',
    inboxStyle: 'Coupon Expiring', template: { title: '🎟️ Expiring soon', body: 'Use <code> before it expires' },
    deepLink: '/(tabs)/deals',
  },
  {
    type: 'coupon-applied', category: CATEGORY.DEALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'checkout coupon application', targeting: 'the user', preference: CATEGORY.DEALS,
    priority: PRIORITY.PERSONAL_HIGH, freqCapped: false, dedupeKey: 'coupon_applied_<orderId>',
    inboxStyle: 'Coupon Applied', template: { title: '✅ Coupon applied', body: '<code> saved you $<x>' },
    deepLink: '/(tabs)/cart',
  },
  {
    type: 'free-shipping', category: CATEGORY.DEALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'shipping promos', targeting: 'all', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'freeship_<id>', inboxStyle: 'Free Shipping',
    template: { title: '📦 Free shipping', body: 'On orders over $X' }, deepLink: '/(tabs)/deals',
  },
  {
    type: 'free-shipping-close', category: CATEGORY.DEALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'cart total', targeting: 'users near threshold', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'freeship_close_<userId>_<day>',
    inboxStyle: 'Almost Free Shipping', template: { title: '📦 $<x> from free shipping', body: 'Add <n> more items' },
    deepLink: '/(tabs)/cart',
  },
  {
    type: 'cart-discount', category: CATEGORY.DEALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'cart + deals', targeting: 'cart owners', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'cart_discount_<userId>_<day>',
    inboxStyle: 'Cart Discount', template: { title: '🛒 Cart discount', body: 'Extra deal on your cart' },
    deepLink: '/(tabs)/cart',
  },
  {
    type: 'brand-sale', category: CATEGORY.DEALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'brand promos', targeting: 'all', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'brand_sale_<brand>_<day>',
    inboxStyle: 'Brand Sale', template: { title: '🏷️ <brand> sale', body: 'Up to X% off' },
    deepLink: '/(tabs)/deals',
  },
  {
    type: 'category-sale', category: CATEGORY.DEALS, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'category promos', targeting: 'all', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'cat_sale_<cat>_<day>',
    inboxStyle: 'Category Sale', template: { title: '🏷️ <category> sale', body: 'Up to X% off' },
    deepLink: '/(tabs)/deals',
  },
  {
    type: 'personalized-deal', category: CATEGORY.DEALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'user signals', targeting: 'per-user', preference: CATEGORY.DEALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'pdeal_<userId>_<id>',
    inboxStyle: 'Deal for You', template: { title: '✨ Deal for you', body: '<product> at a great price' },
    deepLink: '/(tabs)/deals',
  },


  // ═══════════════════════ CART / WISHLIST ═══════════════════════
  {
    type: 'cart-nudge', category: CATEGORY.CART, scope: 'personal', status: 'REAL',
    trigger: 'abandoned-cart scan (cooldown PUSH_CART_NUDGE_COOLDOWN_HOURS)',
    dataSource: 'carts table', targeting: 'cart owners with tokens', preference: CATEGORY.CART,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'cart_<cartId>_<day>', inboxStyle: 'Cart Reminder',
    template: { title: '👀 Still thinking about it?', body: 'Your NOOD cart is waiting' }, deepLink: '/(tabs)/cart',
  },
  {
    type: 'cart-price-drop', category: CATEGORY.CART, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (carts snapshot price vs current price)',
    dataSource: 'carts table + products table', targeting: 'cart owners (per-user)',
    preference: CATEGORY.CART, priority: PRIORITY.PERSONAL_HIGH, freqCapped: false,
    dedupeKey: 'cart_pd_<scopeKey>_<handle>_<priceVersion>', inboxStyle: 'Cart Price Drop',
    template: { title: '📉 Cart price drop', body: '<product> in your cart dropped' }, deepLink: '/(tabs)/cart',
  },
  {
    type: 'cart-low-stock', category: CATEGORY.CART, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (carts + variant quantityAvailable)',
    dataSource: 'carts table + products table', targeting: 'cart owners (per-user)',
    preference: CATEGORY.CART, priority: PRIORITY.PERSONAL_HIGH, freqCapped: false,
    dedupeKey: 'cart_ls_<scopeKey>_<handle>_<day>', inboxStyle: 'Cart Low Stock',
    template: { title: '⚠️ Cart low stock', body: '<product> in your cart is low' }, deepLink: '/(tabs)/cart',
  },
  {
    type: 'cart-restock', category: CATEGORY.CART, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (carts + products availability)',
    dataSource: 'carts table + products table', targeting: 'cart owners (per-user)',
    preference: CATEGORY.CART, priority: PRIORITY.PERSONAL_HIGH, freqCapped: false,
    dedupeKey: 'cart_rs_<scopeKey>_<handle>_<day>', inboxStyle: 'Cart Restock',
    template: { title: '🔁 Cart restock', body: '<product> in your cart is back' }, deepLink: '/(tabs)/cart',
  },
  {
    type: 'cart-reward-ready', category: CATEGORY.CART, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'cart + rewards', targeting: 'cart owners', preference: CATEGORY.CART,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'cart_reward_<userId>_<day>', inboxStyle: 'Cart Reward',
    template: { title: '🎁 Reward ready', body: 'Complete your cart to unlock' }, deepLink: '/(tabs)/cart',
  },
  {
    type: 'cart-coupon-ready', category: CATEGORY.CART, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'cart + coupons', targeting: 'cart owners', preference: CATEGORY.CART,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'cart_coupon_<userId>_<day>', inboxStyle: 'Cart Coupon',
    template: { title: '🎟️ Coupon ready', body: 'Use <code> on your cart' }, deepLink: '/(tabs)/cart',
  },
  {
    type: 'cart-free-shipping-close', category: CATEGORY.CART, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (carts total vs FREE_SHIPPING_THRESHOLD)',
    dataSource: 'carts table', targeting: 'cart owners near threshold (per-user)',
    preference: CATEGORY.CART, priority: PRIORITY.PROMOTIONAL, freqCapped: true,
    dedupeKey: 'cart_fs_<scopeKey>_<day>', inboxStyle: 'Free Shipping Close',
    template: { title: '📦 Almost free shipping', body: 'Add <n> more items' }, deepLink: '/(tabs)/cart',
  },
  {
    type: 'wishlist-price-drop', category: CATEGORY.WISHLIST, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (wishlist_items snapshot price vs current price)',
    dataSource: 'wishlist_items table + products table', targeting: 'wishlist owners (per-user)',
    preference: CATEGORY.WISHLIST, priority: PRIORITY.PERSONAL_HIGH, freqCapped: false,
    dedupeKey: 'wishlist_pd_<userId>_<handle>_<priceVersion>', inboxStyle: 'Wishlist Price Drop',
    template: { title: '⬇️ Wishlist price drop', body: '<product> dropped' }, deepLink: '/product/<handle>',
  },
  {
    type: 'wishlist-restock', category: CATEGORY.WISHLIST, scope: 'personal', status: 'REAL',
    trigger: 'trigger engine scan (wishlist_items + products availability)',
    dataSource: 'wishlist_items table + products table', targeting: 'wishlist owners (per-user)',
    preference: CATEGORY.WISHLIST, priority: PRIORITY.PERSONAL_HIGH, freqCapped: false,
    dedupeKey: 'wishlist_rs_<userId>_<handle>_<day>', inboxStyle: 'Wishlist Restock',
    template: { title: '💜 Wishlist restock', body: '<product> is back' }, deepLink: '/product/<handle>',
  },

  // ═══════════════════════ ORDERS / PAYMENT (TRANSACTIONAL) ═══════════════════════
  {
    type: 'order-confirmed', category: CATEGORY.ORDERS, scope: 'personal', status: 'PARTIAL',
    trigger: 'checkout success (frontend) — no backend webhook yet',
    dataSource: 'order creation', targeting: 'the buyer', preference: CATEGORY.ORDERS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'order_conf_<orderId>', inboxStyle: 'Order Confirmed',
    template: { title: '✅ Order confirmed', body: 'Order <#name> confirmed' }, deepLink: '/account/orders',
  },
  {
    type: 'payment-confirmed', category: CATEGORY.ORDERS, scope: 'personal', status: 'PARTIAL',
    trigger: 'payment capture success (frontend)', dataSource: 'payment result', targeting: 'the buyer',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'pay_conf_<txnId>',
    inboxStyle: 'Payment Confirmed', template: { title: '💳 Payment confirmed', body: '<amount> paid' }, deepLink: '/account/orders',
  },
  {
    type: 'payment-failed', category: CATEGORY.ORDERS, scope: 'personal', status: 'PARTIAL',
    trigger: 'payment failure (frontend)', dataSource: 'payment result', targeting: 'the buyer',
    preference: CATEGORY.ORDERS, priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'pay_fail_<txnId>',
    inboxStyle: 'Payment Failed', template: { title: '❌ Payment failed', body: 'Your payment could not be processed' }, deepLink: '/account/orders',
  },
  {
    type: 'payment-action-needed', category: CATEGORY.ORDERS, scope: 'personal', status: 'PARTIAL',
    trigger: 'payment review needed', dataSource: 'payment result', targeting: 'the buyer',
    preference: CATEGORY.ORDERS, priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'pay_action_<txnId>',
    inboxStyle: 'Action Needed', template: { title: '⚠️ Action needed', body: 'Contact support with transaction ID' }, deepLink: '/account/orders',
  },
  {
    type: 'order-processing', category: CATEGORY.ORDERS, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook (normalizeStatus)', dataSource: 'order_tracking table', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Processing', template: { title: '📦 Processing', body: 'Your order is being prepared' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-packed', category: CATEGORY.ORDERS, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Packed', template: { title: '📦 Packed', body: 'Your order is packed' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-ready', category: CATEGORY.ORDERS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the buyer', preference: CATEGORY.ORDERS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'order_ready_<orderId>', inboxStyle: 'Order Ready',
    template: { title: '✅ Order ready', body: 'Ready for pickup/delivery' }, deepLink: '/account/orders',
  },
  {
    type: 'order-shipped', category: CATEGORY.ORDERS, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Shipped', template: { title: '📦 Shipped', body: 'Your order is on its way' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-in-transit', category: CATEGORY.TRACKING, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'In Transit', template: { title: '🚚 In transit', body: 'Your package is moving' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-local-facility', category: CATEGORY.TRACKING, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'At Local Facility', template: { title: '🏢 At local facility', body: 'Arrived in your area' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-out-for-delivery', category: CATEGORY.TRACKING, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Out for Delivery', template: { title: '🚚 Out for delivery', body: 'Arriving today' }, deepLink: '/account/tracking',
  },
  {
    type: 'delivery-attempted', category: CATEGORY.TRACKING, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Delivery Attempted', template: { title: '🚪 Delivery attempted', body: 'We missed you' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-delivered', category: CATEGORY.TRACKING, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Delivered', template: { title: '🎉 Delivered', body: 'Enjoy your order' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-delayed', category: CATEGORY.TRACKING, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Delayed', template: { title: '⏰ Delayed', body: 'Your order is delayed' }, deepLink: '/account/tracking',
  },
  {
    type: 'order-exception', category: CATEGORY.TRACKING, scope: 'personal', status: 'REAL',
    trigger: 'fulfillment webhook', dataSource: 'order_tracking', targeting: 'order owner',
    preference: CATEGORY.ORDERS, priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'last_notified_status',
    inboxStyle: 'Delivery Exception', template: { title: '⚠️ Delivery exception', body: 'Contact support' }, deepLink: '/account/tracking',
  },
  {
    type: 'address-action-needed', category: CATEGORY.ORDERS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the buyer', preference: CATEGORY.ORDERS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'addr_<orderId>', inboxStyle: 'Address Needed',
    template: { title: '📍 Address needed', body: 'Update your shipping address' }, deepLink: '/account/address',
  },
  {
    type: 'pickup-ready', category: CATEGORY.ORDERS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the buyer', preference: CATEGORY.ORDERS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'pickup_ready_<orderId>', inboxStyle: 'Pickup Ready',
    template: { title: '📦 Pickup ready', body: 'Your order is ready for pickup' }, deepLink: '/account/orders',
  },
  {
    type: 'pickup-reminder', category: CATEGORY.ORDERS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the buyer', preference: CATEGORY.ORDERS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'pickup_rem_<orderId>', inboxStyle: 'Pickup Reminder',
    template: { title: '⏰ Pickup reminder', body: 'Pick up your order soon' }, deepLink: '/account/orders',
  },

  // ═══════════════════════ RETURNS / REFUNDS ═══════════════════════
  {
    type: 'return-requested', category: CATEGORY.RETURNS, scope: 'personal', status: 'REAL',
    trigger: 'POST /api/refunds/requests (customer)', dataSource: 'refund_requests table', targeting: 'the customer',
    preference: CATEGORY.RETURNS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'noo_return_<orderId>_<requestId>',
    inboxStyle: 'Return Requested', template: { title: '📋 Return Requested', body: 'Your return request is pending review' }, deepLink: '/account/returns',
  },
  {
    type: 'return-approved', category: CATEGORY.RETURNS, scope: 'personal', status: 'REAL',
    trigger: 'POST /api/refunds/requests/:id/update (admin)', dataSource: 'refund_requests', targeting: 'the customer',
    preference: CATEGORY.RETURNS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'noo_return_update_<requestId>',
    inboxStyle: 'Return Approved', template: { title: '✅ Return approved', body: 'We\'ll process your refund shortly' }, deepLink: '/account/returns',
  },
  {
    type: 'return-rejected', category: CATEGORY.RETURNS, scope: 'personal', status: 'REAL',
    trigger: 'POST /api/refunds/requests/:id/update (admin)', dataSource: 'refund_requests', targeting: 'the customer',
    preference: CATEGORY.RETURNS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'noo_return_update_<requestId>',
    inboxStyle: 'Return Rejected', template: { title: '❌ Return rejected', body: 'See admin notes for details' }, deepLink: '/account/returns',
  },
  {
    type: 'return-dropoff-reminder', category: CATEGORY.RETURNS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the customer', preference: CATEGORY.RETURNS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'return_drop_<requestId>', inboxStyle: 'Return Dropoff',
    template: { title: '📦 Drop off your return', body: 'Ship it back within N days' }, deepLink: '/account/returns',
  },
  {
    type: 'return-in-transit', category: CATEGORY.RETURNS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the customer', preference: CATEGORY.RETURNS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'return_transit_<requestId>', inboxStyle: 'Return In Transit',
    template: { title: '🚚 Return in transit', body: 'Your return is on its way' }, deepLink: '/account/returns',
  },
  {
    type: 'return-received', category: CATEGORY.RETURNS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the customer', preference: CATEGORY.RETURNS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'return_recv_<requestId>', inboxStyle: 'Return Received',
    template: { title: '📦 Return received', body: 'Refund processing' }, deepLink: '/account/returns',
  },
  {
    type: 'exchange-approved', category: CATEGORY.RETURNS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the customer', preference: CATEGORY.RETURNS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'exch_appr_<requestId>', inboxStyle: 'Exchange Approved',
    template: { title: '✅ Exchange approved', body: 'Your replacement is on the way' }, deepLink: '/account/returns',
  },
  {
    type: 'exchange-shipped', category: CATEGORY.RETURNS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: '—', targeting: 'the customer', preference: CATEGORY.RETURNS,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'exch_ship_<requestId>', inboxStyle: 'Exchange Shipped',
    template: { title: '📦 Exchange shipped', body: 'Your replacement shipped' }, deepLink: '/account/tracking',
  },
  {
    type: 'refund-started', category: CATEGORY.RETURNS, scope: 'personal', status: 'PARTIAL',
    trigger: 'admin refund status update', dataSource: 'refund_requests', targeting: 'the customer',
    preference: CATEGORY.RETURNS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'noo_return_update_<requestId>',
    inboxStyle: 'Refund Started', template: { title: '💰 Refund started', body: 'Refund processing' }, deepLink: '/account/returns',
  },
  {
    type: 'refund-processing', category: CATEGORY.RETURNS, scope: 'personal', status: 'PARTIAL',
    trigger: 'admin refund status update', dataSource: 'refund_requests', targeting: 'the customer',
    preference: CATEGORY.RETURNS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'noo_return_update_<requestId>',
    inboxStyle: 'Refund Processing', template: { title: '⏳ Refund processing', body: 'Working on your refund' }, deepLink: '/account/returns',
  },
  {
    type: 'refund-completed', category: CATEGORY.RETURNS, scope: 'personal', status: 'REAL',
    trigger: 'admin refund status → refunded_to_wallet/original', dataSource: 'refund_requests', targeting: 'the customer',
    preference: CATEGORY.RETURNS, priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'noo_return_update_<requestId>',
    inboxStyle: 'Refund Completed', template: { title: '✅ Refund completed', body: 'Refunded to <destination>' }, deepLink: '/account/returns',
  },
  {
    type: 'refund-failed', category: CATEGORY.RETURNS, scope: 'personal', status: 'PARTIAL',
    trigger: 'admin refund status → failed', dataSource: 'refund_requests', targeting: 'the customer',
    preference: CATEGORY.RETURNS, priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'noo_return_update_<requestId>',
    inboxStyle: 'Refund Failed', template: { title: '❌ Refund failed', body: 'Contact support' }, deepLink: '/account/returns',
  },

  // ═══════════════════════ ACCOUNT / SERVICE / SECURITY ═══════════════════════
  {
    type: 'support-reply', category: CATEGORY.SUPPORT, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'support system', targeting: 'the customer', preference: CATEGORY.SUPPORT,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'support_<caseId>', inboxStyle: 'Support Reply',
    template: { title: '💬 Support reply', body: 'Your case has a new reply' }, deepLink: '/account/support',
  },
  {
    type: 'support-case-update', category: CATEGORY.SUPPORT, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'support system', targeting: 'the customer', preference: CATEGORY.SUPPORT,
    priority: PRIORITY.TRANSACTIONAL_HIGH, freqCapped: false, dedupeKey: 'support_up_<caseId>', inboxStyle: 'Support Update',
    template: { title: '📋 Support update', body: 'Case <id> updated' }, deepLink: '/account/support',
  },
  {
    type: 'security-alert', category: CATEGORY.SECURITY, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'security events', targeting: 'the user', preference: CATEGORY.SECURITY,
    priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'sec_<eventId>', inboxStyle: 'Security Alert',
    template: { title: '🔒 Security alert', body: 'Suspicious activity detected' }, deepLink: '/account/security',
  },
  {
    type: 'new-login', category: CATEGORY.SECURITY, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'login events', targeting: 'the user', preference: CATEGORY.SECURITY,
    priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'login_<eventId>', inboxStyle: 'New Login',
    template: { title: '🔓 New login', body: 'New device signed in' }, deepLink: '/account/security',
  },
  {
    type: 'password-changed', category: CATEGORY.SECURITY, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'account events', targeting: 'the user', preference: CATEGORY.SECURITY,
    priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'pw_<eventId>', inboxStyle: 'Password Changed',
    template: { title: '🔑 Password changed', body: 'If this wasn\'t you, contact support' }, deepLink: '/account/security',
  },
  {
    type: 'email-changed', category: CATEGORY.SECURITY, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'account events', targeting: 'the user', preference: CATEGORY.SECURITY,
    priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'email_ch_<eventId>', inboxStyle: 'Email Changed',
    template: { title: '✉️ Email changed', body: 'Your email was updated' }, deepLink: '/account/security',
  },
  {
    type: 'phone-changed', category: CATEGORY.SECURITY, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'account events', targeting: 'the user', preference: CATEGORY.SECURITY,
    priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'phone_ch_<eventId>', inboxStyle: 'Phone Changed',
    template: { title: '📱 Phone changed', body: 'Your phone was updated' }, deepLink: '/account/security',
  },
  {
    type: 'account-warning', category: CATEGORY.SECURITY, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'account events', targeting: 'the user', preference: CATEGORY.SECURITY,
    priority: PRIORITY.CRITICAL, freqCapped: false, dedupeKey: 'acct_warn_<eventId>', inboxStyle: 'Account Warning',
    template: { title: '⚠️ Account warning', body: 'Action needed on your account' }, deepLink: '/account/security',
  },
  {
    type: 'broadcast', category: CATEGORY.GENERAL, scope: 'global', status: 'REAL',
    trigger: 'admin campaign send', dataSource: 'admin input', targeting: 'all devices', preference: CATEGORY.GENERAL,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'campaignId', inboxStyle: 'Broadcast',
    template: { title: 'NOOD', body: 'Custom message' }, deepLink: '/(tabs)',
  },
  {
    type: 'general', category: CATEGORY.GENERAL, scope: 'global', status: 'REAL',
    trigger: 'admin campaign send', dataSource: 'admin input', targeting: 'all devices', preference: CATEGORY.GENERAL,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'campaignId', inboxStyle: 'General',
    template: { title: 'NOOD', body: 'Custom message' }, deepLink: '/(tabs)',
  },
  {
    type: 'maintenance', category: CATEGORY.GENERAL, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'ops input', targeting: 'all devices', preference: CATEGORY.GENERAL,
    priority: PRIORITY.LOW, freqCapped: true, dedupeKey: 'maint_<id>', inboxStyle: 'Service',
    template: { title: '🛠️ Maintenance', body: 'Scheduled maintenance' }, deepLink: '/(tabs)',
  },
  {
    type: 'service-update', category: CATEGORY.GENERAL, scope: 'global', status: 'NOT WIRED',
    trigger: '—', dataSource: 'ops input', targeting: 'all devices', preference: CATEGORY.GENERAL,
    priority: PRIORITY.LOW, freqCapped: true, dedupeKey: 'svc_<id>', inboxStyle: 'Service',
    template: { title: '📣 Service update', body: 'What\'s new in NOOD' }, deepLink: '/(tabs)',
  },

  // ═══════════════════════ REFERRALS / LOYALTY ═══════════════════════
  {
    type: 'referral-invite', category: CATEGORY.REFERRALS, scope: 'personal', status: 'NOT WIRED',
    trigger: '—', dataSource: 'referral store', targeting: 'the user', preference: CATEGORY.REFERRALS,
    priority: PRIORITY.PROMOTIONAL, freqCapped: true, dedupeKey: 'ref_invite_<code>', inboxStyle: 'Referral',
    template: { title: '💌 Invite friends', body: 'Earn $10 for each friend' }, deepLink: '/account/rewards',
  },
  {
    type: 'referral-joined', category: CATEGORY.REFERRALS, scope: 'personal', status: 'REAL',
    trigger: 'POST /api/rewards/referral/attributed (new invite)',
    dataSource: 'referral-store.json', targeting: 'the referrer', preference: CATEGORY.REFERRALS,
    priority: PRIORITY.PERSONAL_HIGH, freqCapped: false, dedupeKey: 'referral_referral-joined_<userId>', inboxStyle: 'Referral',
    template: { title: '👋 Friend joined', body: 'You\'re one step closer to $10' }, deepLink: '/account/rewards',
  },
  {
    type: 'referral-qualified', category: CATEGORY.REFERRALS, scope: 'personal', status: 'REAL',
    trigger: 'POST /api/rewards/referral/attributed (referrer reaches 5 invites)',
    dataSource: 'referral-store.json', targeting: 'the referrer', preference: CATEGORY.REFERRALS,
    priority: PRIORITY.PERSONAL_HIGH, freqCapped: false, dedupeKey: 'referral_referral-qualified_<userId>', inboxStyle: 'Referral',
    template: { title: '🎉 You qualified', body: 'Claim your reward' }, deepLink: '/account/rewards',
  },
  {
    type: 'referral-reward', category: CATEGORY.REFERRALS, scope: 'personal', status: 'REAL',
    trigger: 'POST /api/rewards/claim (reward claimed)',
    dataSource: 'referral-store.json', targeting: 'the referrer', preference: CATEGORY.REFERRALS,
    priority: PRIORITY.PERSONAL_HIGH, freqCapped: false, dedupeKey: 'referral_referral-reward_<userId>', inboxStyle: 'Referral Reward',
    template: { title: '💰 Referral reward', body: '$10 added to your wallet' }, deepLink: '/account/rewards',
  },
  {
    type: 'vip-tier-up', category: CATEGORY.REFERRALS, scope: 'personal', status: 'REAL',
    trigger: 'addLoyaltyPoints() detects tier change (member→bronze→silver→gold→vip)',
    dataSource: 'loyalty_state + reward_ledger', targeting: 'the user (per-user)',
    preference: CATEGORY.REFERRALS, priority: PRIORITY.PERSONAL_HIGH, freqCapped: false,
    dedupeKey: 'vip_<userId>_<tier>', inboxStyle: 'VIP Tier Up',
    template: { title: '👑 Welcome to VIP <tier>', body: 'New perks unlocked' }, deepLink: '/account/rewards',
  },
  {
    type: 'loyalty-milestone', category: CATEGORY.REFERRALS, scope: 'personal', status: 'REAL',
    trigger: 'addLoyaltyPoints() hits a tier threshold with reward issuance',
    dataSource: 'loyalty_state + reward_ledger', targeting: 'the user (per-user)',
    preference: CATEGORY.REFERRALS, priority: PRIORITY.PERSONAL_HIGH, freqCapped: false,
    dedupeKey: 'loyal_<userId>_<milestone>', inboxStyle: 'Loyalty Milestone',
    template: { title: '🏅 Milestone reached', body: 'You passed <milestone>' }, deepLink: '/account/rewards',
  },
];

/** Map type → entry. */
const BY_TYPE = new Map(REGISTRY.map((e) => [e.type, e]));

function entryFor(type) {
  return BY_TYPE.get(String(type || '')) || null;
}

function statusFor(type) {
  const e = entryFor(type);
  return e ? e.status : 'NOT WIRED';
}

function categoryFor(type) {
  const e = entryFor(type);
  return e ? e.category : CATEGORY.GENERAL;
}

function isFreqCapped(type) {
  const e = entryFor(type);
  return e ? e.freqCapped !== false : false;
}

module.exports = {
  REGISTRY,
  CATEGORY,
  PRIORITY,
  entryFor,
  statusFor,
  categoryFor,
  isFreqCapped,
};
