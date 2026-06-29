import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NoodSpinner from '../components/NoodSpinner';
import { useCart } from '../context/CartContext';
import { BASE_CURRENCY } from '../utils/currency';
import { ensureCatalogFreshness } from '../utils/catalog';
import { buildProductRouteParams } from '../utils/product-navigation';
import {
  clearStaleCategoryTrendingCaches,
  getTrendingPageTitle,
  loadTrendingPoolForCategory,
  refreshTrendingPoolFromBackend,
  type TrendingPoolResult,
} from '../utils/category-trending';
import type { ScopedCategoryProduct } from '../utils/category-scope';
import {
  getProductAvailabilityLabel,
  resolveListProductSoldOut,
} from '../utils/product-availability';

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/600x600.png?text=NOOD';
const PAGE_SIZE = 24;

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

export default function CategoryTrendingScreen() {
  const { mainCategory, source, from } = useLocalSearchParams<{
    mainCategory?: string;
    source?: string;
    from?: string;
  }>();
  const insets = useSafeAreaInsets();
  const { formatMoney, convertPrice, selectedCurrency = BASE_CURRENCY } = useCart();

  const categoryTitle = String(mainCategory || '').trim();
  const pageTitle = getTrendingPageTitle(categoryTitle);

  const [pool, setPool] = useState<TrendingPoolResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const loadGenerationRef = useRef(0);

  const logPoolStats = useCallback(
    (nextPool: TrendingPoolResult, visibleProductCount: number) => {
      console.log(`[NOOD trending] route opened category=${nextPool.mainCategory}`);
      console.log('[NOOD trending] subcategories used count', nextPool.subcategoryCount);
      console.log('[NOOD trending] mixed product pool count', nextPool.products.length);
      console.log('[NOOD trending] visible product count', visibleProductCount);
      console.log(
        `[NOOD trending] excluded non-${nextPool.mainCategory.toLowerCase()} product count`,
        nextPool.excludedCount
      );
    },
    []
  );

  const applyPool = useCallback(
    (nextPool: TrendingPoolResult, resetVisible = true) => {
      setPool(nextPool);
      const nextVisible = resetVisible
        ? Math.min(PAGE_SIZE, nextPool.products.length)
        : Math.min(visibleCount, nextPool.products.length);
      if (resetVisible) {
        setVisibleCount(nextVisible);
      }
      logPoolStats(nextPool, nextVisible);
    },
    [logPoolStats, visibleCount]
  );

  const loadPool = useCallback(
    async (options: { background?: boolean; forceRefresh?: boolean } = {}) => {
      if (!categoryTitle) return;

      const generation = ++loadGenerationRef.current;

      try {
        if (!options.background) {
          setLoading(true);
        }

        let nextPool: TrendingPoolResult;

        if (options.forceRefresh) {
          const refreshed = await refreshTrendingPoolFromBackend(categoryTitle);
          nextPool =
            refreshed ||
            (await loadTrendingPoolForCategory(categoryTitle, { preferCache: false }));
        } else {
          nextPool = await loadTrendingPoolForCategory(categoryTitle, { preferCache: true });
        }

        if (generation !== loadGenerationRef.current) return;

        applyPool(nextPool, !options.background);
      } catch (error) {
        console.log('[NOOD trending] load error', error);
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [applyPool, categoryTitle]
  );

  useEffect(() => {
    if (!categoryTitle || source !== 'trending') return;

    console.log(`[NOOD trending] route opened category=${categoryTitle}`);
    void (async () => {
      await clearStaleCategoryTrendingCaches();
      await loadPool();
    })();

    void ensureCatalogFreshness('category')
      .then((changed) => {
        if (changed) {
          void loadPool({ background: true, forceRefresh: true });
        } else {
          void loadPool({ background: true });
        }
      })
      .catch((error) => {
        console.log('[NOOD trending] freshness check error', error);
      });
  }, [categoryTitle, loadPool, source]);

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

  const visibleProducts = useMemo(
    () => (pool?.products || []).slice(0, visibleCount),
    [pool?.products, visibleCount]
  );

  const hasMoreProducts = (pool?.products.length || 0) > visibleCount;

  const getDisplayPrice = useCallback(
    (item: ScopedCategoryProduct) => {
      const amount = Number(item.priceAmount || 0);
      return formatMoney(
        convertPrice(amount, item.currencyCode || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      );
    },
    [convertPrice, formatMoney, selectedCurrency]
  );

  const openProduct = useCallback(
    (product: ScopedCategoryProduct) => {
      console.log('[NOOD trending] product pressed handle', product.handle);
      router.push({
        pathname: '/product/[handle]',
        params: buildProductRouteParams(product, { from: 'category-trending' }),
      });
    },
    []
  );

  if (!categoryTitle || source !== 'trending') {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Trending category not found.</Text>
        <TouchableOpacity style={styles.backChip} onPress={handleBackPress}>
          <Text style={styles.backChipText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading && !pool?.products.length) {
    return (
      <View style={styles.center}>
        <NoodSpinner size={54} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.headerWrap, { paddingTop: Math.max(insets.top + 8, 20) }]}>
        <View style={styles.titleRow}>
          <TouchableOpacity style={styles.backButton} onPress={handleBackPress}>
            <Ionicons name="arrow-back" size={24} color="#111" />
          </TouchableOpacity>
          <Text numberOfLines={1} style={styles.pageTitle}>
            {pool?.title || pageTitle}
          </Text>
        </View>
      </View>

      <FlatList
        data={visibleProducts}
        numColumns={2}
        keyExtractor={(item) => `${item.id}-${item.handle}`}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadPool({ background: true, forceRefresh: true });
            }}
            tintColor="#ff6a00"
            colors={['#ff6a00']}
            progressBackgroundColor="#ffffff"
          />
        }
        renderItem={({ item }) => {
          const image = getOptimizedImageUrl(item.image, 360);

          return (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.92}
              onPress={() => openProduct(item)}
            >
              {isRealProductImage(item.image) ? (
                <Image source={{ uri: image }} style={styles.image} resizeMode="cover" />
              ) : (
                <View style={styles.imagePlaceholder}>
                  <Ionicons name="image-outline" size={24} color="#b8b8b8" />
                </View>
              )}

              <Text numberOfLines={2} style={styles.name}>
                {item.title}
              </Text>
              <Text style={styles.price}>{item.price || getDisplayPrice(item)}</Text>
              {resolveListProductSoldOut(item) ? (
                <Text numberOfLines={1} style={styles.stockUnavailableText}>
                  {getProductAvailabilityLabel(item)}
                </Text>
              ) : null}
              {item.sourceSubcategoryTitle ? (
                <Text numberOfLines={1} style={styles.meta}>
                  {item.sourceSubcategoryTitle}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        }}
        onEndReachedThreshold={0.35}
        onEndReached={() => {
          if (!hasMoreProducts) return;
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, pool?.products.length || count));
        }}
        ListFooterComponent={
          hasMoreProducts ? (
            <View style={styles.footerLoader}>
              <NoodSpinner size={28} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>No {categoryTitle} trending products yet.</Text>
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f6f3ef',
    paddingHorizontal: 24,
  },
  headerWrap: {
    backgroundColor: '#f6f3ef',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  pageTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '800',
    color: '#111',
  },
  listContent: {
    paddingHorizontal: 10,
    paddingBottom: 28,
  },
  row: {
    justifyContent: 'space-between',
    gap: 10,
  },
  card: {
    flex: 1,
    maxWidth: '49%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 8,
    marginBottom: 10,
  },
  image: {
    width: '100%',
    aspectRatio: 0.82,
    borderRadius: 10,
    backgroundColor: '#f0f0f0',
  },
  imagePlaceholder: {
    width: '100%',
    aspectRatio: 0.82,
    borderRadius: 10,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 17,
    color: '#111',
    fontWeight: '700',
  },
  price: {
    marginTop: 4,
    fontSize: 14,
    color: '#111',
    fontWeight: '800',
  },
  stockUnavailableText: {
    marginTop: 2,
    fontSize: 11,
    color: '#b42318',
    fontWeight: '700',
  },
  meta: {
    marginTop: 2,
    fontSize: 11,
    color: '#888',
    fontWeight: '600',
  },
  footerLoader: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  emptyWrap: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyText: {
    color: '#777',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  backChip: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#fff4ea',
    borderWidth: 1,
    borderColor: '#ffd8b8',
  },
  backChipText: {
    color: '#ff6a00',
    fontWeight: '700',
  },
});