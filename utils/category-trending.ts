import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeCatalogCurrencyCode } from './currency';
import { fetchCatalogPath } from './catalog';
import {
  resolveListProductAvailableForSale,
} from './product-availability';
import {
  buildCategoryGroupsFromCollections,
  getMainShellItem,
  getScopedSubcategoryItems,
  mixProductsAcrossSubcategories,
  sanitizeCategoryGroups,
  type CollectionLike,
  type ScopedCategoryGroup,
  type ScopedCategoryProduct,
} from './category-scope';

export const CATEGORIES_CACHE_KEY = 'NOOD_CATEGORIES_CACHE_V19_MEN_EXPLICIT';
export const CATEGORIES_IMAGE_CACHE_KEY = 'NOOD_CATEGORIES_IMAGE_URLS_V20';
export const CATEGORY_TRENDING_CACHE_KEY = 'NOOD_CATEGORY_TRENDING_CACHE_V1';
export const CATEGORY_CACHE_VERSION = 4;
const TRENDING_PRODUCT_LIMIT = 240;
const CATEGORIES_BACKEND_TIMEOUT_MS = 12000;
const CATEGORIES_MAX_COLLECTION_PAGES = 2;
const TRENDING_CACHE_VERSION = 1;
const CATEGORY_TRENDING_CACHE_TTL_MS = 40 * 60 * 1000;

export const LEGACY_CATEGORIES_CACHE_KEYS = [
  'NOOD_CATEGORIES_CACHE_V17_SHOPIFY_MENU_AUTO',
  'NOOD_CATEGORIES_CACHE_V18_VERSIONED',
] as const;

export const LEGACY_CATEGORY_TRENDING_CACHE_KEYS = [] as const;

export type TrendingPoolResult = {
  mainCategory: string;
  title: string;
  products: ScopedCategoryProduct[];
  subcategoryCount: number;
  excludedCount: number;
  savedAt: number;
  categoriesSavedAt?: number;
  cacheVersion?: number;
};

type TrendingCacheEnvelope = {
  version: number;
  pools: Record<string, TrendingPoolResult>;
};

type CategoriesCacheEnvelope = {
  version: number;
  savedAt: number;
  categories: ScopedCategoryGroup[];
};

function formatMoney(amount?: string | number | null) {
  if (amount == null || amount === '') return '$0.00';
  return `$${Number(amount).toFixed(2)}`;
}

function getProductNodes(products: any) {
  if (Array.isArray(products?.nodes)) return products.nodes;
  if (Array.isArray(products?.edges)) {
    return products.edges.map((edge: any) => edge?.node).filter(Boolean);
  }
  return [];
}

function normalizePreviewProduct(productNode: any, fallbackId: string): ScopedCategoryProduct {
  const priceAmount = Number(productNode?.priceRange?.minVariantPrice?.amount || 0);

  const mapped: ScopedCategoryProduct = {
    id: String(productNode?.id || fallbackId),
    handle: String(productNode?.handle || ''),
    title: String(productNode?.title || 'Product'),
    image: String(productNode?.featuredImage?.url || productNode?.image || '').trim(),
    price: formatMoney(priceAmount),
    priceAmount,
    currencyCode: normalizeCatalogCurrencyCode(
      productNode?.priceRange?.minVariantPrice?.currencyCode
    ),
    availableForSale: productNode?.availableForSale,
  };
  mapped.availableForSale = resolveListProductAvailableForSale({
    ...mapped,
    variants: productNode?.variants?.edges?.length ? productNode.variants : undefined,
  });
  return mapped;
}

function normalizeBackendCollection(node: any): CollectionLike {
  const previewProducts = getProductNodes(node?.products).map((productNode: any, index: number) =>
    normalizePreviewProduct(productNode, `${node?.id || 'product'}-${index}`)
  );

  const image =
    String(node?.imageUrl || node?.previewImage || node?.image?.url || '').trim() ||
    previewProducts.find((product: ScopedCategoryProduct) => product.image)?.image ||
    '';

  return {
    id: String(node?.id || ''),
    title: String(node?.title || 'Collection'),
    handle: String(node?.handle || ''),
    image,
    previewProducts,
  };
}

export function getTrendingPageTitle(mainCategory: string) {
  const trimmed = String(mainCategory || '').trim();
  return trimmed ? `${trimmed} Trending` : 'Trending';
}

