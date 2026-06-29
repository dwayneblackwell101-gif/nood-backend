import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BackendRequestCancelledError,
  getBackendJson,
  isBackendAbortError,
} from './backend';
import {
  catalogCacheDebugSummary,
  emergencyPruneCatalogStorage,
  isStorageFullError,
} from './catalog-cache';
import { CATALOG_CACHE_DEBUG } from './debug-flags';
const PRODUCT_FEED_TIMEOUT_MS = 25000;
const COLLECTION_PRODUCTS_TIMEOUT_MS = 25000;
const SEARCH_CATALOG_TIMEOUT_MS = 30000;

let homeProductFeedSession = 0;
let activeHomeProductFeedController: AbortController | null = null;
const lastSuccessfulProductFeedPages = new Map<string, CatalogJson>();
const MAX_MEMORY_PRODUCT_FEED_PAGES = 8;

function rememberProductFeedPage(cacheKey: string, payload: CatalogJson) {
  if (!cacheKey) return;
  if (lastSuccessfulProductFeedPages.has(cacheKey)) {
    lastSuccessfulProductFeedPages.delete(cacheKey);
  }
  lastSuccessfulProductFeedPages.set(cacheKey, payload);
  while (lastSuccessfulProductFeedPages.size > MAX_MEMORY_PRODUCT_FEED_PAGES) {
    const oldestKey = lastSuccessfulProductFeedPages.keys().next().value;
    if (!oldestKey) break;
    lastSuccessfulProductFeedPages.delete(oldestKey);
  }
}

const CATALOG_LOCAL_CACHE_PREFIX = 'NOOD_CATALOG_LOCAL_V2_SLIM';
const LEGACY_CATALOG_CACHE_PREFIX = 'NOOD_CATALOG_LOCAL_V1';
const CATALOG_CACHE_INDEX_KEY = `${CATALOG_LOCAL_CACHE_PREFIX}:__index__`;
export const CATALOG_BACKEND_VERSION_STORAGE_KEY = 'NOOD_CATALOG_BACKEND_VERSION';
const CATALOG_BACKEND_VERSION_KEY = CATALOG_BACKEND_VERSION_STORAGE_KEY;
const HOME_PRODUCTS_CACHE_KEY = 'NOOD_HOME_PRODUCTS_CACHE_V2';
const SEARCH_PRODUCTS_CACHE_KEY = 'NOOD_SEARCH_PRODUCTS_CACHE_V1';
const CATEGORIES_CACHE_KEY = 'NOOD_CATEGORIES_CACHE_V19_MEN_EXPLICIT';
const CATEGORIES_IMAGE_CACHE_KEY = 'NOOD_CATEGORIES_IMAGE_URLS_V20';
const CATEGORY_TRENDING_CACHE_KEY = 'NOOD_CATEGORY_TRENDING_CACHE_V1';
const LEGACY_CATEGORIES_CACHE_KEYS = [
  'NOOD_CATEGORIES_CACHE_V17_SHOPIFY_MENU_AUTO',
  'NOOD_CATEGORIES_CACHE_V18_VERSIONED',
];
const COLLECTION_PRODUCTS_CACHE_PREFIX = 'NOOD_COLLECTION_PRODUCTS_CACHE_V2';
const CATALOG_VERSION_CHECK_TTL_MS = 8000;
const CATALOG_VERSION_REQUEST_TIMEOUT_MS = 5000;

type CatalogFreshnessScope =
  | 'launch'
  | 'home-open'
  | 'pull'
  | 'category'
  | 'search'
  | 'product-detail'
  | 'collection'
  | 'fetch'
  | 'home-feed';

let catalogFreshnessInFlight: Promise<boolean> | null = null;

type CatalogVersionInfo = {
  catalogVersion: number;
  catalogUpdatedAt: string | null;
  lastSyncAt: string | null;
};

let cachedBackendCatalogVersion: CatalogVersionInfo | null = null;
let lastCatalogVersionCheckAt = 0;

let legacyCatalogCleanupStarted = false;

const MAX_CACHE_ENTRIES = 20;
const MAX_PRODUCTS_PER_LIST = 48;
const MAX_ENTRY_BYTES = 300_000;
const MAX_TOTAL_CACHE_BYTES = 2_000_000;
const MAX_PRODUCT_DETAIL_IMAGES = 30;
const MAX_PRODUCT_DETAIL_VARIANTS = 250;
const MAX_PRODUCT_DETAIL_HTML = 12_000;

type CatalogJson = {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: string }>;
  source?: string;
  success?: boolean;
};

type CatalogFetchOptions = {
  cacheKey?: string;
  mixKey?: string | number;
  skipLocalCache?: boolean;
  timeoutMs?: number;
};

