/**
 * Inventory sync — periodic job to keep local product inventory in sync
 * with Shopify. Runs every 30 minutes using setInterval (no external deps).
 *
 * New-product detection:
 *   The job fetches the full active product list from Shopify, then INSERTS
 *   any product whose shopify_product_id is not already in the `products`
 *   table. Inserts happen BEFORE the new-product campaign fires, so the
 *   product is saved/indexed and can be opened in the app before any push is
 *   sent. Repeated syncs never re-insert (upsert-on-conflict) and never
 *   re-fire (campaign dedupe keys are per product/batch + day).
 *
 * Baseline rule:
 *   The first successful FULL catalog population establishes the baseline.
 *   Products present at baseline are inserted but NOT treated as "new", so a
 *   first successful sync can never fire a mass "everything is new" push.
 *   Only products discovered AFTER the baseline qualify as genuinely new.
 *
 * Storefront fallback:
 *   When the Admin API returns 402 (Payment Required / plan limitation) the
 *   job falls back to the Storefront GraphQL API, which works on every plan.
 *   The fallback now:
 *     - validates GraphQL errors (never silently swallows them),
 *     - paginates through ALL products (after cursor loop),
 *     - requests quantityAvailable but retries without it if the token lacks
 *       the inventory scope (falling back to availableForSale only),
 *     - logs safe diagnostics (never tokens).
 */

const axios = require('axios');
const { updateProductInventory, syncCatalog, detectNewProducts } = require('../utils/inventory');
const { sendNewProductCampaign } = require('./notification-campaigns');

const INVENTORY_SYNC_INTERVAL_MINUTES = 30;
const STOREFRONT_PAGE_SIZE = 250;
const MAX_STOREFRONT_PAGES = 40; // safety cap (~10k products)

// ─── Shape normalizers ──────────────────────────────────────────────────

/** Strip "gid://shopify/Product/123" → "123". */
function stripGid(value) {
  const match = String(value || '').match(/(\d+)$/);
  return match ? match[1] : String(value || '');
}

/** Normalize a Storefront variant node into the shared sync shape. */
function normalizeStorefrontVariant(node, hasInventory) {
  return {
    id: stripGid(node.id),
    title: String(node.title || ''),
    price: node.price?.amount != null ? Number(node.price.amount) : null,
    compareAtPrice:
      node.compareAtPrice?.amount != null ? Number(node.compareAtPrice.amount) : null,
    availableForSale: node.availableForSale !== false,
    quantityAvailable:
      hasInventory && node.quantityAvailable != null ? Number(node.quantityAvailable) : null,
    selectedOptions: Array.isArray(node.selectedOptions)
      ? node.selectedOptions.map((o) => ({ name: String(o?.name || ''), value: String(o?.value || '') }))
      : [],
  };
}

/** Normalize an Admin REST product into the shared sync shape. */
function normalizeAdminProduct(product) {
  return {
    id: String(product?.id || ''),
    title: String(product?.title || ''),
    handle: String(product?.handle || ''),
    variants: Array.isArray(product?.variants)
      ? product.variants.map((v) => ({
          id: String(v?.id || ''),
          title: String(v?.title || ''),
          price: v?.price != null ? Number(v.price) : null,
          compareAtPrice: v?.compare_at_price != null ? Number(v.compare_at_price) : null,
          // Admin REST uses "available" | "deny".
          availableForSale: String(v?.available || '') !== 'deny',
          quantityAvailable: v?.inventory_quantity != null ? Number(v.inventory_quantity) : null,
          selectedOptions: [
            { name: 'Option 1', value: v?.option1 },
            { name: 'Option 2', value: v?.option2 },
            { name: 'Option 3', value: v?.option3 },
          ].filter((o) => o.value != null && String(o.value) !== ''),
        }))
      : [],
  };
}

/** Normalize a Storefront product node into the shared sync shape. */
function normalizeStorefrontProduct(node, hasInventory) {
  return {
    id: stripGid(node.id),
    title: String(node?.title || ''),
    handle: String(node?.handle || ''),
    createdAt: node?.createdAt || null,
    availableForSale: node?.availableForSale !== false,
    variants: Array.isArray(node?.variants?.edges)
      ? node.variants.edges.map((e) => normalizeStorefrontVariant(e?.node, hasInventory))
      : [],
  };
}

// ─── Storefront GraphQL ─────────────────────────────────────────────────

