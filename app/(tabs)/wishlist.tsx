import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCart } from '../../context/CartContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';
import { useWishlist } from '../../context/WishlistContext';
import type { CatalogListProduct } from '../../utils/catalog-product-mapper';
import { BASE_CURRENCY } from '../../utils/currency';
import { noodAlert } from '../../utils/nood-alert';
import { SIGN_IN_ENABLED } from '../../utils/payment-testing';
import { buildProductRouteParams } from '../../utils/product-navigation';
import { loadWishlistRecommendations } from '../../utils/wishlist-recommendations';
import { getWishlistItemKey, type WishlistItem } from '../../utils/wishlist-storage';
import NoodSwipeableRow from '../../components/NoodSwipeableRow';
import { CATALOG_LIST_PROPS } from '../../components/catalog/ListPerf';
import { NOOD_REFRESH_CONTROL_PROPS } from '../../utils/navigation-gestures';
import { useScreenPerfReporter } from '../../utils/screen-perf';

const IMAGE_PLACEHOLDER = 'https://via.placeholder.com/600x700.png?text=No+Image';
const PRODUCT_IMAGE_PLACEHOLDER = 'https://via.placeholder.com/520x520.png?text=Product';
const WISHLIST_RECOMMENDATIONS_FOCUS_MS = 60000;
const WISHLIST_REFRESH_FOCUS_MS = 60000;

function getImageUri(uri?: string | null) {
  const trimmed = String(uri || '').trim();
  return trimmed.length > 0 ? trimmed : IMAGE_PLACEHOLDER;
}

function getVariantLabel(item: WishlistItem) {
  const variantTitle = String(item.variantTitle || '').trim();
  if (variantTitle && variantTitle !== 'Default Title') {
    return variantTitle;
  }

  const parts = [item.size, item.color].filter(Boolean).map(String);
  if (parts.length) {
    return parts.join(' · ');
  }

  return null;
}

const RecommendationProductCard = React.memo(function RecommendationProductCard({
  product,
  priceLabel,
  onPress,
  onAddToCart,
}: {
  product: CatalogListProduct;
  priceLabel: string;
  onPress: () => void;
  onAddToCart: () => void;
}) {
  return (
    <TouchableOpacity style={styles.recoCard} activeOpacity={0.9} onPress={onPress}>
      <ExpoImage
        source={{ uri: product.image || PRODUCT_IMAGE_PLACEHOLDER }}
        style={styles.recoImage}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={product.image || product.id}
        transition={0}
      />
      <View style={styles.recoBody}>
        <Text numberOfLines={2} style={styles.recoTitle}>
          {product.title}
        </Text>
        <View style={styles.recoBottomRow}>
          <Text style={styles.recoPrice}>{priceLabel}</Text>
          <TouchableOpacity
            style={styles.recoCartBtn}
            activeOpacity={0.88}
            onPress={(event) => {
              event.stopPropagation();
              onAddToCart();
            }}
          >
            <Ionicons name="cart-outline" size={16} color="#ff6a00" />
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
});

type WishlistItemRowProps = {
  item: WishlistItem;
  variantLabel: string | null | undefined;
  priceLabel: string;
  onOpen: (item: WishlistItem) => void;
  onMoveToCart: (item: WishlistItem) => void;
  onConfirmRemove: (item: WishlistItem) => void;
  onRemove: (item: WishlistItem) => void;
};

const WishlistItemRow = React.memo(function WishlistItemRow({
  item,
  variantLabel,
  priceLabel,
  onOpen,
  onMoveToCart,
  onConfirmRemove,
  onRemove,
}: WishlistItemRowProps) {
  return (
    <NoodSwipeableRow
      style={styles.itemCard}
      leftActions={[
        {
          key: 'cart',
          label: 'Cart',
          icon: 'cart-outline',
          backgroundColor: '#ff6a00',
          onPress: () => onMoveToCart(item),
        },
      ]}
      rightActions={[
        {
          key: 'remove',
          label: 'Remove',
          icon: 'trash-outline',
          backgroundColor: '#d9480f',
          onPress: () => void onRemove(item),
        },
      ]}
    >
      <TouchableOpacity activeOpacity={0.9} onPress={() => onOpen(item)}>
        <ExpoImage
          source={{ uri: getImageUri(String(item.image || '')) }}
          style={styles.itemImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={getImageUri(String(item.image || ''))}
          transition={0}
        />
      </TouchableOpacity>

      <View style={styles.itemBody}>
        <TouchableOpacity activeOpacity={0.9} onPress={() => onOpen(item)}>
          <Text style={styles.itemTitle} numberOfLines={2}>
            {item.title || 'Saved product'}
          </Text>
        </TouchableOpacity>

        {variantLabel ? (
          <View style={styles.metaPill}>
            <Text style={styles.metaPillText}>{variantLabel}</Text>
          </View>
        ) : null}

        <Text style={styles.itemPrice}>{priceLabel}</Text>

        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.cartButton}
            activeOpacity={0.88}
            onPress={() => onMoveToCart(item)}
          >
            <Ionicons name="cart-outline" size={16} color="#fff" />
            <Text style={styles.cartButtonText}>Add to cart</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.removeButton}
            activeOpacity={0.88}
            onPress={() => onConfirmRemove(item)}
          >
            <Ionicons name="heart" size={16} color="#ff6a00" />
          </TouchableOpacity>
        </View>
      </View>
    </NoodSwipeableRow>
  );
});