function resolveCatalogRequestTimeoutMs(path: string, override?: number) {
  if (override && override > 0) {
    return override;
  }

  const isProductFeed =
    path.startsWith('/api/catalog/products?') && !path.includes('/api/catalog/products/');

  if (isProductFeed) {
    return PRODUCT_FEED_TIMEOUT_MS;
  }

  if (path.includes('/api/catalog/collections/') && path.includes('/products')) {
    return COLLECTION_PRODUCTS_TIMEOUT_MS;
  }

  if (path.includes('/api/catalog/search')) {
    return SEARCH_CATALOG_TIMEOUT_MS;
  }

  if (
    path.startsWith('/api/catalog/collections') ||
    path.startsWith('/api/catalog/menus/')
  ) {
    return 12000;
  }

  return 20000;
}

type CacheIndexEntry = {
  key: string;
  path: string;
  ts: number;
  bytes: number;
};

function catalogCacheLog(message: string, detail?: Record<string, unknown>) {
  if (CATALOG_CACHE_DEBUG) {
    console.log(message, detail);
    return;
  }

  if (
    !__DEV__ &&
    (message.includes('skipped/cleaned') || message.includes('[NOOD app catalog]'))
  ) {
    console.log(message, detail);
  }
}

export async function fetchBackendCatalogVersion(
  force = false
): Promise<CatalogVersionInfo | null> {
  if (
    !force &&
    cachedBackendCatalogVersion &&
    Date.now() - lastCatalogVersionCheckAt < CATALOG_VERSION_CHECK_TTL_MS
  ) {
    return cachedBackendCatalogVersion;
  }

  try {
    const payload = (await getBackendJson('/api/catalog/version', {
      catalog: true,
      timeoutMs: CATALOG_VERSION_REQUEST_TIMEOUT_MS,
    })) as Record<string, unknown>;

    cachedBackendCatalogVersion = {
      catalogVersion: Number(payload?.catalogVersion) || 0,
      catalogUpdatedAt: String(payload?.catalogUpdatedAt || '') || null,
      lastSyncAt: String(payload?.lastSyncAt || '') || null,
    };
    lastCatalogVersionCheckAt = Date.now();
    return cachedBackendCatalogVersion;
  } catch (error) {
    catalogCacheLog('[NOOD app catalog] version check failed', {
      error: String((error as any)?.message || error),
    });
    return null;
  }
}

export async function getStoredCatalogVersion(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(CATALOG_BACKEND_VERSION_KEY);
    return Number(raw) || 0;
  } catch {
    return 0;
  }
}

export async function setStoredCatalogVersion(version: number) {
  await AsyncStorage.setItem(CATALOG_BACKEND_VERSION_KEY, String(Math.max(0, Number(version) || 0)));
}

export async function hasBackendCatalogChanged(force = false): Promise<boolean> {
  const backend = await fetchBackendCatalogVersion(force);
  if (!backend) {
    return false;
  }

  const stored = await getStoredCatalogVersion();
  return backend.catalogVersion > stored;
}

async function invalidateStaleCatalogCaches() {
  const index = await readCacheIndex();
  const keysToRemove = index
    .filter((entry) => {
      const path = entry.path;
      if (path.includes('/api/catalog/products?')) return true;
      if (path.includes('/api/catalog/search')) return true;
      if (path.includes('/collections/') && path.includes('/products')) return true;
      if (
        path.includes('/api/catalog/products/') &&
        !path.includes('recommendations')
      ) {
        return true;
      }
      return false;
    })
    .map((entry) => entry.key);

  if (keysToRemove.length) {
    await removeCatalogCacheKeys(keysToRemove);
    const nextIndex = index.filter((entry) => !keysToRemove.includes(entry.key));
    await writeCacheIndex(nextIndex);
  }

  lastSuccessfulProductFeedPages.clear();

  try {
    const { clearProductDetailCache } = await import('./product-data');
    await clearProductDetailCache();
  } catch {
    // ignore product detail cache clear errors
  }

  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const auxiliaryKeys = [
      HOME_PRODUCTS_CACHE_KEY,
      SEARCH_PRODUCTS_CACHE_KEY,
      CATEGORIES_CACHE_KEY,
      CATEGORY_TRENDING_CACHE_KEY,
      ...LEGACY_CATEGORIES_CACHE_KEYS,
      ...allKeys.filter((key) => key.startsWith(`${COLLECTION_PRODUCTS_CACHE_PREFIX}_`)),
    ];
    await AsyncStorage.multiRemove([...new Set(auxiliaryKeys)]);
  } catch (error) {
    catalogCacheLog('[NOOD app catalog] auxiliary cache clear failed', {
      error: String((error as any)?.message || error),
    });
  }

  console.log('[NOOD app catalog] local cache refreshed', {
    removedEntries: keysToRemove.length,
  });
}

async function handleCatalogVersionChange(
  scope: CatalogFreshnessScope,
  versions: { backendVersion: number; storedVersion: number; catalogUpdatedAt?: string | null }
) {
  console.log('[NOOD app catalog] backend version changed', {
    scope,
    backendVersion: versions.backendVersion,
    storedVersion: versions.storedVersion,
    catalogUpdatedAt: versions.catalogUpdatedAt ?? null,
  });

  await invalidateStaleCatalogCaches();
  await setStoredCatalogVersion(versions.backendVersion);
}

