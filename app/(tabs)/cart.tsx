import React, { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Animated,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCart } from '../../context/CartContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import { BASE_CURRENCY } from '../../utils/currency';
import NoodSpinner from '../../components/NoodSpinner';
import { catalogFetch } from '../../utils/catalog';

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
const WISHLIST_STORAGE_KEY = 'NOOD_WISHLIST';
const CART_RECOMMENDATIONS_CACHE_KEY = 'NOOD_CART_RECOMMENDATIONS_CACHE_V1';

type RecommendedProduct = {
  id: string;
  title: string;
  handle: string;
  image: string;
  price: string;
};

let cartScrollOffsetSnapshot = 0;
let cartRecommendedProductsSnapshot: RecommendedProduct[] = [];
let cartRecommendedProductsSnapshotKey = '';

function getCartImageUri(uri?: string | null) {
  const trimmed = String(uri || '').trim();
  return trimmed.length > 0 ? trimmed : CART_IMAGE_PLACEHOLDER;
}

const RECOMMENDED_PRODUCTS_QUERY = `
  query GetRecommendedProducts($first: Int!) {
    products(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          featuredImage {
            url
          }
          priceRange {
            minVariantPrice {
              amount
            }
          }
        }
      }
    }
  }
`;

export default function CartScreen() {
  const {
    cartItems = [],
    balanceFormatted,
    balanceConverted = 0,
    removeFromCart,
    updateQuantity,
    convertPrice,
    formatMoney,
    selectedCurrency,
  } = useCart();
  const { addHistoryEvent } = useHistoryEvents();
  const [recommendedProducts, setRecommendedProducts] = useState<RecommendedProduct[]>(
    () => cartRecommendedProductsSnapshot
  );
  const [loadingRecommendations, setLoadingRecommendations] = useState(
    !cartRecommendedProductsSnapshot.length
  );
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const promoBounce = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView | null>(null);
  const restoredScrollRef = useRef(false);

  const subtotal = useMemo(() => {
    return cartItems.reduce((sum: number, item: any) => {
      const price = Number(item?.price || 0);
      const qty = Number(item?.quantity || 1);
      const converted = convertPrice(
        price,
        item?.baseCurrency || BASE_CURRENCY,
        selectedCurrency
      );

      return sum + converted * qty;
    }, 0);
  }, [cartItems, selectedCurrency, convertPrice]);

  const itemCount = useMemo(() => {
    return cartItems.reduce((sum: number, item: any) => sum + Number(item?.quantity || 0), 0);
  }, [cartItems]);

  const discountStatusText =
    itemCount >= 3
      ? 'Automatic discount unlocked'
      : 'Add 3+ items to unlock automatic discount';

  const walletCanCover = Number(balanceConverted || 0) >= subtotal && subtotal > 0;

  useEffect(() => {
    if (!confirmationMessage) return;

    const timer = setTimeout(() => setConfirmationMessage(''), 2200);
    return () => clearTimeout(timer);
  }, [confirmationMessage]);

  useEffect(() => {
    if (restoredScrollRef.current || !cartItems.length || cartScrollOffsetSnapshot <= 0) return;

    restoredScrollRef.current = true;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        y: cartScrollOffsetSnapshot,
        animated: false,
      });
    });
  }, [cartItems.length]);

  useFocusEffect(
    React.useCallback(() => {
      promoBounce.setValue(0);
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(promoBounce, {
            toValue: 1,
            duration: 650,
            useNativeDriver: true,
          }),
          Animated.timing(promoBounce, {
            toValue: 0,
            duration: 650,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();

      return () => {
        animation.stop();
      };
    }, [promoBounce])
  );

  const promoBounceStyle = {
    transform: [
      {
        translateY: promoBounce.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -6],
        }),
      },
      {
        scale: promoBounce.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 1.04],
        }),
      },
    ],
  };

  useEffect(() => {
    let isMounted = true;

    const mapRecommendationProducts = (
      edges: any[],
      cartHandles: Set<string>
    ): RecommendedProduct[] =>
      (edges || [])
        .map((edge: any) => ({
          id: String(edge?.node?.id || ''),
          title: edge?.node?.title || 'Product',
          handle: edge?.node?.handle || '',
          image:
            edge?.node?.featuredImage?.url ||
            'https://via.placeholder.com/600x700.png?text=No+Image',
          price: formatMoney(
            Number(edge?.node?.priceRange?.minVariantPrice?.amount || 0),
            selectedCurrency
          ),
        }))
        .filter((product: RecommendedProduct) => product.handle && !cartHandles.has(product.handle))
        .slice(0, 8);

    const loadRecommendations = async () => {
      const cartHandlesKey = cartItems
        .map((item: any) => String(item?.handle || ''))
        .sort()
        .join('|');
      const cartHandles = new Set(cartItems.map((item: any) => String(item?.handle || '')));
      let showedCache = false;

      if (
        cartRecommendedProductsSnapshot.length &&
        cartRecommendedProductsSnapshotKey === cartHandlesKey
      ) {
        if (isMounted) {
          setRecommendedProducts(cartRecommendedProductsSnapshot);
          setLoadingRecommendations(false);
        }
        showedCache = true;
      } else {
        try {
          const cachedRaw = await AsyncStorage.getItem(CART_RECOMMENDATIONS_CACHE_KEY);
          if (cachedRaw) {
            const parsed = JSON.parse(cachedRaw) as {
              products?: RecommendedProduct[];
              cartHandlesKey?: string;
            };
            if (
              Array.isArray(parsed.products) &&
              parsed.products.length &&
              (!parsed.cartHandlesKey || parsed.cartHandlesKey === cartHandlesKey)
            ) {
              if (isMounted) {
                setRecommendedProducts(parsed.products);
                setLoadingRecommendations(false);
              }
              showedCache = true;
            }
          }
        } catch (error) {
          console.log('Cart recommendations cache read error:', error);
        }
      }

      try {
        const json = await catalogFetch(RECOMMENDED_PRODUCTS_QUERY, { first: 12 });
        const mapped = mapRecommendationProducts(json?.data?.products?.edges || [], cartHandles);

        if (isMounted) {
          cartRecommendedProductsSnapshot = mapped;
          cartRecommendedProductsSnapshotKey = cartHandlesKey;
          setRecommendedProducts(mapped);
        }

        await AsyncStorage.setItem(
          CART_RECOMMENDATIONS_CACHE_KEY,
          JSON.stringify({
            products: mapped,
            cartHandlesKey,
            savedAt: new Date().toISOString(),
          })
        );
      } catch (error) {
        console.log('Cart recommendations error:', error);
        if (isMounted && !showedCache) {
          setRecommendedProducts([]);
        }
      } finally {
        if (isMounted) {
          setLoadingRecommendations(false);
        }
      }
    };

    loadRecommendations();

    return () => {
      isMounted = false;
    };
  }, [cartItems, formatMoney, selectedCurrency]);

  const increaseQty = (item: any) => {
    updateQuantity(String(item.id), (item.quantity || 1) + 1, item.size, item.color);
  };

  const decreaseQty = (item: any) => {
    const nextQty = (item.quantity || 1) - 1;

    if (nextQty <= 0) {
      removeFromCart(String(item.id), item.size, item.color);
      return;
    }

    updateQuantity(String(item.id), nextQty, item.size, item.color);
  };

  const saveForLater = async (item: any) => {
    try {
      const savedWishlist = await AsyncStorage.getItem(WISHLIST_STORAGE_KEY);
      const parsedWishlist = savedWishlist ? JSON.parse(savedWishlist) : [];
      const wishlistItems = Array.isArray(parsedWishlist) ? parsedWishlist : [];
      const itemKey = String(item?.handle || item?.id || '');
      const alreadySaved = wishlistItems.some(
        (wishlistItem: any) => String(wishlistItem?.handle || wishlistItem?.id || '') === itemKey
      );

      if (!alreadySaved) {
        const nextWishlist = [
          {
            ...item,
            quantity: 1,
            savedAt: new Date().toISOString(),
          },
          ...wishlistItems,
        ];
        await AsyncStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(nextWishlist));
      }

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
      setConfirmationMessage('Moved to Wishlist');
    } catch (error) {
      console.log('Save for later error:', error);
      setConfirmationMessage('Could not save item');
    }
  };

  const handleCheckout = () => {
    if (!cartItems.length) return;
    void addHistoryEvent({
      type: 'checkout',
      title: 'Checkout started',
      description: `${cartItems.length} item${cartItems.length === 1 ? '' : 's'} in checkout.`,
      amount: subtotal,
      currency: selectedCurrency,
      status: 'started',
      metadata: {
        items: cartItems,
      },
    });
    router.push('/checkout');
  };

  const openProduct = (handle?: string) => {
    if (!handle) return;
    router.push({
      pathname: '/product/[handle]',
      params: { handle },
    });
  };

  const openRecommended = (handle?: string) => {
    if (handle) {
      openProduct(handle);
      return;
    }
    router.push('/(tabs)/categories');
  };

  if (!cartItems.length) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="bag-handle-outline" size={42} color={COLORS.orange} />
          </View>
          <Text style={styles.emptyTitle}>Your cart is empty</Text>
          <Text style={styles.emptySubtitle}>
            Add products to review WiPay, PayPal, and fast checkout options here.
          </Text>
          <TouchableOpacity
            style={styles.emptyButton}
            activeOpacity={0.9}
            onPress={() => router.push('/(tabs)/categories')}
          >
            <Text style={styles.emptyButtonText}>Start shopping</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(event) => {
          cartScrollOffsetSnapshot = event.nativeEvent.contentOffset.y;
        }}
      >
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
            </View>
          </View>
          <Text style={styles.shippingOffer}>Exclusive</Text>
        </View>

        {confirmationMessage ? (
          <View style={styles.confirmationToast}>
            <Ionicons name="checkmark-circle" size={17} color={COLORS.green} />
            <Text style={styles.confirmationToastText}>{confirmationMessage}</Text>
          </View>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Cart</Text>
          <Text style={styles.sectionMeta}>
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </Text>
        </View>

        {cartItems.map((item: any, index: number) => {
          const convertedPrice = convertPrice(
            Number(item.price || 0),
            item?.baseCurrency || BASE_CURRENCY,
            selectedCurrency
          );
          const lineTotal = convertedPrice * Number(item.quantity || 1);

          return (
            <View key={`${item.id}-${item.size || 'default'}-${index}`} style={styles.cartCard}>
              <TouchableOpacity activeOpacity={0.9} onPress={() => openProduct(item.handle)}>
                <Image source={{ uri: getCartImageUri(item.image) }} style={styles.image} />
              </TouchableOpacity>

              <View style={styles.cardContent}>
                <View style={styles.cardTopRow}>
                  <View style={styles.titleWrap}>
                    <Text style={styles.title} numberOfLines={2}>
                      {item.title}
                    </Text>

                    <View style={styles.metaRow}>
                      {item.size ? (
                        <View style={styles.metaPill}>
                          <Text style={styles.metaPillText}>Size {item.size}</Text>
                        </View>
                      ) : null}
                      <View style={styles.metaPill}>
                        <Text style={styles.metaPillText}>Ready to ship</Text>
                      </View>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={styles.removeButton}
                    activeOpacity={0.85}
                    onPress={() => removeFromCart(String(item.id), item.size, item.color)}
                  >
                    <Ionicons name="trash-outline" size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                </View>

                <View style={styles.priceRow}>
                  <Text style={styles.price}>{formatMoney(convertedPrice, selectedCurrency)}</Text>
                  <Text style={styles.lineTotal}>
                    Total {formatMoney(lineTotal, selectedCurrency)}
                  </Text>
                </View>

                <View style={styles.actionsRow}>
                  <View style={styles.qtyControl}>
                    <TouchableOpacity style={styles.qtyButton} onPress={() => decreaseQty(item)}>
                      <Ionicons name="remove" size={16} color={COLORS.text} />
                    </TouchableOpacity>
                    <Text style={styles.qty}>{item.quantity}</Text>
                    <TouchableOpacity style={styles.qtyButton} onPress={() => increaseQty(item)}>
                      <Ionicons name="add" size={16} color={COLORS.text} />
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity
                    style={styles.saveButton}
                    activeOpacity={0.88}
                    onPress={() => void saveForLater(item)}
                  >
                    <Ionicons name="heart-outline" size={16} color={COLORS.orangeDeep} />
                    <Text style={styles.saveButtonText}>Save for later</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          );
        })}

        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Order Summary</Text>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Item total</Text>
            <Text style={styles.summaryValue}>{formatMoney(subtotal, selectedCurrency)}</Text>
          </View>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Shipping</Text>
            <Text style={styles.summaryGreen}>FREE</Text>
          </View>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Discount</Text>
            <Text style={styles.summaryOrange}>{discountStatusText}</Text>
          </View>

          <View style={styles.summaryDivider} />

          <View style={styles.summaryRow}>
            <Text style={styles.summaryTotalLabel}>Total</Text>
            <Text style={styles.summaryTotalValue}>{formatMoney(subtotal, selectedCurrency)}</Text>
          </View>
        </View>

        <View style={styles.paymentCard}>
          <Text style={styles.summaryTitle}>Express Checkout</Text>

          <TouchableOpacity style={styles.walletButton} activeOpacity={0.92} onPress={handleCheckout}>
            <View style={styles.paymentButtonLeft}>
              <View style={styles.logoBadgeWallet}>
                <Ionicons name="wallet-outline" size={20} color={COLORS.green} />
              </View>
              <View style={styles.paymentTextWrap}>
                <Text style={styles.paymentButtonTitleDark}>Pay with Wallet Balance</Text>
                <Text style={styles.paymentButtonSubtitleDark}>
                  Available: {balanceFormatted || formatMoney(0, selectedCurrency)}
                </Text>
              </View>
            </View>
            <Text style={[styles.walletStatus, walletCanCover ? styles.walletStatusReady : styles.walletStatusLow]}>
              {walletCanCover ? 'Ready' : 'Top up'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.wipayButton} activeOpacity={0.92} onPress={handleCheckout}>
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

          <TouchableOpacity style={styles.paypalButton} activeOpacity={0.92} onPress={handleCheckout}>
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

          <TouchableOpacity style={styles.primaryCheckoutButton} activeOpacity={0.92} onPress={handleCheckout}>
            <Text style={styles.primaryCheckoutTitle}>Checkout</Text>
            <Text style={styles.primaryCheckoutSubtitle}>
              Continue with all payment methods
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.recommendSection}>
          <Text style={styles.summaryTitle}>Recommended for you</Text>
          <Text style={styles.recommendSubtitle}>
            Add something extra before you check out.
          </Text>

          {loadingRecommendations ? (
            <View style={styles.recommendLoadingWrap}>
              <NoodSpinner size={38} />
            </View>
          ) : recommendedProducts.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.recommendRow}
            >
              {recommendedProducts.map((product) => (
                <TouchableOpacity
                  key={product.id}
                  style={styles.recommendCard}
                  activeOpacity={0.9}
                  onPress={() => openRecommended(product.handle)}
                >
                  <Image source={{ uri: getCartImageUri(product.image) }} style={styles.recommendImage} />
                  <Text style={styles.recommendTitle} numberOfLines={2}>
                    {product.title}
                  </Text>
                  <Text style={styles.recommendPrice}>{product.price}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.recommendEmptyText}>More products will show here soon.</Text>
          )}
        </View>

        <View style={styles.bottomGap} />
      </ScrollView>

      <View style={styles.bottomBar}>
        <View style={styles.promoTabWrap}>
          <Animated.View style={promoBounceStyle}>
            <TouchableOpacity
              style={styles.promoTab}
              activeOpacity={0.92}
              onPress={() => router.push('/account/rewards' as any)}
            >
              <Ionicons name="gift-outline" size={15} color="#fff" />
              <Text style={styles.promoTabText}>Rewards</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>

        <View>
          <Text style={styles.bottomTotalLabel}>Total</Text>
          <Text style={styles.bottomTotalValue}>{formatMoney(subtotal, selectedCurrency)}</Text>
        </View>

        <TouchableOpacity style={styles.bottomCheckoutButton} activeOpacity={0.92} onPress={handleCheckout}>
          <Text style={styles.bottomCheckoutText}>Checkout</Text>
        </TouchableOpacity>
      </View>
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
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
  },
  metaPill: {
    backgroundColor: COLORS.orangeSoft,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 6,
  },
  metaPillText: {
    color: COLORS.orangeDeep,
    fontSize: 12,
    fontWeight: '800',
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
  price: {
    color: COLORS.orangeDeep,
    fontWeight: '900',
    fontSize: 22,
  },
  lineTotal: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
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
  primaryCheckoutButton: {
    marginTop: 14,
    minHeight: 66,
    borderRadius: 18,
    backgroundColor: '#1a1714',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  primaryCheckoutTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },
  primaryCheckoutSubtitle: {
    color: '#d4ccc5',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  recommendSection: {
    backgroundColor: COLORS.card,
    borderRadius: 22,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 12,
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
  bottomGap: {
    height: 100,
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
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: COLORS.bg,
  },
  emptyIconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: COLORS.orangeSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyTitle: {
    fontSize: 28,
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