function RecommendationSkeletonCard() {
  return (
    <View style={styles.recoCard}>
      <View style={[styles.recoImage, styles.skeletonBlock]} />
      <View style={styles.recoBody}>
        <View style={[styles.skeletonLine, styles.skeletonLineWide]} />
        <View style={[styles.skeletonLine, styles.skeletonLineMedium]} />
      </View>
    </View>
  );
}

export default function WishlistScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const { addToCart, convertPrice, formatMoney, selectedCurrency, cartItems, orders } = useCart();
  const { addHistoryEvent } = useHistoryEvents();
  const { profileId, isSignedIn, isReady } = useUser();
  const { items, wishlistCount, loading, refreshWishlist, removeFromWishlist } = useWishlist();

  const [recommendations, setRecommendations] = useState<CatalogListProduct[]>([]);
  const [recommendationTitle, setRecommendationTitle] = useState('Recommended for you');
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [recommendationsFailed, setRecommendationsFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<FlatList<WishlistItem> | null>(null);
  const lastRecommendationsFocusRef = useRef(0);
  const lastWishlistRefreshRef = useRef(0);
  const recommendationsFingerprintRef = useRef('');

  const loadRecommendations = useCallback(async () => {
    if (!isReady) return;

    setLoadingRecommendations(true);
    setRecommendationsFailed(false);

    try {
      const result = await loadWishlistRecommendations({
        profileId: profileId || 'guest',
        isSignedIn,
        cartItems,
        orders,
      });

      setRecommendationTitle(result.sectionTitle);
      setRecommendations(result.products);
      setRecommendationsFailed(result.status === 'error' || result.status === 'empty');
    } catch (error) {
      console.log('Wishlist recommendations load error:', error);
      setRecommendations([]);
      setRecommendationsFailed(true);
    } finally {
      setLoadingRecommendations(false);
    }
  }, [cartItems, isReady, isSignedIn, orders, profileId]);

  const recommendationsFingerprint = useMemo(
    () =>
      [
        profileId || 'guest',
        isSignedIn ? '1' : '0',
        cartItems
          .map((item: any) => String(item?.handle || item?.id || ''))
          .sort()
          .join('|'),
        orders
          .map((order: any) => String(order?.id || ''))
          .sort()
          .join('|'),
      ].join('::'),
    [cartItems, isSignedIn, orders, profileId]
  );

  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (now - lastWishlistRefreshRef.current >= WISHLIST_REFRESH_FOCUS_MS) {
        lastWishlistRefreshRef.current = now;
        void refreshWishlist();
      }
      const fingerprintChanged = recommendationsFingerprintRef.current !== recommendationsFingerprint;
      const shouldRefresh =
        fingerprintChanged || now - lastRecommendationsFocusRef.current >= WISHLIST_RECOMMENDATIONS_FOCUS_MS;

      if (!shouldRefresh) return;

      recommendationsFingerprintRef.current = recommendationsFingerprint;
      lastRecommendationsFocusRef.current = now;
      void loadRecommendations();
    }, [loadRecommendations, recommendationsFingerprint, refreshWishlist])
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshWishlist(), loadRecommendations()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadRecommendations, refreshWishlist]);

  useEffect(() => {
    const unsubscribe = (navigation as any).addListener('tabPress', () => {
      if (!navigation.isFocused()) return;
      scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
    });

    return unsubscribe;
  }, [navigation]);

  const openProduct = useCallback((item: WishlistItem) => {
    const handle = String(item?.handle || '').trim();
    if (!handle) return;

    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(item, { from: 'wishlist' }) as any,
    });
  }, [router]);

  const handleRemove = useCallback(async (item: WishlistItem) => {
    const itemKey = getWishlistItemKey(item);
    if (!itemKey) return;

    await removeFromWishlist(itemKey);

    void addHistoryEvent({
      type: 'wishlist',
      title: 'Removed from Wishlist',
      description: String(item?.title || 'Product removed from saved items.'),
      status: 'removed',
      relatedId: itemKey,
    });
  }, [addHistoryEvent, removeFromWishlist]);

  const confirmRemove = useCallback((item: WishlistItem) => {
    noodAlert('Remove saved item?', 'This removes the product from your wishlist.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void handleRemove(item) },
    ]);
  }, [handleRemove]);

  const handleMoveToCart = useCallback((item: WishlistItem) => {
    const added = addToCart({
      ...item,
      quantity: 1,
      baseCurrency: item.baseCurrency || BASE_CURRENCY,
    });

    if (added) {
      noodAlert('Added to cart', `${item.title || 'Item'} is ready in your cart.`);
      return;
    }

    openProduct(item);
  }, [addToCart, openProduct]);

  const itemPriceByKey = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((item) => {
      const key = getWishlistItemKey(item);
      if (!key) return;
      map.set(
        key,
        formatMoney(
          convertPrice(
            Number(item.price || 0),
            item.baseCurrency || BASE_CURRENCY,
            selectedCurrency
          ),
          selectedCurrency
        )
      );
    });
    return map;
  }, [convertPrice, formatMoney, items, selectedCurrency]);

  const recommendationPriceById = useMemo(() => {
    const map = new Map<string, string>();
    recommendations.forEach((product) => {
      map.set(
        product.id || product.handle,
        formatMoney(
          convertPrice(
            Number(product.priceAmount || 0),
            product.currencyCode || BASE_CURRENCY,
            selectedCurrency
          ),
          selectedCurrency
        )
      );
    });
    return map;
  }, [convertPrice, formatMoney, recommendations, selectedCurrency]);

  const openRecommendedProduct = useCallback((product: CatalogListProduct) => {
    if (!product?.handle) return;

    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(product, { from: 'wishlist' }) as any,
    });
  }, [router]);

  const handleAddRecommendedToCart = useCallback((product: CatalogListProduct) => {
    const added = addToCart({
      ...product,
      price: product.priceAmount,
      baseCurrency: product.currencyCode || BASE_CURRENCY,
    });

    if (added) {
      noodAlert('Added to cart', `${product.title} is ready in your cart.`);
      return;
    }

    openRecommendedProduct(product);
  }, [addToCart, openRecommendedProduct]);

  const renderRecommendationItem = useCallback(
    ({ item }: { item: CatalogListProduct }) => (
      <RecommendationProductCard
        product={item}
        priceLabel={recommendationPriceById.get(item.id || item.handle) || ''}
        onPress={() => openRecommendedProduct(item)}
        onAddToCart={() => handleAddRecommendedToCart(item)}
      />
    ),
    [handleAddRecommendedToCart, openRecommendedProduct, recommendationPriceById]
  );

  const recommendationKeyExtractor = useCallback(
    (item: CatalogListProduct) => item.id || item.handle,
    []
  );

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/(tabs)' as any);
  };

  const handleBrowseProducts = () => {
    router.push('/(tabs)/categories' as any);
  };

  const handleSignIn = () => {
    router.push('/account/auth' as any);
  };

  const showRecommendations = useMemo(
    () => !loading && items.length === 0,
    [items.length, loading]
  );

  const variantLabels = useMemo(
    () => new Map(items.map((item) => [getWishlistItemKey(item), getVariantLabel(item)])),
    [items]
  );

  const wishlistKeyExtractor = useCallback(
    (item: WishlistItem, index: number) => getWishlistItemKey(item) || `wishlist-${index}`,
    []
  );

  const renderWishlistItem = useCallback(
    ({ item, index }: { item: WishlistItem; index: number }) => {
      const itemKey = getWishlistItemKey(item) || `wishlist-${index}`;
      return (
        <WishlistItemRow
          item={item}
          variantLabel={variantLabels.get(itemKey)}
          priceLabel={itemPriceByKey.get(itemKey) || ''}
          onOpen={openProduct}
          onMoveToCart={handleMoveToCart}
          onConfirmRemove={confirmRemove}
          onRemove={handleRemove}
        />
      );
    },
    [
      confirmRemove,
      handleMoveToCart,
      handleRemove,
      itemPriceByKey,
      openProduct,
      variantLabels,
    ]
  );

  const wishlistListHeader = useMemo(
    () => (
      <>
        <View style={styles.headerCard}>
          <View style={styles.headerTop}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Wishlist</Text>
              <Text style={styles.subtitle}>Keep favorites close and move them to cart anytime.</Text>
            </View>
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{wishlistCount}</Text>
            </View>
          </View>
        </View>

        {SIGN_IN_ENABLED && !isSignedIn ? (
          <View style={styles.syncBanner}>
            <View style={styles.syncCopy}>
              <Ionicons name="cloud-outline" size={18} color="#5c31ff" />
              <Text style={styles.syncText}>Sign in to sync your wishlist across devices</Text>
            </View>
            <TouchableOpacity style={styles.syncButton} activeOpacity={0.9} onPress={handleSignIn}>
              <Text style={styles.syncButtonText}>Sign in</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.compactStateCard}>
            <Text style={styles.stateTitle}>Loading saved items...</Text>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.compactStateCard}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="heart-outline" size={30} color="#ff6a00" />
            </View>
            <Text style={styles.emptyTitle}>No saved items yet</Text>
            <Text style={styles.emptyText}>
              Tap the heart on products or save from cart to build your list.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              activeOpacity={0.9}
              onPress={handleBrowseProducts}
            >
              <Text style={styles.primaryButtonText}>Browse products</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </>
    ),
    [items.length, loading, wishlistCount]
  );

  const wishlistListFooter = useMemo(() => {
    if (!showRecommendations) return null;

    return (
      <View style={styles.recoSection}>
        <View style={styles.recoHeader}>
          <Text style={styles.recoTitleMain}>{recommendationTitle}</Text>
          {!loadingRecommendations && recommendations.length > 0 ? (
            <TouchableOpacity activeOpacity={0.88} onPress={handleBrowseProducts}>
              <Text style={styles.recoSeeAll}>See all</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {loadingRecommendations ? (
          <View style={styles.recoGrid}>
            {Array.from({ length: 4 }).map((_, index) => (
              <RecommendationSkeletonCard key={`wishlist-reco-skeleton-${index}`} />
            ))}
          </View>
        ) : recommendations.length > 0 ? (
          <FlatList
            data={recommendations}
            numColumns={2}
            scrollEnabled={false}
            keyExtractor={recommendationKeyExtractor}
            renderItem={renderRecommendationItem}
            columnWrapperStyle={styles.recoGrid}
            initialNumToRender={4}
            maxToRenderPerBatch={4}
            windowSize={5}
          />
        ) : recommendationsFailed ? null : null}
      </View>
    );
  }, [
    handleBrowseProducts,
    loadingRecommendations,
    recommendationKeyExtractor,
    recommendationTitle,
    recommendations,
    recommendationsFailed,
    renderRecommendationItem,
    showRecommendations,
  ]);

  useScreenPerfReporter(
    'wishlist',
    {
      itemCount: items.length,
      isFetching: loading || loadingRecommendations,
      isRefreshing: refreshing,
    },
    [items.length, loading, loadingRecommendations, refreshing]
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={handleBack} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Saved</Text>
        <View style={styles.topBarSpacer} />
      </View>

      <FlatList
        ref={scrollRef}
        data={!loading && items.length > 0 ? items : []}
        keyExtractor={wishlistKeyExtractor}
        renderItem={renderWishlistItem}
        ListHeaderComponent={wishlistListHeader}
        ListFooterComponent={wishlistListFooter}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        contentContainerStyle={styles.content}
        {...CATALOG_LIST_PROPS}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void handleRefresh()}
            {...NOOD_REFRESH_CONTROL_PROPS}
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBarTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },
  topBarSpacer: {
    width: 42,
  },
  content: {
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 110,
  },
  headerCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginBottom: 12,
    shadowColor: '#ff6a00',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    paddingRight: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },
  subtitle: {
    marginTop: 4,
    fontSize: 13,
    color: '#666',
    lineHeight: 18,
    fontWeight: '600',
  },
  countBadge: {
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#fff1df',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  countBadgeText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '900',
  },
  syncBanner: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ebe4ff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  syncCopy: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  syncText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: '#5c31ff',
    fontWeight: '700',
  },
  syncButton: {
    borderRadius: 999,
    backgroundColor: '#f1ecff',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  syncButtonText: {
    color: '#5c31ff',
    fontSize: 12,
    fontWeight: '900',
  },
  compactStateCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingVertical: 20,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    marginBottom: 12,
  },
  stateTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#666',
  },
  emptyIconWrap: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#111',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 14,
  },
  primaryButton: {
    minHeight: 44,
    paddingHorizontal: 20,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  itemCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    overflow: 'hidden',
    marginBottom: 10,
    flexDirection: 'row',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  itemImage: {
    width: 108,
    height: 128,
    backgroundColor: '#f2ebe4',
  },
  itemBody: {
    flex: 1,
    padding: 12,
    justifyContent: 'space-between',
  },
  itemTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: '#111',
    lineHeight: 20,
  },
  metaPill: {
    alignSelf: 'flex-start',
    marginTop: 6,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  metaPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#6f5a4e',
  },
  itemPrice: {
    marginTop: 8,
    fontSize: 16,
    fontWeight: '900',
    color: '#ff6a00',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  cartButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  cartButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '900',
  },
  removeButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recoSection: {
    marginTop: 4,
  },
  recoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  recoTitleMain: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
  },
  recoSeeAll: {
    fontSize: 13,
    fontWeight: '800',
    color: '#ff6a00',
  },
  recoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  recoCard: {
    width: '48.5%',
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#ffe9dd',
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  recoImage: {
    width: '100%',
    height: 132,
    backgroundColor: '#f2ebe4',
  },
  recoBody: {
    padding: 10,
  },
  recoTitle: {
    fontSize: 13,
    color: '#333',
    fontWeight: '700',
    minHeight: 34,
  },
  recoBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  recoPrice: {
    fontSize: 15,
    fontWeight: '900',
    color: '#111',
    flex: 1,
    paddingRight: 8,
  },
  recoCartBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffd9c6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  skeletonBlock: {
    backgroundColor: '#f1e4d8',
  },
  skeletonLine: {
    height: 10,
    borderRadius: 6,
    backgroundColor: '#f1e4d8',
    marginBottom: 8,
  },
  skeletonLineWide: {
    width: '92%',
  },
  skeletonLineMedium: {
    width: '68%',
  },
});