async function runCatalogVersionCheck(
  scope: CatalogFreshnessScope,
  options: { force?: boolean; refreshOnChange?: boolean; logCheck?: boolean } = {}
): Promise<boolean> {
  const force = Boolean(options.force);
  const refreshOnChange = options.refreshOnChange !== false;
  const logCheck = options.logCheck !== false;

  if (logCheck) {
    console.log('[NOOD app catalog] checking backend version', { scope });
  }

  const backend = await fetchBackendCatalogVersion(force);
  const stored = await getStoredCatalogVersion();
  const backendVersion = backend?.catalogVersion ?? stored;

  if (!backend || backendVersion <= stored) {
    if (logCheck) {
      console.log('[NOOD app catalog] version unchanged', {
        scope,
        backendVersion,
        storedVersion: stored,
      });
    }
    return false;
  }

  if (refreshOnChange) {
    await handleCatalogVersionChange(scope, {
      backendVersion,
      storedVersion: stored,
      catalogUpdatedAt: backend.catalogUpdatedAt,
    });
  }

  return true;
}

export async function ensureCatalogFreshness(
  scope: CatalogFreshnessScope = 'launch'
): Promise<boolean> {
  if (catalogFreshnessInFlight) {
    return catalogFreshnessInFlight;
  }

  catalogFreshnessInFlight = runCatalogVersionCheck(scope, {
    force: true,
    refreshOnChange: true,
  }).finally(() => {
    catalogFreshnessInFlight = null;
  });

  return catalogFreshnessInFlight;
}

export async function peekCatalogFreshness(
  scope: CatalogFreshnessScope = 'fetch'
): Promise<boolean> {
  return runCatalogVersionCheck(scope, {
    force: false,
    refreshOnChange: true,
    logCheck: false,
  });
}

function buildStorageKey(cacheKey: string) {
  return `${CATALOG_LOCAL_CACHE_PREFIX}:${cacheKey}`;
}

function isCatalogProductListPath(pathname: string) {
  return pathname === '/api/catalog/products' || pathname.endsWith('/api/catalog/products');
}

function normalizeCacheKey(path: string) {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  const search = queryIndex >= 0 ? path.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(search);

  if (params.get('after')) {
    return '';
  }

  if (!isCatalogProductListPath(pathname)) {
    params.delete('mixKey');
  }

  const normalizedSearch = params.toString();
  return normalizedSearch ? `${pathname}?${normalizedSearch}` : pathname;
}

