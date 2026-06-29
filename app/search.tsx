import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BackHandler,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CATALOG_LIST_PROPS } from '../components/catalog/ListPerf';
import { router, useFocusEffect } from 'expo-router';
import NoodSpinner from '../components/NoodSpinner';
import { useCart } from '../context/CartContext';
import { BASE_CURRENCY, normalizeCatalogCurrencyCode } from '../utils/currency';
import { fetchCatalogPath, peekCatalogFreshness } from '../utils/catalog';
import {
  getConfiguredBackendUrl,
  getLastSuccessfulBackendUrl,
  PAYMENT_BACKEND_URL,
} from '../utils/backend';
import { buildProductRouteParams } from '../utils/product-navigation';
import { NOOD_REFRESH_CONTROL_PROPS } from '../utils/navigation-gestures';
import { useScreenPerfReporter } from '../utils/screen-perf';
import {
  getProductAvailabilityLabel,
  resolveListProductAvailableForSale,
  resolveListProductSoldOut,
} from '../utils/product-availability';

const SEARCH_PRODUCTS_CACHE_KEY = 'NOOD_SEARCH_PRODUCTS_CACHE_V1';
const HOME_PRODUCTS_CACHE_KEY = 'NOOD_HOME_PRODUCTS_CACHE_V2';
const SEARCH_POPULAR_PRODUCT_LIMIT = 60;

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PERF_DEBUG = false;

function searchPerfLog(...args: unknown[]) {
  if (SEARCH_PERF_DEBUG) {
    console.log(...args);
  }
}

type SearchProduct = {
  id: string;
  title: string;
  handle: string;
  brand: string;
  vendor?: string;
  category: string;
  productType?: string;
  product_type?: string;
  description: string;
  tags: string[];
  collections?: string[];
  image: string;
  price: string;
  oldPrice?: string | null;
  priceAmount: number;
  oldPriceAmount?: number | null;
  currencyCode: string;
  collectionHandle: string;
  collectionTitle?: string;
  collectionHandles?: string[];
  collectionTitles?: string[];
  availableForSale?: boolean;
};

type SearchProductsCache = {
  products: SearchProduct[];
  savedAt?: string;
};

type HomeProductsCache = {
  version?: number;
  products?: SearchProduct[];
  nextCursor?: string | null;
  hasMore?: boolean;
  mixKey?: number | null;
  savedAt?: string;
};

type SearchProductCardProps = {
  item: SearchProduct;
  displayPrice: string;
  displayOldPrice: string | null;
  onOpen: (product: SearchProduct) => void;
};

function searchProductCardPropsAreEqual(
  prev: SearchProductCardProps,
  next: SearchProductCardProps
) {
  return (
    prev.item.id === next.item.id &&
    prev.item.handle === next.item.handle &&
    prev.item.image === next.item.image &&
    prev.item.title === next.item.title &&
    prev.displayPrice === next.displayPrice &&
    prev.displayOldPrice === next.displayOldPrice &&
    prev.onOpen === next.onOpen
  );
}

const SearchProductCard = React.memo(function SearchProductCard({
  item,
  displayPrice,
  displayOldPrice,
  onOpen,
}: SearchProductCardProps) {
  const isSoldOut = resolveListProductSoldOut(item);

  return (
    <TouchableOpacity
      style={styles.productCard}
      activeOpacity={0.9}
      onPress={() => onOpen(item)}
    >
      <ExpoImage
        source={{ uri: item.image }}
        style={styles.productImage}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={item.image || item.id}
        transition={0}
      />
      <Text style={styles.productTitle} numberOfLines={2}>
        {item.title}
      </Text>
      <Text style={styles.productMeta} numberOfLines={1}>
        {item.brand || item.category}
      </Text>
      <View style={styles.priceRow}>
        <Text style={styles.productPrice}>{displayPrice}</Text>
        {displayOldPrice ? <Text style={styles.oldPrice}>{displayOldPrice}</Text> : null}
      </View>
      {isSoldOut ? (
        <Text style={styles.stockUnavailableText}>{getProductAvailabilityLabel(item)}</Text>
      ) : null}
    </TouchableOpacity>
  );
}, searchProductCardPropsAreEqual);

