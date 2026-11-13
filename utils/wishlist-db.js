/**
 * Wishlist persistence — server-side wishlist storage.
 *
 * The app syncs wishlist items here (via POST /api/wishlist/sync) so the
 * backend can compute real wishlist triggers (price-drop, restock,
 * low-stock) against the products table — never trusting client-only state
 * for financial/availability notifications.
 *
 * Table: wishlist_items
 *   user_id, email, handle, product_id, variant_id, title, image,
 *   price (snapshot), currency, size, color,
 *   notified_price (last price we alerted at — for dedupe),
 *   notified_restock / notified_low_stock (condition dedupe flags)
 */

const { supabaseAdmin } = require('./supabase-admin');

async function upsertWishlistItem(entry) {
  const handle = String(entry.handle || '').trim();
  if (!handle) return null;

  const row = {
    user_id: entry.userId || null,
    email: entry.email || null,
    handle,
    product_id: entry.productId || null,
    variant_id: entry.variantId || null,
    title: entry.title || null,
    image: entry.image || null,
    price: entry.price != null ? Number(entry.price) : null,
    currency: entry.currency || 'USD',
    size: entry.size || null,
    color: entry.color || null,
    updated_at: new Date().toISOString(),
  };

  if (supabaseAdmin) {
    try {
      // Unique on (user_id, handle) — upsert by that key.
      const { data, error } = await supabaseAdmin
        .from('wishlist_items')
        .upsert(row, { onConflict: 'user_id,handle' })
        .select('id')
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (error) {
      console.error('[WISHLIST-DB] upsert failed:', error.message);
      return null;
    }
  }
  return null;
}

async function replaceWishlistForUser(userId, items) {
  if (!userId) return { synced: 0 };
  if (!supabaseAdmin) return { synced: 0, source: 'unconfigured' };

  let synced = 0;
  try {
    // Delete existing rows for this user, then insert fresh.
    const { error: delError } = await supabaseAdmin
      .from('wishlist_items')
      .delete()
      .eq('user_id', userId);
    if (delError) throw delError;

    for (const item of items) {
      const row = {
        user_id: userId,
        email: item.email || null,
        handle: String(item.handle || item.id || '').trim(),
        product_id: item.productId || null,
        variant_id: item.variantId || null,
        title: item.title || null,
        image: item.image || null,
        price: item.price != null ? Number(item.price) : null,
        currency: item.currency || 'USD',
        size: item.size || null,
        color: item.color || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (!row.handle) continue;
      const { error } = await supabaseAdmin.from('wishlist_items').insert(row);
      if (error) {
        // Unique conflict (user_id, handle) — update instead.
        if (String(error.message).includes('duplicate key')) {
          await supabaseAdmin
            .from('wishlist_items')
            .update({ ...row, created_at: undefined })
            .eq('user_id', userId)
            .eq('handle', row.handle);
          synced += 1;
        }
        continue;
      }
      synced += 1;
    }
    return { synced };
  } catch (error) {
    console.error('[WISHLIST-DB] replace failed:', error.message);
    return { synced, error: error.message };
  }
}

/** Load wishlist rows for a user (by user_id or email). */
async function getWishlistForUser({ userId, email }) {
  if (!supabaseAdmin) return [];
  try {
    let query = supabaseAdmin.from('wishlist_items').select('*');
    if (userId) {
      query = query.eq('user_id', userId);
    } else if (email) {
      query = query.eq('email', String(email).toLowerCase());
    } else {
      return [];
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('[WISHLIST-DB] get failed:', error.message);
    return [];
  }
}

/** Update a single wishlist row's notification flags (dedupe state). */
async function updateWishlistFlags(id, updates) {
  if (!id || !supabaseAdmin) return;
  try {
    await supabaseAdmin
      .from('wishlist_items')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);
  } catch (error) {
    console.error('[WISHLIST-DB] flag update failed:', error.message);
  }
}

/** Load ALL wishlist rows (for the trigger job scan). */
async function getAllWishlistItems(limit = 5000) {
  if (!supabaseAdmin) return [];
  try {
    const { data, error } = await supabaseAdmin
      .from('wishlist_items')
      .select('*')
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('[WISHLIST-DB] list failed:', error.message);
    return [];
  }
}

module.exports = {
  upsertWishlistItem,
  replaceWishlistForUser,
  getWishlistForUser,
  updateWishlistFlags,
  getAllWishlistItems,
};