function getCollectionHandleFromPath(path: string) {
  const match = path.match(/\/api\/catalog\/collections\/([^/]+)\/products/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

function getProductHandleFromPath(path: string) {
  const match = path.match(/\/api\/catalog\/products\/([^/?]+)/);
  if (!match?.[1]) return '';
  const value = decodeURIComponent(match[1]);
  if (value === 'recommendations') return '';
  return value;
}

function trimText(value: unknown, maxLength: number) {
  return String(value || '').slice(0, maxLength);
}

function slimVariantNode(node: any) {
  return {
    id: trimText(node?.id, 120),
    title: trimText(node?.title, 80),
    availableForSale: Boolean(node?.availableForSale ?? true),
    quantityAvailable: node?.quantityAvailable ?? null,
    price: node?.price
      ? {
          amount: trimText(node?.price?.amount || '0', 24),
          currencyCode: trimText(node?.price?.currencyCode || 'USD', 8),
        }
      : undefined,
    selectedOptions: Array.isArray(node?.selectedOptions)
      ? node.selectedOptions.slice(0, 6).map((option: any) => ({
          name: trimText(option?.name, 40),
          value: trimText(option?.value, 80),
        }))
      : [],
    image: node?.image?.url
      ? {
          url: trimText(node.image.url, 512),
          altText: trimText(node?.image?.altText, 120),
        }
      : null,
  };
}

function slimListProductNode(node: any, collectionHandle = '') {
  const firstVariant = node?.variants?.edges?.[0]?.node || null;
  const price = node?.priceRange?.minVariantPrice || firstVariant?.price || null;
  const compareAt = node?.compareAtPriceRange?.maxVariantPrice?.amount || null;
  const collectionHandles =
    node?.collections?.edges?.map((edge: any) => edge?.node?.handle).filter(Boolean) || [];
  const matchedCollection = collectionHandle || collectionHandles[0] || 'all';
  const imageUrl = trimText(node?.featuredImage?.url, 512);

  return {
    id: trimText(node?.id, 120),
    title: trimText(node?.title, 200),
    handle: trimText(node?.handle, 160),
    vendor: trimText(node?.vendor, 80),
    productType: trimText(node?.productType, 80),
    description: trimText(node?.description, 240),
    tags: Array.isArray(node?.tags) ? node.tags.slice(0, 8).map((tag: string) => trimText(tag, 40)) : [],
    availableForSale: Boolean(node?.availableForSale ?? firstVariant?.availableForSale ?? true),
    featuredImage: imageUrl
      ? {
          url: imageUrl,
          width: node?.featuredImage?.width ?? null,
          height: node?.featuredImage?.height ?? null,
        }
      : null,
    priceRange: {
      minVariantPrice: {
        amount: trimText(price?.amount || '0', 24),
        currencyCode: trimText(price?.currencyCode || 'USD', 8),
      },
    },
    compareAtPriceRange: compareAt
      ? {
          maxVariantPrice: {
            amount: trimText(compareAt, 24),
            currencyCode: trimText(price?.currencyCode || 'USD', 8),
          },
        }
      : { maxVariantPrice: null },
    collections: {
      edges: [matchedCollection, ...collectionHandles]
        .filter(Boolean)
        .slice(0, 3)
        .map((handle: string, index: number) => ({
          node: {
            id: `${trimText(node?.id, 80)}_${index}`,
            handle,
            title: trimText(handle, 80),
          },
        })),
    },
    variants: {
      edges: (node?.variants?.edges || [])
        .slice(0, MAX_PRODUCT_DETAIL_VARIANTS)
        .map((edge: any) => ({ node: slimVariantNode(edge?.node) })),
    },
  };
}

function slimProductDetail(product: any) {
  const images = (product?.images?.edges || []).slice(0, MAX_PRODUCT_DETAIL_IMAGES).map((edge: any) => ({
    node: {
      url: trimText(edge?.node?.url, 512),
      altText: trimText(edge?.node?.altText, 120),
    },
  }));

  const media = (product?.media?.edges || []).slice(0, MAX_PRODUCT_DETAIL_IMAGES).map((edge: any) => {
    const node = edge?.node || {};
    if (node.__typename === 'Video') {
      const source = node?.sources?.[0];
      return {
        node: {
          __typename: 'Video',
          id: trimText(node.id, 120),
          previewImage: node?.previewImage?.url
            ? { url: trimText(node.previewImage.url, 512) }
            : null,
          sources: source?.url
            ? [{ url: trimText(source.url, 512), mimeType: trimText(source.mimeType, 40) }]
            : [],
        },
      };
    }

    return {
      node: {
        __typename: 'MediaImage',
        id: trimText(node.id, 120),
        image: {
          url: trimText(node?.image?.url, 512),
          altText: trimText(node?.image?.altText, 120),
        },
      },
    };
  });

  const variants = (product?.variants?.edges || [])
    .slice(0, MAX_PRODUCT_DETAIL_VARIANTS)
    .map((edge: any) => ({ node: slimVariantNode(edge?.node) }));

  return {
    id: trimText(product?.id, 120),
    title: trimText(product?.title, 200),
    handle: trimText(product?.handle, 160),
    descriptionHtml: trimText(product?.descriptionHtml, MAX_PRODUCT_DETAIL_HTML),
    vendor: trimText(product?.vendor, 80),
    productType: trimText(product?.productType, 80),
    featuredImage: product?.featuredImage?.url
      ? { url: trimText(product.featuredImage.url, 512) }
      : null,
    images: { edges: images },
    media: { edges: media },
    priceRange: product?.priceRange || {
      minVariantPrice: { amount: '0', currencyCode: 'USD' },
    },
    variants: { edges: variants },
  };
}

function shouldSkipLocalCache(path: string) {
  return (
    path.includes('/api/catalog/menus/') ||
    path.startsWith('/api/catalog/collections?')
  );
}

function slimCatalogPayload(path: string, data: Record<string, unknown>) {
  if (shouldSkipLocalCache(path)) {
    return null;
  }

  const productHandle = getProductHandleFromPath(path);
  if (productHandle) {
    const product = (data as any)?.productByHandle;
    if (!product) return null;
    return { productByHandle: slimProductDetail(product) };
  }

  if (path.includes('/collections/') && path.includes('/products')) {
    const collection = (data as any)?.collectionByHandle;
    if (!collection) return null;
    const collectionHandle = getCollectionHandleFromPath(path);
    const edges = (collection?.products?.edges || []).slice(0, MAX_PRODUCTS_PER_LIST);
    return {
      collectionByHandle: {
        title: trimText(collection?.title, 120),
        products: {
          pageInfo: collection?.products?.pageInfo || { hasNextPage: false, endCursor: null },
          edges: edges.map((edge: any) => ({
            node: slimListProductNode(edge?.node, collectionHandle),
          })),
        },
      },
    };
  }

  if (path.includes('/api/catalog/search') || path.startsWith('/api/catalog/products')) {
    const products = (data as any)?.products;
    if (!products) return null;
    const edges = (products?.edges || []).slice(0, MAX_PRODUCTS_PER_LIST);
    return {
      products: {
        pageInfo: products?.pageInfo || { hasNextPage: false, endCursor: null },
        edges: edges.map((edge: any) => ({
          node: slimListProductNode(edge?.node),
        })),
      },
    };
  }

  return null;
}

async function cleanupLegacyCatalogCache() {
  if (legacyCatalogCleanupStarted) return;
  legacyCatalogCleanupStarted = true;

  try {
    const keys = await AsyncStorage.getAllKeys();
    const legacyKeys = keys.filter((key) => key.startsWith(LEGACY_CATALOG_CACHE_PREFIX));
    if (!legacyKeys.length) return;

    await AsyncStorage.multiRemove(legacyKeys);
    catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
      reason: 'legacy-cache-removed',
      removedEntries: legacyKeys.length,
    });
  } catch (error) {
    catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
      reason: 'legacy-cache-cleanup-failed',
      error: String((error as any)?.message || error),
    });
  }
}