const STOREFRONT_QUERY = `
  query ProductsForSync($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          title
          handle
          createdAt
          availableForSale
          variants(first: 10) {
            edges {
              node {
                id
                title
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
                availableForSale
                quantityAvailable
                selectedOptions { name value }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Same query without quantityAvailable — used when the token lacks the
// inventory scope. Falls back to availableForSale (no fabricated counts).
const STOREFRONT_QUERY_NO_INVENTORY = `
  query ProductsForSyncNoInventory($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          title
          handle
          createdAt
          availableForSale
          variants(first: 10) {
            edges {
              node {
                id
                title
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
                availableForSale
                selectedOptions { name value }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Run ONE Storefront GraphQL page request.
 * Throws on GraphQL errors (never silently swallows them).
 */
async function storefrontPage({ domain, token, apiVersion, query, variables, includeInventory }) {
  const response = await axios.post(
    `https://${domain}/api/${apiVersion}/graphql.json`,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token,
      },
      timeout: 20000,
    }
  );

  const body = response?.data || {};
  if (body?.errors?.length) {
    const message = body.errors.map((e) => e?.message || 'unknown').join('; ');
    const err = new Error(`Storefront GraphQL error: ${message}`);
    err.status = 400;
    err.graphqlErrors = body.errors;
    throw err;
  }

  const products = body?.data?.products || null;
  if (!products) {
    throw new Error('Storefront GraphQL response missing products data');
  }

  return {
    products,
    httpStatus: response.status,
  };
}

/**
 * Fetch ALL active products through the Storefront API (paginated).
 *
 * Tries the inventory-aware query first. If the token lacks the inventory
 * scope, the query fails with a GraphQL error — retry WITHOUT quantityAvailable
 * so the sync still works using availableForSale only.
 *
 * @returns {Promise<{ products: Array, inventoryAvailable: boolean, pageCount: number }>}
 */
async function fetchStorefrontProductsForSync() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

  if (!domain || domain.includes('your-store')) {
    throw new Error('Shopify domain not configured');
  }
  if (!token || token.includes('your_shopify_storefront_token')) {
    throw new Error('SHOPIFY_STOREFRONT_TOKEN not configured');
  }

  // Try inventory-aware query first.
  let includeInventory = true;
  try {
    return await pageAllStorefront({
      domain, token, apiVersion, query: STOREFRONT_QUERY, includeInventory: true,
    });
  } catch (error) {
    // Only fall back on GraphQL errors (field/scope related). Network and
    // HTTP errors should still surface.
    if (error?.graphqlErrors?.length) {
      console.warn(
        '[INVENTORY SYNC] Storefront inventory query failed — falling back to availableForSale only.',
        { detail: error.message }
      );
      includeInventory = false;
    } else {
      throw error;
    }
  }

  // Retry without quantityAvailable.
  const result = await pageAllStorefront({
    domain, token, apiVersion, query: STOREFRONT_QUERY_NO_INVENTORY, includeInventory: false,
  });
  return { ...result, inventoryAvailable: false };
}

/** Paginate through ALL products via the after-cursor loop. */
async function pageAllStorefront({ domain, token, apiVersion, query, includeInventory }) {
  const all = [];
  let after = null;
  let pageCount = 0;
  let total = 0;

  for (let page = 0; page < MAX_STOREFRONT_PAGES; page += 1) {
    const variables = { first: STOREFRONT_PAGE_SIZE };
    if (after) variables.after = after;

    const { products, httpStatus } = await storefrontPage({
      domain, token, apiVersion, query, variables, includeInventory,
    });

    const edges = Array.isArray(products?.edges) ? products.edges : [];
    const pageInfo = products?.pageInfo || {};
    for (const edge of edges) {
      all.push(normalizeStorefrontProduct(edge?.node, includeInventory));
    }
    total += edges.length;
    pageCount += 1;

    console.log(
      `[INVENTORY SYNC] Storefront page ${pageCount} | http=${httpStatus} | products=${edges.length} | hasNextPage=${pageInfo.hasNextPage === true}`
    );

    if (pageInfo.hasNextPage === true && pageInfo.endCursor) {
      after = pageInfo.endCursor;
    } else {
      break;
    }
  }

  console.log(
    `[INVENTORY SYNC] Storefront fetched ${total} products across ${pageCount} page(s) (inventory field: ${includeInventory ? 'quantityAvailable' : 'availableForSale only'})`
  );
  return { products: all, inventoryAvailable: includeInventory, pageCount };
}

// ─── Top-level fetch ────────────────────────────────────────────────────

/**
 * Fetch the full active product list from Shopify.
 *
 * Primary: Admin REST API (https://<domain>/admin/api/<version>/products.json).
 * Fallback: Storefront GraphQL API — available on ALL Shopify plans, so the
 * sync + new-product detection keep working even when the Admin API returns
 * 402 (Payment Required — usually an unpaid invoice or a plan that does not
 * include the Admin REST endpoint).
 */
async function fetchShopifyProductsForSync() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

  if (!domain || domain.includes('your-store')) {
    console.warn('[INVENTORY SYNC] Shopify domain not configured — skipping fetch');
    return [];
  }

  // 1) Admin REST API.
  if (adminToken) {
    try {
      const response = await axios.get(`https://${domain}/admin/api/${apiVersion}/products.json`, {
        headers: { 'X-Shopify-Access-Token': adminToken },
        params: { limit: 250, status: 'active' },
        timeout: 15000,
      });
      const raw = Array.isArray(response?.data?.products) ? response.data.products : [];
      if (raw.length) {
        const products = raw.map(normalizeAdminProduct);
        console.log(`[INVENTORY SYNC] Fetched ${products.length} products via Admin API`);
        return products;
      }
    } catch (error) {
      const status = error?.response?.status;
      if (status === 402) {
        console.warn(
          '[INVENTORY SYNC] Admin API returned 402 (Payment Required / plan limitation). Falling back to Storefront API.'
        );
      } else {
        console.error('[INVENTORY SYNC] Shopify Admin fetch failed:', error.message);
      }
    }
  }

  // 2) Storefront GraphQL fallback (works on all plans).
  if (process.env.SHOPIFY_STOREFRONT_TOKEN) {
    try {
      const { products } = await fetchStorefrontProductsForSync();
      return products;
    } catch (error) {
      console.error('[INVENTORY SYNC] Storefront API fallback failed:', error.message);
    }
  }

  return [];
}

