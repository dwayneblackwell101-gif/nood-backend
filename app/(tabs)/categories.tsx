import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import NoodSpinner from '../../components/NoodSpinner';
import {
  CategoryBubbleCell,
  CategoryGridProductCard,
  CategoryOptimizedImage,
  CategoryTrendingCard,
  CategoriesRailList,
  CategoriesTrendingList,
  PERF_CATEGORIES_DEBUG,
} from '../../components/categories/CategoriesPerf';
import { CATALOG_LIST_PROPS } from '../../components/catalog/ListPerf';
import CameraSearchModal, { type CameraSearchPhoto } from '../../components/CameraSearchModal';
import { BASE_CURRENCY, normalizeCatalogCurrencyCode } from '../../utils/currency';
import { ensureCatalogFreshness, fetchCatalogPath } from '../../utils/catalog';
import { getLastSuccessfulBackendUrl, postBackendJson } from '../../utils/backend';
import { buildProductRouteParams } from '../../utils/product-navigation';
import {
  buildCategoryGroupsFromCollections,
  buildCategoryHeroSlides,
  createSeededMainCategoryGroups,
  findMainCategoryForCollection,
  getCategoryBubbleImage as getScopedCategoryBubbleImage,
  getMainShellItem,
  getScopedSubcategoryItems,
  MEN_DROPDOWN_DEFINITIONS,
  mixProductsAcrossSubcategories,
  sanitizeCategoryGroups,
  type CategoryMappingSource,
  type ScopedCategoryGroup,
  type ScopedCategoryItem,
} from '../../utils/category-scope';
import { useUser } from '../../context/UserContext';
import { recordCategoryBrowse } from '../../utils/recommendation-signals';
import {
  buildTrendingPoolForGroup,
  clearCategoryTrendingCache,
  saveCategoryTrendingCache,
} from '../../utils/category-trending';
import {
  getProductAvailabilityLabel,
  logSoldOutDebug,
  resolveListProductAvailableForSale,
  resolveListProductSoldOut,
} from '../../utils/product-availability';
import { useScreenPerfReporter } from '../../utils/screen-perf';

const NOOD_LOGO = require('../../assets/images/logo.png');

function categoriesPerfLog(...args: unknown[]) {
  if (PERF_CATEGORIES_DEBUG) {
    console.log(...args);
  }
}

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/600x600.png?text=NOOD';
const CATEGORY_CACHE_VERSION = 5;
const CATEGORIES_CACHE_KEY = 'NOOD_CATEGORIES_CACHE_V19_MEN_EXPLICIT';
const CATEGORIES_IMAGE_CACHE_KEY = 'NOOD_CATEGORIES_IMAGE_URLS_V20';
const CATEGORY_IMAGE_PREFETCH_LIMIT = 12;
const LEGACY_CATEGORIES_CACHE_KEYS = [
  'NOOD_CATEGORIES_CACHE_V17_SHOPIFY_MENU_AUTO',
  'NOOD_CATEGORIES_CACHE_V18_VERSIONED',
];
const CATEGORY_CACHE_TTL_MS = 40 * 60 * 1000;
const CATEGORIES_FOCUS_REFRESH_MS = 60000;
const CATEGORIES_BACKEND_TIMEOUT_MS = 12000;
const CATEGORIES_MAX_COLLECTION_PAGES = 2;
const webShadow = (value: string) => (Platform.OS === 'web' ? { boxShadow: value } : {});
const platformShadow = (webValue: string, nativeValue: object) =>
  Platform.OS === 'web' ? webShadow(webValue) : nativeValue;
const SHOPIFY_CATEGORIES_MENU_HANDLES = [
  'main-menu',
  'header-menu',
  'primary-menu',
  'main-navigation',
  'nood-app-categories',
];
const WEBSITE_MAIN_CATEGORY_TITLES = [
  'Men',
  'Women',
  'Kids',
  'Shoes',
  'Electronics',
  'Accessories',
  'Beauty',
];
const WEBSITE_MAIN_CATEGORY_KEYS = WEBSITE_MAIN_CATEGORY_TITLES.map((title) =>
  title.toLowerCase()
);
const CATEGORY_HERO_COPY: Record<string, { eyebrow: string; title: string }> = {
  Men: { eyebrow: "Men's Streetwear", title: 'New drops, viral fits, premium looks' },
  Women: { eyebrow: "Women's Fashion", title: 'Fresh styles, standout picks, everyday glam' },
  Kids: { eyebrow: 'Kids Favorites', title: 'Cute finds, comfy fits, ready-to-go looks' },
  Shoes: { eyebrow: 'Shoe Edit', title: 'Statement pairs, fresh soles, daily rotation' },
  Electronics: { eyebrow: 'Smart Tech', title: 'Useful tech, clean audio, everyday upgrades' },
  Accessories: { eyebrow: 'Accessory Picks', title: 'Finishing touches, bold details, easy gifts' },
  Beauty: { eyebrow: 'Beauty Essentials', title: 'Glow picks, fresh scents, beauty must-haves' },
};
const CATEGORY_CARD_BADGES = ['NEW', 'HOT', 'BEST SELLER'];
const SHOP_BY_CATEGORY_BADGES = ['HOT', 'NEW', 'Deals'] as const;
const NON_CATEGORY_MENU_KEYS = new Set([
  'home',
  'about us',
  'order tracking',
  'track order',
  'contact',
  'search',
  'account',
  'cart',
]);
const CATEGORY_MENU_QUERY = `
  query NoodCategoriesMenu($handle: String!) {
    menu(handle: $handle) {
      title
      items {
        title
        url
        type
        resource {
          ... on Collection {
            id
            handle
            title
            image {
              url
              altText
            }
            products(first: 24) {
              nodes {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                images(first: 1) {
                  edges {
                    node {
                      url
                    }
                  }
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        items {
          title
          url
          type
          resource {
            ... on Collection {
            id
            handle
            title
            image {
              url
              altText
            }
            products(first: 24) {
              nodes {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                images(first: 1) {
                  edges {
                    node {
                      url
                    }
                  }
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
            }
          }
          items {
            title
            url
            type
            resource {
              ... on Collection {
            id
            handle
            title
            image {
              url
              altText
            }
            products(first: 24) {
              nodes {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                images(first: 1) {
                  edges {
                    node {
                      url
                    }
                  }
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
              }
            }
          }
        }
      }
    }
  }
`;