async function readCacheIndex(): Promise<CacheIndexEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(CATALOG_CACHE_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeCacheIndex(entries: CacheIndexEntry[]) {
  await AsyncStorage.setItem(CATALOG_CACHE_INDEX_KEY, JSON.stringify(entries));
}

async function removeCatalogCacheKeys(keys: string[]) {
  if (!keys.length) return;
  await AsyncStorage.multiRemove(keys);
}

async function cleanupCatalogCache(options: { aggressive?: boolean } = {}) {
  const index = await readCacheIndex();
  if (!index.length) return 0;

  const aggressive = Boolean(options.aggressive);
  const sorted = [...index].sort((a, b) => a.ts - b.ts);
  const keysToRemove: string[] = [];
  let remaining = [...sorted];

  if (aggressive) {
    const removeCount = Math.max(6, Math.floor(remaining.length * 0.6));
    remaining.slice(0, removeCount).forEach((entry) => keysToRemove.push(entry.key));
    remaining = remaining.slice(removeCount);
  }

  const totalBytes = remaining.reduce((sum, entry) => sum + entry.bytes, 0);
  let runningTotal = totalBytes;

  while (remaining.length > MAX_CACHE_ENTRIES || runningTotal > MAX_TOTAL_CACHE_BYTES) {
    const oldest = remaining.shift();
    if (!oldest) break;
    keysToRemove.push(oldest.key);
    runningTotal -= oldest.bytes;
  }

  if (!keysToRemove.length) return 0;

  await removeCatalogCacheKeys(keysToRemove);
  const nextIndex = remaining.filter((entry) => !keysToRemove.includes(entry.key));
  await writeCacheIndex(nextIndex);
  catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
    removedEntries: keysToRemove.length,
    remainingEntries: nextIndex.length,
  });
  return keysToRemove.length;
}

async function readLocalCatalogCache(cacheKey: string) {
  if (!cacheKey) return null;

  try {
    const raw = await AsyncStorage.getItem(buildStorageKey(cacheKey));
    if (!raw) return null;
    return JSON.parse(raw) as CatalogJson;
  } catch {
    return null;
  }
}

async function writeLocalCatalogCache(cacheKey: string, path: string, payload: CatalogJson) {
  if (!cacheKey || !payload?.data) return;

  const startedAt = Date.now();
  const beforeIndex = await readCacheIndex();
  const beforeCount = beforeIndex.length;
  let deletedOldRows = 0;
  let errorCode: string | null = null;

  const slimData = slimCatalogPayload(path, payload.data);
  if (!slimData) {
    catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
      reason: 'endpoint-not-cached-locally',
      path,
    });
    return;
  }

  const slimPayload: CatalogJson = {
    data: slimData,
    source: payload.source,
  };
  const serialized = JSON.stringify(slimPayload);
  const bytes = serialized.length;

  if (bytes > MAX_ENTRY_BYTES) {
    catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
      reason: 'entry-too-large',
      path,
      bytes,
      maxBytes: MAX_ENTRY_BYTES,
    });
    return;
  }

  const storageKey = buildStorageKey(cacheKey);

  const persist = async () => {
    deletedOldRows += await cleanupCatalogCache();
    const index = await readCacheIndex();
    const withoutCurrent = index.filter((entry) => entry.key !== storageKey);
    const projectedTotal =
      withoutCurrent.reduce((sum, entry) => sum + entry.bytes, 0) + bytes;

    if (projectedTotal > MAX_TOTAL_CACHE_BYTES || withoutCurrent.length >= MAX_CACHE_ENTRIES) {
      deletedOldRows += await cleanupCatalogCache({ aggressive: true });
    }

    await AsyncStorage.setItem(storageKey, serialized);
    const refreshedIndex = await readCacheIndex();
    const nextIndex = [
      ...refreshedIndex.filter((entry) => entry.key !== storageKey),
      { key: storageKey, path: cacheKey, ts: Date.now(), bytes },
    ]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_CACHE_ENTRIES);

    await writeCacheIndex(nextIndex);
    return nextIndex.length;
  };

  try {
    const afterCount = await persist();
    catalogCacheDebugSummary({
      scope: 'catalog-local',
      beforeCount,
      insertCount: 1,
      afterCount,
      deletedOldRows,
      durationMs: Date.now() - startedAt,
      errorCode,
    });
  } catch (error) {
    if (!isStorageFullError(error)) {
      errorCode = 'WRITE_FAILED';
      catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
        reason: 'write-failed',
        path,
        error: String((error as any)?.message || error),
      });
      catalogCacheDebugSummary({
        scope: 'catalog-local',
        beforeCount,
        insertCount: 0,
        afterCount: beforeCount,
        deletedOldRows,
        durationMs: Date.now() - startedAt,
        errorCode,
      });
      return;
    }

    errorCode = 'SQLITE_FULL';

    try {
      deletedOldRows += (await emergencyPruneCatalogStorage({ aggressive: true })).deletedOldRows;
      const afterCount = await persist();
      errorCode = null;
      catalogCacheDebugSummary({
        scope: 'catalog-local',
        beforeCount,
        insertCount: 1,
        afterCount,
        deletedOldRows,
        durationMs: Date.now() - startedAt,
        errorCode,
      });
    } catch (retryError) {
      errorCode = isStorageFullError(retryError) ? 'SQLITE_FULL' : 'WRITE_FAILED';
      catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
        reason: 'write-failed-after-cleanup',
        path,
        error: String((retryError as any)?.message || retryError),
      });
      catalogCacheDebugSummary({
        scope: 'catalog-local',
        beforeCount,
        insertCount: 0,
        afterCount: beforeCount,
        deletedOldRows,
        durationMs: Date.now() - startedAt,
        errorCode,
      });
    }
  }
}

