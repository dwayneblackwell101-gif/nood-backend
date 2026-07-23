const { safeString } = require('./transform');

const SUPPORTED_SCHEMA_VERSION = safeString(process.env.CATALOG_SCHEMA_VERSION, '1');

function error(message, code = 'catalog_validation_failed') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeHandle(value) {
  return safeString(value).toLowerCase();
}

async function validateCatalogVersion(cache, versionId, options = {}) {
  if (!cache || typeof cache.getCatalogVersionMeta !== 'function') {
    throw error('Catalog cache does not support version validation.', 'catalog_versioning_unavailable');
  }

  const meta = await cache.getCatalogVersionMeta(versionId);
  if (!meta?.versionId) throw error('Catalog version metadata is missing.', 'missing_metadata');
  if (safeString(meta.schemaVersion, SUPPORTED_SCHEMA_VERSION) !== SUPPORTED_SCHEMA_VERSION) {
    throw error('Catalog schema version is unsupported.', 'unsupported_schema');
  }
  if (options.requireComplete !== false && meta.hasNextPage !== false) {
    throw error('Catalog sync pagination is incomplete.', 'incomplete_pagination');
  }
  if (safeString(meta.status) === 'failed') {
    throw error('Catalog version has fatal sync errors.', 'failed_sync');
  }

  const products = await cache.getAllProductsForVersion(versionId);
  const collections = await cache.getAllCollectionsForVersion(versionId);
  const productCount = products.length;
  const collectionCount = collections.length;
  if (Number(meta.productCount || 0) !== productCount) {
    throw error('Catalog product count does not match metadata.', 'product_count_mismatch');
  }
  if (Number(meta.collectionCount || 0) !== collectionCount) {
    throw error('Catalog collection count does not match metadata.', 'collection_count_mismatch');
  }

  const ids = new Set();
  const handles = new Set();
  for (const product of products) {
    if (!product?.id || !product?.handle) throw error('Catalog product is missing id or handle.', 'malformed_product');
    if (ids.has(String(product.id))) throw error('Duplicate product ID found.', 'duplicate_product_id');
    ids.add(String(product.id));
    const handle = normalizeHandle(product.handle);
    if (handles.has(handle)) throw error('Duplicate product handle found.', 'duplicate_product_handle');
    handles.add(handle);
    const variants = product?.variants?.edges || [];
    if (!Array.isArray(variants)) throw error('Product variants are malformed.', 'malformed_variants');
    for (const edge of variants) {
      const price = edge?.node?.price?.amount;
      const currency = edge?.node?.price?.currencyCode || 'USD';
      if (price !== undefined && Number.isNaN(Number(price))) throw error('Product variant price is malformed.', 'malformed_price');
      if (currency !== 'USD') throw error('Product variant currency is unsupported.', 'unsupported_currency');
    }
    if (product.images && !Array.isArray(product.images.edges)) {
      throw error('Product images structure is malformed.', 'malformed_images');
    }
  }

  for (const collection of collections) {
    if (!collection?.handle) throw error('Catalog collection is missing handle.', 'malformed_collection');
    const refs = Array.isArray(collection.productHandles) ? collection.productHandles : [];
    for (const handle of refs) {
      if (!handles.has(normalizeHandle(handle))) {
        throw error('Collection references a missing product handle.', 'missing_collection_product');
      }
    }
  }

  const activeMeta = typeof cache.getActiveCatalogMeta === 'function' ? await cache.getActiveCatalogMeta() : null;
  const activeCount = Number(activeMeta?.productCount || 0);
  const minProductCount = Number(process.env.CATALOG_MIN_PRODUCT_COUNT || 0);
  if (productCount < minProductCount) {
    throw error('Catalog product count is below configured minimum.', 'minimum_product_count');
  }
  const maxDropPercent = Number(process.env.CATALOG_MAX_COUNT_DROP_PERCENT || 50);
  if (activeCount > 0 && maxDropPercent >= 0) {
    const dropPercent = ((activeCount - productCount) / activeCount) * 100;
    if (dropPercent > maxDropPercent && !options.allowCountDropOverride) {
      throw error('Catalog product count drop exceeds configured safeguard.', 'suspicious_count_drop');
    }
  }

  return {
    ok: true,
    versionId,
    productCount,
    collectionCount,
    schemaVersion: meta.schemaVersion,
    validatedAt: new Date().toISOString(),
  };
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  validateCatalogVersion,
};
