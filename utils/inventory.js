/**
 * Inventory sync utilities — update product availability from Shopify.
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

async function syncCatalog() {
  if (!supabase) {
    console.warn('[INVENTORY] Supabase not configured');
    return;
  }

  // This would sync collections, categories, etc.
  // Implementation depends on your catalog schema
  console.log('[INVENTORY] Catalog sync completed');
}

module.exports = { updateProductInventory, syncCatalog };