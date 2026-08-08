/**
 * New Product Auto-Campaign — "Just dropped" push notifications.
 *
 * Every 15 minutes, checks Shopify for products created in the last check.
 * When new products are found, sends a "🔥 Just dropped" push to all
 * registered devices with a productHandle so tapping opens the product.
 *
 * Uses the same push-tokens.json as the notification routes.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TOKENS_FILE = path.join(__dirname, '..', 'push-tokens.json');
const STATE_FILE = path.join(__dirname, '..', 'new-product-state.json');
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[NEW-PRODUCT] save failed:', error.message);
  }
}

function loadTokens() {
  return Object.values(loadJson(TOKENS_FILE, {}));
}

function loadState() {
  return loadJson(STATE_FILE, { lastSeenCreatedAt: null });
}

/**
 * Fetch products created in the last N minutes from Shopify Storefront.
 * Returns [{ title, handle, createdAt, featuredImage }].
 */
async function fetchNewProducts(sinceMinutes = 60) {
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();

  const query = `
    query NewProducts($query: String!) {
      products(first: 20, sortKey: CREATED_AT, reverse: true, query: $query) {
        edges {
          node {
            title
            handle
            createdAt
            featuredImage { url }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      `https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        query,
        variables: { query: `created_at:>=${since}` },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
        },
        timeout: 12000,
      }
    );

    const edges = response?.data?.data?.products?.edges || [];
    return edges.map((e) => e.node).filter(Boolean);
  } catch (error) {
    console.error('[NEW-PRODUCT] Shopify fetch failed:', error.message);
    return [];
  }
}

async function sendPush(products) {
  const tokens = loadTokens();
  if (!tokens.length) return 0;

  // Only notify about the first product to avoid spamming.
  const product = products[0];
  const messages = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title: '🔥 Just dropped',
    body: `${product.title} is live on NOOD — shop it before it sells out!`,
    data: { type: 'product_promo', productHandle: product.handle },
  }));

  try {
    const response = await axios.post(EXPO_PUSH_URL, messages, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return messages.length;
  } catch (error) {
    console.error('[NEW-PRODUCT] push failed:', error.message);
    return 0;
  }
}

async function runNewProductCampaign() {
  // Only run if Shopify is configured (not placeholder).
  if (!SHOPIFY_STORE_DOMAIN || SHOPIFY_STORE_DOMAIN.includes('your-store')) {
    console.log('[NEW-PRODUCT] Shopify not configured — skipping');
    return;
  }
  if (!SHOPIFY_STOREFRONT_TOKEN) {
    console.log('[NEW-PRODUCT] Storefront token not set — skipping');
    return;
  }

  const state = loadState();
  const sinceMinutes = 60;

  const products = await fetchNewProducts(sinceMinutes);

  // Dedupe: skip products we've already notified about.
  const lastSeen = state.lastSeenCreatedAt;
  const fresh = products.filter(
    (p) => !lastSeen || !p.createdAt || p.createdAt > lastSeen
  );

  if (fresh.length) {
    const sent = await sendPush(fresh);
    console.log(`[NEW-PRODUCT] notified ${sent} device(s) about ${fresh.length} new product(s)`);
    // Track the newest created_at so we don't re-notify.
    state.lastSeenCreatedAt = fresh[0].createdAt || new Date().toISOString();
    saveJson(STATE_FILE, state);
  }
}

// Run every 15 minutes.
setInterval(() => {
  runNewProductCampaign().catch((e) =>
    console.error('[NEW-PRODUCT] interval error:', e.message)
  );
}, 15 * 60 * 1000);

// Also run once on startup (after 45s).
setTimeout(() => {
  runNewProductCampaign().catch((e) =>
    console.error('[NEW-PRODUCT] startup error:', e.message)
  );
}, 45000);

module.exports = { runNewProductCampaign };