function getCacheAgeMs(savedAt: number | null | undefined) {
  if (!savedAt || !Number.isFinite(savedAt)) return null;
  return Math.max(0, Date.now() - savedAt);
}

function parseCategoriesCacheEnvelope(raw: string | null): {
  groups: ScopedCategoryGroup[];
  savedAt: number | null;
  version: number | null;
  isValid: boolean;
  reason: 'missing' | 'parse_error' | 'version_mismatch' | 'legacy_format' | 'empty' | 'ok';
} {
  if (!raw) {
    return {
      groups: [],
      savedAt: null,
      version: null,
      isValid: false,
      reason: 'missing',
    };
  }

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return {
        groups: [],
        savedAt: null,
        version: null,
        isValid: false,
        reason: 'legacy_format',
      };
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.categories)) {
      return {
        groups: [],
        savedAt: null,
        version: null,
        isValid: false,
        reason: 'parse_error',
      };
    }

    const version = Number(parsed.version);
    const savedAt = Number(parsed.savedAt);

    if (version !== CATEGORY_CACHE_VERSION) {
      return {
        groups: [],
        savedAt: Number.isFinite(savedAt) ? savedAt : null,
        version: Number.isFinite(version) ? version : null,
        isValid: false,
        reason: 'version_mismatch',
      };
    }

    const groups = sanitizeCategoryGroups(parsed.categories);
    if (!groups.length) {
      return {
        groups: [],
        savedAt: Number.isFinite(savedAt) ? savedAt : null,
        version,
        isValid: false,
        reason: 'empty',
      };
    }

    return {
      groups,
      savedAt: Number.isFinite(savedAt) ? savedAt : null,
      version,
      isValid: true,
      reason: 'ok',
    };
  } catch {
    return {
      groups: [],
      savedAt: null,
      version: null,
      isValid: false,
      reason: 'parse_error',
    };
  }
}

export async function readCategoriesCacheMeta(): Promise<{
  groups: ScopedCategoryGroup[];
  savedAt: number | null;
  version: number | null;
  isValid: boolean;
  reason: string;
}> {
  const raw = await AsyncStorage.getItem(CATEGORIES_CACHE_KEY);
  const parsed = parseCategoriesCacheEnvelope(raw);
  return {
    groups: parsed.groups,
    savedAt: parsed.savedAt,
    version: parsed.version,
    isValid: parsed.isValid,
    reason: parsed.reason,
  };
}

export async function readCategoryGroupsFromCache(): Promise<ScopedCategoryGroup[]> {
  const meta = await readCategoriesCacheMeta();
  return meta.groups;
}

function isTrendingPoolStale(
  pool: TrendingPoolResult,
  categoriesSavedAt: number | null
): { stale: boolean; reason?: string } {
  if (Number(pool.cacheVersion) !== TRENDING_CACHE_VERSION) {
    return { stale: true, reason: 'version_mismatch' };
  }

  const poolAgeMs = getCacheAgeMs(pool.savedAt);
  if (poolAgeMs === null || poolAgeMs > CATEGORY_TRENDING_CACHE_TTL_MS) {
    return { stale: true, reason: 'ttl_expired' };
  }

  if (
    categoriesSavedAt &&
    Number(pool.categoriesSavedAt) > 0 &&
    categoriesSavedAt > Number(pool.categoriesSavedAt)
  ) {
    return { stale: true, reason: 'categories_cache_newer' };
  }

  return { stale: false };
}

export function findCategoryGroupByTitle(
  groups: ScopedCategoryGroup[],
  mainCategory: string
): ScopedCategoryGroup | null {
  const normalized = String(mainCategory || '').trim().toLowerCase();
  if (!normalized) return null;

  return groups.find((group) => String(group.title || '').trim().toLowerCase() === normalized) || null;
}

export function buildTrendingPoolForGroup(
  group: Pick<ScopedCategoryGroup, 'title' | 'handle' | 'items'> | null | undefined,
  limit = TRENDING_PRODUCT_LIMIT
): TrendingPoolResult | null {
  if (!group?.title) return null;

  const scopedSubcategoryItems = getScopedSubcategoryItems(group);
  const mainShellItem = getMainShellItem(group);
  const mix = mixProductsAcrossSubcategories(scopedSubcategoryItems, {
    mainTitle: group.title,
    limit,
    includeMainShell: mainShellItem,
  });

  return {
    mainCategory: group.title,
    title: getTrendingPageTitle(group.title),
    products: mix.products,
    subcategoryCount: scopedSubcategoryItems.length,
    excludedCount: mix.excludedCount,
    savedAt: Date.now(),
    cacheVersion: TRENDING_CACHE_VERSION,
  };
}