function resolveCatalogPath(query: string, variables: Record<string, unknown> = {}) {
  const normalizedQuery = String(query || '').replace(/\s+/g, ' ').trim();

  if (normalizedQuery.includes('productByHandle')) {
    const handle = String(variables.handle || '').trim();
    return `/api/catalog/products/${encodeURIComponent(handle)}`;
  }

  if (normalizedQuery.includes('productRecommendations')) {
    const productId = String(variables.productId || '').trim();
    return `/api/catalog/products/recommendations?productId=${encodeURIComponent(productId)}`;
  }

  if (normalizedQuery.includes('collectionByHandle')) {
    const handle = String(variables.handle || '').trim();
    const limit = Number(variables.first || 250);
    const after = variables.after ? `&after=${encodeURIComponent(String(variables.after))}` : '';
    return `/api/catalog/collections/${encodeURIComponent(handle)}/products?limit=${limit}&first=${limit}${after}`;
  }

  if (normalizedQuery.includes('query SearchProducts') || normalizedQuery.includes('SearchProducts(')) {
    const limit = Number(variables.first || 50);
    const q = String(variables.query || '').trim();
    return `/api/catalog/search?q=${encodeURIComponent(q)}&limit=${limit}&first=${limit}`;
  }

  if (normalizedQuery.includes('menu(handle:')) {
    const handle = String(variables.handle || '').trim();
    return `/api/catalog/menus/${encodeURIComponent(handle)}`;
  }

  if (normalizedQuery.includes('collections(first:')) {
    const limit = Number(variables.first || 250);
    const after = variables.after ? `&after=${encodeURIComponent(String(variables.after))}` : '';
    return `/api/catalog/collections?limit=${limit}&first=${limit}${after}`;
  }

  const limit = Number(variables.first || 50);
  const after = variables.after ? `&after=${encodeURIComponent(String(variables.after))}` : '';
  const sort = normalizedQuery.includes('CREATED_AT') ? 'created' : 'updated';
  return `/api/catalog/products?limit=${limit}&first=${limit}${after}&sort=${sort}`;
}

export function startHomeProductFeedSession() {
  homeProductFeedSession += 1;

  if (activeHomeProductFeedController) {
    activeHomeProductFeedController.abort();
    activeHomeProductFeedController = null;
  }

  return homeProductFeedSession;
}

export function getHomeProductFeedSession() {
  return homeProductFeedSession;
}

export function isHomeProductFeedSessionActive(session: number) {
  return session === homeProductFeedSession;
}

function getProductFeedFallback(cacheKey: string, path: string): CatalogJson | null {
  const memoryCached = cacheKey ? lastSuccessfulProductFeedPages.get(cacheKey) : null;
  if (memoryCached?.data) {
    console.log('[NOOD feed] product feed using memory cache fallback', { path });
    return memoryCached;
  }
  return null;
}

async function getProductFeedFallbackAsync(cacheKey: string, path: string): Promise<CatalogJson | null> {
  const memoryFallback = getProductFeedFallback(cacheKey, path);
  if (memoryFallback) return memoryFallback;

  if (!cacheKey) return null;

  const localCached = await readLocalCatalogCache(cacheKey);
  if (localCached?.data) {
    console.log('[NOOD feed] product feed using local cache fallback', { path });
    return localCached;
  }

  return null;
}

function isHomeProductFeedRequestCancelled(error: unknown, session: number) {
  return (
    error instanceof BackendRequestCancelledError ||
    isBackendAbortError(error) ||
    !isHomeProductFeedSessionActive(session)
  );
}

export type HomeProductFeedFetchResult = {
  payload: CatalogJson | null;
  failed: boolean;
  cancelled: boolean;
};

function buildHomeProductFeedFailure(cancelled = false): HomeProductFeedFetchResult {
  return {
    payload: null,
    failed: true,
    cancelled,
  };
}

function buildHomeProductFeedSuccess(payload: CatalogJson): HomeProductFeedFetchResult {
  return {
    payload,
    failed: false,
    cancelled: false,
  };
}