function parseHomeProductsCacheRaw(raw: string | null): SearchProduct[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as SearchProduct[] | HomeProductsCache;

    if (Array.isArray(parsed)) {
      return parsed
        .filter((product) => product?.handle)
        .slice(0, SEARCH_POPULAR_PRODUCT_LIMIT)
        .map(normalizeCachedProduct);
    }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.products)) {
      return parsed.products
        .filter((product) => product?.handle)
        .slice(0, SEARCH_POPULAR_PRODUCT_LIMIT)
        .map(normalizeCachedProduct);
    }
  } catch (error) {
    searchPerfLog('[NOOD search] cache read error', {
      source: 'home-cache',
      error: String((error as any)?.message || error),
    });
  }

  return [];
}

async function readHomePopularProductsFromCache(): Promise<SearchProduct[]> {
  try {
    const homeRaw = await AsyncStorage.getItem(HOME_PRODUCTS_CACHE_KEY);
    const products = parseHomeProductsCacheRaw(homeRaw);

    if (products.length) {
      searchPerfLog('[NOOD search] home cache popular count', products.length);
      searchPerfLog('[NOOD search] using home cache for popular');
    }

    return products;
  } catch (error) {
    searchPerfLog('[NOOD search] cache read error', {
      source: 'home-cache',
      error: String((error as any)?.message || error),
    });
    return [];
  }
}

function formatMoney(amount?: string | null) {
  if (!amount) return '$0.00';
  return `$${Number(amount).toFixed(2)}`;
}