async function readTrendingCacheEnvelope(): Promise<TrendingCacheEnvelope> {
  try {
    const raw = await AsyncStorage.getItem(CATEGORY_TRENDING_CACHE_KEY);
    if (!raw) {
      return { version: TRENDING_CACHE_VERSION, pools: {} };
    }

    const parsed = JSON.parse(raw) as TrendingCacheEnvelope;
    if (!parsed || typeof parsed !== 'object' || Number(parsed.version) !== TRENDING_CACHE_VERSION) {
      return { version: TRENDING_CACHE_VERSION, pools: {} };
    }

    return {
      version: TRENDING_CACHE_VERSION,
      pools: parsed.pools && typeof parsed.pools === 'object' ? parsed.pools : {},
    };
  } catch {
    return { version: TRENDING_CACHE_VERSION, pools: {} };
  }
}

export async function readCategoryTrendingCache(
  mainCategory: string
): Promise<TrendingPoolResult | null> {
  const key = String(mainCategory || '').trim();
  if (!key) return null;

  const categoriesMeta = await readCategoriesCacheMeta();
  const envelope = await readTrendingCacheEnvelope();
  const cached = envelope.pools[key];
  if (!cached || !Array.isArray(cached.products)) return null;

  const stale = isTrendingPoolStale(cached, categoriesMeta.savedAt);
  if (stale.stale) {
    console.log('[NOOD trending] cache miss', { category: key, reason: stale.reason });
    return null;
  }

  return cached;
}

export async function saveCategoryTrendingCache(pool: TrendingPoolResult): Promise<void> {
  const key = String(pool.mainCategory || '').trim();
  if (!key) return;

  const categoriesMeta = await readCategoriesCacheMeta();
  const nextPool: TrendingPoolResult = {
    ...pool,
    savedAt: Date.now(),
    categoriesSavedAt: categoriesMeta.savedAt ?? pool.categoriesSavedAt ?? 0,
    cacheVersion: TRENDING_CACHE_VERSION,
  };

  const envelope = await readTrendingCacheEnvelope();
  envelope.pools[key] = nextPool;
  await AsyncStorage.setItem(
    CATEGORY_TRENDING_CACHE_KEY,
    JSON.stringify({
      version: TRENDING_CACHE_VERSION,
      pools: envelope.pools,
    } satisfies TrendingCacheEnvelope)
  );
}

export async function clearCategoryTrendingCache(): Promise<void> {
  await AsyncStorage.removeItem(CATEGORY_TRENDING_CACHE_KEY);
  for (const legacyKey of LEGACY_CATEGORY_TRENDING_CACHE_KEYS) {
    await AsyncStorage.removeItem(legacyKey);
  }
}