async function runInventorySync() {
  console.log('[INVENTORY SYNC] Starting...');

  try {
    console.log('[INVENTORY SYNC] Syncing catalog structure...');
    await syncCatalog();

    console.log('[INVENTORY SYNC] Fetching product list...');
    const products = await fetchShopifyProductsForSync();

    console.log(`[INVENTORY SYNC] Updating inventory for ${products.length} products...`);

    let updated = 0;
    for (const product of products) {
      const variants = Array.isArray(product?.variants) ? product.variants : [];
      // quantityAvailable may be null when the Storefront token lacks the
      // inventory scope — never fabricate counts; fall back to availableForSale.
      const totalInventory = variants.reduce((sum, v) => {
        const qty = v?.quantityAvailable;
        return sum + (Number.isFinite(qty) && qty > 0 ? qty : 0);
      }, 0);
      const available =
        totalInventory > 0 || variants.some((v) => v?.availableForSale === true);

      if (product.id) {
        await updateProductInventory(String(product.id), {
          availableForSale: available,
          totalInventory,
          variants: variants.map((v) => ({
            id: String(v.id),
            title: v.title,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            availableForSale: v.availableForSale !== false,
            quantityAvailable: v.quantityAvailable != null ? Number(v.quantityAvailable) : null,
            selectedOptions: Array.isArray(v.selectedOptions) ? v.selectedOptions : [],
          })),
        });
        updated++;
      }
    }

    console.log(`[INVENTORY SYNC] Updated ${updated} products`);

    // ── New-product push pipeline ───────────────────────────────────────
    // detectNewProducts() inserts genuinely new products into the products
    // table (idempotent). The FIRST successful full catalog population is
    // treated as a BASELINE — no "new" notifications fire for pre-existing
    // products. Then sendNewProductCampaign fires pushes for anything truly
    // discovered after baseline.
    try {
      const newProducts = await detectNewProducts(products);
      if (newProducts.length) {
        console.log(`[INVENTORY SYNC] Detected ${newProducts.length} genuinely new product(s)`);
        const result = await sendNewProductCampaign({ products: newProducts });
        console.log(
          `[INVENTORY SYNC] new_product campaign result | sent: ${result.sent} failed: ${result.failed} skipped: ${result.skipped}`
        );
      } else {
        console.log('[INVENTORY SYNC] No genuinely new products — no push campaign fired');
      }
    } catch (campaignError) {
      // A campaign failure must never break the sync itself.
      console.error('[INVENTORY SYNC] new-product campaign error:', campaignError.message);
    }

    console.log('[INVENTORY SYNC] Completed');
  } catch (error) {
    console.error('[INVENTORY SYNC] Failed:', error.message);
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────
// NOOD_INVENTORY_SYNC_DISABLED=1 disables the auto-scheduler (used by tests).
if (process.env.NOOD_INVENTORY_SYNC_DISABLED !== '1') {
  // Run on startup (after a short delay so the server is up first).
  setTimeout(() => {
    console.log('[STARTUP] Running initial inventory sync...');
    runInventorySync();
  }, 15000);

  // Schedule every 30 minutes.
  setInterval(() => {
    console.log('[JOB] Running inventory sync...');
    runInventorySync();
  }, INVENTORY_SYNC_INTERVAL_MINUTES * 60 * 1000);
}

module.exports = {
  runInventorySync,
  fetchShopifyProductsForSync,
  fetchStorefrontProductsForSync,
  normalizeAdminProduct,
  normalizeStorefrontProduct,
};
