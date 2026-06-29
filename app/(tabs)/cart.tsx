import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCart } from '../../context/CartContext';
import { useWishlist } from '../../context/WishlistContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';
import type { CatalogListProduct } from '../../utils/catalog-product-mapper';
import { loadCartRecommendations } from '../../utils/cart-recommendations';
import { SHOPIFY_CHECKOUT_CURRENCY } from '../../utils/checkout-totals';
import { BASE_CURRENCY } from '../../utils/currency';
import { resolveCustomerStorageKey } from '../../utils/customer-storage';
import { buildProductRouteParams } from '../../utils/product-navigation';
import NoodSpinner from '../../components/NoodSpinner';
import NoodSwipeableRow from '../../components/NoodSwipeableRow';
import { CATALOG_LIST_PROPS } from '../../components/catalog/ListPerf';
import { NOOD_REFRESH_CONTROL_PROPS } from '../../utils/navigation-gestures';
import { useScreenPerfReporter } from '../../utils/screen-perf';

const COLORS = {
  bg: '#f7f2eb',
  card: '#ffffff',
  line: '#efdfcc',
  text: '#161311',
  muted: '#7b7268',
  orange: '#ff8a00',
  orangeDeep: '#ff7300',
  orangeSoft: '#fff1df',
  green: '#5c31ff',
  paypal: '#0070ba',
};

const WIPAY_LOGO =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/IMG_2415.jpg?v=1772139039';
const PAYPAL_LOGO =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/paypal-logo-symbol-icon-transparent-png-701751695036660okg9nooua3.png?v=1781243217';
const CART_IMAGE_PLACEHOLDER = 'https://via.placeholder.com/600x700.png?text=No+Image';
const CART_RECOMMENDATIONS_FOCUS_MS = 60000;
let cartScrollOffsetSnapshot = 0;

type CartRecommendationCardProps = {
  product: CatalogListProduct;
  priceLabel: string;
  onOpen: (product: CatalogListProduct) => void;
  onAddToCart: (product: CatalogListProduct) => void;
};

