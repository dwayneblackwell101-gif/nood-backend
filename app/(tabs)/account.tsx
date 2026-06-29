import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCart } from '../../context/CartContext';
import { useUpdates } from '../../context/UpdatesContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';

import NoodSpinner from '../../components/NoodSpinner';
import * as WebBrowser from 'expo-web-browser';
import { logAuthRestartCheck } from '../../utils/auth-restart-debug';
import { isAppBootstrapComplete } from '../../utils/app-bootstrap';
import { handleShopifyAuthRedirectUrl } from '../../utils/shopify-auth-handlers';
import { launchShopifyAuthSession } from '../../utils/shopify-auth-launcher';

WebBrowser.maybeCompleteAuthSession();
import { loadAccountRecommendations } from '../../utils/account-recommendations';
import { buildProductRouteParams } from '../../utils/product-navigation';
import type { CatalogListProduct } from '../../utils/catalog-product-mapper';
import { BASE_CURRENCY } from '../../utils/currency';
import { getProfilePictureUri, saveProfilePicture } from '../../utils/profile-avatar';
import { getWalletTransactionDisplay } from '../../utils/wallet-display';
import { noodAlert } from '../../utils/nood-alert';
import { SIGN_IN_ENABLED } from '../../utils/payment-testing';
import { useScreenPerfReporter } from '../../utils/screen-perf';
import { fetchShopifyDiscounts, type NoodDiscount } from '../../utils/shopify-discounts';
import {
  buildCustomerDisplayName,
  getCustomerProfile,
  type CustomerProfile,
} from '../../utils/customer-profile';

const GOOGLE_LOGO_URL =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/2a5758d6-4edb-4047-87bb-e6b94dbbbab0-cover.png?v=1781936734';
const NOOD_LOGO_SOURCE = require('../../assets/images/nood-brand-logo.png');

function getProfileInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    return '';
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

type RowIconName = React.ComponentProps<typeof Ionicons>['name'];

type AccountProduct = CatalogListProduct;

const PRODUCT_IMAGE_PLACEHOLDER = 'https://via.placeholder.com/600x600.png?text=No+Image';
const ACCOUNT_MENU_ROW_COUNT = 10;
const ACCOUNT_FOCUS_REFRESH_MS = 60000;

let accountScrollOffsetSnapshot = 0;
let accountRecommendedProductsSnapshot: AccountProduct[] = [];

const WalletActivityRow = React.memo(function WalletActivityRow({
  note,
  createdAt,
  amountLabel,
  amountColor,
}: {
  note: string;
  createdAt?: string;
  amountLabel: string;
  amountColor: string;
}) {
  return (
    <View style={styles.walletRow}>
      <View style={styles.walletLeft}>
        <Text style={styles.walletNote}>{note}</Text>
        <Text style={styles.walletDate}>
          {createdAt ? new Date(createdAt).toLocaleDateString() : 'Recent'}
        </Text>
      </View>
      <Text style={[styles.walletAmount, { color: amountColor }]}>{amountLabel}</Text>
    </View>
  );
});

const MenuRow = React.memo(function MenuRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: RowIconName;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.menuRow} activeOpacity={0.88} onPress={onPress}>
      <View style={styles.menuLeft}>
        <View style={styles.menuIconWrap}>
          <Ionicons name={icon} size={20} color="#ff6a00" />
        </View>

        <View style={styles.menuTextWrap}>
          <Text style={styles.menuTitle}>{title}</Text>
          {subtitle ? <Text style={styles.menuSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>

      <Ionicons name="chevron-forward" size={20} color="#999" />
    </TouchableOpacity>
  );
});