function getOptimizedImageUrl(url?: string | null, width = 520) {
  if (!url) return 'https://via.placeholder.com/600x700.png?text=No+Image';

  try {
    const parsed = new URL(url);
    parsed.searchParams.set('width', String(width));
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeCachedProduct(product: SearchProduct): SearchProduct {
  const priceAmount =
    Number.isFinite(Number(product.priceAmount)) && Number(product.priceAmount) > 0
      ? Number(product.priceAmount)
      : Number(String(product.price || '').replace(/[^0-9.]/g, '')) || 0;

  return {
    ...product,
    brand: product.brand || '',
    vendor: product.vendor || product.brand || '',
    category: product.category || product.collectionHandle || '',
    productType: product.productType || product.category || '',
    product_type: product.product_type || product.productType || product.category || '',
    description: product.description || '',
    tags: Array.isArray(product.tags) ? product.tags : [],
    collections: Array.isArray(product.collections) ? product.collections : [],
    collectionTitle: product.collectionTitle || '',
    collectionTitles: Array.isArray(product.collectionTitles) ? product.collectionTitles : [],
    collectionHandles: Array.isArray(product.collectionHandles) ? product.collectionHandles : [],
    availableForSale: product.availableForSale ?? true,
    image: getOptimizedImageUrl(product.image),
    priceAmount,
    oldPriceAmount:
      Number.isFinite(Number(product.oldPriceAmount)) && Number(product.oldPriceAmount) > 0
        ? Number(product.oldPriceAmount)
        : Number(String(product.oldPrice || '').replace(/[^0-9.]/g, '')) || null,
    currencyCode: product.currencyCode || BASE_CURRENCY,
  };
}

function normalizeSearchValue(value: string) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const normalize = normalizeSearchValue;

function compactSearchValue(value: string) {
  return normalizeSearchValue(value).replace(/\s+/g, '');
}

function getCollectionLabel(product: SearchProduct) {
  return product.collectionTitle || product.collectionTitles?.[0] || '';
}

function getProductSearchText(product: SearchProduct) {
  return normalizeSearchValue(
    [
      product.title,
      product.handle,
      product.vendor,
      product.brand,
      product.productType,
      product.product_type,
      product.category,
      product.collectionHandle,
      getCollectionLabel(product),
      ...(product.collections || []),
      ...(product.collectionHandles || []),
      ...(product.collectionTitles || []),
      product.tags.join(' '),
      product.description,
      product.price,
      String(product.priceAmount || ''),
    ].join(' ')
  );
}

function buildSearchText(product: SearchProduct) {
  return normalize(
    [
      product.title,
      product.vendor,
      product.brand,
      product.productType,
      product.product_type,
      product.category,
      product.description,
      ...(product.tags || []),
      ...(product.collections || []),
      ...(product.collectionHandles || []),
      ...(product.collectionTitles || []),
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function productMatchesStrictSearch(product: SearchProduct, searchText: string) {
  const query = normalize(searchText);
  if (!query) return false;

  const searchBody = buildSearchText(product);
  if (!searchBody) return false;

  const compactBody = compactSearchValue(searchBody);
  const words = searchBody.split(' ').filter(Boolean);
  const queryTokens = query.split(' ').filter(Boolean);

  if (!queryTokens.length) return false;

  return queryTokens.every((token) => {
    if (token.length === 1) {
      return words.some((word) => word.startsWith(token));
    }

    const compactToken = compactSearchValue(token);
    return (
      searchBody.includes(token) ||
      compactBody.includes(compactToken) ||
      words.some((word) => word.startsWith(token)) ||
      words.some((word) => wordIsCloseToToken(word, token))
    );
  });
}

function filterProducts(products: SearchProduct[], searchText: string) {
  const query = normalize(searchText);
  if (!query) return [];

  return products.filter((product) => productMatchesStrictSearch(product, query));
}

function levenshteinDistance(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function wordIsCloseToToken(word: string, token: string) {
  if (token.length < 4 || word.length < 4) return false;
  if (word.includes(token) || token.includes(word)) return true;

  const maxDistance = token.length <= 5 ? 1 : 2;
  return levenshteinDistance(word, token) <= maxDistance;
}

function getSearchScore(product: SearchProduct, query: string) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return 1;

  const productText = getProductSearchText(product);
  const productCompact = compactSearchValue(productText);
  const queryCompact = compactSearchValue(normalizedQuery);
  const productWords = productText.split(' ').filter(Boolean);
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const titleText = normalizeSearchValue(product.title);
  const titleCompact = compactSearchValue(product.title);
  const handleCompact = compactSearchValue(product.handle);

  if (!queryCompact) return 1;

  let score = 0;

  if (titleText === normalizedQuery || titleCompact === queryCompact || handleCompact === queryCompact) {
    score += 1000;
  }

  if (titleText.includes(normalizedQuery)) score += 700;
  if (titleCompact.includes(queryCompact)) score += 650;
  if (productText.includes(normalizedQuery)) score += 500;
  if (productCompact.includes(queryCompact)) score += 450;

  const allTokensMatch = queryTokens.every((token) => {
    if (token.length === 1) {
      return productCompact.includes(token);
    }

    if (productText.includes(token) || productCompact.includes(token)) {
      return true;
    }

    return productWords.some((word) => wordIsCloseToToken(word, token));
  });

  if (!allTokensMatch && score === 0) return 0;

  queryTokens.forEach((token) => {
    if (titleText.includes(token)) score += token.length === 1 ? 8 : 90;
    if (productText.includes(token)) score += token.length === 1 ? 4 : 45;
    if (productWords.some((word) => word === token)) score += 75;
    if (productWords.some((word) => word.startsWith(token) && token.length >= 2)) score += 65;
    if (productWords.some((word) => wordIsCloseToToken(word, token))) score += 20;
  });

  return score;
}

function getSimilarSearchScore(product: SearchProduct, query: string) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return 1;

  const productText = getProductSearchText(product);
  const productWords = productText.split(' ').filter(Boolean);
  const queryTokens = normalizedQuery.split(' ').filter((token) => token.length >= 2);

  if (!queryTokens.length) return getSearchScore(product, query);

  return queryTokens.reduce((score, token) => {
    if (productText.includes(token)) return score + 45;
    if (productWords.some((word) => word.startsWith(token[0]) && wordIsCloseToToken(word, token))) {
      return score + 28;
    }
    if (productWords.some((word) => wordIsCloseToToken(word, token))) {
      return score + 18;
    }
    return score;
  }, 0);
}

function mergeProducts(primary: SearchProduct[], secondary: SearchProduct[]) {
  const seen = new Set<string>();
  const merged: SearchProduct[] = [];

  [...primary, ...secondary].forEach((product) => {
    const key = product.id || product.handle;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(product);
  });

  return merged;
}

const SEARCH_BACKEND_TIMEOUT_MS = 20000;
const SEARCH_BOOTSTRAP_TIMEOUT_MS = 25000;

async function readInstantDefaultProductsFromCache(): Promise<SearchProduct[]> {
  return readHomePopularProductsFromCache();
}

async function fetchBackendSearchProducts(query: string) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return [];
  }

  const path = `/api/catalog/search?q=${encodeURIComponent(trimmed)}&limit=80&first=80`;
  const backendUrl = getConfiguredBackendUrl();

  searchPerfLog('[NOOD search] backend request', {
    query: trimmed,
    backendUrl: backendUrl || '(not set)',
    path,
  });

  try {
    const json = await fetchCatalogPath(path, {
      skipLocalCache: true,
      timeoutMs: SEARCH_BACKEND_TIMEOUT_MS,
    });
    const products = mapProducts(json?.data?.products?.edges || []);
    searchPerfLog('[NOOD catalog] search count', products.length);
    searchPerfLog('[NOOD search] backend response count', {
      query: trimmed,
      count: products.length,
      source: json?.source || 'unknown',
    });
    return products;
  } catch (error) {
    searchPerfLog('[NOOD search] backend error', {
      query: trimmed,
      backendUrl: backendUrl || '(not set)',
      path,
      error: String((error as any)?.message || error),
    });
    return [];
  }
}

async function fetchSearchCatalogBootstrap(): Promise<{
  products: SearchProduct[];
  usedFallback: boolean;
}> {
  const path = '/api/catalog/products?limit=48&first=48&sort=updated';
  const primaryUrl = getConfiguredBackendUrl();

  searchPerfLog('[NOOD search] fetching backend bootstrap', {
    path,
    primaryUrl: primaryUrl || '(not set)',
  });

  const json = await fetchCatalogPath(path, {
    skipLocalCache: true,
    timeoutMs: SEARCH_BOOTSTRAP_TIMEOUT_MS,
  });
  const edges = json?.data?.products?.edges || [];
  const products = mapProducts(edges);
  const resolvedUrl = getLastSuccessfulBackendUrl();
  const usedFallback = Boolean(primaryUrl && resolvedUrl && primaryUrl !== resolvedUrl);

  if (usedFallback) {
    searchPerfLog('[NOOD search] backend fallback used', {
      primaryUrl,
      resolvedUrl: resolvedUrl || PAYMENT_BACKEND_URL,
    });
  }

  return { products, usedFallback };
}

function mapProducts(edges: any[]): SearchProduct[] {
  return (edges || []).map((edge) => {
    const node = edge?.node || {};
    const priceAmount = Number(node.priceRange?.minVariantPrice?.amount || 0);
    const oldPriceAmount = node.compareAtPriceRange?.maxVariantPrice?.amount
      ? Number(node.compareAtPriceRange.maxVariantPrice.amount)
      : null;
    const currencyCode = normalizeCatalogCurrencyCode(
      node.priceRange?.minVariantPrice?.currencyCode ||
        node.compareAtPriceRange?.maxVariantPrice?.currencyCode
    );
    const collectionHandles =
      node.collections?.edges?.map((collection: any) => collection.node?.handle).filter(Boolean) ||
      [];
    const collectionTitles =
      node.collections?.edges?.map((collection: any) => collection.node?.title).filter(Boolean) ||
      [];
    const matchedCollection = collectionHandles[0] || 'all';
    const category =
      node.productType ||
      collectionTitles[0] ||
      matchedCollection;

    const mapped: SearchProduct = {
      id: String(node.id),
      title: String(node.title || 'Product'),
      handle: String(node.handle || ''),
      brand: String(node.vendor || ''),
      vendor: String(node.vendor || ''),
      category: String(category || ''),
      productType: String(node.productType || ''),
      product_type: String(node.productType || ''),
      description: String(node.description || ''),
      tags: Array.isArray(node.tags) ? node.tags : [],
      collections: collectionTitles,
      image: getOptimizedImageUrl(node.featuredImage?.url),
      price: formatMoney(String(priceAmount)),
      oldPrice: oldPriceAmount ? formatMoney(String(oldPriceAmount)) : null,
      priceAmount,
      oldPriceAmount,
      currencyCode,
      collectionHandle: matchedCollection,
      collectionTitle: collectionTitles[0] || matchedCollection,
      collectionHandles,
      collectionTitles,
      variants: node.variants?.edges?.length ? node.variants : undefined,
      availableForSale: true,
    };
    mapped.availableForSale = resolveListProductAvailableForSale(mapped);
    return mapped;
  });
}

function hasTypedSearchQuery(value: string) {
  return value.trim().length > 0;
}

function hasBackendSearchQuery(value: string) {
  return value.trim().length >= 2;
}

export default function SearchScreen() {
  const inputRef = useRef<TextInput>(null);
  const {
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney: formatCurrencyMoney,
  } = useCart();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [defaultProducts, setDefaultProducts] = useState<SearchProduct[]>([]);
  const defaultProductsRef = useRef<SearchProduct[]>([]);
  const [remoteSearchProducts, setRemoteSearchProducts] = useState<SearchProduct[]>([]);
  const [searchingFreshResults, setSearchingFreshResults] = useState(false);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const bootstrapRequestIdRef = useRef(0);
  const searchRequestSeqRef = useRef(0);
  const activeSearchQueryRef = useRef('');
  const lastSuccessfulSearchRef = useRef<{ query: string; products: SearchProduct[] }>({
    query: '',
    products: [],
  });

  useEffect(() => {
    defaultProductsRef.current = defaultProducts;
  }, [defaultProducts]);

  const applyDefaultProducts = useCallback((nextProducts: SearchProduct[], source: string) => {
    defaultProductsRef.current = nextProducts;
    setDefaultProducts(nextProducts);

    if (!hasTypedSearchQuery(activeSearchQueryRef.current)) {
      setLoadError('');
      if (source === 'home-cache') {
        searchPerfLog('[NOOD search] popular products loaded count', nextProducts.length, { source });
      } else {
        searchPerfLog('[NOOD search] bootstrap products loaded count', nextProducts.length, { source });
      }
      return;
    }

    searchPerfLog('[NOOD search] popular ignored because active query exists', {
      query: activeSearchQueryRef.current,
      count: nextProducts.length,
      source,
    });
  }, []);

  const handleBackPress = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return true;
    }

    router.replace('/(tabs)');
    return true;
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [handleBackPress]);

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 250);

    return () => clearTimeout(timer);
  }, []);

  const refreshDefaultProductsInBackground = useCallback(async () => {
    const requestId = bootstrapRequestIdRef.current + 1;
    bootstrapRequestIdRef.current = requestId;
    const startedWithActiveQuery = hasTypedSearchQuery(activeSearchQueryRef.current);

    if (!defaultProductsRef.current.length && !startedWithActiveQuery) {
      setLoadingDefaults(true);
    }

    void peekCatalogFreshness('search').catch((error) => {
      searchPerfLog('[NOOD search] version check skipped', {
        error: String((error as any)?.message || error),
      });
    });

    try {
      const homePopular = await readHomePopularProductsFromCache();
      if (requestId !== bootstrapRequestIdRef.current) {
        searchPerfLog('[NOOD search] ignored stale popular refresh', { requestId });
        return;
      }

      if (homePopular.length) {
        applyDefaultProducts(homePopular, 'home-cache');
        return;
      }

      searchPerfLog('[NOOD search] fallback to search bootstrap popular');
      const { products: fetchedProducts } = await fetchSearchCatalogBootstrap();
      if (requestId !== bootstrapRequestIdRef.current) {
        searchPerfLog('[NOOD search] ignored stale bootstrap response', { requestId });
        return;
      }

      if (fetchedProducts.length) {
        applyDefaultProducts(fetchedProducts, 'bootstrap');
        await AsyncStorage.setItem(
          SEARCH_PRODUCTS_CACHE_KEY,
          JSON.stringify({
            products: fetchedProducts,
            savedAt: new Date().toISOString(),
          } satisfies SearchProductsCache)
        );
      } else if (!defaultProductsRef.current.length && !hasTypedSearchQuery(activeSearchQueryRef.current)) {
        setLoadError('No products returned from backend. Tap retry.');
      }
    } catch (error) {
      if (requestId !== bootstrapRequestIdRef.current) {
        searchPerfLog('[NOOD search] ignored stale bootstrap response', { requestId });
        return;
      }
      const message = String((error as any)?.message || error);
      if (!defaultProductsRef.current.length && !hasTypedSearchQuery(activeSearchQueryRef.current)) {
        setLoadError('Could not load search products. Tap retry.');
      }
      searchPerfLog('[NOOD search] backend error', { stage: 'bootstrap', error: message });
    } finally {
      if (requestId === bootstrapRequestIdRef.current) {
        setLoadingDefaults(false);
      }
    }
  }, [applyDefaultProducts]);

  const handlePullRefresh = useCallback(async () => {
    setPullRefreshing(true);
    try {
      await refreshDefaultProductsInBackground();
      const activeQuery = activeSearchQueryRef.current.trim();
      if (hasBackendSearchQuery(activeQuery)) {
        const freshProducts = await fetchBackendSearchProducts(activeQuery);
        if (activeSearchQueryRef.current.trim() === activeQuery) {
          setRemoteSearchProducts(freshProducts);
          if (freshProducts.length) {
            lastSuccessfulSearchRef.current = { query: activeQuery, products: freshProducts };
          }
        }
      }
    } finally {
      setPullRefreshing(false);
    }
  }, [refreshDefaultProductsInBackground]);

  useEffect(() => {
    activeSearchQueryRef.current = query.trim();
    searchPerfLog('[NOOD search] query changed', { query: query.trim() });
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const nextDebouncedQuery = query.trim();
      setDebouncedQuery(nextDebouncedQuery);
      searchPerfLog('[NOOD search] debounced query', { query: nextDebouncedQuery });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const trimmedQuery = debouncedQuery.trim();
    const requestId = searchRequestSeqRef.current + 1;
    searchRequestSeqRef.current = requestId;

    if (!hasBackendSearchQuery(trimmedQuery)) {
      if (!hasTypedSearchQuery(activeSearchQueryRef.current)) {
        setRemoteSearchProducts([]);
        lastSuccessfulSearchRef.current = { query: '', products: [] };
      }
      setSearchingFreshResults(false);
      return;
    }

    const localMatches = filterProducts(defaultProductsRef.current, trimmedQuery);
    const hasVisibleLocalResults =
      localMatches.length > 0 ||
      (lastSuccessfulSearchRef.current.query === trimmedQuery &&
        lastSuccessfulSearchRef.current.products.length > 0);
    setSearchingFreshResults(!hasVisibleLocalResults);

    searchPerfLog('[NOOD search] search request start', {
      query: trimmedQuery,
      requestId,
    });
    searchPerfLog('[NOOD search] local prefetch', {
      query: trimmedQuery,
      localMatches: localMatches.length,
      localPool: defaultProductsRef.current.length,
    });

    void fetchBackendSearchProducts(trimmedQuery)
      .then((freshProducts) => {
        if (searchRequestSeqRef.current !== requestId) {
          searchPerfLog('[NOOD search] ignored stale response', {
            requestId,
            query: trimmedQuery,
            reason: 'superseded-request',
          });
          return;
        }

        if (activeSearchQueryRef.current.trim() !== trimmedQuery) {
          searchPerfLog('[NOOD search] ignored stale response', {
            requestId,
            query: trimmedQuery,
            activeQuery: activeSearchQueryRef.current,
            reason: 'query-changed',
          });
          return;
        }

        const nextProducts =
          freshProducts.length > 0
            ? freshProducts
            : lastSuccessfulSearchRef.current.query === trimmedQuery
              ? lastSuccessfulSearchRef.current.products
              : [];

        if (freshProducts.length > 0) {
          lastSuccessfulSearchRef.current = { query: trimmedQuery, products: freshProducts };
        }

        setRemoteSearchProducts(nextProducts);
        searchPerfLog('[NOOD search] search response', {
          query: trimmedQuery,
          requestId,
          count: nextProducts.length,
          usedCachedFallback: !freshProducts.length && nextProducts.length > 0,
        });
      })
      .finally(() => {
        if (
          searchRequestSeqRef.current === requestId &&
          activeSearchQueryRef.current.trim() === trimmedQuery
        ) {
          setSearchingFreshResults(false);
        }
      });
  }, [debouncedQuery]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      void (async () => {
        searchPerfLog('[NOOD search] screen opened');

        if (!hasTypedSearchQuery(activeSearchQueryRef.current)) {
          const cachedProducts = await readInstantDefaultProductsFromCache();
          if (cancelled) return;

          if (cachedProducts.length) {
            applyDefaultProducts(cachedProducts, 'home-cache');
          } else if (!defaultProductsRef.current.length) {
            setLoadingDefaults(true);
          }
        } else {
          searchPerfLog('[NOOD search] popular ignored because active query exists', {
            query: activeSearchQueryRef.current,
            source: 'focus-cache',
          });
        }

        if (!cancelled) {
          await refreshDefaultProductsInBackground();
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [applyDefaultProducts, refreshDefaultProductsInBackground])
  );

  const activeSearchQuery = useMemo(() => query.trim(), [query]);

  const results = useMemo(() => {
    if (!activeSearchQuery) return [];

    const localMatches = filterProducts(defaultProducts, activeSearchQuery);

    if (!hasBackendSearchQuery(activeSearchQuery)) {
      return localMatches
        .map((product) => ({
          product,
          score: getSearchScore(product, activeSearchQuery),
        }))
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.product);
    }

    const merged = remoteSearchProducts.length
      ? mergeProducts(remoteSearchProducts, localMatches)
      : localMatches;

    const ranked = merged
      .map((product) => ({
        product,
        score: getSearchScore(product, activeSearchQuery),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.product);

    return ranked;
  }, [activeSearchQuery, defaultProducts, remoteSearchProducts]);

  const suggestedProducts = useMemo(() => {
    if (!activeSearchQuery || results.length) return [];

    const strictIds = new Set(results.map((product) => product.id || product.handle));
    const searchPool = mergeProducts(remoteSearchProducts, defaultProducts);
    return searchPool
      .map((product) => ({
        product,
        score: getSimilarSearchScore(product, activeSearchQuery),
      }))
      .filter((entry) => entry.score > 0 && !strictIds.has(entry.product.id || entry.product.handle))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24)
      .map((entry) => entry.product);
  }, [activeSearchQuery, defaultProducts, remoteSearchProducts, results]);

  const displayedProducts = useMemo(() => {
    if (!activeSearchQuery) return defaultProducts;
    return results.length ? results : suggestedProducts;
  }, [activeSearchQuery, defaultProducts, results, suggestedProducts]);

  useEffect(() => {
    if (activeSearchQuery.length === 0) {
      void (async () => {
        const homePopular = await readHomePopularProductsFromCache();
        if (homePopular.length) {
          applyDefaultProducts(homePopular, 'home-cache');
        }
      })();
    }
  }, [activeSearchQuery, applyDefaultProducts]);

  useEffect(() => {
    if (searchingFreshResults && displayedProducts.length > 0) {
      setSearchingFreshResults(false);
    }
  }, [displayedProducts.length, searchingFreshResults]);

  const suggestionLabels = useMemo(() => {
    if (!activeSearchQuery) return [];

    return (results.length ? results : suggestedProducts)
      .slice(0, 5)
      .map((product) => product.title)
      .filter((title, index, titles) => title && titles.indexOf(title) === index);
  }, [activeSearchQuery, results, suggestedProducts]);

  const hasExactOrPartialResults = useMemo(() => {
    if (!activeSearchQuery) return true;

    return results.length > 0;
  }, [activeSearchQuery, results.length]);

  const openProduct = useCallback((product: SearchProduct) => {
    if (!product.handle) return;

    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(product, { from: 'search' }),
    });
  }, []);

  const getDisplayPrice = useCallback(
    (product: SearchProduct) =>
      formatCurrencyMoney(
        convertPrice(product.priceAmount || 0, product.currencyCode || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      ),
    [convertPrice, formatCurrencyMoney, selectedCurrency]
  );

  const getDisplayOldPrice = useCallback(
    (product: SearchProduct) => {
      if (!product.oldPrice && !product.oldPriceAmount) return null;
      const amount = Number(product.oldPriceAmount || 0);
      if (!amount) return null;

      return formatCurrencyMoney(
        convertPrice(amount, product.currencyCode || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      );
    },
    [convertPrice, formatCurrencyMoney, selectedCurrency]
  );

  const searchPriceById = useMemo(() => {
    const map = new Map<string, { displayPrice: string; displayOldPrice: string | null }>();
    displayedProducts.forEach((item) => {
      map.set(item.id, {
        displayPrice: getDisplayPrice(item),
        displayOldPrice: getDisplayOldPrice(item),
      });
    });
    return map;
  }, [displayedProducts, getDisplayOldPrice, getDisplayPrice]);

  const searchKeyExtractor = useCallback((item: SearchProduct) => item.id, []);

  const renderProduct = useCallback(
    ({ item }: { item: SearchProduct }) => {
      const prices = searchPriceById.get(item.id);
      return (
        <SearchProductCard
          item={item}
          displayPrice={prices?.displayPrice || getDisplayPrice(item)}
          displayOldPrice={prices?.displayOldPrice ?? getDisplayOldPrice(item)}
          onOpen={openProduct}
        />
      );
    },
    [getDisplayOldPrice, getDisplayPrice, openProduct, searchPriceById]
  );

  const listHeaderComponent = useMemo(() => {
    if (!activeSearchQuery) {
      return defaultProducts.length ? (
        <Text style={styles.resultsHint}>Popular products</Text>
      ) : null;
    }

    return (
      <View style={styles.searchFeedbackWrap}>
        {!hasExactOrPartialResults ? (
          <>
            <Text style={styles.noExactTitle}>No exact results found</Text>
            {suggestedProducts.length ? (
              <Text style={styles.resultsHint}>Suggested products</Text>
            ) : searchingFreshResults && !displayedProducts.length ? (
              <Text style={styles.resultsHint}>Updating results...</Text>
            ) : null}
          </>
        ) : null}

        {suggestionLabels.length ? (
          <View style={styles.suggestionsRow}>
            {suggestionLabels.map((suggestion) => (
              <TouchableOpacity
                key={suggestion}
                style={styles.suggestionPill}
                activeOpacity={0.85}
                onPress={() => setQuery(suggestion)}
              >
                <Text style={styles.suggestionText} numberOfLines={1}>
                  {suggestion}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>
    );
  }, [
    activeSearchQuery,
    defaultProducts.length,
    displayedProducts.length,
    hasExactOrPartialResults,
    searchingFreshResults,
    suggestedProducts.length,
    suggestionLabels,
  ]);

  useScreenPerfReporter(
    'search',
    {
      itemCount: displayedProducts.length,
      isFetching: searchingFreshResults || loadingDefaults,
      isRefreshing: pullRefreshing,
    },
    [displayedProducts.length, loadingDefaults, pullRefreshing, searchingFreshResults]
  );

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} activeOpacity={0.85} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#111" />
        </TouchableOpacity>

        <View style={styles.searchBox}>
          <TextInput
            ref={inputRef}
            autoFocus
            placeholder="Search products"
            placeholderTextColor="#777"
            value={query}
            onChangeText={setQuery}
            style={styles.input}
            returnKeyType="search"
            autoCapitalize="none"
          />
          {query.length ? (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => {
                activeSearchQueryRef.current = '';
                searchRequestSeqRef.current += 1;
                lastSuccessfulSearchRef.current = { query: '', products: [] };
                setRemoteSearchProducts([]);
                setSearchingFreshResults(false);
                setQuery('');
              }}
            >
              <Ionicons name="close-circle" size={22} color="#777" />
            </TouchableOpacity>
          ) : (
            <Ionicons name="search" size={22} color="#777" />
          )}
        </View>
      </View>

      <FlatList
        data={displayedProducts}
        keyExtractor={searchKeyExtractor}
        numColumns={2}
        renderItem={renderProduct}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        {...CATALOG_LIST_PROPS}
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={() => void handlePullRefresh()}
            {...NOOD_REFRESH_CONTROL_PROPS}
          />
        }
        ListHeaderComponent={listHeaderComponent}
        ListEmptyComponent={
          displayedProducts.length === 0 && loadingDefaults ? (
            <View style={styles.emptyWrap}>
              <NoodSpinner size={48} />
            </View>
          ) : displayedProducts.length === 0 && loadError ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>{loadError}</Text>
              <TouchableOpacity
                style={styles.retryButton}
                activeOpacity={0.85}
                onPress={() => {
                  setLoadingDefaults(true);
                  setLoadError('');
                  void refreshDefaultProductsInBackground();
                }}
              >
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : displayedProducts.length === 0 && activeSearchQuery.length > 0 ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>
                {hasBackendSearchQuery(activeSearchQuery)
                  ? 'No products found'
                  : 'No matches yet. Keep typing to search.'}
              </Text>
            </View>
          ) : displayedProducts.length === 0 && !activeSearchQuery ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>No products found</Text>
              <TouchableOpacity
                style={styles.retryButton}
                activeOpacity={0.85}
                onPress={() => {
                  setLoadingDefaults(true);
                  setLoadError('');
                  void refreshDefaultProductsInBackground();
                }}
              >
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: '#fff',
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    backgroundColor: '#f5f5f5',
  },
  searchBox: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    paddingLeft: 16,
    paddingRight: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#111',
    marginRight: 8,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 36,
  },
  row: {
    justifyContent: 'space-between',
  },
  searchFeedbackWrap: {
    paddingBottom: 8,
  },
  noExactTitle: {
    color: '#111',
    fontSize: 16,
    fontWeight: '900',
    marginBottom: 8,
  },
  resultsHint: {
    color: '#777',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 8,
  },
  suggestionPill: {
    maxWidth: '100%',
    borderRadius: 999,
    backgroundColor: '#fff3e8',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  suggestionText: {
    color: '#ff6a00',
    fontSize: 12,
    fontWeight: '800',
  },
  productCard: {
    width: '48%',
    marginBottom: 18,
    backgroundColor: '#fff',
    borderRadius: 12,
  },
  productImage: {
    width: '100%',
    height: 230,
    borderRadius: 10,
    backgroundColor: '#eee',
  },
  productTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
    color: '#111',
    marginTop: 8,
  },
  productMeta: {
    fontSize: 12,
    color: '#777',
    marginTop: 3,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  productPrice: {
    fontSize: 15,
    color: '#ff4d00',
    fontWeight: '800',
  },
  stockUnavailableText: {
    marginTop: 4,
    fontSize: 12,
    color: '#b42318',
    fontWeight: '700',
  },
  oldPrice: {
    marginLeft: 6,
    fontSize: 12,
    color: '#999',
    textDecorationLine: 'line-through',
  },
  emptyWrap: {
    paddingTop: 90,
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
  },
  emptySubTitle: {
    marginTop: 8,
    fontSize: 14,
    color: '#777',
    textAlign: 'center',
    lineHeight: 19,
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#ff6a00',
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
});