const CartRecommendationCard = React.memo(function CartRecommendationCard({
  product,
  priceLabel,
  onOpen,
  onAddToCart,
}: CartRecommendationCardProps) {
  return (
    <View style={styles.recommendCard}>
      <TouchableOpacity activeOpacity={0.9} onPress={() => onOpen(product)}>
        <ExpoImage
          source={{ uri: getCartImageUri(product.image) }}
          style={styles.recommendImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={product.image || product.id}
          transition={0}
        />
        <Text style={styles.recommendTitle} numberOfLines={2}>
          {product.title}
        </Text>
        <Text style={styles.recommendPrice}>{priceLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.recommendAddBtn}
        activeOpacity={0.88}
        onPress={() => onAddToCart(product)}
      >
        <Ionicons name="cart-outline" size={16} color={COLORS.orangeDeep} />
      </TouchableOpacity>
    </View>
  );
});

type CartLineItemProps = {
  item: any;
  convertedPrice: number;
  lineTotal: number;
  variantLine: string | null;
  selectedCurrency: string;
  onOpen: (item: any) => void;
  onDecrease: (item: any) => void;
  onIncrease: (item: any) => void;
  onRemove: (id: string, size?: string, color?: string) => void;
  onSave: (item: any) => void;
  formatMoney: (amount: number, currency: string) => string;
};

const CartLineItem = React.memo(function CartLineItem({
  item,
  convertedPrice,
  lineTotal,
  variantLine,
  selectedCurrency,
  onOpen,
  onDecrease,
  onIncrease,
  onRemove,
  onSave,
  formatMoney,
}: CartLineItemProps) {
  return (
    <NoodSwipeableRow
      style={styles.cartCard}
      leftActions={[
        {
          key: 'save',
          label: 'Save',
          icon: 'heart-outline',
          backgroundColor: '#ff6a00',
          onPress: () => void onSave(item),
        },
      ]}
      rightActions={[
        {
          key: 'remove',
          label: 'Remove',
          icon: 'trash-outline',
          backgroundColor: '#d9480f',
          onPress: () => onRemove(String(item.id), item.size, item.color),
        },
      ]}
    >
      <TouchableOpacity activeOpacity={0.9} onPress={() => onOpen(item)}>
        <ExpoImage
          source={{ uri: getCartImageUri(item.image) }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={getCartImageUri(item.image)}
          transition={0}
        />
      </TouchableOpacity>

      <View style={styles.cardContent}>
        <View style={styles.cardTopRow}>
          <View style={styles.titleWrap}>
            <Text style={styles.title} numberOfLines={2}>
              {item.title}
            </Text>

            {variantLine ? <Text style={styles.variantLine}>{variantLine}</Text> : null}
          </View>

          <TouchableOpacity
            style={styles.removeButton}
            activeOpacity={0.85}
            onPress={() => onRemove(String(item.id), item.size, item.color)}
          >
            <Ionicons name="trash-outline" size={18} color={COLORS.muted} />
          </TouchableOpacity>
        </View>

        <View style={styles.priceRow}>
          <View>
            <Text style={styles.priceLabel}>Price</Text>
            <Text style={styles.price}>{formatMoney(convertedPrice, selectedCurrency)}</Text>
          </View>
          <View style={styles.lineTotalWrap}>
            <Text style={styles.priceLabel}>Qty {item.quantity || 1}</Text>
            <Text style={styles.lineTotal}>
              {formatMoney(lineTotal, selectedCurrency)}
            </Text>
          </View>
        </View>

        <View style={styles.actionsRow}>
          <View style={styles.qtyControl}>
            <TouchableOpacity style={styles.qtyButton} onPress={() => onDecrease(item)}>
              <Ionicons name="remove" size={16} color={COLORS.text} />
            </TouchableOpacity>
            <Text style={styles.qty}>{item.quantity}</Text>
            <TouchableOpacity style={styles.qtyButton} onPress={() => onIncrease(item)}>
              <Ionicons name="add" size={16} color={COLORS.text} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.saveButton}
            activeOpacity={0.88}
            onPress={() => void onSave(item)}
          >
            <Ionicons name="heart-outline" size={16} color={COLORS.orangeDeep} />
            <Text style={styles.saveButtonText}>Save for later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </NoodSwipeableRow>
  );
});

function getCartImageUri(uri?: string | null) {
  const trimmed = String(uri || '').trim();
  return trimmed.length > 0 ? trimmed : CART_IMAGE_PLACEHOLDER;
}

function getVariantDetailsLine(item: any): string | null {
  const parts: string[] = [];
  const color = String(item?.color || '').trim();
  const size = String(item?.size || '').trim();
  const variantTitle = String(item?.variantTitle || '').trim();

  if (color) parts.push(`Color: ${color}`);
  if (size) parts.push(`Size: ${size}`);

  if (!parts.length && variantTitle && variantTitle !== 'Default Title') {
    return variantTitle;
  }

  return parts.length ? parts.join(' | ') : null;
}

export default function CartScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {
    cartItems = [],
    balanceFormatted,
    balanceConverted = 0,
    addToCart,
    removeFromCart,
    updateQuantity,
    convertPrice,
    formatMoney,
    selectedCurrency,
    orders = [],
    checkoutTotals,
  } = useCart();
  const { addHistoryEvent } = useHistoryEvents();
  const { addToWishlist } = useWishlist();
  const { profileId, isSignedIn, isReady } = useUser();
  const customerKey = useMemo(
    () => resolveCustomerStorageKey(profileId || '', '', isSignedIn),
    [isSignedIn, profileId]
  );
  const [recommendedProducts, setRecommendedProducts] = useState<CatalogListProduct[]>([]);
  const [loadingRecommendations, setLoadingRecommendations] = useState(true);
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  type CartLineEntry = {
    item: any;
    key: string;
    convertedPrice: number;
    lineTotal: number;
    variantLine: string | null;
  };
  const scrollRef = useRef<FlatList<CartLineEntry> | null>(null);
  const restoredScrollRef = useRef(false);
  const lastRecommendationsFocusRef = useRef(0);
  const hasCartItems = cartItems.length > 0;
  const bottomBarHeight = 84 + Math.max(insets.bottom, 8);

  const itemCount = useMemo(() => {
    return cartItems.reduce((sum: number, item: any) => sum + Number(item?.quantity || 0), 0);
  }, [cartItems]);

  const orderTotal = checkoutTotals.total;
  const displayOrderTotal = useMemo(
    () => convertPrice(orderTotal, SHOPIFY_CHECKOUT_CURRENCY, selectedCurrency),
    [convertPrice, orderTotal, selectedCurrency]
  );
  const walletBalanceTtd = useMemo(
    () => convertPrice(Number(balanceConverted || 0), selectedCurrency, SHOPIFY_CHECKOUT_CURRENCY),
    [balanceConverted, convertPrice, selectedCurrency]
  );
  const walletCanCover = walletBalanceTtd >= orderTotal && orderTotal > 0;

  const visibleRecommendations = useMemo(() => {
    const cartHandles = new Set(
      cartItems.map((item: any) => String(item?.handle || '').trim()).filter(Boolean)
    );
    return recommendedProducts.filter(
      (product) => product.handle && !cartHandles.has(product.handle)
    );
  }, [cartItems, recommendedProducts]);

  useEffect(() => {
    if (!confirmationMessage) return;

    const timer = setTimeout(() => setConfirmationMessage(''), 2200);
    return () => clearTimeout(timer);
  }, [confirmationMessage]);

  useEffect(() => {
    if (restoredScrollRef.current || !cartItems.length || cartScrollOffsetSnapshot <= 0) return;

    restoredScrollRef.current = true;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToOffset({
        offset: cartScrollOffsetSnapshot,
        animated: false,
      });
    });
  }, [cartItems.length]);

  const loadRecommendations = useCallback(async () => {
    if (!isReady) return;

    setLoadingRecommendations(true);
    try {
      const result = await loadCartRecommendations({
        profileId: profileId || 'guest',
        isSignedIn,
        cartItems,
        orders,
      });
      setRecommendedProducts(result.products);
    } catch (error) {
      console.log('Cart recommendations load error:', error);
      setRecommendedProducts([]);
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
          .map((item: any) => `${item?.handle || item?.id || ''}:${item?.quantity || 1}`)
          .sort()
          .join('|'),
        orders
          .map((order: any) => String(order?.id || ''))
          .sort()
          .join('|'),
      ].join('::'),
    [cartItems, isSignedIn, orders, profileId]
  );
  const recommendationsFingerprintRef = useRef('');

  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      const fingerprintChanged = recommendationsFingerprintRef.current !== recommendationsFingerprint;
      const shouldRefresh =
        fingerprintChanged || now - lastRecommendationsFocusRef.current >= CART_RECOMMENDATIONS_FOCUS_MS;

      if (!shouldRefresh) return;

      recommendationsFingerprintRef.current = recommendationsFingerprint;
      lastRecommendationsFocusRef.current = now;
      void loadRecommendations();
    }, [loadRecommendations, recommendationsFingerprint])
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadRecommendations();
    } finally {
      setRefreshing(false);
    }
  }, [loadRecommendations]);

  useEffect(() => {
    const unsubscribe = (navigation as any).addListener('tabPress', () => {
      if (!navigation.isFocused()) return;
      cartScrollOffsetSnapshot = 0;
      restoredScrollRef.current = true;
      scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
    });

    return unsubscribe;
  }, [navigation]);

  const increaseQty = useCallback(
    (item: any) => {
      updateQuantity(String(item.id), (item.quantity || 1) + 1, item.size, item.color);
    },
    [updateQuantity]
  );

  const decreaseQty = useCallback(
    (item: any) => {
      const nextQty = (item.quantity || 1) - 1;

      if (nextQty <= 0) {
        removeFromCart(String(item.id), item.size, item.color);
        return;
      }

      updateQuantity(String(item.id), nextQty, item.size, item.color);
    },
    [removeFromCart, updateQuantity]
  );

  const saveForLater = useCallback(async (item: any) => {
    try {
      if (!customerKey) {
        return;
      }

      const { alreadySaved } = await addToWishlist(item);

      removeFromCart(String(item.id), item.size, item.color);
      void addHistoryEvent({
        type: 'wishlist',
        title: 'Moved to Wishlist',
        description: item?.title || 'Product was saved for later.',
        status: alreadySaved ? 'already-saved' : 'saved',
        relatedId: String(item?.handle || item?.id || ''),
        metadata: {
          product: item,
        },
      });
      setConfirmationMessage(alreadySaved ? 'Already in Wishlist' : 'Moved to Wishlist');
    } catch (error) {
      console.log('Save for later error:', error);
      setConfirmationMessage('Could not save item');
    }
  }, [addHistoryEvent, addToWishlist, customerKey, removeFromCart]);

  const goToCheckout = (method?: 'wallet' | 'wipay' | 'paypal') => {
    if (!hasCartItems) return;
    void addHistoryEvent({
      type: 'checkout',
      title: 'Checkout started',
      description: `${cartItems.length} item${cartItems.length === 1 ? '' : 's'} in checkout.`,
      amount: orderTotal,
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      status: 'started',
      metadata: {
        items: cartItems,
        method: method || 'checkout',
      },
    });
    router.push({
      pathname: '/checkout',
      params: method ? { method } : {},
    } as any);
  };

  const openProduct = useCallback((item: any) => {
    const handle = String(item?.handle || '').trim();
    if (!handle) return;

    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(item, { from: 'cart' }) as any,
    });
  }, []);

  const handleAddRecommendedToCart = useCallback((product: CatalogListProduct) => {
    const added = addToCart({
      ...product,
      price: product.priceAmount,
      baseCurrency: product.currencyCode || BASE_CURRENCY,
    });

    if (added) {
      setConfirmationMessage(`${product.title} added to cart`);
      return;
    }

    openProduct(product);
  }, [addToCart, openProduct]);

  const handleCartScroll = useCallback((event: any) => {
    cartScrollOffsetSnapshot = event.nativeEvent.contentOffset.y;
  }, []);

  const cartLineItems = useMemo(
    () =>
      cartItems.map((item: any, index: number) => {
        const convertedPrice = convertPrice(
          Number(item.price || 0),
          item?.baseCurrency || BASE_CURRENCY,
          selectedCurrency
        );

        return {
          item,
          key: `${item.id}-${item.size || 'default'}-${item.color || 'default'}-${index}`,
          convertedPrice,
          lineTotal: convertedPrice * Number(item.quantity || 1),
          variantLine: getVariantDetailsLine(item),
        };
      }),
    [cartItems, convertPrice, selectedCurrency]
  );

  const recommendationPriceById = useMemo(() => {
    const map = new Map<string, string>();
    visibleRecommendations.forEach((product) => {
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
  }, [convertPrice, formatMoney, selectedCurrency, visibleRecommendations]);

  const renderRecommendationItem = useCallback(
    ({ item }: { item: CatalogListProduct }) => (
      <CartRecommendationCard
        product={item}
        priceLabel={recommendationPriceById.get(item.id || item.handle) || ''}
        onOpen={openProduct}
        onAddToCart={handleAddRecommendedToCart}
      />
    ),
    [handleAddRecommendedToCart, openProduct, recommendationPriceById]
  );

  const recommendationKeyExtractor = useCallback(
    (item: CatalogListProduct) => item.id || item.handle,
    []
  );

  const handleWalletPress = () => {
    if (walletCanCover) {
      goToCheckout('wallet');
      return;
    }

    router.push('/account/wallet' as any);
  };

  const cartKeyExtractor = useCallback((entry: CartLineEntry) => entry.key, []);

  const renderCartLineItem = useCallback(
    ({ item: entry }: { item: CartLineEntry }) => (
      <CartLineItem
        item={entry.item}
        convertedPrice={entry.convertedPrice}
        lineTotal={entry.lineTotal}
        variantLine={entry.variantLine}
        selectedCurrency={selectedCurrency}
        onOpen={openProduct}
        onDecrease={decreaseQty}
        onIncrease={increaseQty}
        onRemove={removeFromCart}
        onSave={saveForLater}
        formatMoney={formatMoney}
      />
    ),
    [
      decreaseQty,
      formatMoney,
      increaseQty,
      openProduct,
      removeFromCart,
      saveForLater,
      selectedCurrency,
    ]
  );

  const cartListHeader = useMemo(
    () => (
      <>
        {confirmationMessage ? (
          <View style={styles.confirmationToast}>
            <Ionicons name="checkmark-circle" size={17} color={COLORS.green} />
            <Text style={styles.confirmationToastText}>{confirmationMessage}</Text>
          </View>
        ) : null}

        {!hasCartItems ? (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIconCircle}>
              <Ionicons name="bag-handle-outline" size={36} color={COLORS.orange} />
            </View>
            <Text style={styles.emptyTitle}>Your cart is empty</Text>
            <Text style={styles.emptySubtitle}>
              Browse products, save favorites, and check out with WiPay, PayPal, or Wallet.
            </Text>
            <TouchableOpacity
              style={styles.emptyButton}
              activeOpacity={0.9}
              onPress={() => router.push('/(tabs)/categories')}
            >
              <Text style={styles.emptyButtonText}>Browse products</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.topOffer}>
              <View style={styles.topOfferLeft}>
                <Ionicons name="shield-checkmark-outline" size={18} color="#ffffff" />
                <Text style={styles.topOfferText}>All data is safeguarded</Text>
              </View>
              <Text style={styles.topOfferBadge}>Secure</Text>
            </View>

            <View style={styles.shippingBanner}>
              <View style={styles.shippingBannerLeft}>
                <Ionicons name="car-outline" size={22} color="#ffffff" />
                <View>
                  <Text style={styles.shippingTitle}>Free door-to-door shipping for you</Text>
                  <Text style={styles.shippingSubtitle}>Secure checkout with tracked shipping</Text>
                  <Text style={styles.deliveryEstimate}>
                    Delivery estimate shown at checkout
                  </Text>
                </View>
              </View>
              <Text style={styles.shippingOffer}>Exclusive</Text>
            </View>

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Cart</Text>
              <Text style={styles.sectionMeta}>
                {itemCount} item{itemCount === 1 ? '' : 's'}
              </Text>
            </View>
          </>
        )}
      </>
    ),
    [confirmationMessage, hasCartItems, itemCount]
  );

  const renderRecommendations = useMemo(
    () => (
      <View style={styles.recommendSection}>
        <Text style={[styles.summaryTitle, styles.recommendTitlePad]}>Recommended for you</Text>
        <Text style={styles.recommendSubtitle}>
          {hasCartItems
            ? 'Add something extra before you check out.'
            : 'Popular picks to get you started.'}
        </Text>

        {loadingRecommendations ? (
          <View style={styles.recommendLoadingWrap}>
            <NoodSpinner size={38} />
          </View>
        ) : visibleRecommendations.length > 0 ? (
          <FlatList
            horizontal
            data={visibleRecommendations}
            keyExtractor={recommendationKeyExtractor}
            renderItem={renderRecommendationItem}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.recommendRow}
            initialNumToRender={4}
            maxToRenderPerBatch={4}
            windowSize={5}
            removeClippedSubviews
          />
        ) : (
          <Text style={styles.recommendEmptyText}>More products will show here soon.</Text>
        )}
      </View>
    ),
    [
      hasCartItems,
      loadingRecommendations,
      recommendationKeyExtractor,
      renderRecommendationItem,
      visibleRecommendations,
    ]
  );

  const cartListFooter = useMemo(
    () => (
      <>
        {hasCartItems ? (
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Order Summary</Text>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Items subtotal</Text>
            <Text style={styles.summaryValue}>{formatMoney(displayOrderTotal, selectedCurrency)}</Text>
          </View>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Shipping</Text>
            <Text style={styles.summaryGreen}>FREE</Text>
          </View>

          <View style={styles.summaryDivider} />

          <View style={styles.summaryRow}>
            <Text style={styles.summaryTotalLabel}>Total</Text>
            <Text style={styles.summaryTotalValue}>
              {formatMoney(displayOrderTotal, selectedCurrency)}
            </Text>
          </View>
        </View>
        ) : null}

        {hasCartItems ? (
        <View style={styles.paymentCard}>
          <Text style={styles.summaryTitle}>Express Checkout</Text>

          <TouchableOpacity
            style={[styles.walletButton, !walletCanCover && styles.walletButtonDisabled]}
            activeOpacity={walletCanCover ? 0.92 : 1}
            onPress={handleWalletPress}
          >
            <View style={styles.paymentButtonLeft}>
              <View style={styles.logoBadgeWallet}>
                <Ionicons name="wallet-outline" size={20} color={COLORS.green} />
              </View>
              <View style={styles.paymentTextWrap}>
                <Text style={styles.paymentButtonTitleDark}>Pay with Wallet Balance</Text>
                <Text style={styles.paymentButtonSubtitleDark}>
                  Available: {balanceFormatted || formatMoney(0, selectedCurrency)}
                </Text>
                {!walletCanCover ? (
                  <Text style={styles.walletInsufficientText}>
                    Insufficient balance — Top up
                  </Text>
                ) : null}
              </View>
            </View>
            <Text style={[styles.walletStatus, walletCanCover ? styles.walletStatusReady : styles.walletStatusLow]}>
              {walletCanCover ? 'Ready' : 'Top up'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.wipayButton} activeOpacity={0.92} onPress={() => goToCheckout('wipay')}>
            <View style={styles.paymentButtonLeft}>
              <View style={styles.logoBadgeLight}>
                <Image source={{ uri: WIPAY_LOGO }} style={styles.wipayLogo} resizeMode="contain" />
              </View>
              <View style={styles.paymentTextWrap}>
                <Text style={styles.paymentButtonTitleLight}>Pay with WiPay</Text>
                <Text style={styles.paymentButtonSubtitleLight}>Pay securely with WiPay</Text>
                <View style={styles.cardLogoRow}>
                  <View style={styles.cardLogoPill}>
                    <Text style={styles.cardLogoText}>Visa Debit</Text>
                  </View>
                  <View style={styles.cardLogoPill}>
                    <Text style={styles.cardLogoText}>Visa</Text>
                  </View>
                  <View style={styles.cardLogoPill}>
                    <Text style={styles.cardLogoText}>Mastercard</Text>
                  </View>
                </View>
              </View>
            </View>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.paypalButton} activeOpacity={0.92} onPress={() => goToCheckout('paypal')}>
            <View style={styles.paymentButtonLeft}>
              <View style={styles.logoBadgeDark}>
                <Image source={{ uri: PAYPAL_LOGO }} style={styles.paypalLogo} resizeMode="contain" />
              </View>
              <View style={styles.paymentTextWrap}>
                <Text style={styles.paymentButtonTitleDark}>PayPal</Text>
                <Text style={styles.paymentButtonSubtitleDark}>Express checkout with PayPal</Text>
              </View>
            </View>
            <Ionicons name="arrow-forward" size={18} color={COLORS.paypal} />
          </TouchableOpacity>

        </View>
        ) : null}

        {renderRecommendations}
      </>
    ),
    [
      balanceFormatted,
      displayOrderTotal,
      formatMoney,
      handleWalletPress,
      hasCartItems,
      renderRecommendations,
      selectedCurrency,
      walletCanCover,
    ]
  );

  useScreenPerfReporter(
    'cart',
    {
      itemCount: cartItems.length,
      isFetching: loadingRecommendations,
      isRefreshing: refreshing,
    },
    [cartItems.length, loadingRecommendations, refreshing]
  );

  return (
    <SafeAreaView style={styles.screen}>
      <FlatList
        ref={scrollRef}
        data={hasCartItems ? cartLineItems : []}
        keyExtractor={cartKeyExtractor}
        renderItem={renderCartLineItem}
        ListHeaderComponent={cartListHeader}
        ListFooterComponent={cartListFooter}
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: hasCartItems ? bottomBarHeight + 24 : 28 },
        ]}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        onScroll={handleCartScroll}
        scrollEventThrottle={16}
        {...CATALOG_LIST_PROPS}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void handleRefresh()}
            {...NOOD_REFRESH_CONTROL_PROPS}
          />
        }
      />

      {hasCartItems ? (
      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={styles.promoTabWrap}>
          <TouchableOpacity
            style={styles.promoTab}
            activeOpacity={0.92}
            onPress={() => router.push('/account/rewards' as any)}
          >
            <Ionicons name="gift-outline" size={15} color="#fff" />
            <Text style={styles.promoTabText}>Rewards</Text>
          </TouchableOpacity>
        </View>

        <View>
          <Text style={styles.bottomTotalLabel}>Total</Text>
          <Text style={styles.bottomTotalValue}>{formatMoney(displayOrderTotal, selectedCurrency)}</Text>
        </View>

        <TouchableOpacity style={styles.bottomCheckoutButton} activeOpacity={0.92} onPress={() => goToCheckout()}>
          <Text style={styles.bottomCheckoutText}>Checkout</Text>
        </TouchableOpacity>
      </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 22,
  },
  topOffer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#5c31ff',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#9f79ff',
    marginBottom: 12,
  },
  topOfferLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  topOfferText: {
    marginLeft: 8,
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
  },
  topOfferBadge: {
    fontSize: 12,
    fontWeight: '900',
    color: '#ffffff',
  },
  shippingBanner: {
    backgroundColor: '#5c31ff',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  shippingBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 12,
  },
  shippingTitle: {
    marginLeft: 10,
    fontSize: 17,
    fontWeight: '900',
    color: '#ffffff',
  },
  shippingSubtitle: {
    marginLeft: 10,
    marginTop: 2,
    fontSize: 12,
    color: '#eee9ff',
    fontWeight: '700',
  },
  deliveryEstimate: {
    marginLeft: 10,
    marginTop: 4,
    fontSize: 11,
    color: '#ddd5ff',
    fontWeight: '600',
  },
  shippingOffer: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 12,
  },
  confirmationToast: {
    alignSelf: 'center',
    marginBottom: 14,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d9ccff',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
  },
  confirmationToastText: {
    marginLeft: 7,
    fontSize: 13,
    fontWeight: '900',
    color: COLORS.green,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 26,
    fontWeight: '900',
    color: COLORS.text,
  },
  sectionMeta: {
    fontSize: 13,
    color: COLORS.muted,
    fontWeight: '700',
  },
  cartCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.line,
  },
  image: {
    width: '100%',
    height: 220,
    borderRadius: 18,
    backgroundColor: '#ececec',
    marginBottom: 12,
  },
  cardContent: {
    gap: 12,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  titleWrap: {
    flex: 1,
    paddingRight: 12,
  },
  title: {
    fontWeight: '900',
    fontSize: 24,
    lineHeight: 28,
    color: COLORS.text,
  },
  variantLine: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.muted,
    fontWeight: '700',
  },
  removeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#f8f3ec',
    alignItems: 'center',
    justifyContent: 'center',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  priceLabel: {
    fontSize: 11,
    color: COLORS.muted,
    fontWeight: '700',
    marginBottom: 2,
  },
  price: {
    color: COLORS.orangeDeep,
    fontWeight: '900',
    fontSize: 22,
  },
  lineTotalWrap: {
    alignItems: 'flex-end',
  },
  lineTotal: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
  },
  qtyControl: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  qtyButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#f5efe7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qty: {
    minWidth: 34,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '900',
    color: COLORS.text,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.orangeSoft,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  saveButtonText: {
    marginLeft: 6,
    color: COLORS.orangeDeep,
    fontSize: 13,
    fontWeight: '800',
  },
  summaryCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 14,
  },
  summaryTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: COLORS.text,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  summaryLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.muted,
  },
  summaryValue: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
  },
  summaryGreen: {
    fontSize: 16,
    fontWeight: '900',
    color: COLORS.green,
  },
  summaryOrange: {
    flex: 1,
    paddingLeft: 12,
    textAlign: 'right',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '800',
    color: COLORS.orangeDeep,
  },
  summaryDivider: {
    height: 1,
    backgroundColor: COLORS.line,
    marginTop: 16,
  },
  summaryTotalLabel: {
    fontSize: 18,
    fontWeight: '900',
    color: COLORS.text,
  },
  summaryTotalValue: {
    fontSize: 24,
    fontWeight: '900',
    color: COLORS.text,
  },
  paymentCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 14,
  },
  wipayButton: {
    marginTop: 14,
    minHeight: 88,
    borderRadius: 18,
    backgroundColor: COLORS.orange,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  paypalButton: {
    marginTop: 12,
    minHeight: 72,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d7e6f7',
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  paymentButtonLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 12,
  },
  logoBadgeLight: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoBadgeDark: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#f3f8fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoBadgeWallet: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f1ecff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletButton: {
    marginTop: 14,
    minHeight: 72,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d9ccff',
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  walletButtonDisabled: {
    opacity: 0.72,
    borderColor: '#eadfff',
  },
  walletInsufficientText: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.orangeDeep,
  },
  wipayLogo: {
    width: 48,
    height: 48,
  },
  paypalLogo: {
    width: 30,
    height: 30,
  },
  paymentTextWrap: {
    marginLeft: 10,
    flex: 1,
  },
  paymentButtonTitleLight: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '900',
  },
  paymentButtonSubtitleLight: {
    color: '#fff4e8',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  cardLogoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    gap: 5,
  },
  cardLogoPill: {
    backgroundColor: '#ffffff',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  cardLogoText: {
    color: COLORS.orangeDeep,
    fontSize: 9,
    fontWeight: '900',
  },
  paymentButtonTitleDark: {
    color: COLORS.paypal,
    fontSize: 17,
    fontWeight: '900',
  },
  paymentButtonSubtitleDark: {
    color: '#4e6b86',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  walletStatus: {
    fontSize: 13,
    fontWeight: '900',
  },
  walletStatusReady: {
    color: COLORS.green,
  },
  walletStatusLow: {
    color: COLORS.orangeDeep,
  },
  recommendSection: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 12,
    marginTop: 4,
  },
  recommendTitlePad: {
    paddingHorizontal: 16,
  },
  recommendSubtitle: {
    fontSize: 13,
    color: COLORS.muted,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 14,
    paddingHorizontal: 16,
  },
  recommendRow: {
    paddingHorizontal: 16,
    paddingRight: 28,
  },
  recommendCard: {
    width: 170,
    marginRight: 14,
    position: 'relative',
  },
  recommendAddBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffd9c6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recommendImage: {
    width: '100%',
    height: 180,
    borderRadius: 16,
    backgroundColor: '#ececec',
  },
  recommendTitle: {
    marginTop: 8,
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '800',
  },
  recommendPrice: {
    marginTop: 4,
    fontSize: 16,
    color: COLORS.orangeDeep,
    fontWeight: '900',
  },
  recommendLoadingWrap: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recommendEmptyText: {
    paddingHorizontal: 16,
    fontSize: 14,
    color: COLORS.muted,
    fontWeight: '700',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  promoTabWrap: {
    position: 'absolute',
    right: 16,
    top: -34,
    zIndex: 3,
  },
  promoTab: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#5c31ff',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 2,
    borderColor: '#9f79ff',
    shadowColor: '#5c31ff',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  promoTabText: {
    marginLeft: 6,
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  bottomTotalLabel: {
    fontSize: 12,
    color: COLORS.muted,
    fontWeight: '700',
  },
  bottomTotalValue: {
    fontSize: 22,
    color: COLORS.text,
    fontWeight: '900',
    marginTop: 2,
  },
  bottomCheckoutButton: {
    minWidth: 170,
    height: 56,
    borderRadius: 999,
    backgroundColor: COLORS.orange,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  bottomCheckoutText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },
  emptyCard: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.line,
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingVertical: 28,
    marginBottom: 14,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLORS.orangeSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: COLORS.text,
    textAlign: 'center',
  },
  emptySubtitle: {
    marginTop: 10,
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.muted,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: 24,
    backgroundColor: COLORS.orange,
    borderRadius: 999,
    paddingHorizontal: 24,
    paddingVertical: 15,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
  },
});