export async function fetchHomeProductFeedPath(
  path: string,
  options: { session?: number; mixKey?: number; manualRefresh?: boolean } = {}
): Promise<HomeProductFeedFetchResult> {
  const session = options.session ?? homeProductFeedSession;
  const manualRefresh = Boolean(options.manualRefresh);
  const mixKey = options.mixKey;

  if (!manualRefresh) {
    void peekCatalogFreshness('home-feed').catch(() => {
      // Freshness refresh runs in background and must not block cached feed rendering.
    });
  }

  const cacheKey = normalizeCacheKey(
    mixKey !== undefined && path.startsWith('/api/catalog/products?')
      ? `${path}&mixKey=${encodeURIComponent(String(mixKey))}`
      : path
  );

  const tryCacheFallback = async (): Promise<HomeProductFeedFetchResult> => {
    if (manualRefresh) {
      console.log('[NOOD home] skipped stale cache for manual refresh');
      return buildHomeProductFeedFailure(false);
    }

    const cached = await getProductFeedFallbackAsync(cacheKey, path);
    if (cached) {
      return buildHomeProductFeedSuccess(cached);
    }

    return buildHomeProductFeedFailure(false);
  };

  if (!isHomeProductFeedSessionActive(session)) {
    if (manualRefresh) {
      console.log('[NOOD backend] request cancelled');
      return buildHomeProductFeedFailure(true);
    }
    return tryCacheFallback();
  }

  const requestOnce = async (withMixKey?: number) => {
    const resolvedPath =
      withMixKey !== undefined
        ? `${path}&mixKey=${encodeURIComponent(String(withMixKey))}`
        : path;

    if (!isHomeProductFeedSessionActive(session)) {
      throw new BackendRequestCancelledError();
    }

    const controller = new AbortController();
    activeHomeProductFeedController = controller;

    try {
      const payload = (await getBackendJson(resolvedPath, {
        catalog: true,
        timeoutMs: PRODUCT_FEED_TIMEOUT_MS,
        signal: controller.signal,
      })) as CatalogJson;

      if (!isHomeProductFeedSessionActive(session)) {
        throw new BackendRequestCancelledError();
      }

      const resolvedCacheKey = normalizeCacheKey(resolvedPath);
      if (payload?.data && resolvedCacheKey) {
        rememberProductFeedPage(resolvedCacheKey, payload);
        void writeLocalCatalogCache(resolvedCacheKey, resolvedPath, payload);
      }

      const backendVersion = await fetchBackendCatalogVersion();
      if (backendVersion) {
        await setStoredCatalogVersion(backendVersion.catalogVersion);
      }

      return payload;
    } finally {
      if (activeHomeProductFeedController === controller) {
        activeHomeProductFeedController = null;
      }
    }
  };

  try {
    const primary =
      mixKey !== undefined ? await requestOnce(mixKey) : await requestOnce(undefined);

    if (primary) {
      return buildHomeProductFeedSuccess(primary);
    }

    if (!isHomeProductFeedSessionActive(session)) {
      console.log('[NOOD backend] request cancelled');
      return manualRefresh ? buildHomeProductFeedFailure(true) : tryCacheFallback();
    }

    if (mixKey !== undefined && !manualRefresh) {
      console.log('[NOOD feed] mixed page empty, retrying without mixKey', {
        mixKey,
        path,
      });
      const fallback = await requestOnce(undefined);
      if (fallback) {
        return buildHomeProductFeedSuccess(fallback);
      }
    }

    if (manualRefresh) {
      console.log('[NOOD home] skipped stale cache for manual refresh');
      return buildHomeProductFeedFailure(false);
    }

    const memoryFallback = getProductFeedFallback(cacheKey, path);
    if (memoryFallback) {
      return buildHomeProductFeedSuccess(memoryFallback);
    }

    return buildHomeProductFeedFailure(false);
  } catch (error) {
    if (isHomeProductFeedRequestCancelled(error, session)) {
      console.log('[NOOD backend] request cancelled');
      return manualRefresh ? buildHomeProductFeedFailure(true) : tryCacheFallback();
    }

    if (isHomeProductFeedSessionActive(session)) {
      try {
        console.log('[NOOD feed] product feed retry', { path });
        const retryPayload = await requestOnce(mixKey);
        if (retryPayload) {
          return buildHomeProductFeedSuccess(retryPayload);
        }

        if (mixKey !== undefined && !manualRefresh) {
          const retryWithoutMix = await requestOnce(undefined);
          if (retryWithoutMix) {
            return buildHomeProductFeedSuccess(retryWithoutMix);
          }
        }
      } catch (retryError) {
        if (isHomeProductFeedRequestCancelled(retryError, session)) {
          console.log('[NOOD backend] request cancelled');
          return manualRefresh ? buildHomeProductFeedFailure(true) : tryCacheFallback();
        }
      }
    }

    if (manualRefresh) {
      console.log('[NOOD home] skipped stale cache for manual refresh');
      return buildHomeProductFeedFailure(false);
    }

    const cachedFallback = await tryCacheFallback();
    if (!cachedFallback.failed && cachedFallback.payload) {
      return cachedFallback;
    }

    console.log('[NOOD feed] product feed failed', {
      path,
      error: String((error as any)?.message || error),
    });
    return buildHomeProductFeedFailure(false);
  }
}

