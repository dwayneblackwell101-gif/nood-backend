import AsyncStorage from '@react-native-async-storage/async-storage';
import { CATALOG_CACHE_DEBUG } from './debug-flags';
import { PRODUCT_DETAIL_CACHE_PREFIX } from './product-data';

export const MAX_CACHED_HOME_PRODUCTS = 2000;
export const MAX_IN_MEMORY_HOME_PRODUCTS = 400;
export const MAX_CATALOG_PRODUCT_RECORDS = 2000;
export const MAX_PRODUCT_DETAIL_CACHE_ENTRIES = 400;

export const CATALOG_LOCAL_CACHE_PREFIX = 'NOOD_CATALOG_LOCAL_V2_SLIM';
export const LEGACY_CATALOG_CACHE_PREFIX = 'NOOD_CATALOG_LOCAL_V1';
export const CATALOG_CACHE_INDEX_KEY = `${CATALOG_LOCAL_CACHE_PREFIX}:__index__`;
export const HOME_PRODUCTS_CACHE_KEY = 'NOOD_HOME_PRODUCTS_CACHE_V2';
export const SEARCH_PRODUCTS_CACHE_KEY = 'NOOD_SEARCH_PRODUCTS_CACHE_V1';
export const COLLECTION_PRODUCTS_CACHE_PREFIX = 'NOOD_COLLECTION_PRODUCTS_CACHE_V2';

const PROTECTED_STORAGE_PREFIXES = [
  'NOOD_CART',
  'NOOD_WISHLIST',
  'USER_SETTINGS',
  'NOOD_BALANCE',
  'NOOD_ADDRESS_BOOK',
  'NOOD_HISTORY_EVENTS',
  'NOOD_ORDERS',
  'NOOD_CUSTOMER_REVIEWS',
  'NOOD_NOTIFICATION_SETTINGS',
  'NOOD_READ_UPDATES',
  'NOOD_LUCKY_SPIN',
  'NOOD_EXCHANGE_RATES',
  'GUEST_PROFILE_ID',
  'MEMBER_PROFILE_ID',
  'SIGNED_IN',
  'DISPLAY_NAME',
];

export type CatalogCacheDebugSummary = {
  scope: string;
  beforeCount: number;
  insertCount: number;
  afterCount: number;
  deletedOldRows: number;
  durationMs: number;
  errorCode?: string | null;
};

export function isStorageFullError(error: unknown) {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return (
    message.includes('sqlite_full') ||
    message.includes('disk is full') ||
    message.includes('code 13') ||
    message.includes('quota')
  );
}

export function catalogCacheDebugSummary(summary: CatalogCacheDebugSummary) {
  if (!CATALOG_CACHE_DEBUG) return;

  console.log('[CATALOG_CACHE_DEBUG]', {
    beforeCount: summary.beforeCount,
    insertCount: summary.insertCount,
    afterCount: summary.afterCount,
    deletedOldRows: summary.deletedOldRows,
    durationMs: summary.durationMs,
    errorCode: summary.errorCode ?? null,
    scope: summary.scope,
  });
}

export function dedupeProductsByHandle<T extends { id?: string; handle?: string }>(products: T[]) {
  const seenIds = new Set<string>();
  const seenHandles = new Set<string>();
  const result: T[] = [];

  for (const product of products) {
    const id = String(product?.id || '').trim();
    const handle = String(product?.handle || '').trim().toLowerCase();
    if (id && seenIds.has(id)) continue;
    if (handle && seenHandles.has(handle)) continue;
    if (id) seenIds.add(id);
    if (handle) seenHandles.add(handle);
    result.push(product);
  }

  return result;
}

export function trimProductsForCache<T>(products: T[], max = MAX_CACHED_HOME_PRODUCTS) {
  const deduped = dedupeProductsByHandle(products as Array<T & { id?: string; handle?: string }>);
  if (deduped.length <= max) {
    return { products: deduped, trimmedCount: products.length - deduped.length };
  }

  const trimmed = deduped.slice(-max);
  return {
    products: trimmed,
    trimmedCount: products.length - trimmed.length,
  };
}

export function trimProductsForMemory<T extends { id?: string; handle?: string }>(
  products: T[],
  max = MAX_IN_MEMORY_HOME_PRODUCTS
) {
  return trimProductsForCache(products, max);
}

function isProtectedStorageKey(key: string) {
  return PROTECTED_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix) || key === prefix);
}

type CacheIndexEntry = {
  key: string;
  path: string;
  ts: number;
  bytes: number;
};

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