export async function clearStaleCategoryTrendingCaches(): Promise<void> {
  const trendingRaw = await AsyncStorage.getItem(CATEGORY_TRENDING_CACHE_KEY);
  if (trendingRaw) {
    try {
      const parsed = JSON.parse(trendingRaw) as TrendingCacheEnvelope;
      if (!parsed || Number(parsed.version) !== TRENDING_CACHE_VERSION) {
        console.log('[NOOD trending] cache cleared', { reason: 'version_mismatch' });
        await clearCategoryTrendingCache();
      }
    } catch {
      console.log('[NOOD trending] cache cleared', { reason: 'parse_error' });
      await clearCategoryTrendingCache();
    }
  }

  for (const legacyKey of LEGACY_CATEGORY_TRENDING_CACHE_KEYS) {
    const legacyRaw = await AsyncStorage.getItem(legacyKey);
    if (legacyRaw) {
      console.log('[NOOD trending] legacy cache removed', { legacyKey });
      await AsyncStorage.removeItem(legacyKey);
    }
  }

  const categoriesMeta = await readCategoriesCacheMeta();
  if (
    categoriesMeta.reason === 'version_mismatch' ||
    categoriesMeta.reason === 'legacy_format'
  ) {
    console.log('[NOOD trending] cache cleared', { reason: `categories_${categoriesMeta.reason}` });
    await clearCategoryTrendingCache();
    return;
  }

  if (!trendingRaw || categoriesMeta.savedAt == null) return;

  try {
    const envelope = JSON.parse(trendingRaw) as TrendingCacheEnvelope;
    const pools = envelope?.pools && typeof envelope.pools === 'object' ? envelope.pools : {};
    let removedCount = 0;

    Object.entries(pools).forEach(([key, pool]) => {
      const stale = isTrendingPoolStale(pool, categoriesMeta.savedAt);
      if (stale.stale) {
        delete pools[key];
        removedCount += 1;
        console.log('[NOOD trending] stale pool removed', {
          category: key,
          reason: stale.reason,
        });
      }
    });

    if (removedCount > 0) {
      if (!Object.keys(pools).length) {
        await clearCategoryTrendingCache();
      } else {
        await AsyncStorage.setItem(
          CATEGORY_TRENDING_CACHE_KEY,
          JSON.stringify({
            version: TRENDING_CACHE_VERSION,
            pools,
          } satisfies TrendingCacheEnvelope)
        );
      }
    }
  } catch {
    await clearCategoryTrendingCache();
  }

  for (const legacyKey of LEGACY_CATEGORIES_CACHE_KEYS) {
    const legacyRaw = await AsyncStorage.getItem(legacyKey);
    if (legacyRaw) {
      console.log('[NOOD trending] legacy categories cache detected', { legacyKey });
    }
  }
}

async function fetchCategoryCollections(forceRefresh = false): Promise<CollectionLike[]> {
  const collections: CollectionLike[] = [];
  const seenHandles = new Set<string>();
  let after: string | null = null;
  let hasMore = true;
  let guard = 0;

  while (hasMore && guard < CATEGORIES_MAX_COLLECTION_PAGES) {
    const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
    const json: any = await fetchCatalogPath(
      `/api/catalog/collections?limit=250&first=250${afterParam}`,
      { skipLocalCache: forceRefresh, timeoutMs: CATEGORIES_BACKEND_TIMEOUT_MS }
    );

    const pageCollections = (json?.data?.collections?.edges || [])
      .map((edge: any) => normalizeBackendCollection(edge?.node || edge || {}))
      .filter((item: CollectionLike) => item.handle);

    pageCollections.forEach((collection: CollectionLike) => {
      if (seenHandles.has(collection.handle)) return;
      seenHandles.add(collection.handle);
      collections.push(collection);
    });

    const pageInfo: { hasNextPage?: boolean; endCursor?: string | null } =
      json?.data?.collections?.pageInfo || {};
    after = pageInfo?.endCursor ?? null;
    hasMore = Boolean(pageInfo?.hasNextPage && after);
    guard += 1;
  }

  return collections;
}

export async function refreshTrendingPoolFromBackend(
  mainCategory: string
): Promise<TrendingPoolResult | null> {
  const collections = await fetchCategoryCollections(true);
  if (!collections.length) return null;

  const built = buildCategoryGroupsFromCollections(collections);
  const groups = sanitizeCategoryGroups(built.groups);
  const group = findCategoryGroupByTitle(groups, mainCategory);
  const pool = buildTrendingPoolForGroup(group);

  if (pool) {
    await saveCategoryTrendingCache(pool);
  }

  return pool;
}

export async function loadTrendingPoolForCategory(
  mainCategory: string,
  options: { preferCache?: boolean } = {}
): Promise<TrendingPoolResult> {
  const title = getTrendingPageTitle(mainCategory);
  const empty: TrendingPoolResult = {
    mainCategory,
    title,
    products: [],
    subcategoryCount: 0,
    excludedCount: 0,
    savedAt: Date.now(),
  };

  await clearStaleCategoryTrendingCaches();

  if (options.preferCache !== false) {
    const cached = await readCategoryTrendingCache(mainCategory);
    if (cached?.products?.length) {
      console.log('[NOOD trending] cache hit', {
        category: mainCategory,
        productCount: cached.products.length,
        savedAt: cached.savedAt,
      });
      return cached;
    }
  }

  const groups = await readCategoryGroupsFromCache();
  const group = findCategoryGroupByTitle(groups, mainCategory);
  const fromGroups = buildTrendingPoolForGroup(group);
  if (fromGroups?.products?.length) {
    await saveCategoryTrendingCache(fromGroups);
    return fromGroups;
  }

  return fromGroups || empty;
}