async function refreshCatalogFromBackend(
  path: string,
  cacheKey: string,
  timeoutMs?: number
): Promise<CatalogJson> {
  let payload: CatalogJson;
  const resolvedTimeoutMs = resolveCatalogRequestTimeoutMs(path, timeoutMs);
  const isCollectionProductsPath =
    path.includes('/api/catalog/collections/') && path.includes('/products');

  try {
    payload = (await getBackendJson(path, {
      timeoutMs: resolvedTimeoutMs,
      catalog: true,
    })) as CatalogJson;
  } catch (error) {
    if (path.includes('/api/catalog/products/recommendations')) {
      console.log('[NOOD catalog] recommendations request failed; using empty fallback', {
        path,
        error: String((error as any)?.message || error),
      });
      return {
        data: { productRecommendations: [] },
        source: 'cache',
      };
    }

    if (isCollectionProductsPath || path.includes('/api/catalog/search')) {
      console.log('[NOOD catalog] background refresh failed; keeping cached response', {
        path,
        error: String((error as any)?.message || error),
      });
      const cached = cacheKey ? await readLocalCatalogCache(cacheKey) : null;
      if (cached?.data) {
        return {
          data: cached.data,
          source: cached.source || 'local',
        };
      }
    }

    throw error;
  }

  if (payload?.data && cacheKey) {
    void writeLocalCatalogCache(cacheKey, path, payload);
  }

  const backendVersion = await fetchBackendCatalogVersion();
  if (backendVersion) {
    await setStoredCatalogVersion(backendVersion.catalogVersion);
  }

  return {
    data: payload.data,
    errors: payload.errors,
    source: payload.source,
    success: payload.success,
  };
}

export { clearCatalogCacheForDev } from './catalog-cache';

export async function clearCatalogProductListCache() {
  try {
    const index = await readCacheIndex();
    const productEntries = index.filter((entry) => entry.path.includes('/api/catalog/products?'));
    if (!productEntries.length) return;

    await removeCatalogCacheKeys(productEntries.map((entry) => entry.key));
    const nextIndex = index.filter((entry) => !entry.path.includes('/api/catalog/products?'));
    await writeCacheIndex(nextIndex);
    catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
      reason: 'product-list-cache-cleared',
      removedEntries: productEntries.length,
    });
  } catch (error) {
    catalogCacheLog('[NOOD catalog] local cache skipped/cleaned because storage full', {
      reason: 'product-list-cache-clear-failed',
      error: String((error as any)?.message || error),
    });
  }
}

export async function fetchCatalogPath(
  path: string,
  options: CatalogFetchOptions = {}
): Promise<CatalogJson> {
  void cleanupLegacyCatalogCache();

  const normalizedCacheKey = normalizeCacheKey(path);
  const cacheKey = options.cacheKey ? normalizeCacheKey(options.cacheKey) || options.cacheKey : normalizedCacheKey;
  const isProductFeed =
    path.startsWith('/api/catalog/products?') && !path.includes('/api/catalog/products/');
  const canUseLocalCache =
    Boolean(cacheKey) &&
    !options.skipLocalCache &&
    !shouldSkipLocalCache(path) &&
    !isProductFeed;

  const cached = canUseLocalCache ? await readLocalCatalogCache(cacheKey) : null;
  const cachedProductCount =
    path.includes('/api/catalog/products') && !path.includes('/api/catalog/products/')
      ? ((cached?.data as any)?.products?.edges || []).length
      : null;
  const hasUsableProductCache = cachedProductCount === null || cachedProductCount > 0;
  const backendRefresh = refreshCatalogFromBackend(path, cacheKey, options.timeoutMs);

  if (canUseLocalCache) {
    void peekCatalogFreshness('fetch').catch(() => {
      // Version refresh must not block cache-first catalog reads.
    });
  }

  if (cached?.data && hasUsableProductCache) {
    void backendRefresh.catch(() => {});
    return {
      data: cached.data,
      source: cached.source || 'local',
    };
  }

  return backendRefresh;
}

export async function fetchProductDetailFromBackend(handle: string) {
  const path = `/api/catalog/products/${encodeURIComponent(String(handle || '').trim())}`;
  return getBackendJson(path, { catalog: true, timeoutMs: 20000 });
}

export async function catalogFetch(
  query: string,
  variables?: Record<string, unknown>,
  options: CatalogFetchOptions = {}
): Promise<CatalogJson> {
  let path = resolveCatalogPath(query, variables || {});

  if (options.mixKey !== undefined && path.startsWith('/api/catalog/products?')) {
    path = `${path}&mixKey=${encodeURIComponent(String(options.mixKey))}`;
  }

  const normalizedCacheKey = normalizeCacheKey(path);

  return fetchCatalogPath(path, {
    ...options,
    cacheKey: options.cacheKey || normalizedCacheKey || path,
  });
}
