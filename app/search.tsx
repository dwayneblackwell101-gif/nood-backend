import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FlatList,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import NoodSpinner from '../components/NoodSpinner';
import { useCart } from '../context/CartContext';
import { BASE_CURRENCY } from '../utils/currency';
import { catalogFetch } from '../utils/catalog';
import { buildProductRouteParams } from '../utils/product-navigation';

const SEARCH_PRODUCTS_CACHE_KEY = 'NOOD_SEARCH_PRODUCTS_CACHE_V1';

const SEARCH_DEBOUNCE_MS = 300;

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

const ALL_PRODUCTS_QUERY = `
  query GetSearchProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          description
          tags
          availableForSale
          featuredImage {
            url
          }
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          compareAtPriceRange {
            maxVariantPrice {
              amount
              currencyCode
            }
          }
          collections(first: 10) {
            edges {
              node {
                handle
                title
              }
            }
          }
        }
      }
    }
  }
`;

const SHOPIFY_PRODUCT_SEARCH_QUERY = `
  query SearchProducts($first: Int!, $query: String!) {
    products(first: $first, query: $query, sortKey: RELEVANCE) {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          description
          tags
          availableForSale
          featuredImage {
            url
          }
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          compareAtPriceRange {
            maxVariantPrice {
              amount
              currencyCode
            }
          }
          collections(first: 10) {
            edges {
              node {
                handle
                title
              }
            }
          }
        }
      }
    }
  }
`;

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

function buildShopifySearchQuery(query: string) {
  const tokens = normalizeSearchValue(query)
    .split(' ')
    .filter((token) => token.length >= 2)
    .slice(0, 4);

  if (!tokens.length) return '';

  return tokens
    .flatMap((token) => [
      `title:${token}*`,
      `tag:${token}*`,
      `vendor:${token}*`,
      `product_type:${token}*`,
    ])
    .join(' OR ');
}

const SEARCH_BACKEND_TIMEOUT_MS = 30000;

async function fetchShopifySearchProducts(query: string) {
  const shopifyQuery = buildShopifySearchQuery(query);
  if (!shopifyQuery) return [];

  try {
    const json = await catalogGraphqlFetch(
      SHOPIFY_PRODUCT_SEARCH_QUERY,
      {
        first: 80,
        query: shopifyQuery,
      },
      { timeoutMs: SEARCH_BACKEND_TIMEOUT_MS }
    );

    return mapProducts(json?.data?.products?.edges || []);
  } catch (error) {
    console.log('[NOOD app] search backend timed out or failed; using local results', String(error));
    return [];
  }
}

async function fetchSearchCatalogBootstrap() {
  const json = await catalogGraphqlFetch(ALL_PRODUCTS_QUERY, {
    first: 48,
    after: null,
  });
  const edges = json?.data?.products?.edges || [];
  const products = mapProducts(edges);

  console.log(`[NOOD app] search bootstrap loaded count=${products.length}`);
  return products;
}

function mapProducts(edges: any[]): SearchProduct[] {
  return (edges || []).map((edge) => {
    const node = edge?.node || {};
    const priceAmount = Number(node.priceRange?.minVariantPrice?.amount || 0);
    const oldPriceAmount = node.compareAtPriceRange?.maxVariantPrice?.amount
      ? Number(node.compareAtPriceRange.maxVariantPrice.amount)
      : null;
    const currencyCode =
      node.priceRange?.minVariantPrice?.currencyCode ||
      node.compareAtPriceRange?.maxVariantPrice?.currencyCode ||
      BASE_CURRENCY;
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

    return {
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
      availableForSale: Boolean(node.availableForSale ?? true),
    };
  });
}

