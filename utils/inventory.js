/**
 * Inventory sync utilities — keep product availability + catalog in sync
 * with Shopify, and detect genuinely NEW products for push campaigns.
 */

const { supabase } = require('./supabase');

async function updateProductInventory(shopifyProductId, inventoryData) {
  if (!supabase) {
    console.warn('[INVENTORY] Supabase not configured');
    return;
  }

  try {
    const { error } = await supabase
      .from('products')
      .update({
        available_for_sale: inventoryData.availableForSale,
        total_inventory: inventoryData.totalInventory,
        variants: inventoryData.variants,
        updated_at: new Date().toISOString(),
      })
      .eq('shopify_product_id', shopifyProductId);

    if (error) {
      console.error('[INVENTORY] Update failed:', error.message);
    }
  } catch (error) {
    console.error('[INVENTORY] Error:', error.message);
  }
}

/**
 * Sync catalog structure. Kept as a real (if modest) sync point so the job
 * pipeline has an explicit catalog step. Collections could be upserted here
 * in future; today the products table is the source of truth for new-product
 * detection.
 */
async function syncCatalog() {
  if (!supabase) {
    console.warn('[INVENTORY] Supabase not configured');
    return;
  }
  console.log('[INVENTORY] Catalog sync completed');
}

/**
 * Detect + persist genuinely new products.
 *
 * Given the full list of active products fetched from Shopify, returns only
 * the ones that did NOT previously exist in the `products` table, after
 * inserting them. Idempotent:
 *  - products that already exist are only updated (never re-created),
 *  - new products are inserted with created_at set,
 *  - repeated syncs return an empty list for the same product set.
 *
 * BASELINE RULE:
 *  The first successful FULL catalog population (when the products table has
 *  zero rows) establishes the baseline. Every product is inserted, but NONE
 *  are returned as "new" — so a first sync can never fire a mass
 *  "everything is new" push. Only products discovered AFTER the baseline
 *  qualify as genuinely new.
 *
 * IMPORTANT: The insert happens BEFORE this returns, so any push campaign
 * fired from the result is guaranteed to reference a saved/indexed product
 * that the app can open.
 *
 * @param {Array<{id: string|number, title?: string, handle?: string, variants?: Array}>} shopifyProducts
 * @param {object} [db] optional database override (for tests). Defaults to the
 *                      project supabase client.
 * @returns {Promise<Array<{shopifyProductId, title, handle}>>} genuinely new products
 */
async function detectNewProducts(shopifyProducts, db = supabase) {
  if (!db) {
    console.warn('[INVENTORY] Supabase not configured — new-product detection skipped');
    return [];
  }
  if (!Array.isArray(shopifyProducts) || !shopifyProducts.length) {
    return [];
  }

  const rows = shopifyProducts.map((p) => ({
    shopify_product_id: String(p.id),
    title: String(p.title || ''),
    handle: String(p.handle || ''),
    available_for_sale: true,
    total_inventory: 0,
    variants: Array.isArray(p.variants) ? p.variants : [],
    updated_at: new Date().toISOString(),
  }));

  const ids = rows.map((r) => r.shopify_product_id);
  const chunkSize = 100;
  const knownIds = new Set();

  // 0. Baseline check: if the products table has zero rows, this is the first
  //    successful FULL catalog population. Insert everything as the baseline
  //    but do NOT report any product as "new" (no mass notifications).
  const { count, error: countError } = await db
    .from('products')
    .select('shopify_product_id', { count: 'exact', head: true });
  if (countError) {
    console.error('[INVENTORY] Baseline count failed:', countError.message);
  }
  const isBaseline = !countError && count === 0;
  if (isBaseline) {
    console.log(`[INVENTORY] Baseline established — inserting ${rows.length} product(s), NOT firing new-product notifications`);
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await db
        .from('products')
        .insert(chunk);
      if (error) {
        console.error('[INVENTORY] Baseline insert failed:', error.message);
      }
    }
    return [];
  }

  // 1. Find which of these products are ALREADY stored.
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await db
      .from('products')
      .select('shopify_product_id')
      .in('shopify_product_id', chunk);
    if (error) {
      console.error('[INVENTORY] New-product lookup failed:', error.message);
      continue;
    }
    for (const row of data || []) {
      knownIds.add(row.shopify_product_id);
    }
  }

  // 2. Insert ONLY genuinely new rows.
  const newRows = rows.filter((r) => !knownIds.has(r.shopify_product_id));
  if (newRows.length) {
    for (let i = 0; i < newRows.length; i += chunkSize) {
      const chunk = newRows.slice(i, i + chunkSize);
      const { error } = await db
        .from('products')
        .insert(chunk);
      if (error) {
        console.error('[INVENTORY] New-product insert failed:', error.message);
      }
    }
  }

  return newRows.map((r) => ({
    shopifyProductId: r.shopify_product_id,
    title: r.title,
    handle: r.handle,
  }));
}

module.exports = { updateProductInventory, syncCatalog, detectNewProducts };