const QuickAction = React.memo(function QuickAction({
  icon,
  label,
  subtitle,
  onPress,
}: {
  icon: RowIconName;
  label: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.quickItem} activeOpacity={0.88} onPress={onPress}>
      <View style={styles.quickMiniCard}>
        <View style={styles.quickIconWrap}>
          <Ionicons name={icon} size={20} color="#ff6a00" />
        </View>
        <Text style={styles.quickText} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.quickSubtitle} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

function ProductSkeletonCard() {
  return (
    <View style={styles.productCard}>
      <View style={[styles.productImage, styles.skeletonBlock]} />
      <View style={styles.productBody}>
        <View style={[styles.skeletonLine, styles.skeletonLineWide]} />
        <View style={[styles.skeletonLine, styles.skeletonLineMedium]} />
        <View style={styles.productBottomRow}>
          <View style={[styles.skeletonLine, styles.skeletonLinePrice]} />
          <View style={[styles.smallCartBtn, styles.skeletonBlock]} />
        </View>
      </View>
    </View>
  );
}

const ProductCard = React.memo(function ProductCard({
  image,
  title,
  price,
  onPress,
  onAddToCart,
}: {
  image: string;
  title: string;
  price: string;
  onPress: () => void;
  onAddToCart?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.productCard} activeOpacity={0.9} onPress={onPress}>
      <ExpoImage
        source={{ uri: image || PRODUCT_IMAGE_PLACEHOLDER }}
        style={styles.productImage}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={image || PRODUCT_IMAGE_PLACEHOLDER}
        transition={0}
      />

      <View style={styles.productBody}>
        <Text numberOfLines={2} style={styles.productTitle}>
          {title}
        </Text>

        <View style={styles.productBottomRow}>
          <Text style={styles.productPrice}>{price}</Text>

          <TouchableOpacity
            style={styles.smallCartBtn}
            activeOpacity={0.88}
            onPress={(event) => {
              event.stopPropagation();
              onAddToCart?.();
            }}
          >
            <Ionicons name="cart-outline" size={18} color="#ff6a00" />
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
});

export default function AccountScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const { settings, isReady, isSignedIn, displayName, profileId, markSignedIn } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const [openingSignInProvider, setOpeningSignInProvider] = useState<string | null>(null);
  const { unreadCount = 0 } = useUpdates();
  const isCompact = width < 430;

  const {
    balanceConverted = 0,
    walletHistory = [],
    orders = [],
    cartItems = [],
    selectedCurrency = settings?.currency || BASE_CURRENCY,
    convertPrice,
    formatMoney,
    addToCart,
    refreshOrdersFromShopify,
  } = (useCart() as any) || {};

  const [recommendedProducts, setRecommendedProducts] = useState<AccountProduct[]>(
    () => accountRecommendedProductsSnapshot
  );
  const [loadingProducts, setLoadingProducts] = useState(!accountRecommendedProductsSnapshot.length);
  const [recommendationsStatus, setRecommendationsStatus] = useState<
    'loading' | 'ready' | 'cached' | 'error'
  >(accountRecommendedProductsSnapshot.length ? 'ready' : 'loading');
  const [activeShippingDeal, setActiveShippingDeal] = useState<NoodDiscount | null>(null);
  const [profilePictureUri, setProfilePictureUri] = useState<string | null>(null);
  const [shopifyProfile, setShopifyProfile] = useState<CustomerProfile | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const restoredScrollRef = useRef(false);
  const lastAccountFocusLoadRef = useRef(0);
  const recommendationsLoadedFingerprintRef = useRef('');

  const currentCurrency = selectedCurrency || settings?.currency || BASE_CURRENCY;

  const loadShopifyProfile = useCallback(async () => {
    if (!isSignedIn) {
      setShopifyProfile(null);
      return;
    }

    const profile = await getCustomerProfile();
    setShopifyProfile(profile);
  }, [isSignedIn]);

  const shownName = useMemo(() => {
    if (!isSignedIn) {
      return 'Guest';
    }

    const fromProfile = shopifyProfile
      ? buildCustomerDisplayName(shopifyProfile) || shopifyProfile.displayName
      : '';
    if (fromProfile) {
      return fromProfile;
    }

    const fromContext = String(displayName || '').trim();
    if (fromContext && fromContext !== 'NOOD Shopper') {
      return fromContext;
    }

    return 'NOOD Member';
  }, [displayName, isSignedIn, shopifyProfile]);

  const openSignIn = useCallback(
    async (provider?: 'google' | 'facebook' | 'shop') => {
      if (!provider) {
        router.push('/sign-in' as any);
        return;
      }

      if (openingSignInProvider) return;

      setOpeningSignInProvider(provider);
      logAuthRestartCheck({
        step: 'account-open-sign-in',
        isAppBootstrapping: !isAppBootstrapComplete(),
        isAuthLoading: true,
        detail: { provider },
      });

      await launchShopifyAuthSession({
        provider,
        onRedirectUrl: async (url) => {
          await handleShopifyAuthRedirectUrl(url, {
            markSignedIn,
            addHistoryEvent,
          });
        },
        onError: (message) => {
          noodAlert('Sign-in unavailable', message);
        },
      });

      setOpeningSignInProvider(null);
    },
    [addHistoryEvent, markSignedIn, openingSignInProvider, router]
  );

  const memberLabel = useMemo(() => {
    if (!isSignedIn) {
      return 'Sign in to view your customer account';
    }

    const email = String(shopifyProfile?.email || '').trim();
    if (email) {
      return email;
    }

    return 'NOOD Member';
  }, [isSignedIn, shopifyProfile]);

  const profileInitials = useMemo(() => {
    if (!isSignedIn) {
      return '';
    }

    const normalizedName = String(shownName || '').trim();
    if (!normalizedName || normalizedName === 'NOOD Member') {
      return '';
    }

    return getProfileInitials(normalizedName);
  }, [isSignedIn, shownName]);

  const loadProfilePicture = useCallback(async () => {
    if (!isSignedIn || !profileId) {
      setProfilePictureUri(null);
      return;
    }

    const savedUri = await getProfilePictureUri(profileId);
    setProfilePictureUri(savedUri);
  }, [isSignedIn, profileId]);

  useFocusEffect(
    useCallback(() => {
      void loadProfilePicture();
      void loadShopifyProfile();

      const now = Date.now();
      if (now - lastAccountFocusLoadRef.current < ACCOUNT_FOCUS_REFRESH_MS) {
        return;
      }
      lastAccountFocusLoadRef.current = now;

      void fetchShopifyDiscounts().then((response) => {
        const firstShippingDeal = response.shipping.find((deal) => deal.isActive) || null;
        setActiveShippingDeal(firstShippingDeal);
      });

      if (isSignedIn) {
        void refreshOrdersFromShopify?.();
      }
    }, [isSignedIn, loadProfilePicture, loadShopifyProfile, refreshOrdersFromShopify])
  );

  const handleEditProfilePicture = useCallback(async () => {
    if (!isSignedIn || !profileId) {
      return;
    }

    if (Platform.OS === 'web') {
      noodAlert('Profile picture', 'Choose a profile picture from the NOOD mobile app.');
      return;
    }

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        noodAlert(
          'Photo access needed',
          'Allow photo library access to choose a profile picture.'
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });

      if (result.canceled || !result.assets?.[0]?.uri) {
        return;
      }

      const savedUri = await saveProfilePicture(profileId, result.assets[0].uri);
      setProfilePictureUri(savedUri);
    } catch (error) {
      console.log('Profile picture picker error:', error);
      noodAlert('Profile picture', 'Could not update your profile picture. Please try again.');
    }
  }, [isSignedIn, profileId]);

  const recommendationFingerprint = useMemo(
    () =>
      [
        profileId || 'guest',
        isSignedIn ? '1' : '0',
        (cartItems || [])
          .map((item: any) => String(item?.handle || item?.id || ''))
          .sort()
          .join('|'),
        (orders || [])
          .map((order: any) => String(order?.id || ''))
          .sort()
          .join('|'),
      ].join('::'),
    [cartItems, isSignedIn, orders, profileId]
  );

  const loadRecommendedProducts = useCallback(async () => {
    if (!isReady) return;

    const hasSnapshot = accountRecommendedProductsSnapshot.length > 0;
    if (!hasSnapshot) {
      setLoadingProducts(true);
    }
    setRecommendationsStatus('loading');

    try {
      const result = await loadAccountRecommendations({
        profileId: profileId || 'guest',
        isSignedIn,
        cartItems,
        orders,
      });

      accountRecommendedProductsSnapshot = result.products;
      setRecommendedProducts(result.products);
      setRecommendationsStatus(
        result.products.length ? result.status : 'error'
      );
    } catch (error) {
      console.log('Account recommended products error:', error);
      setRecommendationsStatus(hasSnapshot ? 'cached' : 'error');
    } finally {
      setLoadingProducts(false);
    }
  }, [cartItems, isReady, isSignedIn, orders, profileId]);

  useEffect(() => {
    if (!isReady) return;
    if (recommendationsLoadedFingerprintRef.current === recommendationFingerprint) return;

    recommendationsLoadedFingerprintRef.current = recommendationFingerprint;

    if (accountRecommendedProductsSnapshot.length) {
      setRecommendedProducts(accountRecommendedProductsSnapshot);
      setLoadingProducts(false);
    }

    void loadRecommendedProducts();
  }, [isReady, recommendationFingerprint, loadRecommendedProducts]);

  const scrollToTop = useCallback(() => {
    accountScrollOffsetSnapshot = 0;
    restoredScrollRef.current = true;
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  useEffect(() => {
    const unsubscribe = (navigation as any).addListener('tabPress', () => {
      if (!navigation.isFocused()) return;
      scrollToTop();
    });

    return unsubscribe;
  }, [navigation, scrollToTop]);

  useEffect(() => {
    if (restoredScrollRef.current || accountScrollOffsetSnapshot <= 0) return;

    restoredScrollRef.current = true;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        y: accountScrollOffsetSnapshot,
        animated: false,
      });
    });
  }, []);

  const ordersCount =
    isSignedIn && Array.isArray(orders) ? orders.length : 0;

  const recentWalletHistory = useMemo(() => {
    if (!isSignedIn || !Array.isArray(walletHistory)) {
      return [];
    }

    return walletHistory.slice(0, 5);
  }, [isSignedIn, walletHistory]);

  const goToProduct = useCallback((product: AccountProduct) => {
    if (!product?.handle) return;

    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(product, { from: 'account' }) as any,
    });
  }, [router]);

  const handleAddRecommendedToCart = useCallback((product: AccountProduct) => {
    const added = addToCart?.({
      ...product,
      price: product.priceAmount,
      baseCurrency: product.currencyCode || BASE_CURRENCY,
    });

    if (added) {
      noodAlert('Added to cart', `${product.title} is ready in your cart.`);
      return;
    }

    goToProduct(product);
  }, [addToCart, goToProduct]);

  const getWalletDisplay = useCallback((item: any) => {
    const display = getWalletTransactionDisplay(String(item?.type || ''));
    return {
      color: display.color,
      sign: display.sign,
      amount: Math.abs(Number(item?.amount || 0)),
    };
  }, []);

  const displayMoney = useCallback(
    (amount: number, fromCurrency = BASE_CURRENCY) =>
      formatMoney(
        convertPrice(Number(amount || 0), fromCurrency || BASE_CURRENCY, currentCurrency),
        currentCurrency
      ),
    [convertPrice, currentCurrency, formatMoney]
  );

  const recommendationPriceById = useMemo(() => {
    const map = new Map<string, string>();
    recommendedProducts.forEach((product) => {
      const key = `${product.id}-${product.handle}`;
      map.set(key, displayMoney(product.priceAmount, product.currencyCode));
    });
    return map;
  }, [displayMoney, recommendedProducts]);

  const recommendationKeyExtractor = useCallback(
    (item: AccountProduct) => `${item.id}-${item.handle}`,
    []
  );

  const renderRecommendationItem = useCallback(
    ({ item }: { item: AccountProduct }) => {
      const itemKey = `${item.id}-${item.handle}`;
      return (
        <ProductCard
          image={item.image}
          title={item.title}
          price={recommendationPriceById.get(itemKey) || displayMoney(item.priceAmount, item.currencyCode)}
          onPress={() => goToProduct(item)}
          onAddToCart={() => handleAddRecommendedToCart(item)}
        />
      );
    },
    [displayMoney, goToProduct, handleAddRecommendedToCart, recommendationPriceById]
  );

  const handleAccountScroll = useCallback((event: any) => {
    accountScrollOffsetSnapshot = event.nativeEvent.contentOffset.y;
  }, []);

  useScreenPerfReporter(
    'account',
    {
      itemCount: recommendedProducts.length,
      isFetching: loadingProducts,
      isRefreshing: false,
    },
    [loadingProducts, recommendedProducts.length]
  );

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        contentContainerStyle={[styles.scrollContent, isCompact && styles.scrollContentCompact]}
        scrollEventThrottle={32}
        removeClippedSubviews={Platform.OS === 'android'}
        onScroll={handleAccountScroll}
      >
        <View style={styles.topSpace} />

        <View style={styles.logoWrap}>
          <Image
            source={require('../../assets/images/nood-brand-logo.png')}
            style={[styles.logo, isCompact && styles.logoCompact]}
            resizeMode="contain"
          />
        </View>

        {!isReady ? (
          <View style={styles.accountLoadingCard}>
            <NoodSpinner size={58} reason="account-user-settings-bootstrap" />
          </View>
        ) : (
        <View style={[styles.heroCard, isCompact && styles.heroCardCompact]}>
          <View style={[styles.heroGlow, isCompact && styles.heroGlowCompact]} />

          <View style={styles.heroTopRow}>
            <View style={styles.profileAvatarShell}>
              <TouchableOpacity
                style={[
                  styles.profileAvatarBubble,
                  isCompact && styles.profileAvatarBubbleCompact,
                  isSignedIn && profilePictureUri ? styles.profileAvatarBubblePhoto : null,
                  isSignedIn && !profilePictureUri && profileInitials ? styles.profileAvatarBubbleInitials : null,
                ]}
                activeOpacity={isSignedIn ? 0.88 : 1}
                disabled={!isSignedIn}
                onPress={() => {
                  void handleEditProfilePicture();
                }}
              >
                {isSignedIn && profilePictureUri ? (
                  <Image
                    source={{ uri: profilePictureUri }}
                    style={styles.profileAvatarImage}
                    resizeMode="cover"
                  />
                ) : isSignedIn && profileInitials ? (
                  <Text
                    style={[
                      styles.profileAvatarInitialsText,
                      isCompact && styles.profileAvatarInitialsTextCompact,
                    ]}
                  >
                    {profileInitials}
                  </Text>
                ) : (
                  <Image
                    source={NOOD_LOGO_SOURCE}
                    style={[
                      styles.profileAvatarLogo,
                      isCompact && styles.profileAvatarLogoCompact,
                    ]}
                    resizeMode="contain"
                  />
                )}
              </TouchableOpacity>

              {isSignedIn ? (
                <TouchableOpacity
                  style={[styles.profileAvatarEditBtn, isCompact && styles.profileAvatarEditBtnCompact]}
                  activeOpacity={0.88}
                  onPress={() => {
                    void handleEditProfilePicture();
                  }}
                >
                  <Ionicons name="camera" size={11} color="#fff" />
                </TouchableOpacity>
              ) : null}
            </View>

            <View style={[styles.heroTextWrap, isCompact && styles.heroTextWrapCompact]}>
              <Text style={[styles.name, isCompact && styles.nameCompact]}>{shownName}</Text>
              {!isSignedIn && SIGN_IN_ENABLED ? (
                <TouchableOpacity
                  activeOpacity={0.82}
                  onPress={() => void openSignIn()}
                  accessibilityRole="button"
                  accessibilityLabel="Sign in to view your customer account"
                >
                  <Text
                    style={[styles.memberText, isCompact && styles.memberTextCompact]}
                    numberOfLines={2}
                  >
                    {memberLabel}
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text
                  style={[styles.memberText, isCompact && styles.memberTextCompact]}
                  numberOfLines={2}
                >
                  {memberLabel}
                </Text>
              )}
              <Text style={[styles.regionText, isCompact && styles.regionTextCompact]}>
                {settings.country} • {settings.currency}
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.settingsBtn, isCompact && styles.settingsBtnCompact]}
              activeOpacity={0.88}
              onPress={() => router.push('/account/settings' as any)}
            >
              <Ionicons name="settings-outline" size={22} color="#111" />
            </TouchableOpacity>
          </View>

          {isSignedIn ? (
            <View style={[styles.statsRow, isCompact && styles.statsRowCompact]}>
              <TouchableOpacity
                style={[styles.statCard, isCompact && styles.statCardCompact]}
                activeOpacity={0.9}
                onPress={() => router.push('/account/wallet' as any)}
              >
                <Text style={[styles.statValue, isCompact && styles.statValueCompact]} numberOfLines={1}>
                  {formatMoney(Number(balanceConverted || 0), currentCurrency)}
                </Text>
                <Text style={[styles.statLabel, isCompact && styles.statLabelCompact]}>Balance</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.statCard, isCompact && styles.statCardCompact]}
                activeOpacity={0.9}
                onPress={() => router.push('/account/orders' as any)}
              >
                <Text style={[styles.statValue, isCompact && styles.statValueCompact]}>{ordersCount}</Text>
                <Text style={[styles.statLabel, isCompact && styles.statLabelCompact]}>Orders</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {SIGN_IN_ENABLED && !isSignedIn ? (
            <View style={[styles.signInActions, isCompact && styles.signInActionsCompact]}>
              <TouchableOpacity
                style={[styles.googleSignInButton, isCompact && styles.googleSignInButtonCompact]}
                activeOpacity={0.9}
                onPress={() => void openSignIn('google')}
              >
                <View style={[styles.googleSignInIconWrap, isCompact && styles.googleSignInIconWrapCompact]}>
                  <Image
                    source={{ uri: GOOGLE_LOGO_URL }}
                    style={[styles.googleSignInIcon, isCompact && styles.googleSignInIconCompact]}
                    resizeMode="contain"
                  />
                </View>
                <Text
                  style={[
                    styles.googleSignInButtonText,
                    isCompact && styles.googleSignInButtonTextCompact,
                  ]}
                  numberOfLines={1}
                >
                  Continue with Google
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.facebookSignInButton, isCompact && styles.facebookSignInButtonCompact]}
                activeOpacity={0.9}
                onPress={() => void openSignIn('facebook')}
              >
                <View
                  style={[styles.facebookSignInIconWrap, isCompact && styles.facebookSignInIconWrapCompact]}
                >
                  <Text style={styles.facebookSignInIconText}>f</Text>
                </View>
                <Text
                  style={[
                    styles.facebookSignInButtonText,
                    isCompact && styles.facebookSignInButtonTextCompact,
                  ]}
                  numberOfLines={1}
                >
                  Continue with Facebook
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.shopSignInButton, isCompact && styles.shopSignInButtonCompact]}
                activeOpacity={0.9}
                onPress={() => void openSignIn('shop')}
              >
                <View style={[styles.shopSignInIconWrap, isCompact && styles.shopSignInIconWrapCompact]}>
                  <Ionicons name="bag-handle" size={18} color="#5433EB" />
                </View>
                <Text
                  style={[styles.shopSignInButtonText, isCompact && styles.shopSignInButtonTextCompact]}
                  numberOfLines={1}
                >
                  Continue with Shop
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
        )}

        {isSignedIn ? (
          <View style={styles.walletSection}>
            <Text style={styles.sectionTitle}>Wallet Activity</Text>

            {recentWalletHistory.length === 0 ? (
              <View style={styles.emptyProductsWrap}>
                <Text style={styles.emptyProductsText}>No wallet activity yet</Text>
              </View>
            ) : (
              recentWalletHistory.map((item: any, index: number) => {
                const walletDisplay = getWalletDisplay(item);

                return (
                  <WalletActivityRow
                    key={item?.id ? String(item.id) : `wallet-${index}`}
                    note={item?.note || 'Wallet update'}
                    createdAt={item?.createdAt}
                    amountLabel={`${walletDisplay.sign}${displayMoney(walletDisplay.amount)}`}
                    amountColor={walletDisplay.color}
                  />
                );
              })
            )}

            <TouchableOpacity
              style={styles.sectionFooterBtn}
              activeOpacity={0.88}
              onPress={() => router.push('/account/wallet' as any)}
            >
              <Text style={styles.sectionFooterBtnText}>Open wallet</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.menuCard}>
          <Text style={styles.sectionTitle}>Your account</Text>

          <MenuRow
            icon="person-circle-outline"
            title="Profile"
            subtitle="Name, email, phone, profile picture"
            onPress={() => router.push('/account/profile' as any)}
          />
          <MenuRow
            icon="receipt-outline"
            title="Orders"
            subtitle="Track and manage purchases"
            onPress={() => router.push('/account/orders' as any)}
          />
          <MenuRow
            icon="card-outline"
            title="Payment methods"
            subtitle="Cards, PayPal, Wallet, billing"
            onPress={() => router.push('/account/payment-methods' as any)}
          />
          <MenuRow
            icon="wallet-outline"
            title="Wallet"
            subtitle="Balance, top up, refunds, history"
            onPress={() => router.push('/account/wallet' as any)}
          />
          <MenuRow
            icon="location-outline"
            title="Addresses"
            subtitle="Shipping and billing addresses"
            onPress={() => router.push('/account/address' as any)}
          />
          <MenuRow
            icon="return-down-back-outline"
            title="Returns & refunds"
            subtitle="Request return or check refund status"
            onPress={() => router.push('/account/returns' as any)}
          />
          <MenuRow
            icon="shield-checkmark-outline"
            title="Security"
            subtitle="Sign-in methods and account protection"
            onPress={() => router.push('/account/security' as any)}
          />
          <MenuRow
            icon="notifications-outline"
            title="Updates"
            subtitle={
              unreadCount > 0
                ? `${unreadCount} new update${unreadCount === 1 ? '' : 's'}`
                : 'Deals, rewards, shipping, and app news'
            }
            onPress={() => router.push('/account/updates' as any)}
          />
          <MenuRow
            icon="chatbubble-ellipses-outline"
            title="Help & Support"
            subtitle="Chat with MooseDesk support"
            onPress={() => router.push('/account/support' as any)}
          />
          <MenuRow
            icon="star-outline"
            title="Reviews"
            subtitle="Rate your recent items"
            onPress={() => router.push('/account/reviews' as any)}
          />
          <MenuRow
            icon="pricetags-outline"
            title="Deals"
            subtitle="Coupons, special offers, and NOOD Deals Hub"
            onPress={() => router.push('/account/deals' as any)}
          />
        </View>

        <View style={styles.quickCard}>
          <Text style={styles.sectionTitle}>Quick access</Text>

          <View style={styles.quickRow}>
            <QuickAction
              icon="time-outline"
              label="History"
              subtitle="Recent activity"
              onPress={() => router.push('/account/history' as any)}
            />
            <QuickAction
              icon="location-outline"
              label="Address"
              subtitle="Shipping info"
              onPress={() => router.push('/account/address' as any)}
            />
            <QuickAction
              icon="gift-outline"
              label="Rewards"
              subtitle="Locked rewards"
              onPress={() => router.push('/account/rewards' as any)}
            />
            <QuickAction
              icon="heart-outline"
              label="Saved"
              subtitle="Wishlist items"
              onPress={() => router.replace('/wishlist' as any)}
            />
          </View>
        </View>

        {activeShippingDeal ? (
          <TouchableOpacity
            style={styles.infoBar}
            activeOpacity={0.9}
            onPress={() => router.push('/account/deals' as any)}
          >
            <Ionicons name="cube-outline" size={18} color="#ff6a00" />
            <Text style={styles.infoText} numberOfLines={1}>
              {activeShippingDeal.title || 'Free shipping offer'}
            </Text>
            <Text style={styles.infoLinkText}>View in Deals</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.productsSection}>
          <View style={styles.productsHeader}>
            <Text style={styles.sectionTitleNoPad}>Recommended</Text>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => router.push('/search' as any)}
            >
              <Text style={styles.viewAllText}>View all</Text>
            </TouchableOpacity>
          </View>

          {loadingProducts ? (
            <View style={styles.productsGrid}>
              {Array.from({ length: 8 }).map((_, index) => (
                <ProductSkeletonCard key={`account-rec-skeleton-${index}`} />
              ))}
            </View>
          ) : recommendedProducts.length === 0 ? (
            <View style={styles.emptyProductsWrap}>
              <Text style={styles.emptyProductsText}>
                {recommendationsStatus === 'error'
                  ? "We couldn't load recommendations right now."
                  : 'No recommendations right now. Browse products to get personalized picks.'}
              </Text>
              {recommendationsStatus === 'error' ? (
                <TouchableOpacity
                  style={styles.retryRecommendationsBtn}
                  activeOpacity={0.9}
                  onPress={() => void loadRecommendedProducts()}
                >
                  <Text style={styles.retryRecommendationsText}>Try again</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.retryRecommendationsBtn}
                  activeOpacity={0.9}
                  onPress={() => router.push('/search' as any)}
                >
                  <Text style={styles.retryRecommendationsText}>Browse products</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View>
              {recommendationsStatus === 'cached' ? (
                <Text style={styles.cachedRecommendationsText}>
                  Showing saved picks while recommendations refresh.
                </Text>
              ) : null}
              <FlatList
                data={recommendedProducts}
                numColumns={2}
                scrollEnabled={false}
                keyExtractor={recommendationKeyExtractor}
                renderItem={renderRecommendationItem}
                columnWrapperStyle={styles.productsGrid}
                initialNumToRender={8}
                maxToRenderPerBatch={8}
                windowSize={5}
              />
            </View>
          )}
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    backgroundColor: '#fff7f2',
    alignItems: 'center',
    justifyContent: 'center',
  },

  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: '#666',
    fontWeight: '600',
  },

  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
  },

  scrollContent: {
    paddingHorizontal: 14,
    paddingBottom: 110,
  },

  scrollContentCompact: {
    paddingHorizontal: 10,
    paddingBottom: 96,
  },

  topSpace: {
    height: 12,
  },

  logoWrap: {
    alignItems: 'center',
    paddingTop: 6,
    paddingBottom: 8,
  },

  logo: {
    width: 188,
    height: 64,
  },

  logoCompact: {
    width: 138,
    height: 48,
  },

  accountLoadingCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    paddingVertical: 34,
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },

  heroCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 16,
    marginTop: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 4,
  },

  heroCardCompact: {
    borderRadius: 20,
    padding: 12,
    marginTop: 4,
  },

  heroGlow: {
    position: 'absolute',
    top: -30,
    right: -20,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#fff0e7',
  },

  heroGlowCompact: {
    top: -26,
    right: -32,
    width: 104,
    height: 104,
    borderRadius: 52,
  },

  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },

  profileAvatarShell: {
    position: 'relative',
    flexShrink: 0,
  },

  profileAvatarBubble: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e6e6e6',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
    overflow: 'hidden',
  },

  profileAvatarBubbleCompact: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },

  profileAvatarBubblePhoto: {
    padding: 0,
    borderColor: '#ffe4d6',
  },

  profileAvatarBubbleInitials: {
    backgroundColor: '#ff6a00',
    borderColor: '#ff6a00',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.18,
  },

  profileAvatarImage: {
    width: '100%',
    height: '100%',
  },

  profileAvatarLogo: {
    width: 34,
    height: 24,
  },

  profileAvatarLogoCompact: {
    width: 30,
    height: 21,
  },

  profileAvatarInitialsText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
  },

  profileAvatarInitialsTextCompact: {
    fontSize: 18,
  },

  profileAvatarEditBtn: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ff6a00',
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },

  profileAvatarEditBtnCompact: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },

  heroTextWrap: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0,
  },

  heroTextWrapCompact: {
    marginLeft: 10,
  },

  name: {
    fontSize: 24,
    fontWeight: '900',
    color: '#111',
    flexShrink: 1,
  },

  nameCompact: {
    fontSize: 22,
  },

  memberText: {
    marginTop: 2,
    fontSize: 13,
    color: '#ff6a00',
    fontWeight: '800',
    flexShrink: 1,
  },

  memberTextCompact: {
    fontSize: 12,
    lineHeight: 16,
  },

  regionText: {
    marginTop: 4,
    fontSize: 12,
    color: '#666',
    fontWeight: '700',
  },

  regionTextCompact: {
    fontSize: 11,
  },

  settingsBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff7f2',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    flexShrink: 0,
  },

  settingsBtnCompact: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },

  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 18,
    gap: 10,
  },

  statsRowCompact: {
    gap: 8,
    marginTop: 14,
  },

  signInActions: {
    marginTop: 14,
    width: '100%',
    gap: 10,
  },

  signInActionsCompact: {
    marginTop: 12,
    gap: 8,
  },

  googleSignInButton: {
    minHeight: 54,
    width: '100%',
    backgroundColor: '#34A853',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#34A853',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  googleSignInButtonCompact: {
    minHeight: 48,
    borderRadius: 16,
    paddingHorizontal: 10,
  },

  googleSignInIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },

  googleSignInIconWrapCompact: {
    width: 26,
    height: 26,
    borderRadius: 13,
    marginRight: 8,
  },

  googleSignInIcon: {
    width: 20,
    height: 20,
  },

  googleSignInIconCompact: {
    width: 18,
    height: 18,
  },

  googleSignInButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
    flexShrink: 1,
  },

  googleSignInButtonTextCompact: {
    fontSize: 14,
  },

  facebookSignInButton: {
    minHeight: 54,
    width: '100%',
    backgroundColor: '#1877F2',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1877F2',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  facebookSignInButtonCompact: {
    minHeight: 48,
    borderRadius: 16,
    paddingHorizontal: 10,
  },

  facebookSignInIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },

  facebookSignInIconWrapCompact: {
    width: 26,
    height: 26,
    borderRadius: 13,
    marginRight: 8,
  },

  facebookSignInIconText: {
    color: '#1877F2',
    fontSize: 22,
    lineHeight: 24,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif',
    marginTop: Platform.OS === 'ios' ? 1 : 0,
  },

  facebookSignInButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
    flexShrink: 1,
  },

  facebookSignInButtonTextCompact: {
    fontSize: 14,
  },

  shopSignInButton: {
    minHeight: 54,
    width: '100%',
    backgroundColor: '#5433EB',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#5433EB',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  shopSignInButtonCompact: {
    minHeight: 48,
    borderRadius: 16,
    paddingHorizontal: 10,
  },

  shopSignInIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },

  shopSignInIconWrapCompact: {
    width: 26,
    height: 26,
    borderRadius: 7,
    marginRight: 8,
  },

  shopSignInButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
    flexShrink: 1,
  },

  shopSignInButtonTextCompact: {
    fontSize: 14,
  },

  statCard: {
    flex: 1,
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    minHeight: 84,
    justifyContent: 'center',
  },

  statCardCompact: {
    borderRadius: 16,
    minHeight: 72,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },

  statValue: {
    fontSize: 15,
    fontWeight: '900',
    color: '#ff6a00',
    textAlign: 'center',
    paddingHorizontal: 4,
  },

  statValueCompact: {
    fontSize: 13,
  },

  statLabel: {
    marginTop: 4,
    fontSize: 12,
    color: '#666',
    fontWeight: '700',
  },

  statLabelCompact: {
    fontSize: 11,
  },

  demoRewardCard: {
    marginTop: 14,
    backgroundColor: '#5c31ff',
    borderRadius: 22,
    paddingVertical: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#7b57ff',
  },

  demoRewardTextWrap: {
    flex: 1,
    paddingRight: 10,
  },

  demoRewardTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '900',
  },

  demoRewardSubtitle: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },

  demoRewardBtn: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },

  demoRewardBtnText: {
    color: '#5c31ff',
    fontWeight: '900',
    fontSize: 14,
  },

  promoCard: {
    marginTop: 14,
    backgroundColor: '#ff6a00',
    borderRadius: 22,
    paddingVertical: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.16,
    shadowRadius: 10,
    elevation: 4,
  },

  promoTextWrap: {
    flex: 1,
    paddingRight: 10,
  },

  promoTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },

  promoSubtitle: {
    color: '#fff4ec',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },

  promoBtn: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },

  promoBtnText: {
    color: '#ff6a00',
    fontWeight: '900',
    fontSize: 14,
  },

  walletSection: {
    marginTop: 14,
    backgroundColor: '#fff',
    borderRadius: 22,
    paddingTop: 14,
    paddingBottom: 6,
    borderWidth: 1,
    borderColor: '#ffe9dd',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },

  walletRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#f3f3f3',
  },

  walletLeft: {
    flex: 1,
    paddingRight: 10,
  },

  walletNote: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111',
  },

  walletDate: {
    fontSize: 12,
    color: '#888',
    marginTop: 3,
  },

  walletAmount: {
    fontSize: 16,
    fontWeight: '900',
  },

  sectionFooterBtn: {
    marginTop: 6,
    marginHorizontal: 14,
    marginBottom: 10,
    backgroundColor: '#fff7f2',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },

  sectionFooterBtnText: {
    color: '#ff6a00',
    fontWeight: '900',
    fontSize: 14,
  },

  menuCard: {
    marginTop: 14,
    backgroundColor: '#fff',
    borderRadius: 22,
    paddingTop: 14,
    paddingBottom: 4,
    borderWidth: 1,
    borderColor: '#ffe9dd',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },

  sectionTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    paddingHorizontal: 14,
    marginBottom: 8,
  },

  sectionTitleNoPad: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
  },

  menuRow: {
    minHeight: 72,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  menuLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },

  menuTextWrap: {
    flex: 1,
    paddingRight: 10,
  },

  menuIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },

  menuTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
  },

  menuSubtitle: {
    marginTop: 3,
    fontSize: 12,
    color: '#7a7a7a',
    fontWeight: '600',
  },

  quickCard: {
    marginTop: 14,
    backgroundColor: '#fff',
    borderRadius: 22,
    paddingTop: 14,
    paddingBottom: 16,
    borderWidth: 1,
    borderColor: '#ffe9dd',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },

  quickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 10,
  },

  quickItem: {
    flex: 1,
    minWidth: 0,
  },

  quickMiniCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    minHeight: 108,
  },

  quickIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },

  quickText: {
    marginTop: 8,
    fontSize: 12,
    color: '#111',
    fontWeight: '900',
    textAlign: 'center',
  },

  quickSubtitle: {
    marginTop: 3,
    fontSize: 10,
    color: '#8a7a70',
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 13,
    paddingHorizontal: 2,
  },

  infoBar: {
    marginTop: 14,
    backgroundColor: '#fff0e7',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#ffe1d1',
  },

  infoText: {
    flex: 1,
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '900',
  },

  infoLinkText: {
    color: '#8d5a2b',
    fontSize: 12,
    fontWeight: '800',
  },

  cachedRecommendationsText: {
    marginBottom: 8,
    paddingHorizontal: 2,
    fontSize: 12,
    color: '#8d7a6f',
    fontWeight: '700',
  },

  productsSection: {
    marginTop: 16,
  },

  productsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingHorizontal: 2,
  },

  viewAllText: {
    color: '#ff6a00',
    fontWeight: '800',
    fontSize: 14,
  },

  emptyProductsWrap: {
    paddingVertical: 24,
    alignItems: 'center',
    paddingHorizontal: 12,
  },

  emptyProductsText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 20,
  },

  retryRecommendationsBtn: {
    marginTop: 12,
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
  },

  retryRecommendationsText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '900',
  },

  skeletonBlock: {
    backgroundColor: '#f1e4d8',
  },

  skeletonLine: {
    height: 12,
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

  skeletonLinePrice: {
    width: 72,
    marginBottom: 0,
  },

  productsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },

  productCard: {
    width: '48.5%',
    backgroundColor: '#fff',
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#ffe9dd',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
    marginBottom: 12,
  },

  productImage: {
    width: '100%',
    height: 148,
    backgroundColor: '#eee',
  },

  productBody: {
    padding: 10,
  },

  productTitle: {
    fontSize: 13,
    color: '#333',
    fontWeight: '700',
    minHeight: 34,
  },

  productBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },

  productPrice: {
    fontSize: 16,
    fontWeight: '900',
    color: '#111',
    flex: 1,
    paddingRight: 8,
  },

  smallCartBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffd9c6',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