async function catalogGraphqlFetch(
  query: string,
  variables?: Record<string, any>,
  options?: { timeoutMs?: number }
) {
  return catalogFetch(query, variables, options);
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
  const [products, setProducts] = useState<SearchProduct[]>([]);
  const [remoteSearchProducts, setRemoteSearchProducts] = useState<SearchProduct[]>([]);
  const [searchingFreshResults, setSearchingFreshResults] = useState(false);
  const [loading, setLoading] = useState(true);
  const isFetchingRef = useRef(false);
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 250);

    return () => clearTimeout(timer);
  }, []);

  const loadSearchCache = useCallback(async () => {
    try {
      const cached = await AsyncStorage.getItem(SEARCH_PRODUCTS_CACHE_KEY);
      if (!cached) return false;

      const parsed = JSON.parse(cached) as SearchProduct[] | SearchProductsCache;
      const cachedProducts = Array.isArray(parsed) ? parsed : parsed.products;

      if (!Array.isArray(cachedProducts) || !cachedProducts.length) {
        return false;
      }

      setProducts(cachedProducts.map(normalizeCachedProduct));
      setLoading(false);
      return true;
    } catch (error) {
      console.log('Search cache read error:', error);
      return false;
    }
  }, []);

  const refreshSearchBootstrap = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const fetchedProducts = await fetchSearchCatalogBootstrap();
      if (!fetchedProducts.length) return;

      setProducts(fetchedProducts);
      await AsyncStorage.setItem(
        SEARCH_PRODUCTS_CACHE_KEY,
        JSON.stringify({
          products: fetchedProducts,
          savedAt: new Date().toISOString(),
        } satisfies SearchProductsCache)
      );
      console.log('[NOOD home] search did not overwrite home feed cache');
    } catch (error) {
      console.log('Search bootstrap refresh error:', error);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  const loadProducts = useCallback(async () => {
    const showedCache = await loadSearchCache();
    void refreshSearchBootstrap();
    if (!showedCache) {
      setLoading(true);
    }
  }, [loadSearchCache, refreshSearchBootstrap]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const trimmedQuery = debouncedQuery.trim();
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;

    if (trimmedQuery.length < 2) {
      setRemoteSearchProducts([]);
      setSearchingFreshResults(false);
      return;
    }

    setSearchingFreshResults(true);

    void fetchShopifySearchProducts(trimmedQuery)
      .then((freshProducts) => {
        if (searchRequestIdRef.current !== requestId) return;
        if (freshProducts.length) {
          setRemoteSearchProducts(freshProducts);
        }
      })
      .finally(() => {
        if (searchRequestIdRef.current === requestId) {
          setSearchingFreshResults(false);
        }
      });
  }, [debouncedQuery]);

  useFocusEffect(
    useCallback(() => {
      void loadProducts();
    }, [loadProducts])
  );

  const results = useMemo(() => {
    const trimmedQuery = debouncedQuery.trim() || query.trim();
    const searchPool = mergeProducts(remoteSearchProducts, products);
    if (!trimmedQuery) return products;

    return filterProducts(searchPool, trimmedQuery)
      .map((product) => ({
        product,
        score: getSearchScore(product, trimmedQuery),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.product);
  }, [debouncedQuery, products, query, remoteSearchProducts]);

  const suggestedProducts = useMemo(() => {
    const trimmedQuery = debouncedQuery.trim() || query.trim();
    if (!trimmedQuery || results.length) return [];

    const strictIds = new Set(results.map((product) => product.id || product.handle));
    const searchPool = mergeProducts(remoteSearchProducts, products);
    return searchPool
      .map((product) => ({
        product,
        score: getSimilarSearchScore(product, trimmedQuery),
      }))
      .filter((entry) => entry.score > 0 && !strictIds.has(entry.product.id || entry.product.handle))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24)
      .map((entry) => entry.product);
  }, [debouncedQuery, products, query, remoteSearchProducts, results]);

  const displayedProducts = useMemo(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return products;
    return results.length ? results : suggestedProducts;
  }, [products, query, results, suggestedProducts]);

  const suggestionLabels = useMemo(() => {
    const trimmedQuery = debouncedQuery.trim() || query.trim();
    if (trimmedQuery.length < 1) return [];

    return (results.length ? results : suggestedProducts)
      .slice(0, 5)
      .map((product) => product.title)
      .filter((title, index, titles) => title && titles.indexOf(title) === index);
  }, [debouncedQuery, query, results, suggestedProducts]);

  const hasExactOrPartialResults = useMemo(() => {
    const trimmedQuery = debouncedQuery.trim() || query.trim();
    if (!trimmedQuery) return true;

    return results.length > 0;
  }, [debouncedQuery, query, results.length]);

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

  const renderProduct = useCallback(
    ({ item }: { item: SearchProduct }) => (
      <TouchableOpacity
        style={styles.productCard}
        activeOpacity={0.9}
        onPress={() => openProduct(item)}
      >
        <Image source={{ uri: item.image }} style={styles.productImage} resizeMode="cover" />
        <Text style={styles.productTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.productMeta} numberOfLines={1}>
          {item.brand || item.category}
        </Text>
        <View style={styles.priceRow}>
          <Text style={styles.productPrice}>{getDisplayPrice(item)}</Text>
          {getDisplayOldPrice(item) ? <Text style={styles.oldPrice}>{getDisplayOldPrice(item)}</Text> : null}
        </View>
      </TouchableOpacity>
    ),
    [getDisplayOldPrice, getDisplayPrice, openProduct]
  );

  const listHeaderComponent = useMemo(() => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      return products.length ? (
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
            ) : null}
          </>
        ) : searchingFreshResults ? (
          <Text style={styles.resultsHint}>Updating results...</Text>
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
    hasExactOrPartialResults,
    products.length,
    query,
    searchingFreshResults,
    suggestedProducts.length,
    suggestionLabels,
  ]);

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
            <TouchableOpacity activeOpacity={0.85} onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={22} color="#777" />
            </TouchableOpacity>
          ) : (
            <Ionicons name="search" size={22} color="#777" />
          )}
        </View>
      </View>

      <FlatList
        data={displayedProducts}
        keyExtractor={(item) => item.id}
        numColumns={2}
        renderItem={renderProduct}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={listHeaderComponent}
        ListEmptyComponent={
          loading ? (
            <View style={styles.emptyWrap}>
              <NoodSpinner size={48} />
            </View>
          ) : query.trim() ? null : (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>No products found</Text>
              <Text style={styles.emptySubTitle}>Pull to refresh and try again.</Text>
            </View>
          )
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
});
