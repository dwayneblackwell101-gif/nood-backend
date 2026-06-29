import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  TextInput,
  BackHandler,
  RefreshControl,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import {
  CATALOG_LIST_END_REACHED_THRESHOLD,
  CATALOG_LIST_PROPS,
} from '../../components/catalog/ListPerf';
import { useFocusEffect, useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCart } from '../../context/CartContext';
import { BASE_CURRENCY, normalizeCatalogCurrencyCode } from '../../utils/currency';
import { catalogFetch, ensureCatalogFreshness } from '../../utils/catalog';
import { buildProductRouteParams } from '../../utils/product-navigation';
import {
  getProductAvailabilityLabel,
  resolveListProductAvailableForSale,
  resolveListProductSoldOut,
} from '../../utils/product-availability';
import { noodAlert } from '../../utils/nood-alert';
import NoodSpinner from '../../components/NoodSpinner';
import { useScreenPerfReporter } from '../../utils/screen-perf';

const COLLECTION_IMAGE_PLACEHOLDER = 'https://via.placeholder.com/600x700.png?text=No+Image';
const COLLECTION_PRODUCTS_CACHE_PREFIX = 'NOOD_COLLECTION_PRODUCTS_CACHE_V2';
const COLLECTION_PAGE_SIZE = 50;

type CollectionProductsCache = {
  title?: string;
  products: CollectionProduct[];
  nextCursor?: string | null;
  hasMore?: boolean;
};

