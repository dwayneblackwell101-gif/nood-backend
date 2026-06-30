const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createCatalogCache } = require('../catalog/cache/redis-cache');
const {
  COLLECTION_HANDLE_ALIASES,
  applyCollectionHandleAliases,
} = require('../catalog/collection-aliases');
const {
  reconcileCollectionProductHandlesFromProducts,
} = require('../catalog/sync');

const REQUIRED_HANDLES = ['men', 'women', 'kids', 'shoes', 'electronics'];

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getBaseUrl() {
  const configured = trim(process.env.BACKEND_BASE_URL);
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const port = trim(process.env.PORT) || '3000';
  const host = trim(process.env.LOCAL_IP) || '127.0.0.1';
  return `http://${host}:${port}`;
}

async function inspectCollections(cache) {
  const productCount =
    typeof cache.getProductCount === 'function' ? await cache.getProductCount() : 0;
  const collectionCount =
    typeof cache.getCollectionCount === 'function' ? await cache.getCollectionCount() : 0;
  const meta = await cache.getMeta();

  console.log('[NOOD catalog rebuild] inspect', {
    driver: typeof cache.driver === 'function' ? cache.driver() : 'unknown',
    productCount,
    collectionCount,
    lastSyncAt: meta?.lastSyncAt || null,
  });

  const collections =
    typeof cache.getAllCollections === 'function' ? await cache.getAllCollections() : [];
  const handles = collections.map((entry) => entry.handle).filter(Boolean).sort();
  console.log('[NOOD catalog rebuild] collection handles sample', handles.slice(0, 40).join(', '));

  for (const handle of REQUIRED_HANDLES) {
    const direct = await cache.getCollection(handle);
    const canonical = COLLECTION_HANDLE_ALIASES[handle];
    const canonicalCollection = canonical ? await cache.getCollection(canonical) : null;
    console.log('[NOOD catalog rebuild] required handle', {
      handle,
      direct: direct ? direct.productHandles?.length || 0 : null,
      canonical: canonical || null,
      canonicalCount: canonicalCollection ? canonicalCollection.productHandles?.length || 0 : null,
    });
  }

  const fuzzyTargets = ['men', 'mens', 'clothing', 'women', 'kids', 'shoes', 'electronics', 'sneakers'];
  for (const target of fuzzyTargets) {
    const matches = handles.filter((handle) => handle.toLowerCase().includes(target));
    if (matches.length) {
      console.log('[NOOD catalog rebuild] fuzzy', { target, matches });
    }
  }
}

async function rebuildCollections(cache) {
  const reconcile = await reconcileCollectionProductHandlesFromProducts(cache);
  const aliases = await applyCollectionHandleAliases(cache);
  console.log('[NOOD catalog rebuild] reconcile complete', reconcile);
  console.log('[NOOD catalog rebuild] aliases complete', aliases);
  await inspectCollections(cache);
}

async function verifyEndpoints() {
  const baseUrl = getBaseUrl();
  console.log('[NOOD catalog rebuild] verifying endpoints', { baseUrl });

  for (const handle of REQUIRED_HANDLES) {
    const url = `${baseUrl}/api/catalog/collections/${encodeURIComponent(handle)}/products?limit=20`;
    try {
      const response = await fetch(url);
      const body = await response.json();
      const count = body?.data?.collectionByHandle?.products?.edges?.length || 0;
      console.log('[NOOD catalog rebuild] endpoint', {
        handle,
        status: response.status,
        source: body?.source || null,
        count,
        message: body?.message || null,
      });
      if (!response.ok || count <= 0) {
        throw new Error(`Endpoint failed for ${handle}: status=${response.status} count=${count}`);
      }
    } catch (error) {
      console.error('[NOOD catalog rebuild] endpoint failed', {
        handle,
        error: String(error?.message || error),
      });
      throw error;
    }
  }
}

async function main() {
  const command = trim(process.argv[2]) || 'inspect';
  const forceJson = trim(process.argv[3]) === '--json' || process.env.NOOD_CATALOG_FORCE_JSON === '1';

  if (forceJson) {
    process.env.NOOD_CATALOG_FORCE_JSON = '1';
  }

  const cache = await createCatalogCache();

  if (command === 'inspect') {
    await inspectCollections(cache);
    return;
  }

  if (command === 'rebuild') {
    await rebuildCollections(cache);
    return;
  }

  if (command === 'verify') {
    await verifyEndpoints();
    return;
  }

  if (command === 'rebuild-and-verify') {
    await rebuildCollections(cache);
    await verifyEndpoints();
    return;
  }

  throw new Error(
    `Unknown command "${command}". Use inspect, rebuild, verify, or rebuild-and-verify.`
  );
}

void main().catch((error) => {
  console.error('[NOOD catalog rebuild] failed', error?.message || error);
  process.exit(1);
});