async function pruneProductDetailCache(maxEntries = MAX_PRODUCT_DETAIL_CACHE_ENTRIES) {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const detailKeys = keys.filter((key) => key.startsWith(`${PRODUCT_DETAIL_CACHE_PREFIX}:`));
    if (detailKeys.length <= maxEntries) {
      return { removed: 0, remaining: detailKeys.length };
    }

    const removeCount = detailKeys.length - maxEntries;
    await AsyncStorage.multiRemove(detailKeys.slice(0, removeCount));
    return { removed: removeCount, remaining: maxEntries };
  } catch {
    return { removed: 0, remaining: 0 };
  }
}

export async function emergencyPruneCatalogStorage(options: { aggressive?: boolean } = {}) {
  const startedAt = Date.now();
  const aggressive = Boolean(options.aggressive);
  let deletedOldRows = 0;

  try {
    const index = await readCacheIndex();
    const beforeCount = index.length;

    if (index.length) {
      const sorted = [...index].sort((a, b) => a.ts - b.ts);
      const removeCount = aggressive
        ? Math.max(8, Math.floor(sorted.length * 0.65))
        : Math.max(4, Math.floor(sorted.length * 0.35));
      const keysToRemove = sorted.slice(0, removeCount).map((entry) => entry.key);
      if (keysToRemove.length) {
        await AsyncStorage.multiRemove(keysToRemove);
        const remaining = sorted.slice(removeCount);
        await writeCacheIndex(remaining);
        deletedOldRows += keysToRemove.length;
      }

      catalogCacheDebugSummary({
        scope: 'emergency-catalog-index',
        beforeCount,
        insertCount: 0,
        afterCount: Math.max(0, beforeCount - deletedOldRows),
        deletedOldRows,
        durationMs: Date.now() - startedAt,
        errorCode: 'SQLITE_FULL',
      });
    }

    const detailPrune = await pruneProductDetailCache(
      aggressive ? Math.floor(MAX_PRODUCT_DETAIL_CACHE_ENTRIES * 0.5) : MAX_PRODUCT_DETAIL_CACHE_ENTRIES
    );
    deletedOldRows += detailPrune.removed;

    const auxiliaryKeys = [
      SEARCH_PRODUCTS_CACHE_KEY,
      ...(
        await AsyncStorage.getAllKeys()
      ).filter((key) => key.startsWith(`${COLLECTION_PRODUCTS_CACHE_PREFIX}_`)),
    ];

    const safeAuxiliaryKeys = auxiliaryKeys.filter((key) => !isProtectedStorageKey(key));
    if (safeAuxiliaryKeys.length) {
      await AsyncStorage.multiRemove([...new Set(safeAuxiliaryKeys)]);
      deletedOldRows += safeAuxiliaryKeys.length;
    }

    return { deletedOldRows, durationMs: Date.now() - startedAt };
  } catch (error) {
    catalogCacheDebugSummary({
      scope: 'emergency-catalog-index',
      beforeCount: 0,
      insertCount: 0,
      afterCount: 0,
      deletedOldRows,
      durationMs: Date.now() - startedAt,
      errorCode: isStorageFullError(error) ? 'SQLITE_FULL' : 'PRUNE_FAILED',
    });
    return { deletedOldRows, durationMs: Date.now() - startedAt };
  }
}

export async function clearCatalogCacheForDev() {
  if (!__DEV__) {
    return { cleared: false, reason: 'not-dev' };
  }

  const startedAt = Date.now();
  let removedKeys = 0;

  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const catalogKeys = allKeys.filter((key) => {
      if (isProtectedStorageKey(key)) return false;
      return (
        key.startsWith(CATALOG_LOCAL_CACHE_PREFIX) ||
        key.startsWith(LEGACY_CATALOG_CACHE_PREFIX) ||
        key.startsWith(`${COLLECTION_PRODUCTS_CACHE_PREFIX}_`) ||
        key.startsWith(`${PRODUCT_DETAIL_CACHE_PREFIX}:`) ||
        key === HOME_PRODUCTS_CACHE_KEY ||
        key === SEARCH_PRODUCTS_CACHE_KEY ||
        key === CATALOG_CACHE_INDEX_KEY
      );
    });

    if (catalogKeys.length) {
      await AsyncStorage.multiRemove(catalogKeys);
      removedKeys = catalogKeys.length;
    }

    catalogCacheDebugSummary({
      scope: 'dev-clear-catalog',
      beforeCount: allKeys.length,
      insertCount: 0,
      afterCount: Math.max(0, allKeys.length - removedKeys),
      deletedOldRows: removedKeys,
      durationMs: Date.now() - startedAt,
      errorCode: null,
    });

    return {
      cleared: true,
      removedKeys,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      cleared: false,
      reason: String((error as any)?.message || error),
      removedKeys,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (__DEV__) {
  (globalThis as any).clearNoodCatalogCache = clearCatalogCacheForDev;
}