const COLLECTION_PRODUCTS_QUERY = `
  query CollectionProducts($handle: String!, $first: Int!, $after: String) {
    collectionByHandle(handle: $handle) {
      title
      products(first: $first, after: $after, sortKey: MANUAL) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
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
            variants(first: 1) {
              edges {
                node {
                  id
                  title
                  availableForSale
                  price {
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

function getCollectionImageUri(uri?: string | null) {
  const trimmed = String(uri || '').trim();
  return trimmed.length > 0 ? trimmed : COLLECTION_IMAGE_PLACEHOLDER;
}

type CollectionProduct = {
  id: string;
  title: string;
  handle: string;
  image: string;
  priceAmount: number;
  currencyCode: string;
  variantId?: string;
  variantTitle?: string;
  availableForSale?: boolean;
  variants?: { edges?: any[] };
};

async function shopifyFetch(query: string, variables?: Record<string, any>) {
  return catalogFetch(query, variables);
}

function mapCollectionProduct(node: any): CollectionProduct {
  const variant = node?.variants?.edges?.[0]?.node || null;
  const priceAmount = Number(variant?.price?.amount || node?.priceRange?.minVariantPrice?.amount || 0);

  const mapped: CollectionProduct = {
    id: String(node?.id || ''),
    title: String(node?.title || 'Product'),
    handle: String(node?.handle || ''),
    image: getCollectionImageUri(node?.featuredImage?.url),
    priceAmount,
    currencyCode: normalizeCatalogCurrencyCode(
      variant?.price?.currencyCode || node?.priceRange?.minVariantPrice?.currencyCode
    ),
    variantId: variant?.id ? String(variant.id) : undefined,
    variantTitle: variant?.title ? String(variant.title) : undefined,
    variants: node?.variants?.edges?.length ? node.variants : undefined,
    availableForSale: Boolean(node?.availableForSale ?? variant?.availableForSale ?? true),
  };
  mapped.availableForSale = resolveListProductAvailableForSale(mapped);
  return mapped;
}

type CollectionProductCardProps = {
  item: CollectionProduct;
  displayPrice: string;
  onOpen: (item: CollectionProduct) => void;
  onAddToCart: (item: CollectionProduct) => void;
};

function collectionProductCardPropsAreEqual(
  prev: CollectionProductCardProps,
  next: CollectionProductCardProps
) {
  return (
    prev.item.id === next.item.id &&
    prev.item.handle === next.item.handle &&
    prev.item.image === next.item.image &&
    prev.item.title === next.item.title &&
    prev.item.priceAmount === next.item.priceAmount &&
    prev.item.variantId === next.item.variantId &&
    prev.item.availableForSale === next.item.availableForSale &&
    prev.displayPrice === next.displayPrice &&
    prev.onOpen === next.onOpen &&
    prev.onAddToCart === next.onAddToCart
  );
}

const CollectionProductCard = React.memo(function CollectionProductCard({
  item,
  displayPrice,
  onOpen,
  onAddToCart,
}: CollectionProductCardProps) {
  const image = getCollectionImageUri(item.image);
  const isSoldOut = resolveListProductSoldOut(item);

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onOpen(item)}
      activeOpacity={0.92}
    >
      <ExpoImage
        source={{ uri: image }}
        style={styles.image}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={image}
        transition={0}
      />

      <Text numberOfLines={2} style={styles.name}>
        {item.title}
      </Text>

      <Text style={styles.price}>{displayPrice}</Text>
      {isSoldOut ? (
        <Text style={styles.stockUnavailableText}>{getProductAvailabilityLabel(item)}</Text>
      ) : null}

      <TouchableOpacity
        style={styles.smallCartBtn}
        onPress={() => onAddToCart(item)}
      >
        <Ionicons name="cart-outline" size={20} color="#111" />
        <Ionicons name="add" size={14} color="#111" style={styles.smallCartPlus} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}, collectionProductCardPropsAreEqual);

export default function CollectionScreen() {
  const { handle, from } = useLocalSearchParams<{ handle?: string; from?: string }>();
  const insets = useSafeAreaInsets();
  const [products, setProducts] = useState<CollectionProduct[]>([]);
  const [collectionTitle, setCollectionTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextProductsCursor, setNextProductsCursor] = useState<string | null>(null);
  const [hasMoreProducts, setHasMoreProducts] = useState(false);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<'default' | 'price-low' | 'price-high' | 'name'>('default');
  const {
    addToCart,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = useCart();

  const isFetchingRef = useRef(false);
  const isFetchingMoreRef = useRef(false);
  const productsRef = useRef<CollectionProduct[]>([]);
  const nextProductsCursorRef = useRef<string | null>(null);
  const hasMoreProductsRef = useRef(false);

  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  useEffect(() => {
    nextProductsCursorRef.current = nextProductsCursor;
  }, [nextProductsCursor]);

  useEffect(() => {
    hasMoreProductsRef.current = hasMoreProducts;
  }, [hasMoreProducts]);

  const getCollectionCacheKey = useCallback(
    (collectionHandle: string) => `${COLLECTION_PRODUCTS_CACHE_PREFIX}_${collectionHandle}`,
    []
  );

  const persistCollectionCache = useCallback(
    async (
      collectionHandle: string,
      nextProducts: CollectionProduct[],
      title: string,
      nextCursor: string | null,
      hasMore: boolean
    ) => {
      await AsyncStorage.setItem(
        getCollectionCacheKey(collectionHandle),
        JSON.stringify({
          title,
          products: nextProducts,
          nextCursor,
          hasMore,
        } satisfies CollectionProductsCache)
      );
    },
    [getCollectionCacheKey]
  );
  const handleBackPress = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return true;
    }

    router.replace(from === 'categories' ? '/(tabs)/categories' : '/(tabs)');
    return true;
  }, [from]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [handleBackPress]);

  const fetchCollectionPage = useCallback(
    async (collectionHandle: string, after: string | null = null) => {
      const json = await shopifyFetch(COLLECTION_PRODUCTS_QUERY, {
        handle: collectionHandle,
        first: COLLECTION_PAGE_SIZE,
        after,
      });
      const collection = json?.data?.collectionByHandle;
      const edges = collection?.products?.edges || [];
      const pageInfo = collection?.products?.pageInfo || {};

      return {
        title: collection?.title ? String(collection.title) : '',
        products: edges.map((edge: any) => mapCollectionProduct(edge?.node)),
        endCursor: pageInfo?.endCursor ?? null,
        hasNextPage: Boolean(pageInfo?.hasNextPage && pageInfo?.endCursor),
      };
    },
    []
  );

  const applyPaginationState = useCallback((endCursor: string | null, hasMore: boolean) => {
    setNextProductsCursor(endCursor);
    setHasMoreProducts(hasMore);
    nextProductsCursorRef.current = endCursor;
    hasMoreProductsRef.current = hasMore;
  }, []);

  const loadCollectionFromCache = useCallback(
    async (collectionHandle: string) => {
      const cached = await AsyncStorage.getItem(getCollectionCacheKey(collectionHandle));
      if (!cached) return false;

      try {
        const parsed = JSON.parse(cached) as CollectionProductsCache;
        if (!Array.isArray(parsed.products) || !parsed.products.length) {
          return false;
        }

        setProducts(parsed.products);
        productsRef.current = parsed.products;
        setCollectionTitle(parsed.title || '');
        const hasLegacyFullCache =
          parsed.nextCursor == null && parsed.products.length > COLLECTION_PAGE_SIZE;
        applyPaginationState(
          parsed.nextCursor ?? null,
          parsed.hasMore ??
            (!hasLegacyFullCache && parsed.products.length >= COLLECTION_PAGE_SIZE)
        );
        setLoading(false);
        return true;
      } catch {
        return false;
      }
    },
    [applyPaginationState, getCollectionCacheKey]
  );

  const loadCollectionProducts = useCallback(
    async (isRefresh = false) => {
      const collectionHandle = String(handle || '').trim();
      if (!collectionHandle || isFetchingRef.current) return;

      try {
        isFetchingRef.current = true;
        if (isRefresh) {
          setRefreshing(true);
        } else if (!productsRef.current.length) {
          setLoading(true);
        }

        if (!isRefresh && !productsRef.current.length) {
          await loadCollectionFromCache(collectionHandle);
        }

        const page = await fetchCollectionPage(collectionHandle, isRefresh ? null : null);
        if (page.title) {
          setCollectionTitle(page.title);
        }

        const existingProducts = isRefresh ? [] : productsRef.current;
        const seen = new Set(existingProducts.map((product) => product.id));
        const uniquePageProducts = page.products.filter((product) => !seen.has(product.id));
        const nextProducts = isRefresh
          ? page.products
          : existingProducts.length
            ? existingProducts
            : page.products;

        if (isRefresh || !existingProducts.length) {
          setProducts(nextProducts);
          productsRef.current = nextProducts;
        } else if (uniquePageProducts.length) {
          const merged = [...existingProducts, ...uniquePageProducts];
          setProducts(merged);
          productsRef.current = merged;
        }

        const resolvedCursor = isRefresh
          ? page.endCursor
          : existingProducts.length
            ? nextProductsCursorRef.current ?? page.endCursor
            : page.endCursor;
        const resolvedHasMore = isRefresh
          ? page.hasNextPage
          : existingProducts.length
            ? hasMoreProductsRef.current
            : page.hasNextPage;

        applyPaginationState(resolvedCursor, resolvedHasMore);
        await persistCollectionCache(
          collectionHandle,
          productsRef.current,
          page.title || collectionTitle,
          resolvedCursor,
          resolvedHasMore
        );
      } catch (err) {
        console.log(err);
        if (!productsRef.current.length) {
          noodAlert('Error', 'Failed to load collection.');
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
        isFetchingRef.current = false;
      }
    },
    [
      applyPaginationState,
      collectionTitle,
      fetchCollectionPage,
      handle,
      loadCollectionFromCache,
      persistCollectionCache,
    ]
  );

  const loadMoreCollectionProducts = useCallback(async () => {
    const collectionHandle = String(handle || '').trim();
    if (
      !collectionHandle ||
      isFetchingMoreRef.current ||
      isFetchingRef.current ||
      !hasMoreProductsRef.current ||
      !nextProductsCursorRef.current
    ) {
      return;
    }

    isFetchingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const page = await fetchCollectionPage(collectionHandle, nextProductsCursorRef.current);
      if (page.title) {
        setCollectionTitle(page.title);
      }

      const seen = new Set(productsRef.current.map((product) => product.id));
      const uniqueProducts = page.products.filter((product) => !seen.has(product.id));
      if (!uniqueProducts.length && page.hasNextPage && page.endCursor) {
        applyPaginationState(page.endCursor, true);
        return;
      }

      const nextProducts = [...productsRef.current, ...uniqueProducts];
      setProducts(nextProducts);
      productsRef.current = nextProducts;
      applyPaginationState(page.endCursor, page.hasNextPage);

      await persistCollectionCache(
        collectionHandle,
        nextProducts,
        page.title || collectionTitle,
        page.endCursor,
        page.hasNextPage
      );
    } catch (error) {
      console.log('Collection load more error:', error);
    } finally {
      setLoadingMore(false);
      isFetchingMoreRef.current = false;
    }
  }, [applyPaginationState, collectionTitle, fetchCollectionPage, handle, persistCollectionCache]);

  useEffect(() => {
    void (async () => {
      const collectionHandle = String(handle || '').trim();
      if (!collectionHandle) return;
      await loadCollectionFromCache(collectionHandle);
      void loadCollectionProducts(false);
      void ensureCatalogFreshness('collection')
        .then((changed) => {
          if (changed) {
            void loadCollectionProducts(true);
          }
        })
        .catch((error) => {
          console.log('[NOOD catalog] collection freshness check error', error);
        });
    })();
  }, [handle, loadCollectionFromCache, loadCollectionProducts]);

  const cleanTitle = String(collectionTitle || handle || '')
    .replace('-collection', '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const filteredProducts = useMemo(() => {
    let list = [...products];

    const query = search.trim().toLowerCase();
    if (query) {
      list = list.filter((item) =>
        String(item.title || '').toLowerCase().includes(query)
      );
    }

    if (sortMode === 'price-low') {
      list.sort(
        (a, b) =>
          Number(a?.priceAmount || 0) - Number(b?.priceAmount || 0)
      );
    } else if (sortMode === 'price-high') {
      list.sort(
        (a, b) =>
          Number(b?.priceAmount || 0) - Number(a?.priceAmount || 0)
      );
    } else if (sortMode === 'name') {
      list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    }

    return list;
  }, [products, search, sortMode]);

  const handleFilterPress = () => {
    noodAlert('Filters', 'Filter options can be added next.');
  };

  const handleSortPress = () => {
    setSortMode((prev) => {
      if (prev === 'default') return 'price-low';
      if (prev === 'price-low') return 'price-high';
      if (prev === 'price-high') return 'name';
      return 'default';
    });
  };

  const sortLabel =
    sortMode === 'default'
      ? 'Sort by'
      : sortMode === 'price-low'
      ? 'Price: Low'
      : sortMode === 'price-high'
      ? 'Price: High'
      : 'Name';

  const getVariantPrice = useCallback((item: CollectionProduct) => Number(item?.priceAmount || 0), []);

  const getDisplayPrice = useCallback(
    (item: CollectionProduct) =>
      formatMoney(
        convertPrice(getVariantPrice(item), item.currencyCode || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      ),
    [convertPrice, formatMoney, getVariantPrice, selectedCurrency]
  );

  const displayPriceById = useMemo(() => {
    const map = new Map<string, string>();
    filteredProducts.forEach((item) => {
      map.set(item.id, getDisplayPrice(item));
    });
    return map;
  }, [filteredProducts, getDisplayPrice]);

  const handleOpenCollectionProduct = useCallback(
    (item: CollectionProduct) => {
      router.push({
        pathname: '/product/[handle]',
        params: buildProductRouteParams(item, {
          from: from || 'collection',
        }),
      });
    },
    [from]
  );

  const handleAddCollectionProductToCart = useCallback(
    (item: CollectionProduct) => {
      if (resolveListProductSoldOut(item)) return;
      if (!item.variantId) return;

      const image = getCollectionImageUri(item.image);
      addToCart({
        id: item.variantId,
        productId: item.id.toString(),
        variantId: item.variantId,
        title: item.title,
        handle: item.handle,
        variantTitle: item.variantTitle || 'Default Title',
        price: getVariantPrice(item),
        currencyCode: item.currencyCode || BASE_CURRENCY,
        baseCurrency: item.currencyCode || BASE_CURRENCY,
        image,
        quantity: 1,
      });
    },
    [addToCart, getVariantPrice]
  );

  const collectionKeyExtractor = useCallback((item: CollectionProduct) => item.id, []);

  const renderCollectionItem = useCallback(
    ({ item }: { item: CollectionProduct }) => (
      <CollectionProductCard
        item={item}
        displayPrice={displayPriceById.get(item.id) || getDisplayPrice(item)}
        onOpen={handleOpenCollectionProduct}
        onAddToCart={handleAddCollectionProductToCart}
      />
    ),
    [displayPriceById, getDisplayPrice, handleAddCollectionProductToCart, handleOpenCollectionProduct]
  );

  const handleLoadMoreCollection = useCallback(() => {
    void loadMoreCollectionProducts();
  }, [loadMoreCollectionProducts]);

  useScreenPerfReporter(
    'collection',
    {
      itemCount: filteredProducts.length,
      isFetching: loading || loadingMore,
      isRefreshing: refreshing,
    },
    [filteredProducts.length, loading, loadingMore, refreshing]
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <NoodSpinner size={54} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.headerWrap, { paddingTop: Math.max(insets.top + 8, 20) }]}>
        <View style={styles.logoRow}>
          <Image
            source={require('../../assets/images/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        <View style={styles.searchRow}>
          <TouchableOpacity style={styles.backButton} onPress={handleBackPress}>
            <Ionicons name="arrow-back" size={24} color="#111" />
          </TouchableOpacity>

          <View style={styles.searchBar}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={cleanTitle}
              placeholderTextColor="#7a7a7a"
              style={styles.searchInput}
            />

            <TouchableOpacity style={styles.iconBtn}>
              <Ionicons name="camera-outline" size={22} color="#000" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.searchIconWrap}>
              <Ionicons name="search-outline" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.filterRow}>
          <TouchableOpacity style={styles.chip} onPress={handleFilterPress}>
            <Ionicons name="filter-outline" size={18} color="#666" />
            <Text style={styles.chipText}>Filters</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.chip} onPress={handleSortPress}>
            <Text style={styles.chipText}>{sortLabel}</Text>
            <Ionicons name="chevron-down" size={18} color="#666" />
          </TouchableOpacity>
        </View>

        <View style={styles.promoBar}>
          <Text style={styles.promoText}>✔ Free shipping</Text>
          <Text style={styles.promoDivider}>|</Text>
          <Text style={styles.promoText}>✔ Safe checkout</Text>
          <Ionicons name="chevron-forward" size={20} color="#5c31ff" />
        </View>
      </View>

      <FlatList
        data={filteredProducts}
        numColumns={2}
        keyExtractor={collectionKeyExtractor}
        renderItem={renderCollectionItem}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        {...CATALOG_LIST_PROPS}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void (async () => {
                await ensureCatalogFreshness('collection');
                await loadCollectionProducts(true);
              })();
            }}
            tintColor="#ff6a00"
            colors={['#ff6a00']}
            progressBackgroundColor="#ffffff"
          />
        }
        onEndReachedThreshold={CATALOG_LIST_END_REACHED_THRESHOLD}
        onEndReached={handleLoadMoreCollection}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footerLoader}>
              <NoodSpinner size={32} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>No products found</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f6f3ef',
  },

  headerWrap: {
    backgroundColor: '#f6f3ef',
    paddingTop: 8,
    paddingHorizontal: 10,
  },

  logoRow: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },

  logo: {
    width: 90,
    height: 32,
  },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 10,
  },

  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    flexShrink: 0,
  },

  searchBar: {
    flex: 1,
    height: 56,
    borderWidth: 2,
    borderColor: '#000',
    borderRadius: 28,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 8,
    minWidth: 0,
  },

  searchInput: {
    flex: 1,
    fontSize: 16,
    color: '#111',
    fontWeight: '600',
    minWidth: 0,
  },

  iconBtn: {
    marginLeft: 6,
    marginRight: 6,
    flexShrink: 0,
  },

  searchIconWrap: {
    width: 50,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#efefef',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 10,
  },

  chipText: {
    color: '#555',
    fontWeight: '700',
    fontSize: 16,
    marginHorizontal: 4,
  },

  promoBar: {
    height: 46,
    backgroundColor: '#fff0df',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginBottom: 10,
  },

  promoText: {
    color: '#5c31ff',
    fontSize: 16,
    fontWeight: '800',
  },

  promoDivider: {
    color: '#d1b391',
    marginHorizontal: 10,
    fontWeight: '700',
  },

  listContent: {
    paddingHorizontal: 10,
    paddingBottom: 120,
  },

  row: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  card: {
    width: '48.5%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 8,
    position: 'relative',
  },

  image: {
    width: '100%',
    height: 175,
    borderRadius: 10,
    marginBottom: 8,
    backgroundColor: '#eee',
  },

  name: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
    color: '#111',
  },

  stockUnavailableText: {
    fontSize: 12,
    color: '#b42318',
    fontWeight: '700',
    marginTop: 2,
  },
  price: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ff8a00',
  },

  smallCartBtn: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    borderColor: '#111',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },

  smallCartPlus: {
    position: 'absolute',
    right: 7,
    top: 7,
  },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  emptyWrap: {
    paddingTop: 40,
    alignItems: 'center',
  },

  emptyText: {
    fontSize: 16,
    color: '#777',
    fontWeight: '600',
  },

  footerLoader: {
    paddingVertical: 24,
    alignItems: 'center',
  },
});
