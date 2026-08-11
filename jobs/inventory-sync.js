/**
 * Inventory sync — periodic job to keep local product inventory in sync
 * with Shopify. Runs every 30 minutes using setInterval (no external deps).
 *
 * New-product detection:
 *   The job fetches the full active product list from Shopify Admin, then
 *   INSERTS any product whose shopify_product_id is not already in the
 *   `products` table. Inserts happen BEFORE the new-product campaign fires,
 *   so the product is saved/indexed and can be opened in the app before any
 *   push is sent. Repeated syncs never re-insert (upsert-on-conflict) and
 *   never re-fire (campaign dedupe keys are per product/batch + day).
 */

const axios = require('axios');
const { updateProductInventory, syncCatalog, detectNewProducts } = require('../utils/inventory');
const { sendNewProductCampaign } = require('./notification-campaigns');

const INVENTORY_SYNC_INTERVAL_MINUTES = 30;

async function fetchShopifyProductsForSync() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!domain || !token || domain.includes('your-store')) {
    console.warn('[INVENTORY SYNC] Shopify Admin credentials not configured — skipping fetch');
    return [];
  }

  try {
    const response = await axios.get(`https://${domain}/admin/api/2026-04/products.json`, {
      headers: { 'X-Shopify-Access-Token': token },
      params: { limit: 250, status: 'active' },
      timeout: 15000,
    });
    return Array.isArray(response?.data?.products) ? response.data.products : [];
  } catch (error) {
    console.error('[INVENTORY SYNC] Shopify fetch failed:', error.message);
    return [];
  }
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
      const totalInventory = variants.reduce((sum, v) => sum + Number(v.inventory_quantity || 0), 0);
      const available = totalInventory > 0;

      if (product.id) {
        await updateProductInventory(String(product.id), {
          availableForSale: available,
          totalInventory,
          variants: variants.map((v) => ({
            id: String(v.id),
            availableForSale: Number(v.inventory_quantity || 0) > 0,
            inventoryQuantity: Number(v.inventory_quantity || 0),
          })),
        });
        updated++;
      }
    }

    console.log(`[INVENTORY SYNC] Updated ${updated} products`);

    // ── New-product push pipeline ───────────────────────────────────────
    // detectNewProducts() inserts genuinely new products into the products
    // table (idempotent). Then sendNewProductCampaign fires the pushes.
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

module.exports = { runInventorySync };