const CATEGORY_BROWSER_QUERY = `
  query GetCategoryBrowser($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          image {
            url
          }
          products(first: 24) {
            edges {
              node {
                id
                handle
                title
                featuredImage {
                  url
                }
                images(first: 1) {
                  edges {
                    node {
                      url
                    }
                  }
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type CategoryProduct = {
  id: string;
  handle: string;
  title: string;
  image: string;
  price: string;
  priceAmount: number;
  currencyCode: string;
  brand?: string;
  vendor?: string;
  productType?: string;
  category?: string;
  tags?: string[];
  collectionHandles?: string[];
  variantTitle?: string;
  score?: number;
  matchReason?: string;
  visualCandidate?: boolean;
  imageSearchRank?: number;
  availableForSale?: boolean;
  variants?: { edges?: any[] };
  groupId?: string;
  groupTitle?: string;
  sourceSubcategoryTitle?: string;
};

type MenuCategoryItem = {
  id: string;
  title: string;
  handle: string;
  image: string;
  fallbackImage?: string | null;
  displayImage?: string | null;
  productsCount?: number;
  previewProducts: CategoryProduct[];
};

type MenuCategoryGroup = {
  id: string;
  title: string;
  handle: string;
  items: MenuCategoryItem[];
};

type CategoryCollection = {
  id: string;
  title: string;
  handle: string;
  image: string;
  fallbackImage?: string | null;
  displayImage?: string | null;
  productsCount?: number;
  previewProducts: CategoryProduct[];
};

type CategoriesCacheEnvelope = {
  version: number;
  savedAt: number;
  categories: MenuCategoryGroup[];
};

type CategoriesSessionSnapshot = {
  groups: MenuCategoryGroup[];
  activeGroupId: string;
  scrollOffset: number;
  railScrollOffset: number;
  savedAt: number;
  version: number;
};

type ParsedCategoriesCache = {
  groups: MenuCategoryGroup[];
  savedAt: number | null;
  version: number | null;
  isValid: boolean;
  isFresh: boolean;
  reason: 'missing' | 'parse_error' | 'version_mismatch' | 'legacy_format' | 'empty' | 'stale' | 'ok';
};

let categoriesSessionSnapshot: CategoriesSessionSnapshot | null = null;

type CategoryImageUrlEntry = {
  url: string;
  source: string;
};

type CategoryImageCacheEnvelope = {
  version: number;
  savedAt: number;
  urls: Record<string, CategoryImageUrlEntry>;
};

let memoryCategoryImageUrls: Record<string, CategoryImageUrlEntry> = {};
let categoryImageCacheHydrated = false;
let categoryImageCacheHydratePromise: Promise<Record<string, CategoryImageUrlEntry>> | null = null;

function hydrateCategoryImageCacheFromStorage() {
  if (categoryImageCacheHydratePromise) {
    return categoryImageCacheHydratePromise;
  }

  categoryImageCacheHydratePromise = readCategoryImageCacheFromStorage()
    .then((urlMap) => {
      if (Object.keys(urlMap).length) {
        memoryCategoryImageUrls = {
          ...memoryCategoryImageUrls,
          ...urlMap,
        };
      }
      categoryImageCacheHydrated = true;
      categoriesPerfLog('[NOOD categories] cached image map count', Object.keys(memoryCategoryImageUrls).length);
      categoriesPerfLog('[NOOD categories] cached men image urls count', countMenImageUrlEntries(memoryCategoryImageUrls));
      return memoryCategoryImageUrls;
    })
    .catch(() => {
      categoryImageCacheHydrated = true;
      return memoryCategoryImageUrls;
    });

  return categoryImageCacheHydratePromise;
}

void hydrateCategoryImageCacheFromStorage();

function getCategoriesCacheAgeMs(savedAt: number | null) {
  if (!savedAt || !Number.isFinite(savedAt)) return null;
  return Math.max(0, Date.now() - savedAt);
}

function rejectStaleSessionSnapshot() {
  const snap = categoriesSessionSnapshot;
  if (!snap) return;

  if (snap.version !== CATEGORY_CACHE_VERSION) {
    categoriesPerfLog('[CATEGORIES CACHE] session snapshot ignored', { reason: 'version_mismatch' });
    categoriesSessionSnapshot = null;
    return;
  }

  const ageMs = getCategoriesCacheAgeMs(snap.savedAt);
  if (ageMs === null || ageMs > CATEGORY_CACHE_TTL_MS) {
    categoriesPerfLog('[CATEGORIES CACHE] session snapshot ignored', { reason: 'stale' });
    categoriesSessionSnapshot = null;
  }
}

function parseCategoriesCacheEnvelope(raw: string | null): ParsedCategoriesCache {
  if (!raw) {
    return {
      groups: [],
      savedAt: null,
      version: null,
      isValid: false,
      isFresh: false,
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
        isFresh: false,
        reason: 'legacy_format',
      };
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.categories)
    ) {
      return {
        groups: [],
        savedAt: null,
        version: null,
        isValid: false,
        isFresh: false,
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
        isFresh: false,
        reason: 'version_mismatch',
      };
    }

    const groups = sanitizeCategoryGroups(
      normalizeGroupsToWebsiteMainCategories(parsed.categories) as ScopedCategoryGroup[]
    ) as MenuCategoryGroup[];
    if (!groups.length) {
      return {
        groups: [],
        savedAt: Number.isFinite(savedAt) ? savedAt : null,
        version,
        isValid: false,
        isFresh: false,
        reason: 'empty',
      };
    }

    const ageMs = getCategoriesCacheAgeMs(savedAt);
    const isFresh = ageMs !== null && ageMs <= CATEGORY_CACHE_TTL_MS;

    return {
      groups,
      savedAt: Number.isFinite(savedAt) ? savedAt : null,
      version,
      isValid: true,
      isFresh,
      reason: isFresh ? 'ok' : 'stale',
    };
  } catch {
    return {
      groups: [],
      savedAt: null,
      version: null,
      isValid: false,
      isFresh: false,
      reason: 'parse_error',
    };
  }
}

function buildCategoriesCacheEnvelope(groups: MenuCategoryGroup[]): CategoriesCacheEnvelope {
  return {
    version: CATEGORY_CACHE_VERSION,
    savedAt: Date.now(),
    categories: groups,
  };
}

async function readCategoriesCacheFromStorage(): Promise<ParsedCategoriesCache> {
  const raw = await AsyncStorage.getItem(CATEGORIES_CACHE_KEY);
  return parseCategoriesCacheEnvelope(raw);
}

function extractCategoryImageUrlMap(groups: MenuCategoryGroup[]): Record<string, CategoryImageUrlEntry> {
  const map: Record<string, CategoryImageUrlEntry> = {};

  groups.forEach((group) => {
    group.items.forEach((item) => {
      const handle = String(item.handle || '').trim();
      if (!handle) return;

      const bubbleImage = resolveItemBubbleImage(item, group.title).url;
      if (!isRealProductImage(bubbleImage)) return;

      const collectionImage = String(item.image || '').trim();
      const displayImage = String(item.displayImage || '').trim();
      const fallbackImage = String(item.fallbackImage || '').trim();

      map[handle] = {
        url: bubbleImage,
        source: isRealProductImage(collectionImage)
          ? 'collection'
          : isRealProductImage(displayImage)
            ? 'displayImage'
            : isRealProductImage(fallbackImage)
              ? 'fallbackImage'
              : 'product',
      };
    });
  });

  return map;
}

function hydrateMemoryCategoryImageUrls(groups: MenuCategoryGroup[]) {
  const extracted = extractCategoryImageUrlMap(groups);
  memoryCategoryImageUrls = {
    ...memoryCategoryImageUrls,
    ...extracted,
  };
}

function logCategoryImageTestFromGroups(groups: MenuCategoryGroup[]) {
  const gloGang = groups
    .flatMap((group) => group.items || [])
    .find((item) => item.handle === 'glo-gang');

  if (!gloGang) return;

  categoriesPerfLog('[CATEGORY_IMAGE_TEST]', {
    title: gloGang.title,
    handle: gloGang.handle,
    image: isRealProductImage(gloGang.image) ? gloGang.image : null,
    fallbackImage: gloGang.fallbackImage || null,
    displayImage: gloGang.displayImage || null,
    productsCount: gloGang.productsCount ?? gloGang.previewProducts?.length ?? 0,
  });
}

function resolveItemBubbleImage(
  item: MenuCategoryItem,
  mainTitle: string,
  urlMap: Record<string, CategoryImageUrlEntry> = memoryCategoryImageUrls
): { url: string; source: string } {
  const handle = String(item.handle || '').trim();

  const collectionImage = String(item.image || '').trim();
  if (isRealProductImage(collectionImage)) {
    return { url: collectionImage, source: 'collection' };
  }

  const displayImage = String(item.displayImage || '').trim();
  if (isRealProductImage(displayImage)) {
    return { url: displayImage, source: 'displayImage' };
  }

  const fallbackImage = String(item.fallbackImage || '').trim();
  if (isRealProductImage(fallbackImage)) {
    return { url: fallbackImage, source: 'fallbackImage' };
  }

  const firstProduct = item.previewProducts?.[0];
  const firstFeaturedImage = String(firstProduct?.image || '').trim();
  if (isRealProductImage(firstFeaturedImage)) {
    return { url: firstFeaturedImage, source: 'first-product-featured' };
  }

  const firstProductImage =
    item.previewProducts?.find((product) => isRealProductImage(product.image))?.image || '';
  if (isRealProductImage(firstProductImage)) {
    return { url: firstProductImage, source: 'first-product' };
  }

  const scopedImage = getScopedCategoryBubbleImage(item as ScopedCategoryItem, mainTitle);
  if (isRealProductImage(scopedImage)) {
    return { url: scopedImage, source: 'preview' };
  }

  const cachedEntry = handle ? urlMap[handle] : null;
  if (cachedEntry && isRealProductImage(cachedEntry.url)) {
    return { url: cachedEntry.url, source: cachedEntry.source || 'cache' };
  }

  return { url: '', source: 'fallback' };
}

function applyCategoryImageUrlsToGroups(
  groups: MenuCategoryGroup[],
  urlMap: Record<string, CategoryImageUrlEntry> = memoryCategoryImageUrls
): MenuCategoryGroup[] {
  if (!groups.length) return groups;

  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const resolved = resolveItemBubbleImage(item, group.title, urlMap);
      if (!isRealProductImage(resolved.url)) {
        return item;
      }

      if (isRealProductImage(item.image)) {
        return item;
      }

      return {
        ...item,
        image: resolved.url,
        displayImage: resolved.url,
      };
    }),
  }));
}

function countMenImageUrlEntries(
  urlMap: Record<string, CategoryImageUrlEntry>,
  handles: string[] = MEN_DROPDOWN_DEFINITIONS.map((item) => item.handle)
) {
  let count = 0;
  handles.forEach((handle) => {
    if (isRealProductImage(urlMap[handle]?.url)) count += 1;
  });
  return count;
}

function parseCategoryImageCacheEnvelope(raw: string | null): Record<string, CategoryImageUrlEntry> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as CategoryImageCacheEnvelope;
    if (!parsed || typeof parsed !== 'object' || Number(parsed.version) !== CATEGORY_CACHE_VERSION) {
      return {};
    }

    const urls = parsed.urls && typeof parsed.urls === 'object' ? parsed.urls : {};
    const normalized: Record<string, CategoryImageUrlEntry> = {};

    Object.entries(urls).forEach(([handle, entry]) => {
      const url = typeof entry === 'string' ? entry : entry?.url;
      if (!handle || !isRealProductImage(url)) return;
      normalized[handle] = {
        url: String(url),
        source: typeof entry === 'object' && entry?.source ? String(entry.source) : 'cache',
      };
    });

    return normalized;
  } catch {
    return {};
  }
}

async function readCategoryImageCacheFromStorage(): Promise<Record<string, CategoryImageUrlEntry>> {
  const raw = await AsyncStorage.getItem(CATEGORIES_IMAGE_CACHE_KEY);
  return parseCategoryImageCacheEnvelope(raw);
}

async function saveCategoryImageCacheFromGroups(groups: MenuCategoryGroup[]) {
  const extracted = extractCategoryImageUrlMap(groups);
  const stored = await readCategoryImageCacheFromStorage();
  const merged: Record<string, CategoryImageUrlEntry> = { ...stored };

  Object.entries(extracted).forEach(([handle, entry]) => {
    if (!handle || !isRealProductImage(entry?.url)) return;
    merged[handle] = entry;
  });

  Object.entries(memoryCategoryImageUrls).forEach(([handle, entry]) => {
    if (!handle || !isRealProductImage(entry?.url)) return;
    if (!isRealProductImage(merged[handle]?.url)) {
      merged[handle] = entry;
    }
  });

  if (!Object.keys(merged).length) return;

  memoryCategoryImageUrls = merged;

  const envelope: CategoryImageCacheEnvelope = {
    version: CATEGORY_CACHE_VERSION,
    savedAt: Date.now(),
    urls: memoryCategoryImageUrls,
  };

  await AsyncStorage.setItem(CATEGORIES_IMAGE_CACHE_KEY, JSON.stringify(envelope));
}

async function saveCategoriesCacheToStorage(groups: MenuCategoryGroup[]) {
  const envelope = buildCategoriesCacheEnvelope(groups);
  await AsyncStorage.setItem(CATEGORIES_CACHE_KEY, JSON.stringify(envelope));
  await saveCategoryImageCacheFromGroups(groups);
  return envelope.savedAt;
}

async function clearCategoriesCacheFromStorage() {
  await AsyncStorage.removeItem(CATEGORIES_CACHE_KEY);
  await AsyncStorage.removeItem(CATEGORIES_IMAGE_CACHE_KEY);
  await clearCategoryTrendingCache();
  memoryCategoryImageUrls = {};
  for (const legacyKey of LEGACY_CATEGORIES_CACHE_KEYS) {
    await AsyncStorage.removeItem(legacyKey);
  }
}

async function clearStaleCategoriesCaches() {
  const current = await readCategoriesCacheFromStorage();

  if (current.reason === 'version_mismatch') {
    categoriesPerfLog('[CATEGORIES CACHE] version mismatch, clearing', {
      expected: CATEGORY_CACHE_VERSION,
      found: current.version,
    });
    await clearCategoriesCacheFromStorage();
  } else if (current.reason === 'legacy_format') {
    await clearCategoriesCacheFromStorage();
  }

  for (const legacyKey of LEGACY_CATEGORIES_CACHE_KEYS) {
    const legacyRaw = await AsyncStorage.getItem(legacyKey);
    if (legacyRaw) {
      categoriesPerfLog('[CATEGORIES CACHE] legacy cache removed', { legacyKey });
      await AsyncStorage.removeItem(legacyKey);
    }
  }

  rejectStaleSessionSnapshot();
}

function getInitialCategoryGroups(): MenuCategoryGroup[] {
  rejectStaleSessionSnapshot();
  let groups: MenuCategoryGroup[];

  if (categoriesSessionSnapshot?.groups.length) {
    groups = sanitizeCategoryGroups(
      categoriesSessionSnapshot.groups as ScopedCategoryGroup[]
    ) as MenuCategoryGroup[];
    hydrateMemoryCategoryImageUrls(groups);
  } else {
    groups = createSeededMainCategoryGroups() as MenuCategoryGroup[];
  }

  const withImages = applyCategoryImageUrlsToGroups(groups, memoryCategoryImageUrls);
  if (Object.keys(memoryCategoryImageUrls).length) {
    categoriesPerfLog('[NOOD categories] cached image map count', Object.keys(memoryCategoryImageUrls).length);
    categoriesPerfLog('[NOOD categories] cached men image urls count', countMenImageUrlEntries(memoryCategoryImageUrls));
  }
  return withImages;
}

// Legacy alias for dev-client Fast Refresh after rename.
const getInitialSessionGroups = getInitialCategoryGroups;

async function hydrateCategoriesFromCache(): Promise<{
  groups: MenuCategoryGroup[];
  source: 'session' | 'storage' | 'default';
}> {
  rejectStaleSessionSnapshot();
  if (categoriesSessionSnapshot?.groups.length) {
    const groups = applyCategoryImageUrlsToGroups(
      sanitizeCategoryGroups(
        categoriesSessionSnapshot.groups as ScopedCategoryGroup[]
      ) as MenuCategoryGroup[]
    );
    hydrateMemoryCategoryImageUrls(groups);
    return { groups, source: 'session' };
  }

  const cached = await readCategoriesCacheFromStorage();
  if (cached.isValid && cached.groups.length) {
    const groups = applyCategoryImageUrlsToGroups(
      sanitizeCategoryGroups(cached.groups as ScopedCategoryGroup[]) as MenuCategoryGroup[]
    );
    hydrateMemoryCategoryImageUrls(groups);
    return { groups, source: 'storage' };
  }

  return {
    groups: applyCategoryImageUrlsToGroups(
      createSeededMainCategoryGroups() as MenuCategoryGroup[]
    ),
    source: 'default',
  };
}

function countCategoryPreviewProducts(groups: MenuCategoryGroup[]) {
  return groups.reduce(
    (total, group) =>
      total +
      group.items.reduce((itemTotal, item) => itemTotal + (item.previewProducts?.length || 0), 0),
    0
  );
}

function countMenImageStats(groups: MenuCategoryGroup[]) {
  const menGroup = groups.find((group) => group.title === 'Men');
  if (!menGroup) {
    return { cachedImages: 0, placeholders: 0, visibleCount: 0 };
  }

  let cachedImages = 0;
  let placeholders = 0;

  menGroup.items.forEach((item) => {
    const bubbleImage = getScopedCategoryBubbleImage(item as ScopedCategoryItem, 'Men');
    if (isRealProductImage(bubbleImage)) {
      cachedImages += 1;
    } else {
      placeholders += 1;
    }
  });

  return {
    cachedImages,
    placeholders,
    visibleCount: menGroup.items.length,
  };
}

function mergeCategoryGroupsPreservingContent(
  previous: MenuCategoryGroup[],
  incoming: MenuCategoryGroup[]
): { groups: MenuCategoryGroup[]; preservedImageCount: number } {
  const previousByTitle = new Map(previous.map((group) => [group.title, group]));
  let preservedImageCount = 0;

  const groups = incoming.map((incomingGroup) => {
    const previousGroup = previousByTitle.get(incomingGroup.title);
    if (!previousGroup) return incomingGroup;

    const previousItemByHandle = new Map(
      previousGroup.items
        .filter((item) => item.handle)
        .map((item) => [String(item.handle).trim(), item])
    );

    const mergedItems = incomingGroup.items.map((incomingItem) => {
      const previousItem = previousItemByHandle.get(String(incomingItem.handle || '').trim());
      if (!previousItem) return incomingItem;

      const incomingImage = isRealProductImage(incomingItem.image) ? incomingItem.image : '';
      const previousImage = isRealProductImage(previousItem.image) ? previousItem.image : '';
      const cachedEntry = memoryCategoryImageUrls[String(incomingItem.handle || '').trim()];
      const cachedImage = isRealProductImage(cachedEntry?.url) ? cachedEntry.url : '';
      const image =
        incomingImage || previousImage || cachedImage || incomingItem.image || previousItem.image || '';

      if (!incomingImage && (previousImage || cachedImage)) {
        preservedImageCount += 1;
        if (!incomingImage && previousImage) {
          categoriesPerfLog('[NOOD categories] refresh skipped blank overwrite', {
            handle: incomingItem.handle,
            kept: 'previous-image',
          });
        } else if (!incomingImage && cachedImage) {
          categoriesPerfLog('[NOOD categories] refresh skipped blank overwrite', {
            handle: incomingItem.handle,
            kept: 'cached-image',
          });
        }
      }

      const incomingProducts = Array.isArray(incomingItem.previewProducts)
        ? incomingItem.previewProducts
        : [];
      const previousProducts = Array.isArray(previousItem.previewProducts)
        ? previousItem.previewProducts
        : [];
      const previewProducts = incomingProducts.length ? incomingProducts : previousProducts;

      return {
        ...incomingItem,
        title: incomingItem.title || previousItem.title,
        image,
        previewProducts,
      };
    });

    return {
      ...incomingGroup,
      items: mergedItems,
    };
  });

  return { groups, preservedImageCount };
}

function pruneGroupsToValidCollectionHandles(
  groups: MenuCategoryGroup[],
  collections: CategoryCollection[]
) {
  const validHandles = new Set(
    collections.map((collection) => String(collection.handle || '').trim()).filter(Boolean)
  );

  if (!validHandles.size) {
    return normalizeGroupsToWebsiteMainCategories(groups);
  }

  return normalizeGroupsToWebsiteMainCategories(
    groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const handle = String(item.handle || '').trim();
        return Boolean(handle && validHandles.has(handle));
      }),
    }))
  );
}

function formatMoney(amount?: string | null) {
  if (!amount) return '$0.00';
  return `$${Number(amount).toFixed(2)}`;
}

function isRealProductImage(uri?: string | null) {
  const image = String(uri || '').trim();

  if (!image) return false;
  if (image === PLACEHOLDER_IMAGE) return false;
  if (image.toLowerCase().includes('via.placeholder.com')) return false;

  return true;
}

function getOptimizedImageUrl(uri?: string | null, width = 360) {
  const image = String(uri || '').trim();
  if (!isRealProductImage(image)) return PLACEHOLDER_IMAGE;

  try {
    const parsed = new URL(image);
    if (parsed.hostname.includes('cdn.shopify.com')) {
      parsed.searchParams.set('width', String(width));
      return parsed.toString();
    }
  } catch {
    return image;
  }

  return image;
}

function normalizeProductNode(productNode: any, fallbackId: string): CategoryProduct {
  const priceAmount = Number(productNode?.priceRange?.minVariantPrice?.amount || 0);
  const collectionHandles =
    productNode?.collections?.edges?.map((edge: any) => edge?.node?.handle).filter(Boolean) || [];
  const firstVariant = productNode?.variants?.edges?.[0]?.node || null;
  const productImage =
    String(productNode?.featuredImage?.url || '').trim() ||
    String(productNode?.images?.edges?.[0]?.node?.url || '').trim();
  const mapped: CategoryProduct = {
    id: String(productNode?.id || fallbackId),
    handle: String(productNode?.handle || ''),
    title: String(productNode?.title || 'Product'),
    image: isRealProductImage(productImage)
      ? productImage
      : PLACEHOLDER_IMAGE,
    price: formatMoney(String(priceAmount)),
    priceAmount,
    currencyCode: normalizeCatalogCurrencyCode(
      productNode?.priceRange?.minVariantPrice?.currencyCode
    ),
    brand: String(productNode?.vendor || ''),
    vendor: String(productNode?.vendor || ''),
    productType: String(productNode?.productType || ''),
    category: String(productNode?.productType || collectionHandles[0] || ''),
    tags: Array.isArray(productNode?.tags) ? productNode.tags.map(String) : [],
    collectionHandles,
    variantTitle: firstVariant?.title ? String(firstVariant.title) : undefined,
    variants: productNode?.variants?.edges?.length ? productNode.variants : undefined,
    availableForSale: productNode?.availableForSale,
  };
  mapped.availableForSale = resolveListProductAvailableForSale(mapped);
  return mapped;
}

function getProductNodes(products: any) {
  if (Array.isArray(products?.nodes)) return products.nodes;
  if (Array.isArray(products?.edges)) return products.edges.map((edge: any) => edge?.node).filter(Boolean);
  return [];
}

function normalizeCollectionNode(node: any): CategoryCollection {
  const previewProducts: CategoryProduct[] = getProductNodes(node?.products).map(
    (productNode: any, index: number) => normalizeProductNode(productNode, `${node?.id || 'product'}-${index}`)
  );
  const collectionImage = String(node?.image?.url || node?.imageUrl || '').trim();
  const firstProductNode = getProductNodes(node?.products)[0];
  const firstFeaturedImage = String(firstProductNode?.featuredImage?.url || '').trim();
  const firstEdgeImage = String(firstProductNode?.images?.edges?.[0]?.node?.url || '').trim();
  const firstProductImage =
    (isRealProductImage(firstFeaturedImage) ? firstFeaturedImage : '') ||
    (isRealProductImage(firstEdgeImage) ? firstEdgeImage : '') ||
    previewProducts.find((product) => isRealProductImage(product.image))?.image ||
    '';
  const fallbackImage = String(node?.fallbackImage || '').trim() || firstProductImage || null;
  const displayImage = String(node?.displayImage || '').trim() || null;
  const productsCount = Number(
    node?.productsCount ?? node?.products?.edges?.length ?? node?.products?.nodes?.length ?? 0
  );
  const normalizedHandle = String(node?.handle || '').trim();

  if (normalizedHandle === 'glo-gang') {
    categoriesPerfLog('[CATEGORY_IMAGE_TEST]', {
      title: String(node?.title || 'Collection'),
      handle: normalizedHandle,
      image: isRealProductImage(collectionImage) ? collectionImage : null,
      fallbackImage,
      displayImage,
      productsCount,
    });
  }

  return {
    id: String(node?.id || Math.random()),
    title: String(node?.title || 'Collection'),
    handle: normalizedHandle,
    image: isRealProductImage(collectionImage) ? collectionImage : '',
    fallbackImage,
    displayImage,
    productsCount,
    previewProducts,
  };
}

function normalizeCollection(edge: any): CategoryCollection {
  return normalizeCollectionNode(edge?.node || edge || {});
}

type CategorySearchCategoryResult = {
  id: string;
  title: string;
  subtitle: string;
  groupId: string;
  item?: MenuCategoryItem;
  score: number;
};

type CategorySearchResults = {
  categories: CategorySearchCategoryResult[];
  products: CategoryProduct[];
};

function normalizeSearchText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getSearchTokens(value: string) {
  return normalizeSearchText(value).split(/\s+/).filter(Boolean);
}

function levenshteinDistance(a: string, b: string, maxDistance = 2) {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
      rowMin = Math.min(rowMin, current[j]);
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function fieldMatchesQuery(fieldText: string, queryTokens: string[]) {
  const normalized = normalizeSearchText(fieldText);
  if (!normalized || !queryTokens.length) return false;
  const fieldTokens = getSearchTokens(normalized);

  return queryTokens.every((queryToken) => {
    if (normalized.includes(queryToken)) return true;
    return fieldTokens.some((fieldToken) => {
      if (fieldToken.includes(queryToken) || queryToken.includes(fieldToken)) return true;
      if (queryToken.length < 4 || fieldToken.length < 4) return false;
      return levenshteinDistance(queryToken, fieldToken, 2) <= 2;
    });
  });
}

function scoreSearchField(fieldText: string, query: string, queryTokens: string[]) {
  const normalized = normalizeSearchText(fieldText);
  if (!normalized) return 0;
  if (normalized === query) return 100;
  if (normalized.startsWith(query)) return 80;
  if (normalized.includes(query)) return 65;
  return fieldMatchesQuery(normalized, queryTokens) ? 42 : 0;
}

function getProductSearchText(product: CategoryProduct) {
  const variantTitles = (product.variants?.edges || [])
    .map((edge: any) => edge?.node?.title)
    .filter(Boolean);
  const optionValues = (product.variants?.edges || [])
    .flatMap((edge: any) => edge?.node?.selectedOptions || [])
    .flatMap((option: any) => [option?.name, option?.value])
    .filter(Boolean);

  return [
    product.title,
    product.handle,
    product.brand,
    product.vendor,
    product.productType,
    product.category,
    product.groupTitle,
    product.sourceSubcategoryTitle,
    ...(product.tags || []),
    ...(product.collectionHandles || []),
    ...(variantTitles || []),
    ...(optionValues || []),
  ]
    .filter(Boolean)
    .join(' ');
}

function scoreProductSearch(product: CategoryProduct, query: string, queryTokens: string[]) {
  return Math.max(
    scoreSearchField(product.title, query, queryTokens) + 15,
    scoreSearchField(product.handle, query, queryTokens) + 10,
    scoreSearchField(getProductSearchText(product), query, queryTokens)
  );
}

function dedupeProductsByHandle(products: CategoryProduct[]) {
  const seen = new Set<string>();
  const deduped: CategoryProduct[] = [];

  products.forEach((product) => {
    const key = product.handle || product.id;
    if (!key || seen.has(key)) return;
    seen.add(key);
    deduped.push(product);
  });

  return deduped;
}

type CameraSearchSignals = {
  detectedText: string;
  detectedBrand: string;
  detectedCategory: string;
  colors: string[];
  styles: string[];
  labels: string[];
  searchTerms: string[];
  confidence: number;
};

const CAMERA_SEARCH_BRAND_HINTS = [
  'nike',
  'adidas',
  'new balance',
  'prada',
  'chrome hearts',
  'chrome of hearts',
  'essentials',
  'fear of god',
  'glo gang',
  'off white',
  'offwhite',
  'sp5der',
  'hellstar',
  'gallery dept',
  'casablanca',
  'rhude',
];

const CAMERA_CATEGORY_SYNONYMS: Record<string, string[]> = {
  shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'footwear', 'boot', 'boots'],
  fragrance: ['cologne', 'perfume', 'fragrance', 'scent', 'spray', 'bottle'],
  bags: ['bag', 'bags', 'purse', 'handbag', 'backpack', 'tote'],
  clothing: ['shirt', 'hoodie', 'pants', 'jeans', 'jacket', 'dress', 'clothing', 'apparel', 'shorts'],
  watches: ['watch', 'watches', 'timepiece'],
  electronics: ['phone', 'tablet', 'camera', 'electronics', 'headphone', 'speaker'],
  beauty: ['beauty', 'makeup', 'cosmetic', 'cosmetics', 'hair', 'wig'],
  machinery: ['excavator', 'tractor', 'loader', 'machinery', 'construction', 'machine'],
};

function normalizeCameraSearchPayload(payload: any): CameraSearchSignals {
  const detectedText = String(
    payload?.detectedText ||
      payload?.text ||
      payload?.ocrText ||
      payload?.analysis?.detectedText ||
      payload?.analysis?.ocrText ||
      ''
  ).trim();
  const labels = [
    ...(Array.isArray(payload?.labels) ? payload.labels : []),
    ...(Array.isArray(payload?.objects) ? payload.objects : []),
    ...(Array.isArray(payload?.analysis?.labels) ? payload.analysis.labels : []),
    ...(Array.isArray(payload?.analysis?.objects) ? payload.analysis.objects : []),
  ].map(String).filter(Boolean);
  const colors = [
    ...(Array.isArray(payload?.colors) ? payload.colors : []),
    ...(Array.isArray(payload?.analysis?.colors) ? payload.analysis.colors : []),
  ].map(String).filter(Boolean);
  const styles = [
    ...(Array.isArray(payload?.styles) ? payload.styles : []),
    ...(Array.isArray(payload?.analysis?.styles) ? payload.analysis.styles : []),
  ].map(String).filter(Boolean);
  const blob = normalizeSearchText([
    detectedText,
    payload?.detectedBrand,
    payload?.brand,
    payload?.analysis?.detectedBrand,
    payload?.analysis?.brand,
    payload?.detectedCategory,
    payload?.category,
    payload?.analysis?.detectedCategory,
    payload?.analysis?.category,
    ...labels,
  ].join(' '));

  const detectedBrand = String(
    payload?.detectedBrand ||
      payload?.brand ||
      payload?.analysis?.detectedBrand ||
      payload?.analysis?.brand ||
      CAMERA_SEARCH_BRAND_HINTS.find((brand) => blob.includes(normalizeSearchText(brand))) ||
      ''
  ).trim();

  let detectedCategory = String(
    payload?.detectedCategory ||
      payload?.category ||
      payload?.analysis?.detectedCategory ||
      payload?.analysis?.category ||
      ''
  ).trim();

  if (!detectedCategory) {
    detectedCategory =
      Object.entries(CAMERA_CATEGORY_SYNONYMS).find(([, words]) =>
        words.some((word) => blob.includes(word))
      )?.[0] || '';
  }

  const searchTerms = [
    detectedBrand,
    detectedCategory,
    detectedText,
    ...labels.slice(0, 5),
    ...styles.slice(0, 3),
    ...colors.slice(0, 3),
    ...(Array.isArray(payload?.searchTerms) ? payload.searchTerms : []),
    ...(Array.isArray(payload?.analysis?.searchTerms) ? payload.analysis.searchTerms : []),
  ]
    .map((term) => normalizeSearchText(term))
    .filter(Boolean)
    .filter((term, index, list) => list.indexOf(term) === index)
    .slice(0, 8);

  const confidence = Number(payload?.confidence ?? payload?.analysis?.confidence ?? 0);

  return {
    detectedText,
    detectedBrand,
    detectedCategory,
    colors,
    styles,
    labels,
    searchTerms,
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

function arrayFromImageSearchValue(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.edges)) return value.edges;
  if (Array.isArray(value?.nodes)) return value.nodes;
  return [];
}

function extractImageSearchProductEntries(payload: any): any[] {
  const candidates = [
    payload?.data?.products,
    payload?.products,
    payload?.data?.matches,
    payload?.matches,
    payload?.data?.results,
    payload?.results,
    payload?.data?.items,
    payload?.items,
    payload?.data?.product ? [payload.data.product] : null,
    payload?.product ? [payload.product] : null,
  ];

  const entries = candidates.flatMap(arrayFromImageSearchValue);
  const seen = new Set<string>();

  return entries.filter((entry) => {
    const product = getImageSearchEntryProduct(entry);
    const key =
      String(product?.handle || '').trim() ||
      String(product?.id || '').trim() ||
      String(entry?.handle || entry?.id || '').trim();
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getImageSearchEntryProduct(entry: any) {
  return (
    entry?.node ||
    entry?.product ||
    entry?.item ||
    entry?.shopifyProduct ||
    entry?.matchedProduct ||
    entry
  );
}

function getImageSearchEntryScore(entry: any, product: any, index: number) {
  const explicitScore = Number(
    entry?.score ??
      entry?.similarity ??
      entry?.visualScore ??
      entry?.confidence ??
      entry?.matchScore ??
      product?.score ??
      product?.similarity ??
      product?.visualScore ??
      product?.confidence ??
      product?.matchScore ??
      0
  );
  if (Number.isFinite(explicitScore) && explicitScore > 0) {
    return explicitScore <= 1 ? explicitScore * 100 : explicitScore;
  }

  const distance = Number(entry?.distance ?? product?.distance ?? NaN);
  if (Number.isFinite(distance) && distance >= 0) {
    return Math.max(100 - distance * 100, 1);
  }

  return Math.max(98 - index * 3, 60);
}

function getImageSearchEntryReason(entry: any, product: any) {
  return String(
    entry?.matchReason ||
      entry?.reason ||
      entry?.matchType ||
      product?.matchReason ||
      product?.reason ||
      product?.matchType ||
      'visual match'
  );
}

function productMatchesDetectedCategory(product: CategoryProduct, detectedCategory: string) {
  const category = normalizeSearchText(detectedCategory);
  if (!category) return true;
  const synonyms = CAMERA_CATEGORY_SYNONYMS[category] || [category];
  const text = normalizeSearchText(getProductSearchText(product));
  return synonyms.some((word) => text.includes(normalizeSearchText(word)));
}

function scoreCameraProduct(product: CategoryProduct, signals: CameraSearchSignals) {
  const text = normalizeSearchText(getProductSearchText(product));
  const title = normalizeSearchText(product.title);
  const rawVisualScore = Number(product.score || 0);
  const visualScore =
    rawVisualScore > 0 && rawVisualScore <= 1 ? rawVisualScore * 100 : rawVisualScore;
  let score = visualScore > 0 ? Math.min(visualScore, 110) : 0;
  const reasons: string[] = [];

  if (product.visualCandidate) {
    score += Math.max(150 - Number(product.imageSearchRank || 0) * 6, 90);
    reasons.push('visual match');
  }

  const brand = normalizeSearchText(signals.detectedBrand);
  if (brand && text.includes(brand)) {
    score += title.includes(brand) ? 90 : 75;
    reasons.push('brand match');
  }

  if (signals.detectedCategory && productMatchesDetectedCategory(product, signals.detectedCategory)) {
    score += 55;
    reasons.push('category match');
  } else if (signals.detectedCategory) {
    score -= 80;
  }

  const queryTokens = getSearchTokens(signals.searchTerms.join(' '));
  const titleScore = Math.max(
    ...signals.searchTerms.map((term) => scoreSearchField(product.title, term, getSearchTokens(term))),
    0
  );
  if (titleScore > 0 || fieldMatchesQuery(text, queryTokens)) {
    score += Math.max(titleScore, 35);
    reasons.push('title match');
  }

  if (visualScore > 0) {
    score += Math.min(visualScore, 65);
    reasons.push('visual match');
  }

  const colorStyleMatches = [...signals.colors, ...signals.styles].filter((term) =>
    text.includes(normalizeSearchText(term))
  ).length;
  if (colorStyleMatches) {
    score += Math.min(colorStyleMatches * 10, 30);
  }

  if (!reasons.length) {
    reasons.push('fallback');
  }

  return {
    ...product,
    score: Math.max(0, Math.round(score)),
    matchReason: reasons[0],
  };
}

function rankCameraSearchProducts(products: CategoryProduct[], signals: CameraSearchSignals) {
  const deduped = dedupeProductsByHandle(products);
  const hasVisualCandidates = deduped.some((product) => Number(product.score || 0) > 0);
  const hasUsefulSignal = Boolean(
    signals.detectedBrand ||
      signals.detectedCategory ||
      signals.detectedText ||
      signals.searchTerms.length ||
      signals.labels.length ||
      hasVisualCandidates
  );
  const categoryAware = signals.detectedCategory
    ? deduped.filter((product) => {
        const rawVisualScore = Number(product.score || 0);
        const visualScore =
          rawVisualScore > 0 && rawVisualScore <= 1 ? rawVisualScore * 100 : rawVisualScore;
        return (
          product.visualCandidate ||
          productMatchesDetectedCategory(product, signals.detectedCategory) ||
          visualScore >= 75
        );
      })
    : deduped;
  const pool = categoryAware.length >= 3 ? categoryAware : deduped;

  const ranked = pool
    .map((product) => scoreCameraProduct(product, signals))
    .filter((product) => product.score && product.score > (signals.confidence < 0.25 && !hasVisualCandidates ? 45 : 10))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  if (!ranked.length && !hasUsefulSignal) {
    return [];
  }

  return ranked.length ? ranked : pool.slice(0, 12).map((product) => ({
    ...product,
    score: 1,
    matchReason: 'fallback',
  }));
}

function buildCategorySearchResults(
  groups: MenuCategoryGroup[],
  searchText: string,
  remoteProducts: CategoryProduct[] = [],
  showRemoteProductsDirectly = false
): CategorySearchResults {
  const query = normalizeSearchText(searchText);
  const queryTokens = getSearchTokens(query);
  if (!queryTokens.length && !showRemoteProductsDirectly) return { categories: [], products: [] };

  const categories: CategorySearchCategoryResult[] = [];
  const products: Array<CategoryProduct & { __score?: number }> = [];

  if (queryTokens.length) {
    groups.forEach((group) => {
      const groupScore = Math.max(
        scoreSearchField(group.title, query, queryTokens),
        scoreSearchField(group.handle, query, queryTokens)
      );

      if (groupScore > 0) {
        categories.push({
          id: `group-${group.id}`,
          title: group.title,
          subtitle: 'Main category',
          groupId: group.id,
          score: groupScore + 20,
        });
      }

      group.items.forEach((item) => {
        const itemScore = Math.max(
          scoreSearchField(item.title, query, queryTokens),
          scoreSearchField(item.handle, query, queryTokens)
        );

        if (itemScore > 0) {
          categories.push({
            id: `item-${group.id}-${item.id}-${item.handle}`,
            title: item.title,
            subtitle: group.title,
            groupId: group.id,
            item,
            score: itemScore + 10,
          });
        }

        (item.previewProducts || []).forEach((product) => {
          const enrichedProduct = {
            ...product,
            groupId: group.id,
            groupTitle: group.title,
            sourceSubcategoryTitle: item.title,
          };
          const productScore = scoreProductSearch(enrichedProduct, query, queryTokens);
          if (productScore > 0) {
            products.push({ ...enrichedProduct, __score: productScore });
          }
        });
      });
    });
  }

  remoteProducts.forEach((product) => {
    const productScore = showRemoteProductsDirectly
      ? Number(product.score || 0) + 500
      : Math.max(scoreProductSearch(product, query, queryTokens), Number(product.score || 0));
    if (productScore > 0) {
      products.push({ ...product, __score: productScore + 8 });
    }
  });

  return {
    categories: categories
      .sort((a, b) => b.score - a.score)
      .slice(0, 12),
    products: dedupeProductsByHandle(
      products.sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0))
    ).slice(0, 48),
  };
}

function getCategoryBubbleImage(item: MenuCategoryItem, mainTitle: string) {
  const image = getScopedCategoryBubbleImage(item as ScopedCategoryItem, mainTitle);
  return isRealProductImage(image) ? image : '';
}

function getCategoryBubbleBadge(item: MenuCategoryItem, index: number) {
  const label = normalizeMenuTitle(`${item.title} ${item.handle}`);
  if (/\b(deal|deals|sale|clearance|offer)\b/.test(label)) {
    return 'Deals';
  }
  if (/\b(new|latest|just in)\b/.test(label)) {
    return 'NEW';
  }
  if (index % 3 === 0) {
    return SHOP_BY_CATEGORY_BADGES[index % SHOP_BY_CATEGORY_BADGES.length];
  }
  if (index % 3 === 1) {
    return SHOP_BY_CATEGORY_BADGES[(index + 1) % SHOP_BY_CATEGORY_BADGES.length];
  }
  return null;
}

function getCollectionHandleFromMenuItem(item: any) {
  const resourceHandle = String(item?.resource?.handle || '').trim();
  if (resourceHandle) return resourceHandle;

  const url = String(item?.url || '').trim();
  if (!url) return '';

  const match = url.match(/\/collections\/([^/?#]+)/i);
  if (match?.[1]) return decodeURIComponent(match[1]).trim();

  return '';
}

function buildMenuItemFromCollection(item: any, index: number): MenuCategoryItem | null {
  const resource = item?.resource || {};
  const handle = getCollectionHandleFromMenuItem(item);
  if (!handle) return null;

  const collection = normalizeCollectionNode({
    ...resource,
    handle,
    title: resource?.title || item?.title,
  });

  return {
    id: String(resource?.id || `${handle}-${index}`),
    title: String(item?.title || collection.title || handle),
    handle,
    image: collection.displayImage || collection.image || collection.fallbackImage || '',
    fallbackImage: collection.fallbackImage,
    displayImage: collection.displayImage,
    productsCount: collection.productsCount,
    previewProducts: collection.previewProducts,
  };
}

function getNestedMenuItems(item: any) {
  const directChildren = Array.isArray(item?.items) ? item.items : [];
  const allChildren: any[] = [];

  directChildren.forEach((child: any) => {
    allChildren.push(child);

    if (Array.isArray(child?.items) && child.items.length) {
      child.items.forEach((grandChild: any) => {
        allChildren.push(grandChild);
      });
    }
  });

  return allChildren;
}

function dedupeMenuItemsByHandle(items: MenuCategoryItem[]) {
  const seenHandles = new Set<string>();
  return items.filter((item) => {
    if (!item.handle) return false;
    if (seenHandles.has(item.handle)) return false;

    seenHandles.add(item.handle);
    return true;
  });
}

function normalizeMenuTitle(title?: string | null) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getCategoryIcon(title?: string | null): React.ComponentProps<typeof Ionicons>['name'] {
  const normalized = normalizeMenuTitle(title);

  if (normalized.includes('women')) return 'woman-outline';
  if (normalized.includes('men')) return 'person-outline';
  if (normalized.includes('kid') || normalized.includes('baby')) return 'happy-outline';
  if (normalized.includes('shoe')) return 'walk-outline';
  if (normalized.includes('bag')) return 'bag-handle-outline';
  if (normalized.includes('electronic') || normalized.includes('audio')) return 'headset-outline';
  if (normalized.includes('accessor') || normalized.includes('watch')) return 'watch-outline';
  if (normalized.includes('beauty')) return 'sparkles-outline';
  if (normalized.includes('home') || normalized.includes('kitchen')) return 'home-outline';

  return 'grid-outline';
}

function isMainCategoryTitle(title?: string | null) {
  const normalized = normalizeMenuTitle(title);
  return Boolean(normalized && !NON_CATEGORY_MENU_KEYS.has(normalized));
}

function getMainCategoryDisplayTitle(title?: string | null) {
  const normalized = normalizeMenuTitle(title);
  return WEBSITE_MAIN_CATEGORY_TITLES.find((mainTitle) => normalizeMenuTitle(mainTitle) === normalized) ||
    String(title || 'Category');
}

function sortMainGroupsByWebsiteOrder(groups: MenuCategoryGroup[]) {
  const order = new Map(
    WEBSITE_MAIN_CATEGORY_TITLES.map((title, index) => [normalizeMenuTitle(title), index])
  );

  return [...groups].sort((a, b) => {
    const aOrder = order.get(normalizeMenuTitle(a.title)) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(normalizeMenuTitle(b.title)) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}

function createWebsiteMainCategoryGroups(): MenuCategoryGroup[] {
  return WEBSITE_MAIN_CATEGORY_TITLES.map((title) => {
    const key = normalizeMenuTitle(title);

    return {
      id: `main-category-${key}`,
      title,
      handle: key,
      items: [],
    };
  });
}

function getMainCategoryGroupKey(title?: string | null) {
  const normalized = normalizeMenuTitle(title);
  if (WEBSITE_MAIN_CATEGORY_KEYS.includes(normalized)) return normalized;

  const matchedTitle = findMainCategoryForCollection({ title: String(title || ''), handle: '' });
  return normalizeMenuTitle(matchedTitle);
}

function getCompactMatchKey(value?: string | null) {
  return normalizeMenuTitle(value).replace(/\b(and|of|the|a)\b/g, '').replace(/\s+/g, '');
}

function findBestCollectionMatch(
  config: { title: string; handle: string },
  collections: CategoryCollection[]
) {
  const configHandle = normalizeMenuTitle(config.handle);
  const configTitle = normalizeMenuTitle(config.title);
  const compactConfigTitle = getCompactMatchKey(config.title);
  const compactConfigHandle = getCompactMatchKey(config.handle);

  return collections.find((collection) => {
    const handle = normalizeMenuTitle(collection.handle);
    const title = normalizeMenuTitle(collection.title);
    const compactTitle = getCompactMatchKey(collection.title);
    const compactHandle = getCompactMatchKey(collection.handle);

    return (
      handle === configHandle ||
      title === configTitle ||
      compactTitle === compactConfigTitle ||
      compactHandle === compactConfigHandle ||
      compactTitle.includes(compactConfigTitle) ||
      compactConfigTitle.includes(compactTitle) ||
      compactHandle.includes(compactConfigHandle) ||
      compactConfigHandle.includes(compactHandle)
    );
  });
}

function applyWebsiteSubcategoryLists(
  groups: MenuCategoryGroup[],
  _collections: CategoryCollection[] = []
) {
  return sortMainGroupsByWebsiteOrder(groups).map((group) => {
    return {
      ...group,
      items: dedupeMenuItemsByHandle(group.items),
    };
  });
}

function buildGroupFromTopMenuItem(topItem: any, groupIndex: number): MenuCategoryGroup | null {
  const topCollectionItem = buildMenuItemFromCollection(topItem, 0);
  const nestedCollectionItems = getNestedMenuItems(topItem)
    .map((item: any, itemIndex: number) => buildMenuItemFromCollection(item, itemIndex))
    .filter(Boolean) as MenuCategoryItem[];

  const items = dedupeMenuItemsByHandle(
    nestedCollectionItems.length
      ? nestedCollectionItems
      : topCollectionItem
        ? [topCollectionItem]
        : []
  );

  if (!items.length) return null;

  return {
    id: String(topItem?.resource?.id || topItem?.id || topItem?.title || `menu-group-${groupIndex}`),
    title: getMainCategoryDisplayTitle(topItem?.title || topCollectionItem?.title || `Category ${groupIndex + 1}`),
    handle: getCollectionHandleFromMenuItem(topItem),
    items,
  };
}

function buildGroupsFromFlatMenu(topItems: any[]): MenuCategoryGroup[] {
  const groups: MenuCategoryGroup[] = [];
  let currentGroup: MenuCategoryGroup | null = null;

  topItems.forEach((topItem: any, index: number) => {
    const topTitle = String(topItem?.title || '').trim();
    const topCollectionItem = buildMenuItemFromCollection(topItem, index);
    const nestedCollectionItems = getNestedMenuItems(topItem)
      .map((item: any, itemIndex: number) => buildMenuItemFromCollection(item, itemIndex))
      .filter(Boolean) as MenuCategoryItem[];

    if (isMainCategoryTitle(topTitle)) {
      currentGroup = {
        id: String(topItem?.resource?.id || topItem?.id || `main-category-${normalizeMenuTitle(topTitle)}`),
        title: getMainCategoryDisplayTitle(topTitle),
        handle: getCollectionHandleFromMenuItem(topItem),
        items: [],
      };

      if (nestedCollectionItems.length) {
        currentGroup.items = dedupeMenuItemsByHandle(nestedCollectionItems);
      } else if (topCollectionItem) {
        // Keep the main collection as a right-side tile only when Shopify has no nested subcategories.
        currentGroup.items = [topCollectionItem];
      }

      groups.push(currentGroup);
      return;
    }

    // If Shopify menu is accidentally flat, treat non-main titles as subcategories
    // under the most recent main category instead of showing them on the left.
    if (currentGroup && topCollectionItem) {
      currentGroup.items = dedupeMenuItemsByHandle([
        ...currentGroup.items,
        topCollectionItem,
        ...nestedCollectionItems,
      ]);
    }
  });

  return groups.filter((group) => group.items.length > 0);
}

function buildGroupsFromMenu(menu: any): MenuCategoryGroup[] {
  const topItems = Array.isArray(menu?.items) ? menu.items : [];
  if (!topItems.length) return [];

  const menuGroups = topItems
    .filter((topItem: any) => {
      if (!isMainCategoryTitle(topItem?.title)) return false;
      const hasCollection = Boolean(getCollectionHandleFromMenuItem(topItem));
      const hasChildren = Array.isArray(topItem?.items) && topItem.items.length > 0;
      return hasCollection || hasChildren;
    })
    .map((topItem: any, groupIndex: number) => buildGroupFromTopMenuItem(topItem, groupIndex))
    .filter(Boolean) as MenuCategoryGroup[];

  if (menuGroups.length) return sortMainGroupsByWebsiteOrder(menuGroups);

  return sortMainGroupsByWebsiteOrder(buildGroupsFromFlatMenu(topItems));
}

function buildGroupsFromCollections(collections: CategoryCollection[]): MenuCategoryGroup[] {
  const built = buildCategoryGroupsFromCollections(collections);
  return built.groups as MenuCategoryGroup[];
}

function enrichMenuGroupsWithCollections(
  menuGroups: MenuCategoryGroup[],
  collections: CategoryCollection[]
) {
  return menuGroups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const collection = findBestCollectionMatch(
        { title: item.title, handle: item.handle },
        collections
      );
      if (!collection) return item;

      const collectionImage = isRealProductImage(collection.image) ? collection.image : '';
      const displayImage =
        (isRealProductImage(collection.displayImage) ? collection.displayImage : '') ||
        (isRealProductImage(item.displayImage) ? String(item.displayImage) : '');
      const fallbackImage =
        (isRealProductImage(collection.fallbackImage) ? collection.fallbackImage : '') ||
        (isRealProductImage(item.fallbackImage) ? String(item.fallbackImage) : '') ||
        collection.previewProducts.find((product) => isRealProductImage(product.image))?.image ||
        '';

      return {
        ...item,
        title: item.title || collection.title,
        handle: collection.handle || item.handle,
        image: collectionImage || item.image || '',
        fallbackImage: fallbackImage || null,
        displayImage: displayImage || null,
        productsCount: collection.productsCount ?? item.productsCount,
        previewProducts: collection.previewProducts.length
          ? collection.previewProducts
          : item.previewProducts,
      };
    }),
  }));
}

function normalizeGroupsToWebsiteMainCategories(groups: MenuCategoryGroup[]) {
  const sourceGroups = Array.isArray(groups) ? groups : [];

  const groupsByKey = new Map(
    createWebsiteMainCategoryGroups().map((group) => [normalizeMenuTitle(group.title), group])
  );

  sourceGroups.forEach((group) => {
    const groupItems = Array.isArray(group.items) ? group.items : [];
    const groupKey = getMainCategoryGroupKey(group.title);
    const mainGroup = groupsByKey.get(groupKey);

    if (mainGroup && isMainCategoryTitle(group.title)) {
      mainGroup.handle = group.handle || mainGroup.handle;
      mainGroup.items.push(...groupItems);

      if (!groupItems.length && group.handle) {
        mainGroup.items.push({
          id: `${group.id || group.handle}-main-item`,
          title: group.title,
          handle: group.handle,
          image: '',
          previewProducts: [],
        });
      }
      return;
    }

    const fallbackGroup = groupsByKey.get(groupKey);
    if (!fallbackGroup) return;

    if (groupItems.length) {
      fallbackGroup.items.push(...groupItems);
      return;
    }

    if (group.handle) {
      fallbackGroup.items.push({
        id: `${group.id || group.handle}-legacy-item`,
        title: group.title,
        handle: group.handle,
        image: '',
        previewProducts: [],
      });
    }
  });

  return applyWebsiteSubcategoryLists(
    Array.from(groupsByKey.values()).map((group) => ({
      ...group,
      items: dedupeMenuItemsByHandle(group.items),
    }))
  );
}

export default function CategoriesScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const { isSignedIn, profileId } = useUser();
  const { width } = useWindowDimensions();
  const isDesktop = width >= 768;
  const isTablet = width >= 700 && width < 768;
  const isMobile = width < 700;
  const [groups, setGroups] = useState<MenuCategoryGroup[]>(getInitialCategoryGroups);
  const groupsRef = useRef<MenuCategoryGroup[]>(getInitialCategoryGroups());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collectionMappingSource, setCollectionMappingSource] = useState<CategoryMappingSource>('default');
  const [menMatchedHandles, setMenMatchedHandles] = useState<string[]>([]);
  const [allCollectionCount, setAllCollectionCount] = useState(0);
  const [heroSlideIndex, setHeroSlideIndex] = useState(0);
  const [visibleGridCount, setVisibleGridCount] = useState(12);
  const [search, setSearch] = useState('');
  const [remoteSearchProducts, setRemoteSearchProducts] = useState<CategoryProduct[]>([]);
  const [searchingCatalog, setSearchingCatalog] = useState(false);
  const [cameraSearching, setCameraSearching] = useState(false);
  const [cameraModalVisible, setCameraModalVisible] = useState(false);
  const [galleryPreviewPhoto, setGalleryPreviewPhoto] = useState<CameraSearchPhoto | null>(null);
  const [cameraSearchHeading, setCameraSearchHeading] = useState('');
  const [activeGroupId, setActiveGroupId] = useState(
    () =>
      categoriesSessionSnapshot?.activeGroupId ||
      getInitialCategoryGroups()[0]?.id ||
      ''
  );
  const panelScrollRef = useRef<FlatList<CategoryProduct> | ScrollView | null>(null);
  const railScrollRef = useRef<FlatList<{ id: string; title: string }> | null>(null);
  const searchInputRef = useRef<TextInput | null>(null);
  const searchRequestSeqRef = useRef(0);
  const cameraSearchActiveRef = useRef(false);
  const panelScrollOffsetRef = useRef(categoriesSessionSnapshot?.scrollOffset ?? 0);
  const railScrollOffsetRef = useRef(categoriesSessionSnapshot?.railScrollOffset ?? 0);
  const restoredPanelScrollRef = useRef(false);
  const restoredRailScrollRef = useRef(false);
  const categoriesLoadGenerationRef = useRef(0);
  const lastCategoriesFocusLoadRef = useRef(0);

  const persistCategoriesSessionSnapshot = useCallback(() => {
    if (!groupsRef.current.length) return;

    categoriesSessionSnapshot = {
      groups: groupsRef.current,
      activeGroupId,
      scrollOffset: panelScrollOffsetRef.current,
      railScrollOffset: railScrollOffsetRef.current,
      savedAt: Date.now(),
      version: CATEGORY_CACHE_VERSION,
    };
  }, [activeGroupId]);

  const scrollPanelToTop = useCallback((animated = false) => {
    panelScrollOffsetRef.current = 0;
    requestAnimationFrame(() => {
      const panel = panelScrollRef.current as
        | (FlatList<CategoryProduct> & { scrollTo?: (options: { y: number; animated?: boolean }) => void })
        | (ScrollView & { scrollToOffset?: (options: { offset: number; animated?: boolean }) => void })
        | null;

      if (!panel) return;

      if (typeof (panel as FlatList<CategoryProduct>).scrollToOffset === 'function') {
        (panel as FlatList<CategoryProduct>).scrollToOffset({ offset: 0, animated });
        return;
      }

      if (typeof (panel as ScrollView).scrollTo === 'function') {
        (panel as ScrollView).scrollTo({ y: 0, animated });
      }
    });
  }, []);

  const handleSelectCategory = useCallback(
    (groupId: string) => {
      if (!groupId || groupId === activeGroupId) return;

      setActiveGroupId(groupId);
      scrollPanelToTop(false);
    },
    [activeGroupId, scrollPanelToTop]
  );

  useEffect(() => {
    const unsubscribe = (navigation as any).addListener('tabPress', () => {
      if (!navigation.isFocused()) return;
      scrollPanelToTop(true);
    });

    return unsubscribe;
  }, [navigation, scrollPanelToTop]);

  useEffect(() => {
    categoriesPerfLog('[NOOD categories] screen mounted');
    categoriesPerfLog('[NOOD categories] using explicit men map immediately', {
      menSubcategoryCount: MEN_DROPDOWN_DEFINITIONS.length,
    });
    const initialMenStats = countMenImageStats(groupsRef.current);
    categoriesPerfLog('[NOOD categories] men subcategories visible count', initialMenStats.visibleCount);
    categoriesPerfLog('[NOOD categories] cached men image urls count', countMenImageUrlEntries(memoryCategoryImageUrls));
    categoriesPerfLog('[NOOD categories] cached men images count', initialMenStats.cachedImages);
    categoriesPerfLog('[NOOD categories] image placeholders count', initialMenStats.placeholders);

    void (async () => {
      await clearStaleCategoriesCaches();
      const [imageUrlMap, hydrated] = await Promise.all([
        hydrateCategoryImageCacheFromStorage(),
        hydrateCategoriesFromCache(),
      ]);
      const { groups: cachedGroups, source } = hydrated;

      memoryCategoryImageUrls = {
        ...memoryCategoryImageUrls,
        ...imageUrlMap,
      };
      hydrateMemoryCategoryImageUrls(cachedGroups);

      const hydratedMenStats = countMenImageStats(cachedGroups);
      categoriesPerfLog('[NOOD categories] cache loaded count', {
        count: cachedGroups.length,
        source,
      });
      categoriesPerfLog('[NOOD categories] cached men image urls count', countMenImageUrlEntries(memoryCategoryImageUrls));
      categoriesPerfLog('[NOOD categories] men subcategories visible count', hydratedMenStats.visibleCount);
      categoriesPerfLog('[NOOD categories] cached men images count', hydratedMenStats.cachedImages);
      categoriesPerfLog('[NOOD categories] image placeholders count', hydratedMenStats.placeholders);

      const merged = mergeCategoryGroupsPreservingContent(groupsRef.current, cachedGroups);
      const mergedGroups = applyCategoryImageUrlsToGroups(merged.groups, memoryCategoryImageUrls);
      hydrateMemoryCategoryImageUrls(mergedGroups);
      logCategoryImageTestFromGroups(mergedGroups);

      if (merged.preservedImageCount > 0) {
        categoriesPerfLog(
          '[NOOD categories] refresh did not overwrite cached image with blank',
          merged.preservedImageCount
        );
      }

      setGroups(mergedGroups);
      setActiveGroupId((current) => {
        if (mergedGroups.some((group) => group.id === current)) return current;
        return mergedGroups[0]?.id || '';
      });
      setCollectionMappingSource(
        source === 'storage' ? 'cache' : source === 'session' ? 'cache' : 'default'
      );
      setLoading(false);
      categoriesPerfLog('[NOOD categories] loading false', { source: 'cache-first' });
    })();
  }, []);

  useEffect(() => {
    groupsRef.current = groups;
    if (!groups.length) return;
    persistCategoriesSessionSnapshot();
  }, [activeGroupId, groups, persistCategoriesSessionSnapshot]);

  useEffect(() => {
    if (restoredPanelScrollRef.current || !groups.length) return;
    if (!categoriesSessionSnapshot || categoriesSessionSnapshot.scrollOffset <= 0) return;

    restoredPanelScrollRef.current = true;
    requestAnimationFrame(() => {
      const panel = panelScrollRef.current;
      const offset = categoriesSessionSnapshot?.scrollOffset ?? 0;
      if (!panel) return;

      if ('scrollToOffset' in panel && typeof panel.scrollToOffset === 'function') {
        panel.scrollToOffset({ offset, animated: false });
        return;
      }

      if ('scrollTo' in panel && typeof panel.scrollTo === 'function') {
        panel.scrollTo({ y: offset, animated: false });
      }
    });
  }, [groups.length]);

  useEffect(() => {
    if (restoredRailScrollRef.current || !groups.length) return;
    if (!categoriesSessionSnapshot || (categoriesSessionSnapshot.railScrollOffset ?? 0) <= 0) return;

    restoredRailScrollRef.current = true;
    requestAnimationFrame(() => {
      railScrollRef.current?.scrollToOffset({
        offset: categoriesSessionSnapshot?.railScrollOffset ?? 0,
        animated: false,
      });
    });
  }, [groups.length]);

  const openCategoryTarget = useCallback(
    (item?: MenuCategoryItem | null) => {
      if (!item) return;

      persistCategoriesSessionSnapshot();

      if (item.handle) {
        void recordCategoryBrowse(
          { profileId: profileId || 'guest', isSignedIn },
          item.handle,
          item.title
        );

        router.push({
          pathname: '/collection/[handle]',
          params: { handle: item.handle, from: 'categories' },
        });
        return;
      }

      const fallbackProductHandle = item.previewProducts?.[0]?.handle;
      if (!fallbackProductHandle) return;

      const previewProduct = item.previewProducts?.[0];
      router.push({
        pathname: '/product/[handle]',
        params: buildProductRouteParams(
          previewProduct || { handle: fallbackProductHandle },
          { from: 'categories' }
        ) as any,
      });
    },
    [isSignedIn, persistCategoriesSessionSnapshot, profileId, router]
  );

  const fetchCategoriesMenu = useCallback(async (forceRefresh = false) => {
    for (const handle of SHOPIFY_CATEGORIES_MENU_HANDLES) {
      try {
        const json: any = await fetchCatalogPath(
          `/api/catalog/menus/${encodeURIComponent(handle)}`,
          { skipLocalCache: forceRefresh, timeoutMs: CATEGORIES_BACKEND_TIMEOUT_MS }
        );


        if (json?.errors?.length) {
          categoriesPerfLog(`Categories menu GraphQL error for ${handle}:`, json.errors);
        }

        const menu = json?.data?.menu;
        const groupsFromMenu = buildGroupsFromMenu(menu);

        categoriesPerfLog('Shopify menu check:', {
          handle,
          menuTitle: menu?.title || null,
          topItems: Array.isArray(menu?.items) ? menu.items.map((item: any) => item?.title) : [],
          nestedItems: Array.isArray(menu?.items)
            ? menu.items.map((item: any) => ({
                title: item?.title,
                children: Array.isArray(item?.items)
                  ? item.items.map((child: any) => ({
                      title: child?.title,
                      children: Array.isArray(child?.items)
                        ? child.items.map((grandChild: any) => grandChild?.title)
                        : [],
                    }))
                  : [],
              }))
            : [],
          groupsCount: groupsFromMenu.length,
        });

        if (groupsFromMenu.length) {
          return groupsFromMenu;
        }
      } catch (error) {
        categoriesPerfLog(`Categories menu load error for ${handle}:`, error);
      }
    }

    categoriesPerfLog('No Shopify navigation menu returned category groups. Falling back to all collections.');
    return [];
  }, []);

  const fetchCategoryCollections = useCallback(async (forceRefresh = false) => {
    const collections: CategoryCollection[] = [];
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
      if (json?.errors?.length) {
        categoriesPerfLog('Categories collections GraphQL error:', json.errors);
      }

      const pageCollections = (json?.data?.collections?.edges || [])
        .map(normalizeCollection)
        .filter((item: CategoryCollection) => item.handle);

      pageCollections.forEach((collection: CategoryCollection) => {
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
  }, []);

  const loadCategories = useCallback(async (forceRefresh = false) => {
    const loadGeneration = ++categoriesLoadGenerationRef.current;

    try {
      if (forceRefresh) {
        setRefreshing(true);
        setLoadError(null);
        categoriesPerfLog('[CATEGORIES CACHE] manual refresh started');
      }

      categoriesPerfLog('[NOOD categories] backend refresh start', { forceRefresh });
      categoriesPerfLog('[NOOD categories] backend fetch start', { forceRefresh });
      const [collections, menuGroups] = await Promise.all([
        fetchCategoryCollections(forceRefresh),
        fetchCategoriesMenu(forceRefresh),
      ]);
      categoriesPerfLog('[NOOD categories] backend fetch end', {
        collectionsCount: collections.length,
        menuGroupCount: menuGroups.length,
      });
      categoriesPerfLog('[NOOD categories] backend refresh end', {
        collectionsCount: collections.length,
        menuGroupCount: menuGroups.length,
      });
      categoriesPerfLog('[NOOD categories] collections count', collections.length);
      const backendUrl = getLastSuccessfulBackendUrl();
      if (backendUrl && backendUrl.includes('onrender.com')) {
        categoriesPerfLog('[NOOD categories] backend fallback used', { url: backendUrl });
      } else if (backendUrl) {
        categoriesPerfLog('[NOOD categories] backend candidate used', { url: backendUrl });
      }

      if (loadGeneration !== categoriesLoadGenerationRef.current) return;

      const enrichedMenuGroups = menuGroups.length
        ? enrichMenuGroupsWithCollections(menuGroups, collections)
        : [];

      const built = buildCategoryGroupsFromCollections(collections);
      setAllCollectionCount(built.allCollectionCount);
      setMenMatchedHandles(built.menMatchedHandles);

      let nextGroups: MenuCategoryGroup[] = built.groups as MenuCategoryGroup[];
      let mappingSource: CategoryMappingSource = enrichedMenuGroups.length
        ? 'shopify-menu'
        : built.mappingSource;

      if (enrichedMenuGroups.length) {
        const menuNormalized = normalizeGroupsToWebsiteMainCategories(enrichedMenuGroups);
        nextGroups = built.groups.map((group) => {
          if (group.title === 'Men') return group as MenuCategoryGroup;
          const menuGroup = menuNormalized.find((entry) => entry.title === group.title);
          if (menuGroup?.items?.length) return menuGroup;
          return group as MenuCategoryGroup;
        });
      }

      nextGroups = sanitizeCategoryGroups(nextGroups as ScopedCategoryGroup[]) as MenuCategoryGroup[];
      const mergedRefresh = mergeCategoryGroupsPreservingContent(groupsRef.current, nextGroups);
      nextGroups = applyCategoryImageUrlsToGroups(mergedRefresh.groups, memoryCategoryImageUrls);
      hydrateMemoryCategoryImageUrls(nextGroups);

      const backendMenImageUrls = extractCategoryImageUrlMap(nextGroups);
      const backendMenImageCount = countMenImageUrlEntries(backendMenImageUrls);
      categoriesPerfLog('[NOOD categories] backend imageUrl live', backendMenImageCount > 0);
      categoriesPerfLog('[NOOD categories] cached image map count', Object.keys(memoryCategoryImageUrls).length);
      categoriesPerfLog(
        '[NOOD categories] backend men image urls count',
        backendMenImageCount
      );
      MEN_DROPDOWN_DEFINITIONS.forEach((definition) => {
        const entry = backendMenImageUrls[definition.handle];
        const live = Boolean(isRealProductImage(entry?.url));
        categoriesPerfLog('[NOOD categories] backend imageUrl live', live, {
          handle: definition.handle,
        });
        if (entry?.url) {
          categoriesPerfLog('[NOOD categories] bubble image used', {
            handle: definition.handle,
            url: entry.url,
            source: entry.source || 'backend',
          });
        }
      });

      if (mergedRefresh.preservedImageCount > 0) {
        categoriesPerfLog(
          '[NOOD categories] refresh did not overwrite cached image with blank',
          mergedRefresh.preservedImageCount
        );
      }

      const refreshedMenStats = countMenImageStats(nextGroups);
      logCategoryImageTestFromGroups(nextGroups);
      categoriesPerfLog('[NOOD categories] men subcategories visible count', refreshedMenStats.visibleCount);
      categoriesPerfLog('[NOOD categories] cached men image urls count', countMenImageUrlEntries(memoryCategoryImageUrls));
      categoriesPerfLog('[NOOD categories] cached men images count', refreshedMenStats.cachedImages);
      categoriesPerfLog('[NOOD categories] image placeholders count', refreshedMenStats.placeholders);
      if (refreshedMenStats.placeholders > 0) {
        categoriesPerfLog('[NOOD categories] placeholder used reason', 'no-cached-or-backend-image');
        const menGroup = nextGroups.find((group) => group.title === 'Men');
        menGroup?.items.forEach((item) => {
          const resolved = resolveItemBubbleImage(item, 'Men');
          if (!isRealProductImage(resolved.url)) {
            categoriesPerfLog('[NOOD categories] placeholder used reason', {
              handle: item.handle,
              title: item.title,
              reason: 'missing-imageUrl',
            });
          }
        });
      }

      setCollectionMappingSource(mappingSource);
      categoriesPerfLog('[NOOD categories] menu source used:', mappingSource);
      categoriesPerfLog('[NOOD categories] all collection handles count', built.allCollectionCount);
      categoriesPerfLog('[NOOD categories] matched men menu handles', built.menMatchedHandles);
      const productCount = countCategoryPreviewProducts(nextGroups);
      categoriesPerfLog('[NOOD categories] products count', productCount);

      if (!nextGroups.length) {
        categoriesPerfLog('[NOOD categories] error', { reason: 'backend_empty' });
        if (!groupsRef.current.length) {
          const fallback = await hydrateCategoriesFromCache();
          setGroups(fallback.groups);
          setActiveGroupId(fallback.groups[0]?.id || '');
        }
        return;
      }

      categoriesPerfLog('[CATEGORIES CACHE] fresh backend categories loaded', {
        groupCount: nextGroups.length,
        collectionCount: collections.length,
        subcategoryHandles: nextGroups.flatMap((group) =>
          group.items.map((item) => item.handle).filter(Boolean)
        ),
      });

      const nextActiveGroupId = nextGroups[0]?.id || '';
      setGroups(nextGroups);
      setActiveGroupId((current) => {
        if (nextGroups.some((group) => group.id === current)) return current;
        return nextActiveGroupId;
      });
      setLoadError(null);

      await saveCategoriesCacheToStorage(nextGroups);
      categoriesPerfLog('[CATEGORIES CACHE] fresh cache saved', {
        version: CATEGORY_CACHE_VERSION,
        groupCount: nextGroups.length,
      });
    } catch (error) {
      categoriesPerfLog('[NOOD categories] error', {
        message: String((error as any)?.message || error || ''),
      });
      categoriesPerfLog('Categories load error:', error);

      if (loadGeneration !== categoriesLoadGenerationRef.current) return;

      if (groupsRef.current.length) {
        return;
      }

      try {
        const cached = await readCategoriesCacheFromStorage();
        if (cached.isValid && cached.groups.length) {
          categoriesPerfLog('[CATEGORIES CACHE] cache hit', {
            version: cached.version,
            savedAt: cached.savedAt,
            fresh: cached.isFresh,
          });
          setGroups(cached.groups);
          setActiveGroupId((current) => {
            if (cached.groups.some((group) => group.id === current)) return current;
            return cached.groups[0]?.id || '';
          });
          return;
        }

        const fallback = await hydrateCategoriesFromCache();
        setGroups(fallback.groups);
        setActiveGroupId(fallback.groups[0]?.id || '');
        setCollectionMappingSource(fallback.source === 'storage' ? 'cache' : 'default');
        setLoadError(
          fallback.source === 'default'
            ? 'Could not refresh categories. Showing default categories.'
            : null
        );
      } catch (cacheError) {
        categoriesPerfLog('[CATEGORIES CACHE] cache miss', { reason: 'cache_read_error', cacheError });
        const fallback = createSeededMainCategoryGroups() as MenuCategoryGroup[];
        setGroups(fallback);
        setActiveGroupId(fallback[0]?.id || '');
        setLoadError('Could not load categories. Showing default categories.');
      }
    } finally {
      if (loadGeneration === categoriesLoadGenerationRef.current) {
        setLoading(false);
        setRefreshing(false);
        categoriesPerfLog('[NOOD categories] loading false');
      }
    }
  }, [fetchCategoriesMenu, fetchCategoryCollections]);

  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      const shouldReload = now - lastCategoriesFocusLoadRef.current >= CATEGORIES_FOCUS_REFRESH_MS;

      if (shouldReload) {
        lastCategoriesFocusLoadRef.current = now;
        void loadCategories(false);
      }

      void ensureCatalogFreshness('category')
        .then((changed) => {
          if (changed) {
            void loadCategories(false);
          }
        })
        .catch(() => {});
    }, [loadCategories])
  );

  const fetchBackendCategorySearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const json: any = await fetchCatalogPath(
      `/api/catalog/search?q=${encodeURIComponent(trimmed)}&limit=48&first=48`,
      { skipLocalCache: true, timeoutMs: CATEGORIES_BACKEND_TIMEOUT_MS }
    );

    return (json?.data?.products?.edges || [])
      .map((edge: any, index: number) =>
        normalizeProductNode(edge?.node || edge, `category-search-${trimmed}-${index}`)
      )
      .filter((product: CategoryProduct) => product.handle);
  }, []);

  useEffect(() => {
    const query = search.trim();
    const requestId = searchRequestSeqRef.current + 1;
    searchRequestSeqRef.current = requestId;

    if (cameraSearchActiveRef.current) {
      setSearchingCatalog(false);
      return undefined;
    }

    if (!query) {
      setRemoteSearchProducts([]);
      setSearchingCatalog(false);
      setCameraSearchHeading('');
      return undefined;
    }

    setSearchingCatalog(true);
    const timer = setTimeout(() => {
      void fetchBackendCategorySearch(query)
        .then((products) => {
          if (searchRequestSeqRef.current !== requestId) return;
          setRemoteSearchProducts(products);
        })
        .catch((error) => {
          if (searchRequestSeqRef.current !== requestId) return;
          categoriesPerfLog('[NOOD categories] search backend error', {
            query,
            error: String((error as any)?.message || error),
          });
          setRemoteSearchProducts([]);
        })
        .finally(() => {
          if (searchRequestSeqRef.current === requestId) {
            setSearchingCatalog(false);
          }
        });
    }, 140);

    return () => clearTimeout(timer);
  }, [fetchBackendCategorySearch, search]);

  const handleFocusSearch = useCallback(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, []);

  const runImageSearchFromAsset = useCallback(
    async (asset: {
      uri: string;
      base64?: string | null;
      mimeType?: string;
      width?: number;
      height?: number;
    }) => {
      cameraSearchActiveRef.current = true;
      setSearch('Searching image...');
      setSearchingCatalog(true);
      setCameraSearching(true);
      setCameraSearchHeading('');

      let matched = false;

      try {
        const payload: any = await postBackendJson(
          '/api/catalog/image-search',
          {
            imageBase64: asset.base64 || '',
            image: asset.base64 || '',
            base64: asset.base64 || '',
            imageData: asset.base64 || '',
            dataUrl: asset.base64
              ? `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`
              : '',
            uri: asset.uri,
            mimeType: asset.mimeType || 'image/jpeg',
          },
          { timeoutMs: 30000 }
        );
        const signals = normalizeCameraSearchPayload(payload);
        const imageProductEntries = extractImageSearchProductEntries(payload);

        categoriesPerfLog('[CAMERA_SEARCH_RESPONSE]', {
          keys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
          dataKeys:
            payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data) : [],
          analysisKeys:
            payload?.analysis && typeof payload.analysis === 'object'
              ? Object.keys(payload.analysis)
              : [],
          productEntryCount: imageProductEntries.length,
          firstEntry: (() => {
            const firstProduct = getImageSearchEntryProduct(imageProductEntries[0] || {});
            return firstProduct
              ? {
                  title: firstProduct.title,
                  handle: firstProduct.handle,
                  score: getImageSearchEntryScore(imageProductEntries[0], firstProduct, 0),
                  reason: getImageSearchEntryReason(imageProductEntries[0], firstProduct),
                }
              : null;
          })(),
          asset: {
            width: asset.width,
            height: asset.height,
            mimeType: asset.mimeType || 'image/jpeg',
            base64Length: asset.base64?.length || 0,
          },
        });

        const products = imageProductEntries
          .map((edge: any, index: number) => {
            const productNode = getImageSearchEntryProduct(edge);
            const product = normalizeProductNode(productNode, `image-search-${index}`);
            const normalizedVisualScore = getImageSearchEntryScore(edge, productNode, index);
            return {
              ...product,
              score: normalizedVisualScore,
              matchReason: getImageSearchEntryReason(edge, productNode),
              visualCandidate: true,
              imageSearchRank: index,
            };
          })
          .filter((product: CategoryProduct) => product.handle);

        const searchTerms = signals.searchTerms.length
          ? signals.searchTerms
          : [signals.detectedBrand, signals.detectedCategory, signals.detectedText]
              .map((term) => normalizeSearchText(term))
              .filter(Boolean);

        const catalogResults = (
          await Promise.all(
            searchTerms.slice(0, 5).map((term) =>
              fetchBackendCategorySearch(term).catch(() => [])
            )
          )
        ).flat();

        const ranked = rankCameraSearchProducts([...products, ...catalogResults], signals).slice(0, 48);

        categoriesPerfLog('[CAMERA_SEARCH_DEBUG]', {
          detectedText: signals.detectedText,
          detectedBrand: signals.detectedBrand,
          detectedCategory: signals.detectedCategory,
          searchTerms,
          topMatches: ranked.slice(0, 10).map((product) => ({
            title: product.title,
            handle: product.handle,
            score: product.score,
            reason: product.matchReason,
            visualCandidate: product.visualCandidate,
          })),
        });

        if (ranked.length) {
          const strongestScore = Number(ranked[0]?.score || 0);
          const lowConfidence = signals.confidence > 0 ? signals.confidence < 0.35 : strongestScore < 85;
          setCameraSearchHeading(lowConfidence ? 'We found similar items' : 'Closest matches');
          cameraSearchActiveRef.current = true;
          setSearch(searchTerms[0] || signals.detectedCategory || signals.detectedBrand || 'Closest matches');
          setRemoteSearchProducts(ranked);
          matched = true;
        }
      } catch (error) {
        categoriesPerfLog('[NOOD categories] image search unavailable', {
          error: String((error as any)?.message || error),
        });
      } finally {
        setCameraSearching(false);
        setSearchingCatalog(false);
      }

      if (!matched) {
        cameraSearchActiveRef.current = false;
        setSearch('');
        Alert.alert('Image search coming soon');
      }
    },
    [fetchBackendCategorySearch]
  );

  const handlePickSearchImage = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Photo permission needed', 'Photo access is needed to search by image.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.7,
        base64: true,
      });

      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setGalleryPreviewPhoto({
        uri: asset.uri,
        base64: asset.base64 || undefined,
        mimeType: asset.mimeType || 'image/jpeg',
        width: asset.width,
        height: asset.height,
      });
    } catch (error) {
      categoriesPerfLog('[NOOD categories] library image search error', error);
    }
  }, []);

  const handleChooseAnotherGalleryPhoto = useCallback(() => {
    setGalleryPreviewPhoto(null);
    requestAnimationFrame(() => {
      void handlePickSearchImage();
    });
  }, [handlePickSearchImage]);

  const handleUseGalleryPhoto = useCallback(async () => {
    const photo = galleryPreviewPhoto;
    if (!photo) return;
    setGalleryPreviewPhoto(null);
    await runImageSearchFromAsset(photo);
  }, [galleryPreviewPhoto, runImageSearchFromAsset]);

  const handleCameraPhotoSelected = useCallback(
    async (photo: CameraSearchPhoto) => {
      await runImageSearchFromAsset(photo);
    },
    [runImageSearchFromAsset]
  );

  const handleCameraSearchPress = useCallback(() => {
    const openCamera = () => setCameraModalVisible(true);
    const openPhotos = () => void handlePickSearchImage();

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Search by image',
          options: ['Take Photo', 'Choose From Photos', 'Cancel'],
          cancelButtonIndex: 2,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) openCamera();
          if (buttonIndex === 1) openPhotos();
        }
      );
      return;
    }

    Alert.alert('Search by image', 'Choose how you want to search.', [
      { text: 'Take Photo', onPress: openCamera },
      { text: 'Choose From Photos', onPress: openPhotos },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [handlePickSearchImage]);

  const baseGroups = groups;

  const showingCameraResults = Boolean(cameraSearchHeading && remoteSearchProducts.length);
  const categorySearchResults = useMemo(
    () => buildCategorySearchResults(baseGroups, search, remoteSearchProducts, showingCameraResults),
    [baseGroups, remoteSearchProducts, search, showingCameraResults]
  );
  const isSearchingCategories = search.trim().length > 0;

  useEffect(() => {
    if (!showingCameraResults) return;
    categoriesPerfLog('[CAMERA_SEARCH_RENDER]', {
      remoteProducts: remoteSearchProducts.length,
      renderedProducts: categorySearchResults.products.length,
      search,
      heading: cameraSearchHeading,
      topRendered: categorySearchResults.products.slice(0, 5).map((product) => ({
        title: product.title,
        handle: product.handle,
        score: product.score,
        reason: product.matchReason,
        visualCandidate: product.visualCandidate,
      })),
    });
  }, [
    cameraSearchHeading,
    categorySearchResults.products,
    remoteSearchProducts.length,
    search,
    showingCameraResults,
  ]);

  const groupsToRender = useMemo(
    () => sortMainGroupsByWebsiteOrder(baseGroups),
    [baseGroups]
  );

  const activeGroup = activeGroupId
    ? groupsToRender.find((group) => group.id === activeGroupId) ||
      baseGroups.find((group) => group.id === activeGroupId) ||
      groupsToRender[0] ||
      baseGroups[0] ||
      null
    : groupsToRender[0] || baseGroups[0] || null;
  const resolvedActiveGroup = activeGroup || null;

  const scopedSubcategoryItems = useMemo(
    () => getScopedSubcategoryItems(resolvedActiveGroup) as ScopedCategoryItem[],
    [resolvedActiveGroup]
  );
  const mainShellItem = useMemo(
    () => getMainShellItem(resolvedActiveGroup) as ScopedCategoryItem | null,
    [resolvedActiveGroup]
  );
  const heroContent = useMemo(() => {
    const title = resolvedActiveGroup?.title || 'Category';
    return CATEGORY_HERO_COPY[title] || { eyebrow: title, title: `Shop ${title}` };
  }, [resolvedActiveGroup?.title]);
  const heroSlides = useMemo(
    () =>
      buildCategoryHeroSlides(
        resolvedActiveGroup?.title || 'Category',
        scopedSubcategoryItems,
        heroContent
      ),
    [heroContent, resolvedActiveGroup?.title, scopedSubcategoryItems]
  );
  const activeHeroSlide = heroSlides[heroSlideIndex] || heroSlides[0] || null;
  const shopByCategoryItems = scopedSubcategoryItems;
  const shopByCategoryBubbleData = useMemo(
    () =>
      shopByCategoryItems.map((item, index) => {
        const bubbleResolved = resolveItemBubbleImage(
          item as MenuCategoryItem,
          resolvedActiveGroup?.title || 'Category'
        );
        const bubbleImage = bubbleResolved.url;
        return {
          id: item.id,
          handle: item.handle,
          title: item.title,
          imageUri: isRealProductImage(bubbleImage)
            ? getOptimizedImageUrl(bubbleImage, 180)
            : '',
          hasImage: isRealProductImage(bubbleImage),
          badge: getCategoryBubbleBadge(item as MenuCategoryItem, index),
          item: item as MenuCategoryItem,
        };
      }),
    [resolvedActiveGroup?.title, shopByCategoryItems]
  );
  const scopedProductMix = useMemo(() => {
    if (!resolvedActiveGroup) {
      return { products: [], excludedCount: 0 };
    }

    return mixProductsAcrossSubcategories(scopedSubcategoryItems, {
      mainTitle: resolvedActiveGroup.title,
      limit: 120,
      includeMainShell: mainShellItem,
    });
  }, [mainShellItem, resolvedActiveGroup, scopedSubcategoryItems]);
  const trendingProducts = useMemo(
    () => scopedProductMix.products.slice(0, 8),
    [scopedProductMix.products]
  );
  const gridProducts = useMemo(
    () => scopedProductMix.products.slice(0, visibleGridCount),
    [scopedProductMix.products, visibleGridCount]
  );
  const hasMoreGridProducts = scopedProductMix.products.length > visibleGridCount;

  useEffect(() => {
    if (!PERF_CATEGORIES_DEBUG) return;

    categoriesPerfLog('[PERF_CATEGORIES_RENDER]', {
      selectedCategory: resolvedActiveGroup?.title || null,
      bubbleCount: shopByCategoryBubbleData.length,
      productCount: scopedProductMix.products.length,
    });
  }, [
    resolvedActiveGroup?.title,
    scopedProductMix.products.length,
    shopByCategoryBubbleData.length,
  ]);

  useEffect(() => {
    setHeroSlideIndex(0);
    setVisibleGridCount(12);
  }, [resolvedActiveGroup?.id]);

  useEffect(() => {
    if (heroSlides.length <= 1) return undefined;

    const timer = setInterval(() => {
      setHeroSlideIndex((current) => (current + 1) % heroSlides.length);
    }, 4500);

    return () => clearInterval(timer);
  }, [heroSlides.length, resolvedActiveGroup?.id]);

  useEffect(() => {
    if (!PERF_CATEGORIES_DEBUG || !resolvedActiveGroup) return;

    const mainTitle = resolvedActiveGroup.title;
    categoriesPerfLog(`[NOOD categories] selected main category ${mainTitle}`);
    categoriesPerfLog('[NOOD categories] menu source used:', collectionMappingSource);
    categoriesPerfLog('[NOOD categories] all collection handles count', allCollectionCount);
    if (mainTitle === 'Men') {
      categoriesPerfLog('[NOOD categories] matched men menu handles', menMatchedHandles);
    }
    categoriesPerfLog(`[NOOD categories] ${mainTitle.toLowerCase()} subcategories count`, scopedSubcategoryItems.length);
    categoriesPerfLog(
      `[NOOD categories] ${mainTitle.toLowerCase()} subcategory titles`,
      scopedSubcategoryItems.map((item) => item.title)
    );
    categoriesPerfLog(`[NOOD categories] ${mainTitle.toLowerCase()} slideshow slides count`, heroSlides.length);
    categoriesPerfLog(`[NOOD categories] ${mainTitle.toLowerCase()} trending products count`, trendingProducts.length);
    categoriesPerfLog(`[NOOD categories] ${mainTitle.toLowerCase()} grid products count`, gridProducts.length);
    categoriesPerfLog(
      `[NOOD categories] excluded non-${mainTitle.toLowerCase()} product count`,
      scopedProductMix.excludedCount
    );
    if (mainTitle === 'Men' && !scopedSubcategoryItems.length) {
      categoriesPerfLog('[NOOD categories] empty state reason', {
        reason: 'no-men-subcategories-after-scope',
        seeded: MEN_DROPDOWN_DEFINITIONS.length,
        matched: menMatchedHandles.length,
      });
    }
  }, [
    allCollectionCount,
    collectionMappingSource,
    gridProducts.length,
    heroSlides.length,
    menMatchedHandles,
    resolvedActiveGroup,
    scopedProductMix.excludedCount,
    scopedSubcategoryItems,
    trendingProducts.length,
  ]);

  const openScopedProduct = useCallback(
    (product: CategoryProduct) => {
      persistCategoriesSessionSnapshot();

      router.push({
        pathname: '/product/[handle]',
        params: buildProductRouteParams(product, { from: 'categories' }) as any,
      });
    },
    [persistCategoriesSessionSnapshot, router]
  );

  const handleRailScrollOffset = useCallback((offset: number) => {
    railScrollOffsetRef.current = offset;
    if (categoriesSessionSnapshot) {
      categoriesSessionSnapshot.railScrollOffset = offset;
    }
  }, []);

  const handlePanelScrollOffset = useCallback((offset: number) => {
    panelScrollOffsetRef.current = offset;
    if (categoriesSessionSnapshot) {
      categoriesSessionSnapshot.scrollOffset = offset;
    }
  }, []);

  const handlePanelScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      handlePanelScrollOffset(event.nativeEvent.contentOffset.y);
    },
    [handlePanelScrollOffset]
  );

  const getCategoryIconStable = useCallback(
    (title?: string | null) => getCategoryIcon(title),
    []
  );

  const renderTrendingProduct = useCallback(
    (product: CategoryProduct, index: number) => {
      const imageUri = getOptimizedImageUrl(product.image, 260);
      const isSoldOut = resolveListProductSoldOut(product);

      return (
        <CategoryTrendingCard
          productHandle={product.handle}
          title={product.title}
          price={product.price}
          imageUri={imageUri}
          hasImage={isRealProductImage(product.image)}
          availabilityLabel={isSoldOut ? getProductAvailabilityLabel(product) : null}
          badgeText={CATEGORY_CARD_BADGES[index % CATEGORY_CARD_BADGES.length]}
          cardStyle={[styles.trendingCategoryCard, isDesktop && styles.trendingCategoryCardDesktop]}
          styles={styles}
          onPress={() => openScopedProduct(product)}
        />
      );
    },
    [isDesktop, openScopedProduct]
  );

  const openScopedProductRef = useRef(openScopedProduct);
  openScopedProductRef.current = openScopedProduct;

  const renderGridProduct = useCallback(
    ({ item }: { item: CategoryProduct }) => {
      const imageUri = getOptimizedImageUrl(item.image, isMobile ? 220 : 140);

      return (
        <CategoryGridProductCard
          productId={item.id}
          productHandle={item.handle}
          title={item.title}
          price={item.price}
          imageUri={imageUri}
          imageWidth={isMobile ? 220 : 140}
          hasImage={isRealProductImage(item.image)}
          isMobile={isMobile}
          meta={item.sourceSubcategoryTitle || null}
          availabilityLabel={
            resolveListProductSoldOut(item) ? getProductAvailabilityLabel(item) : null
          }
          cardStyle={[styles.productCard, isMobile && styles.productCardMobile]}
          imageStyle={[styles.productImage, isMobile && styles.productImageMobile]}
          infoStyle={[styles.productInfo, isMobile && styles.productInfoMobile]}
          titleStyle={[styles.productTitle, isMobile && styles.productTitleMobile]}
          priceStyle={[styles.productPrice, isMobile && styles.productPriceMobile]}
          placeholderStyle={[styles.allCategoryPlaceholder, isMobile && styles.productImageMobile]}
          styles={styles}
          onPress={() => openScopedProductRef.current(item)}
        />
      );
    },
    [isMobile]
  );

  useScreenPerfReporter(
    'categories',
    {
      itemCount: gridProducts.length,
      isFetching: loading || searchingCatalog,
      isRefreshing: refreshing,
    },
    [gridProducts.length, loading, refreshing, searchingCatalog]
  );

  const gridKeyExtractor = useCallback(
    (item: CategoryProduct) => `grid-product-${item.id}-${item.handle}`,
    []
  );

  const openTrendingViewAll = useCallback(() => {
    if (!resolvedActiveGroup) return;

    const mainTitle = resolvedActiveGroup.title;

    categoriesPerfLog(`[NOOD categories] trending view all pressed category=${mainTitle}`);
    categoriesPerfLog(`[NOOD categories] navigating to trending page category=${mainTitle}`);

    persistCategoriesSessionSnapshot();

    const pool = buildTrendingPoolForGroup(resolvedActiveGroup as ScopedCategoryGroup);
    if (pool) {
      void saveCategoryTrendingCache(pool);
    }

    router.push({
      pathname: '/category-trending',
      params: {
        mainCategory: mainTitle,
        source: 'trending',
        activeGroupId: resolvedActiveGroup.id,
        from: 'categories',
      },
    });
  }, [persistCategoriesSessionSnapshot, resolvedActiveGroup, router]);

  useEffect(() => {
    if (!resolvedActiveGroup) return;

    const mainTitle = resolvedActiveGroup.title;
    const urls = shopByCategoryItems
      .slice(0, CATEGORY_IMAGE_PREFETCH_LIMIT)
      .map((item) => resolveItemBubbleImage(item as MenuCategoryItem, mainTitle).url)
      .filter((uri) => isRealProductImage(uri))
      .map((uri) => getOptimizedImageUrl(uri, 180));

    categoriesPerfLog('[NOOD categories] image prefetch start count', urls.length);
    if (!urls.length) return;

    let done = 0;
    urls.forEach((url) => {
      void Image.prefetch(url).finally(() => {
        done += 1;
        if (done === urls.length) {
          categoriesPerfLog('[NOOD categories] image prefetch done count', done);
        }
      });
    });
  }, [resolvedActiveGroup, shopByCategoryItems]);

  const panelListHeader = useMemo(() => {
    if (!resolvedActiveGroup) return null;

    const hasSubcategoryContent =
      resolvedActiveGroup.title === 'Men'
        ? scopedSubcategoryItems.length > 0
        : scopedSubcategoryItems.length > 0 || scopedProductMix.products.length > 0;

    if (!hasSubcategoryContent) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>No subcategories available yet.</Text>
          <Text style={styles.emptySubText}>
            Add Shopify collections under this category to show them here.
          </Text>
        </View>
      );
    }

    return (
      <>
        <Text numberOfLines={1} style={styles.categoryPanelTitle}>
          {resolvedActiveGroup.title}
        </Text>

        <TouchableOpacity
          activeOpacity={0.9}
          style={[styles.dynamicHeroCard, isMobile && styles.dynamicHeroCardMobile]}
          onPress={() => {
            const slide = activeHeroSlide;
            if (!slide) return;
            if (slide.targetHandle && slide.subcategoryTitle !== resolvedActiveGroup?.title) {
              openCategoryTarget({
                id: slide.id,
                title: slide.subcategoryTitle,
                handle: slide.targetHandle,
                image: slide.image,
                previewProducts: [],
              });
              return;
            }
            const firstProduct = scopedProductMix.products[0];
            if (firstProduct) {
              openScopedProduct(firstProduct);
            }
          }}
        >
          {isRealProductImage(activeHeroSlide?.image) ? (
            <CategoryOptimizedImage
              uri={getOptimizedImageUrl(activeHeroSlide?.image, isDesktop ? 900 : 520)}
              style={styles.dynamicHeroImage}
              recyclingKey={`hero-${resolvedActiveGroup.id}-${heroSlideIndex}`}
            />
          ) : (
            <View style={styles.dynamicHeroPlaceholder}>
              <Ionicons name="image-outline" size={34} color="#777" />
            </View>
          )}
          <View style={styles.dynamicHeroShade} />
          <View style={styles.dynamicHeroPaint} />
          <View style={styles.dynamicHeroContent}>
            <Text numberOfLines={1} style={styles.dynamicHeroEyebrow}>
              {activeHeroSlide?.eyebrow || heroContent.eyebrow}
            </Text>
            <Text
              numberOfLines={3}
              style={[styles.dynamicHeroTitle, isMobile && styles.dynamicHeroTitleMobile]}
            >
              {activeHeroSlide?.title || heroContent.title}
            </Text>
            <View style={styles.dynamicHeroButton}>
              <Text style={styles.dynamicHeroButtonText}>Shop now</Text>
              <Ionicons name="arrow-forward" size={16} color="#fff" />
            </View>
          </View>
        </TouchableOpacity>

        <View style={styles.heroDots}>
          {(heroSlides.length ? heroSlides : [null]).map((slide, index) => (
            <TouchableOpacity
              key={slide?.id || `hero-dot-${index}`}
              activeOpacity={0.85}
              onPress={() => setHeroSlideIndex(index)}
            >
              <View style={[styles.heroDot, index === heroSlideIndex && styles.heroDotActive]} />
            </TouchableOpacity>
          ))}
        </View>

        {shopByCategoryBubbleData.length ? (
          <>
            <View style={styles.categorySectionHeader}>
              <Text style={styles.categorySectionTitle}>Shop by category</Text>
            </View>

            <View style={styles.shopByCategoryGrid}>
              {shopByCategoryBubbleData.map((bubble) => (
                <CategoryBubbleCell
                  key={`shop-bubble-${bubble.id}-${bubble.handle}`}
                  itemId={bubble.id}
                  itemHandle={bubble.handle}
                  title={bubble.title}
                  imageUri={bubble.imageUri}
                  badge={bubble.badge}
                  placeholderIcon={getCategoryIcon(bubble.title)}
                  hasImage={bubble.hasImage}
                  styles={styles}
                  onPress={() => openCategoryTarget(bubble.item)}
                />
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.categorySectionHeader}>
          <Text style={styles.categorySectionTitle}>Trending now</Text>
          <TouchableOpacity activeOpacity={0.85} onPress={openTrendingViewAll}>
            <Text style={styles.categorySectionAction}>View all</Text>
          </TouchableOpacity>
        </View>

        <CategoriesTrendingList
          products={trendingProducts}
          isDesktop={isDesktop}
          styles={styles}
          renderCard={renderTrendingProduct}
        />

        <View style={styles.categorySectionHeader}>
          <Text style={styles.categorySectionTitle}>All categories</Text>
        </View>
      </>
    );
  }, [
    activeHeroSlide,
    heroContent.eyebrow,
    heroContent.title,
    heroSlideIndex,
    heroSlides,
    isDesktop,
    isMobile,
    openCategoryTarget,
    openScopedProduct,
    openTrendingViewAll,
    renderTrendingProduct,
    resolvedActiveGroup,
    scopedProductMix.products,
    scopedSubcategoryItems.length,
    shopByCategoryBubbleData,
    trendingProducts,
  ]);

  const panelListFooter = useMemo(() => {
    if (!hasMoreGridProducts) return null;

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        style={styles.loadMoreButton}
        onPress={() => setVisibleGridCount((count) => count + 12)}
      >
        <Text style={styles.loadMoreButtonText}>Load more</Text>
      </TouchableOpacity>
    );
  }, [hasMoreGridProducts]);

  const panelListEmpty = useMemo(() => {
    if (gridProducts.length) return null;

    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>No products available yet.</Text>
      </View>
    );
  }, [gridProducts.length]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={[styles.contentShell, isDesktop && styles.contentShellDesktop]}>
          <View style={styles.aliexpressTopBar}>
            <View style={styles.noodLogoWrap}>
              <Image
                source={NOOD_LOGO}
                style={styles.noodLogoImage}
                resizeMode="contain"
              />
            </View>

            <View style={styles.topActions}>
              <TouchableOpacity
                activeOpacity={0.85}
                style={styles.topSearchIcon}
                onPress={handleCameraSearchPress}
                disabled={cameraSearching}
              >
                <Ionicons name="camera-outline" size={25} color="#171717" />
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.85} style={styles.topSearchIcon} onPress={handleFocusSearch}>
                <Ionicons name="search-outline" size={29} color="#171717" />
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity activeOpacity={1} style={styles.searchWrap} onPress={handleFocusSearch}>
            <Ionicons name="search-outline" size={18} color="#9a9a9a" />
            <TextInput
              ref={searchInputRef}
              value={search}
              onChangeText={(value) => {
                cameraSearchActiveRef.current = false;
                setCameraSearchHeading('');
                setSearch(value);
              }}
              placeholder="Search categories"
              placeholderTextColor="#9a9a9a"
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            <View style={styles.searchBadge}>
              <Ionicons name="grid-outline" size={14} color="#ff6a00" />
            </View>
          </TouchableOpacity>

          <View style={[styles.browserWrap, isMobile && styles.browserWrapMobile]}>
            <View
              style={[
                styles.railShell,
                isDesktop ? styles.railDesktop : isTablet ? styles.railTablet : styles.railMobile,
              ]}
            >
              <CategoriesRailList
                listRef={railScrollRef}
                groups={groupsToRender}
                activeGroupId={activeGroupId}
                isDesktop={isDesktop}
                isMobile={isMobile}
                styles={styles}
                getIconName={getCategoryIconStable}
                onSelectCategory={handleSelectCategory}
                onScrollOffset={handleRailScrollOffset}
              />
            </View>

            {resolvedActiveGroup && !isSearchingCategories ? (
              <FlatList
                ref={panelScrollRef as React.RefObject<FlatList<CategoryProduct>>}
                key={`categories-panel-${resolvedActiveGroup.id}-${isMobile ? 'mobile' : 'desktop'}`}
                data={gridProducts}
                numColumns={isMobile ? 2 : 1}
                style={[styles.panel, isMobile && styles.panelMobile]}
                contentContainerStyle={styles.panelScrollContent}
                columnWrapperStyle={isMobile ? styles.trendingListMobile : undefined}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                {...CATALOG_LIST_PROPS}
                onScroll={handlePanelScroll}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={() => {
                      void loadCategories(true /* forceRefresh */);
                    }}
                    tintColor="#ff6a00"
                    colors={['#ff6a00']}
                    progressBackgroundColor="#ffffff"
                  />
                }
                ListHeaderComponent={panelListHeader}
                ListFooterComponent={panelListFooter}
                ListEmptyComponent={panelListEmpty}
                renderItem={renderGridProduct}
                keyExtractor={gridKeyExtractor}
              />
            ) : (
            <ScrollView
              ref={panelScrollRef as React.RefObject<ScrollView>}
              style={[styles.panel, isMobile && styles.panelMobile]}
              contentContainerStyle={styles.panelScrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={32}
              onScroll={handlePanelScroll}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    void loadCategories(true /* forceRefresh */);
                  }}
                  tintColor="#ff6a00"
                  colors={['#ff6a00']}
                  progressBackgroundColor="#ffffff"
                />
              }
            >
              {loading && !groups.length ? (
                <View style={styles.loadingPanel}>
                  <NoodSpinner size={48} />
                  <Text style={styles.loadingPanelText}>Loading categories...</Text>
                </View>
              ) : loadError && !scopedSubcategoryItems.length && !scopedProductMix.products.length ? (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyText}>{loadError}</Text>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => void loadCategories(true)}
                    style={styles.emptyRetryButton}
                  >
                    <Text style={styles.emptyRetryText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : isSearchingCategories ? (
                <>
                  <Text numberOfLines={1} style={styles.categoryPanelTitle}>
                    {cameraSearchHeading || 'Search results'}
                  </Text>

                  {categorySearchResults.categories.length ? (
                    <>
                      <View style={styles.categorySectionHeader}>
                        <Text style={styles.categorySectionTitle}>Categories</Text>
                      </View>

                      <View style={styles.shopByCategoryGrid}>
                        {categorySearchResults.categories.map((result) => (
                          <TouchableOpacity
                            key={result.id}
                            activeOpacity={0.88}
                            style={styles.shopByCategoryBubbleCell}
                            onPress={() => {
                              handleSelectCategory(result.groupId);
                              scrollPanelToTop(false);
                            }}
                          >
                            <View style={styles.shopByCategoryBubbleRing}>
                              {isRealProductImage(result.item?.image) ? (
                                <Image
                                  source={{ uri: getOptimizedImageUrl(result.item?.image, 180) }}
                                  style={styles.shopByCategoryBubbleImage}
                                  resizeMode="cover"
                                />
                              ) : (
                                <View style={styles.shopByCategoryBubblePlaceholder}>
                                  <Ionicons name={getCategoryIcon(result.title)} size={22} color="#b8b8b8" />
                                </View>
                              )}
                            </View>
                            <Text numberOfLines={2} style={styles.shopByCategoryBubbleLabel}>
                              {result.title}
                            </Text>
                            <Text numberOfLines={1} style={styles.allCategoryMeta}>
                              {result.subtitle}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  ) : null}

                  {categorySearchResults.products.length ? (
                    <>
                      <View style={styles.categorySectionHeader}>
                        <Text style={styles.categorySectionTitle}>Products</Text>
                        {searchingCatalog ? (
                          <Text style={styles.categorySectionAction}>Searching...</Text>
                        ) : null}
                      </View>

                      <View style={[styles.allCategoryGrid, isMobile && styles.trendingListMobile]}>
                        {categorySearchResults.products.map((product) => (
                          <TouchableOpacity
                            key={`search-product-${product.id}-${product.handle}`}
                            activeOpacity={0.88}
                            style={[styles.productCard, isMobile && styles.productCardMobile]}
                            onPress={() => openScopedProduct(product)}
                          >
                            {isRealProductImage(product.image) ? (
                              <Image
                                source={{ uri: getOptimizedImageUrl(product.image, isMobile ? 220 : 140) }}
                                style={[styles.productImage, isMobile && styles.productImageMobile]}
                                resizeMode="cover"
                              />
                            ) : (
                              <View style={[styles.allCategoryPlaceholder, isMobile && styles.productImageMobile]}>
                                <Ionicons name="image-outline" size={24} color="#b8b8b8" />
                              </View>
                            )}
                            <View style={[styles.productInfo, isMobile && styles.productInfoMobile]}>
                              <Text numberOfLines={2} style={[styles.productTitle, isMobile && styles.productTitleMobile]}>
                                {product.title}
                              </Text>
                              <Text numberOfLines={1} style={[styles.productPrice, isMobile && styles.productPriceMobile]}>
                                {product.price}
                              </Text>
                              {product.sourceSubcategoryTitle || product.productType || product.brand ? (
                                <Text numberOfLines={1} style={styles.allCategoryMeta}>
                                  {product.sourceSubcategoryTitle || product.productType || product.brand}
                                </Text>
                              ) : null}
                            </View>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  ) : null}

                  {!categorySearchResults.categories.length &&
                  !categorySearchResults.products.length &&
                  !searchingCatalog ? (
                    <View style={styles.emptyWrap}>
                      <Text style={styles.emptyText}>No results found</Text>
                    </View>
                  ) : null}
                </>
              ) : (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyText}>No categories available yet.</Text>
                  <Text style={styles.emptySubText}>Check Metro logs for Shopify menu and collection errors.</Text>
                </View>
              )}
            </ScrollView>
            )}
          </View>
        </View>

      <Modal
        visible={Boolean(galleryPreviewPhoto)}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => setGalleryPreviewPhoto(null)}
      >
        <View style={styles.galleryPreviewScreen}>
          <Image
            source={{ uri: galleryPreviewPhoto?.uri || '' }}
            style={styles.galleryPreviewImage}
            resizeMode="contain"
          />

          <SafeAreaView style={styles.galleryPreviewControls}>
            <Text style={styles.galleryPreviewTitle}>Use this photo?</Text>
            <View style={styles.galleryPreviewActions}>
              <TouchableOpacity
                style={styles.gallerySecondaryButton}
                activeOpacity={0.9}
                onPress={handleChooseAnotherGalleryPhoto}
              >
                <Text style={styles.gallerySecondaryButtonText}>Choose Another</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.galleryPrimaryButton}
                activeOpacity={0.9}
                onPress={() => void handleUseGalleryPhoto()}
              >
                <Text style={styles.galleryPrimaryButtonText}>Use Photo</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      <CameraSearchModal
        visible={cameraModalVisible}
        onClose={() => setCameraModalVisible(false)}
        onUsePhoto={(photo) => void handleCameraPhotoSelected(photo)}
        onChooseAnother={() => {
          setCameraModalVisible(false);
          requestAnimationFrame(() => {
            void handlePickSearchImage();
          });
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    paddingTop: 0,
    paddingBottom: 120,
    backgroundColor: '#fff',
  },
  contentShell: {
    flex: 1,
    width: '100%',
    backgroundColor: '#fff',
  },
  contentShellDesktop: {
    maxWidth: 1180,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: 16,
  },
  galleryPreviewScreen: {
    flex: 1,
    backgroundColor: '#000',
  },
  galleryPreviewImage: {
    flex: 1,
    width: '100%',
  },
  galleryPreviewControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 22,
    paddingBottom: 28,
    paddingTop: 18,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  galleryPreviewTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 16,
  },
  galleryPreviewActions: {
    flexDirection: 'row',
    gap: 12,
  },
  gallerySecondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
  },
  gallerySecondaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  galleryPrimaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ff6a00',
  },
  galleryPrimaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  loadingWrap: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: '#666',
    fontWeight: '600',
  },
  pageTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
    marginBottom: 4,
  },
  pageTitleMobile: {
    display: 'none',
  },
  pageSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: '#6e6e73',
    textAlign: 'center',
    marginBottom: 14,
    paddingHorizontal: 18,
  },
  pageSubtitleMobile: {
    display: 'none',
  },
  aliexpressTopBar: {
    height: 74,
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  noodLogoWrap: {
    minWidth: 104,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  noodLogoImage: {
    width: 96,
    height: 34,
  },
  noodLogoText: {
    fontSize: 31,
    lineHeight: 34,
    fontWeight: '900',
    color: '#111',
    letterSpacing: -1.4,
  },
  noodLogoSubText: {
    marginTop: -2,
    fontSize: 11,
    fontWeight: '800',
    color: '#ff6a00',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  topSearchIcon: {
    width: 34,
    height: 44,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchWrap: {
    marginHorizontal: 24,
    marginTop: 0,
    marginBottom: 16,
    height: 47,
    borderRadius: 14,
    backgroundColor: '#f8f8f8',
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ededed',
    ...platformShadow('0 8px 18px rgba(17,17,17,0.06)', {
      shadowColor: '#000',
      shadowOpacity: 0.06,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 6 },
      elevation: 2,
    }),
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    color: '#111',
    fontSize: 14,
    fontWeight: '600',
  },
  searchBadge: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  browserWatermark: {
    position: 'absolute',
    top: 108,
    left: 6,
    right: 8,
    height: 230,
    opacity: 0.18,
    zIndex: 1,
  },
  recommendedWrap: {
    backgroundColor: 'transparent',
    paddingTop: 8,
    paddingBottom: 8,
  },
  recommendedHeader: {
    minHeight: 34,
    justifyContent: 'center',
    marginBottom: 8,
    position: 'relative',
    overflow: 'visible',
  },
  noodWatermark: {
    position: 'absolute',
    left: 4,
    top: -8,
    fontSize: 54,
    lineHeight: 60,
    fontWeight: '900',
    color: 'rgba(255,106,0,0.06)',
    letterSpacing: -2,
  },
  noodLogoWatermark: {
    position: 'absolute',
    left: -18,
    top: -22,
    width: 220,
    height: 112,
    opacity: 0,
  },
  recommendedTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#ff6a00',
    letterSpacing: 0.2,
    paddingLeft: 6,
  },
  recommendedTitleMobile: {
    fontSize: 20,
  },
  selectedMainCategoryText: {
    marginTop: 4,
    paddingLeft: 6,
    fontSize: 13,
    lineHeight: 18,
    color: '#777',
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  recommendedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingBottom: 6,
  },
  recommendedItem: {
    width: '33.333%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 14,
  },
  recommendedImageBubble: {
    width: 86,
    height: 86,
    borderRadius: 43,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#f3e4d6',
    overflow: 'hidden',
    ...platformShadow('0 10px 20px rgba(17,17,17,0.08)', {
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 8 },
      elevation: 3,
    }),
  },
  recommendedImage: {
    width: '100%',
    height: '100%',
    borderRadius: 43,
    backgroundColor: '#fff',
  },
  recommendedPlaceholder: {
    width: '100%',
    height: '100%',
    borderRadius: 43,
    backgroundColor: '#f6f6f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recommendedText: {
    marginTop: 10,
    minHeight: 36,
    fontSize: 13,
    lineHeight: 17,
    color: '#222',
    fontWeight: '700',
    textAlign: 'center',
  },
  curatedHero: {
    marginHorizontal: 10,
    marginTop: 12,
    marginBottom: 4,
    minHeight: 86,
    borderRadius: 20,
    backgroundColor: '#fff4e8',
    borderWidth: 1,
    borderColor: '#ffe2cf',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  curatedHeroMobile: {
    minHeight: 78,
    borderRadius: 18,
    marginTop: 12,
  },
  curatedHeroAccent: {
    width: 4,
    height: 42,
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    marginRight: 12,
  },
  curatedHeroTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  curatedHeroTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    letterSpacing: 0.1,
  },
  curatedHeroCopy: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: '#6b5b50',
    fontWeight: '600',
  },
  tipBar: {
    marginTop: 10,
    backgroundColor: '#fff0df',
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tipBarMobile: {
    display: 'none',
  },
  tipText: {
    flex: 1,
    marginLeft: 8,
    color: '#333',
    fontSize: 13,
    fontWeight: '600',
  },
  browserWrap: {
    flex: 1,
    flexDirection: 'row',
    marginTop: 0,
    minHeight: 0,
    alignItems: 'stretch',
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: '#fff',
    position: 'relative',
    overflow: 'hidden',
  },
  browserWrapMobile: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 0,
    marginTop: 0,
  },
  railShell: {
    width: 154,
    backgroundColor: '#fafafa',
    flexShrink: 0,
    alignSelf: 'stretch',
    position: 'relative',
    overflow: 'hidden',
    borderRightWidth: 1,
    borderRightColor: '#ececec',
    zIndex: 2,
  },
  railScroll: {
    flex: 1,
  },
  railDesktop: {
    width: 154,
  },
  railTablet: {
    width: 136,
  },
  railMobile: {
    width: 132,
    minWidth: 132,
    maxWidth: 136,
    borderRightWidth: 1,
    backgroundColor: '#fafafa',
  },
  railContent: {
    paddingVertical: 0,
  },
  railContentMobile: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: 8,
    backgroundColor: '#f5f5f5',
  },
  railItem: {
    position: 'relative',
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 11,
  },
  railItemDesktop: {
    minHeight: 68,
    paddingHorizontal: 16,
  },
  railItemMobile: {
    minHeight: 68,
    paddingHorizontal: 13,
    gap: 9,
  },
  railItemActive: {
    backgroundColor: '#fff',
    borderRightWidth: 0,
  },
  railAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: '#ff6a00',
  },
  railText: {
    color: '#5f5f5f',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
    flex: 1,
  },
  railTextMobile: {
    fontSize: 13,
    lineHeight: 16,
    flexShrink: 1,
  },
  railTextActive: {
    color: '#ff6a00',
    fontWeight: '900',
  },
  railIcon: {
    width: 23,
    textAlign: 'center',
  },
  railEdgeIndicator: {
    position: 'absolute',
    top: 13,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    ...platformShadow('0 2px 5px rgba(0,0,0,0.08)', {
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 5,
        elevation: 2,
    }),
  },
  railEdgeIndicatorLeft: {
    left: 4,
  },
  railEdgeIndicatorRight: {
    right: 4,
  },
  panel: {
    flex: 1,
    flexBasis: 0,
    flexGrow: 1,
    alignSelf: 'stretch',
    minWidth: 0,
    minHeight: 0,
    paddingHorizontal: 24,
    paddingTop: 21,
    backgroundColor: '#fff',
    zIndex: 2,
  },
  panelMobile: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    paddingHorizontal: 18,
    paddingTop: 20,
    backgroundColor: '#fff',
  },
  panelScrollContent: {
    paddingBottom: 120,
  },
  categoryPanelTitle: {
    marginBottom: 18,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '900',
    color: '#111',
  },
  dynamicHeroCard: {
    width: '100%',
    minHeight: 182,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#151515',
    marginBottom: 8,
    position: 'relative',
    ...platformShadow('0 12px 24px rgba(17,17,17,0.12)', {
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 8 },
      elevation: 3,
    }),
  },
  dynamicHeroCardMobile: {
    minHeight: 154,
    borderRadius: 16,
  },
  dynamicHeroImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  dynamicHeroPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#161616',
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 28,
  },
  dynamicHeroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.46)',
  },
  dynamicHeroPaint: {
    position: 'absolute',
    right: -20,
    bottom: -28,
    width: 170,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(255,106,0,0.72)',
    transform: [{ rotate: '-16deg' }],
  },
  dynamicHeroContent: {
    minHeight: 182,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    paddingVertical: 22,
    maxWidth: '72%',
  },
  dynamicHeroEyebrow: {
    color: '#ff6a00',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  dynamicHeroTitle: {
    color: '#fff',
    fontSize: 27,
    lineHeight: 32,
    fontWeight: '900',
  },
  dynamicHeroTitleMobile: {
    fontSize: 22,
    lineHeight: 27,
  },
  dynamicHeroButton: {
    marginTop: 18,
    minHeight: 42,
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dynamicHeroButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  heroDots: {
    height: 20,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  heroDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#a7a7a7',
  },
  heroDotActive: {
    width: 18,
    backgroundColor: '#ff6a00',
  },
  shopByCategoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 4,
  },
  shopByCategoryBubbleCell: {
    width: '33.3333%',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginBottom: 18,
  },
  shopByCategoryBubbleRing: {
    width: 92,
    height: 92,
    borderRadius: 46,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#f1f1f1',
    backgroundColor: '#f8f8f8',
    position: 'relative',
    ...platformShadow('0 8px 16px rgba(17,17,17,0.08)', {
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    }),
  },
  shopByCategoryBubbleImage: {
    width: '100%',
    height: '100%',
  },
  shopByCategoryBubblePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f3f3f3',
  },
  shopByCategoryBubbleBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minHeight: 18,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  shopByCategoryBubbleBadgeText: {
    color: '#fff',
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  shopByCategoryBubbleLabel: {
    marginTop: 8,
    color: '#222',
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
    textAlign: 'center',
    minHeight: 30,
    paddingHorizontal: 2,
  },
  categorySectionHeader: {
    marginTop: 14,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  categorySectionTitle: {
    color: '#111',
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '900',
  },
  categorySectionAction: {
    color: '#ff6a00',
    fontSize: 13,
    fontWeight: '900',
  },
  trendingCardsRow: {
    gap: 12,
    paddingRight: 4,
    paddingBottom: 4,
  },
  trendingCategoryCard: {
    width: 132,
    minHeight: 168,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ededed',
    overflow: 'hidden',
    alignItems: 'center',
    paddingBottom: 10,
    ...platformShadow('0 8px 18px rgba(17,17,17,0.08)', {
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 5 },
      elevation: 2,
    }),
  },
  trendingCategoryCardDesktop: {
    width: 154,
  },
  trendingCategoryImage: {
    width: '100%',
    height: 104,
    backgroundColor: '#f6f6f6',
  },
  trendingCategoryPlaceholder: {
    width: '100%',
    height: 104,
    backgroundColor: '#f6f6f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trendingCategoryTitle: {
    marginTop: 8,
    minHeight: 34,
    paddingHorizontal: 8,
    color: '#111',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
    textAlign: 'center',
  },
  stockUnavailableText: {
    fontSize: 11,
    color: '#b42318',
    fontWeight: '700',
    marginTop: 2,
  },
  trendingCategoryPrice: {
    marginTop: 4,
    paddingHorizontal: 8,
    color: '#ff6a00',
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  loadMoreButton: {
    alignSelf: 'center',
    marginTop: 16,
    marginBottom: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: '#fff4ea',
    borderWidth: 1,
    borderColor: '#ffd8b8',
  },
  loadMoreButtonText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '800',
  },
  smallOrangeBadge: {
    marginTop: 6,
    minHeight: 22,
    borderRadius: 7,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallOrangeBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
  },
  allCategoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
    paddingBottom: 24,
  },
  allCategoryCard: {
    width: '100%',
    minHeight: 136,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ededed',
    flexDirection: 'row',
    overflow: 'hidden',
    ...platformShadow('0 8px 18px rgba(17,17,17,0.07)', {
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 5 },
      elevation: 2,
    }),
  },
  allCategoryCardDesktop: {
    width: '48.8%',
  },
  allCategoryImage: {
    width: 118,
    height: '100%',
    minHeight: 136,
    backgroundColor: '#f6f6f6',
  },
  allCategoryPlaceholder: {
    width: 118,
    minHeight: 136,
    backgroundColor: '#f6f6f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  allCategoryInfo: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: 13,
    justifyContent: 'center',
    position: 'relative',
  },
  allCategoryBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    minHeight: 22,
    borderRadius: 7,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allCategoryBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
  },
  allCategoryTitle: {
    paddingRight: 54,
    color: '#111',
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
  },
  allCategoryMeta: {
    marginTop: 7,
    color: '#777',
    fontSize: 13,
    fontWeight: '700',
  },
  allCategoryCta: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  allCategoryCtaText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '900',
  },
  categoryList: {
    gap: 14,
    paddingBottom: 20,
  },
  categoryListRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
  },
  categoryListImage: {
    width: 66,
    height: 66,
    borderRadius: 10,
    backgroundColor: '#f6f6f6',
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  categoryListPlaceholder: {
    width: 66,
    height: 66,
    borderRadius: 10,
    backgroundColor: '#f6f6f6',
    borderWidth: 1,
    borderColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryListText: {
    flex: 1,
    marginLeft: 16,
    marginRight: 8,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
    color: '#242424',
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14,
    paddingBottom: 24,
  },
  categoryGridCard: {
    width: '47%',
    minHeight: 142,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ededed',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 12,
    ...platformShadow('0 5px 14px rgba(17,17,17,0.06)', {
      shadowColor: '#000',
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    }),
  },
  categoryGridCardDesktop: {
    width: 132,
  },
  categoryGridImage: {
    width: '100%',
    height: 92,
    borderRadius: 6,
    backgroundColor: '#f7f7f7',
  },
  categoryGridPlaceholder: {
    width: '100%',
    height: 92,
    borderRadius: 6,
    backgroundColor: '#f7f7f7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryGridText: {
    marginTop: 10,
    minHeight: 34,
    fontSize: 14,
    lineHeight: 17,
    fontWeight: '800',
    color: '#242424',
    textAlign: 'center',
  },
  loadingPanel: {
    flex: 1,
    minHeight: 280,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingPanelText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: '700',
    color: '#6e6258',
  },
  mobileTrendingSection: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  shopByCategoryWrap: {
    width: '100%',
    marginBottom: 18,
  },
  shopByCategoryLegacyGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 14,
  },
  shopByCategoryItem: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  shopByCategoryImage: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: '#f3f3f3',
    borderWidth: 2,
    borderColor: '#fff',
    ...platformShadow('0 8px 18px rgba(30,18,10,0.10)', {
      shadowColor: '#000',
      shadowOpacity: 0.1,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 6 },
      elevation: 3,
    }),
  },
  shopByCategoryPlaceholder: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#f3f3f3',
    borderWidth: 1,
    borderColor: '#ededed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shopByCategoryText: {
    marginTop: 7,
    fontSize: 9,
    lineHeight: 12,
    color: '#222',
    fontWeight: '800',
    textAlign: 'center',
  },
  feedLoadingWrap: {
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featuredBrandsWrap: {
    marginTop: -2,
    marginBottom: 16,
    width: '100%',
  },
  smallSectionHeader: {
    marginBottom: 10,
  },
  smallSectionTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#111',
  },
  smallSectionTitleMobile: {
    fontSize: 15,
  },
  featuredBrandsRow: {
    paddingRight: 12,
    gap: 12,
  },
  featuredBrandItem: {
    width: 74,
    alignItems: 'center',
  },
  featuredBrandImage: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#f3f3f3',
    borderWidth: 1,
    borderColor: '#ededed',
  },
  featuredBrandText: {
    marginTop: 6,
    fontSize: 10,
    lineHeight: 12,
    color: '#333',
    fontWeight: '700',
    textAlign: 'center',
  },
  heroCard: {
    width: '100%',
    height: 180,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#f6f0e8',
    marginBottom: 16,
  },
  heroCardMobile: {
    height: 124,
    borderRadius: 16,
    marginBottom: 10,
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,17,0.28)',
  },
  heroContent: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: 16,
  },
  heroChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.88)',
    marginBottom: 10,
  },
  heroChipText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#111',
    textTransform: 'uppercase',
  },
  heroTitle: {
    fontSize: 26,
    lineHeight: 30,
    fontWeight: '800',
    color: '#fff',
  },
  heroTitleMobile: {
    fontSize: 13,
    lineHeight: 16,
  },
  heroCopy: {
    marginTop: 6,
    fontSize: 14,
    color: 'rgba(255,255,255,0.9)',
    fontWeight: '600',
  },
  heroCopyMobile: {
    marginTop: 3,
    fontSize: 10,
    lineHeight: 12,
  },
  panelHeader: {
    width: '100%',
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  panelTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
  },
  panelTitleMobile: {
    fontSize: 14,
  },
  panelMeta: {
    fontSize: 13,
    color: '#8b8b90',
    fontWeight: '700',
  },
  panelMetaMobile: {
    fontSize: 10,
  },
  legacyCategoryGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  categoryGridMobile: {
    justifyContent: 'space-between',
  },
  categoryCard: {
    width: '33.33%',
    alignItems: 'center',
    marginBottom: 22,
    paddingHorizontal: 6,
  },
  categoryCardDesktop: {
    width: '33.33%',
  },
  categoryCardMobile: {
    width: '50%',
    marginBottom: 14,
    paddingHorizontal: 3,
  },
  categoryCardDisabled: {
    opacity: 0.78,
  },
  categoryThumbWrap: {
    width: 94,
    height: 94,
    borderRadius: 47,
    overflow: 'visible',
    backgroundColor: '#f3f3f3',
    marginBottom: 12,
    position: 'relative',
  },
  categoryThumbWrapMobile: {
    width: 64,
    height: 64,
    borderRadius: 32,
    marginBottom: 6,
  },
  categoryThumb: {
    width: '100%',
    height: '100%',
    borderRadius: 47,
  },
  categoryCardText: {
    fontSize: 14,
    lineHeight: 18,
    color: '#222',
    textAlign: 'center',
    fontWeight: '700',
  },
  categoryCardTextMobile: {
    fontSize: 10,
    lineHeight: 12,
  },
  trendingHeader: {
    marginTop: 8,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  trendingHeaderMobile: {
    marginTop: 14,
    marginBottom: 12,
  },
  trendingTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
  },
  trendingTitleMobile: {
    fontSize: 18,
    flex: 1,
    paddingRight: 8,
    fontWeight: '900',
  },
  trendingSort: {
    fontSize: 14,
    color: '#8a6a5a',
    fontWeight: '700',
  },
  trendingSortMobile: {
    fontSize: 12,
    lineHeight: 16,
  },
  trendingList: {
    width: '100%',
    gap: 10,
    backgroundColor: 'transparent',
  },
  trendingListMobile: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 16,
    columnGap: 0,
    backgroundColor: 'transparent',
  },
  fadeInCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  fadeInCardMobile: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ededed',
    padding: 10,
    paddingRight: 54,
    position: 'relative',
    ...platformShadow('0 4px 10px rgba(0,0,0,0.05)', {
        shadowColor: '#000',
        shadowOpacity: 0.05,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        elevation: 2,
    }),
  },
  productCardMobile: {
    width: '48.5%',
    minHeight: 0,
    padding: 0,
    paddingRight: 0,
    paddingBottom: 8,
    borderRadius: 14,
    borderWidth: 0,
    borderColor: '#f1e7dc',
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  productCartBubble: {
    position: 'absolute',
    top: -10,
    right: 8,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '10deg' }],
    ...platformShadow('0 3px 6px rgba(0,0,0,0.08)', {
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 3 },
        elevation: 3,
    }),
  },
  productCartBubbleMobile: {
    top: 78,
    right: 6,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    transform: [{ rotate: '0deg' }],
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  productCartBubbleInner: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  productCartBubblePlus: {
    position: 'absolute',
    top: 4,
    right: 3,
  },
  productImage: {
    width: 60,
    height: 60,
    borderRadius: 14,
    backgroundColor: '#eee',
  },
  productImageMobile: {
    width: '100%',
    height: undefined,
    aspectRatio: 1,
    borderRadius: 12,
    backgroundColor: '#f6f6f6',
  },
  productInfo: {
    flex: 1,
    marginLeft: 8,
  },
  productInfoMobile: {
    marginLeft: 0,
    marginTop: 7,
    paddingHorizontal: 2,
  },
  productTitle: {
    fontSize: 12,
    lineHeight: 16,
    color: '#111',
    fontWeight: '600',
  },
  productTitleMobile: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
  },
  productPrice: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '800',
    color: '#ff6a00',
  },
  productPriceMobile: {
    marginTop: 4,
    fontSize: 14,
    color: '#111',
  },
  popularBrandsWrap: {
    marginTop: 18,
    width: '100%',
  },
  popularBrandsGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  popularBrandsGridMobile: {
    rowGap: 8,
  },
  popularBrandCard: {
    width: '48.5%',
    minHeight: 78,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ededed',
    backgroundColor: '#fff',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  popularBrandCardMobile: {
    width: '100%',
    minHeight: 66,
    borderRadius: 16,
    padding: 8,
  },
  popularBrandImage: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#f3f3f3',
  },
  popularBrandText: {
    flex: 1,
    marginLeft: 10,
    fontSize: 13,
    lineHeight: 16,
    color: '#111',
    fontWeight: '800',
  },
  popularBrandTextMobile: {
    fontSize: 11,
    lineHeight: 14,
  },
  emptyWrap: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  trendingViewAllEmptyWrap: {
    paddingVertical: 28,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  emptyText: {
    color: '#777',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyRetryButton: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#fff4ea',
    borderWidth: 1,
    borderColor: '#ffd8b8',
  },
  emptyRetryText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '700',
  },
  emptySubText: {
    marginTop: 8,
    color: '#999',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
