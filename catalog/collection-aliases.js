const { safeString } = require('./transform');

/** App-facing collection handles mapped to canonical Shopify cache handles. */
const COLLECTION_HANDLE_ALIASES = {
  men: 'clothing',
  mens: 'clothing',
};

function normalizeCollectionLookupHandle(value) {
  return safeString(value).toLowerCase().trim();
}

function resolveCanonicalCollectionHandle(handle) {
  const key = normalizeCollectionLookupHandle(handle);
  if (!key) {
    return '';
  }
  return COLLECTION_HANDLE_ALIASES[key] || key;
}

function buildAliasCollectionRecord(canonicalCollection, aliasHandle) {
  const canonicalHandle = safeString(canonicalCollection?.handle);
  const alias = safeString(aliasHandle);
  if (!canonicalHandle || !alias) {
    return null;
  }

  return {
    ...canonicalCollection,
    handle: alias,
    canonicalHandle,
    title: canonicalCollection.title || alias,
    productHandles: Array.isArray(canonicalCollection.productHandles)
      ? [...canonicalCollection.productHandles]
      : [],
    updatedAt: new Date().toISOString(),
  };
}

async function applyCollectionHandleAliases(cache) {
  if (typeof cache.getCollection !== 'function' || typeof cache.setCollection !== 'function') {
    return { applied: 0, skipped: 0 };
  }

  let applied = 0;
  let skipped = 0;

  for (const [alias, canonical] of Object.entries(COLLECTION_HANDLE_ALIASES)) {
    const canonicalCollection = await cache.getCollection(canonical);
    if (!canonicalCollection) {
      skipped += 1;
      console.log('[NOOD catalog] collection alias skipped missing canonical', {
        alias,
        canonical,
      });
      continue;
    }

    const aliasCollection = buildAliasCollectionRecord(canonicalCollection, alias);
    if (!aliasCollection) {
      skipped += 1;
      continue;
    }

    await cache.setCollection(alias, aliasCollection);
    applied += 1;
    console.log('[NOOD catalog] collection alias applied', {
      alias,
      canonical,
      productHandles: aliasCollection.productHandles.length,
    });
  }

  if (applied > 0 && typeof cache.persist === 'function') {
    await cache.persist();
  }

  return { applied, skipped };
}

module.exports = {
  COLLECTION_HANDLE_ALIASES,
  normalizeCollectionLookupHandle,
  resolveCanonicalCollectionHandle,
  buildAliasCollectionRecord,
  applyCollectionHandleAliases,
};