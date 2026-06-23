import React, { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCart } from '../../context/CartContext';
import { useUser } from '../../context/UserContext';
import { useUpdates } from '../../context/UpdatesContext';
import NoodSpinner from '../../components/NoodSpinner';
import { BASE_CURRENCY } from '../../utils/currency';
import { catalogFetch } from '../../utils/catalog';

const GOOGLE_LOGO_URL =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/2a5758d6-4edb-4047-87bb-e6b94dbbbab0-cover.png?v=1781936734';

type RowIconName = React.ComponentProps<typeof Ionicons>['name'];

type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  image: string;
  priceAmount: number;
  currencyCode: string;
};

let accountScrollOffsetSnapshot = 0;
let accountRecommendedProductsSnapshot: ShopifyProduct[] = [];
const ACCOUNT_RECOMMENDATIONS_CACHE_KEY = 'NOOD_ACCOUNT_RECOMMENDATIONS_CACHE_V1';

const ACCOUNT_PRODUCTS_QUERY = `
  query GetAccountRecommendedProducts($first: Int!) {
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
              currencyCode
            }
          }
        }
      }
    }
  }
`;

function MenuRow({
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
}

function QuickAction({
  icon,
  label,
  onPress,
}: {
  icon: RowIconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.quickItem} activeOpacity={0.88} onPress={onPress}>
      <View style={styles.quickIconWrap}>
        <Ionicons name={icon} size={22} color="#ff6a00" />
      </View>
      <Text style={styles.quickText}>{label}</Text>
    </TouchableOpacity>
  );
}

function ProductCard({
  image,
  title,
  price,
  onPress,
}: {
  image: string;
  title: string;
  price: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.productCard} activeOpacity={0.9} onPress={onPress}>
      <Image source={{ uri: image }} style={styles.productImage} resizeMode="cover" />

      <View style={styles.productBody}>
        <Text numberOfLines={2} style={styles.productTitle}>
          {title}
        </Text>

        <View style={styles.ratingRow}>
          <Text style={styles.stars}>★★★★★</Text>
          <Text style={styles.soldLabel}>Store pick</Text>
        </View>

        <View style={styles.productBottomRow}>
          <Text style={styles.productPrice}>{price}</Text>

          <View style={styles.smallCartBtn}>
            <Ionicons name="cart-outline" size={18} color="#ff6a00" />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function AccountScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { settings, isReady, isSignedIn, displayName } = useUser();
  const { unreadCount } = useUpdates();
  const isCompact = width < 430;

  const {
    balanceConverted = 0,
    walletHistory = [],
    orders = [],
    selectedCurrency = settings?.currency || BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = (useCart() as any) || {};

  const [recommendedProducts, setRecommendedProducts] = useState<ShopifyProduct[]>(
    () => accountRecommendedProductsSnapshot
  );
  const [loadingProducts, setLoadingProducts] = useState(!accountRecommendedProductsSnapshot.length);
  const scrollRef = useRef<ScrollView | null>(null);
  const restoredScrollRef = useRef(false);

  const currentCurrency = selectedCurrency || settings?.currency || BASE_CURRENCY;
  const shownName = isSignedIn ? displayName || 'NOOD Shopper' : 'Guest';
  const memberLabel = isSignedIn ? 'NOOD Member' : 'Sign in to view your customer account';

  useEffect(() => {
    const mapAccountProducts = (edges: any[]): ShopifyProduct[] =>
      (edges || []).map((edge: any) => ({
        id: String(edge?.node?.id),
        title: edge?.node?.title || 'Untitled Product',
        handle: edge?.node?.handle || '',
        image:
          edge?.node?.featuredImage?.url ||
          'https://via.placeholder.com/600x600.png?text=No+Image',
        priceAmount: Number(edge?.node?.priceRange?.minVariantPrice?.amount || 0),
        currencyCode:
          edge?.node?.priceRange?.minVariantPrice?.currencyCode || BASE_CURRENCY,
      }));

    const loadProducts = async () => {
      let showedCache = accountRecommendedProductsSnapshot.length > 0;

      if (showedCache) {
        setRecommendedProducts(accountRecommendedProductsSnapshot);
        setLoadingProducts(false);
      } else {
        try {
          const cachedRaw = await AsyncStorage.getItem(ACCOUNT_RECOMMENDATIONS_CACHE_KEY);
          if (cachedRaw) {
            const parsed = JSON.parse(cachedRaw) as { products?: ShopifyProduct[] };
            if (Array.isArray(parsed.products) && parsed.products.length) {
              setRecommendedProducts(parsed.products);
              setLoadingProducts(false);
              showedCache = true;
            }
          }
        } catch (error) {
          console.log('Account recommendations cache read error:', error);
        }
      }

      try {
        const json = await catalogFetch(ACCOUNT_PRODUCTS_QUERY, { first: 4 });
        const mapped = mapAccountProducts(json?.data?.products?.edges || []);

        accountRecommendedProductsSnapshot = mapped;
        setRecommendedProducts(mapped);
        await AsyncStorage.setItem(
          ACCOUNT_RECOMMENDATIONS_CACHE_KEY,
          JSON.stringify({
            products: mapped,
            savedAt: new Date().toISOString(),
          })
        );
      } catch (error) {
        console.log('Account recommended products error:', error);
        if (!showedCache) {
          setRecommendedProducts([]);
        }
      } finally {
        setLoadingProducts(false);
      }
    };

    loadProducts();
  }, []);

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

  const ordersCount = Array.isArray(orders) ? orders.length : 0;
  const offersCount = useMemo(() => 5, []);

  const recentWalletHistory = useMemo(() => {
    if (!Array.isArray(walletHistory)) return [];
    return walletHistory.slice(0, 5);
  }, [walletHistory]);

  const goToProduct = (handle: string) => {
    if (!handle) return;

    router.push({
      pathname: '/product/[handle]',
      params: { handle, from: 'account' },
    });
  };

  const getWalletDisplay = (item: any) => {
    const type = String(item?.type || '').toLowerCase();
    const amount = Math.abs(Number(item?.amount || 0));

    const isPositive = type === 'credit' || type === 'refund';
    const color = isPositive ? '#5c31ff' : '#ff3b30';
    const sign = isPositive ? '+' : '-';

    return {
      color,
      sign,
      amount,
    };
  };

  const displayMoney = (amount: number, fromCurrency = BASE_CURRENCY) =>
    formatMoney(
      convertPrice(Number(amount || 0), fromCurrency || BASE_CURRENCY, currentCurrency),
      currentCurrency
    );

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scrollContent, isCompact && styles.scrollContentCompact]}
        scrollEventThrottle={16}
        onScroll={(event) => {
          accountScrollOffsetSnapshot = event.nativeEvent.contentOffset.y;
        }}
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
            <NoodSpinner size={58} />
          </View>
        ) : (
        <View style={[styles.heroCard, isCompact && styles.heroCardCompact]}>
          <View style={[styles.heroGlow, isCompact && styles.heroGlowCompact]} />

          <View style={styles.heroTopRow}>
            <View style={[styles.googleAvatar, isCompact && styles.googleAvatarCompact]}>
              <Image
                source={{ uri: GOOGLE_LOGO_URL }}
                style={[styles.googleAvatarLogo, isCompact && styles.googleAvatarLogoCompact]}
                resizeMode="contain"
              />
            </View>

            <View style={[styles.heroTextWrap, isCompact && styles.heroTextWrapCompact]}>
              <Text style={[styles.name, isCompact && styles.nameCompact]}>{shownName}</Text>
              <Text
                style={[styles.memberText, isCompact && styles.memberTextCompact]}
                numberOfLines={2}
              >
                {memberLabel}
              </Text>
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
              onPress={() => router.push('/account/deals' as any)}
            >
              <Text style={[styles.statValue, isCompact && styles.statValueCompact]}>{offersCount}</Text>
              <Text style={[styles.statLabel, isCompact && styles.statLabelCompact]}>Offers</Text>
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

          {!isSignedIn ? (
            <View style={[styles.signInActions, isCompact && styles.signInActionsCompact]}>
              <TouchableOpacity
                style={[styles.googleSignInButton, isCompact && styles.googleSignInButtonCompact]}
                activeOpacity={0.9}
                onPress={() =>
                  router.push({
                    pathname: '/account/auth',
                    params: { provider: 'google' },
                  } as any)
                }
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
                style={[styles.signInButton, isCompact && styles.signInButtonCompact]}
                activeOpacity={0.9}
                onPress={() => router.push('/account/auth' as any)}
              >
                <Ionicons name="log-in-outline" size={18} color="#fff" />
                <Text style={[styles.signInButtonText, isCompact && styles.signInButtonTextCompact]}>
                  Sign in
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
        )}

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
                <View
                  key={item?.id ? String(item.id) : `wallet-${index}`}
                  style={styles.walletRow}
                >
                  <View style={styles.walletLeft}>
                    <Text style={styles.walletNote}>
                      {item?.note || 'Wallet update'}
                    </Text>
                    <Text style={styles.walletDate}>
                      {item?.createdAt
                        ? new Date(item.createdAt).toLocaleDateString()
                        : 'Recent'}
                    </Text>
                  </View>

                  <Text
                    style={[
                      styles.walletAmount,
                      { color: walletDisplay.color },
                    ]}
                  >
                    {walletDisplay.sign}
                    {displayMoney(walletDisplay.amount)}
                  </Text>
                </View>
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

        <View style={styles.menuCard}>
          <Text style={styles.sectionTitle}>Your account</Text>

          <MenuRow
            icon="notifications-outline"
            title="Updates"
            subtitle={unreadCount > 0 ? `${unreadCount} unread updates` : 'Deals, rewards, shipping, and app news'}
            onPress={() => router.push('/account/updates' as any)}
          />
          <MenuRow
            icon="receipt-outline"
            title="Orders"
            subtitle="Track and manage purchases"
            onPress={() => router.push('/account/orders' as any)}
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
              onPress={() => router.push('/account/history' as any)}
            />
            <QuickAction
              icon="location-outline"
              label="Address"
              onPress={() => router.push('/account/address' as any)}
            />
            <QuickAction
              icon="gift-outline"
              label="Rewards"
              onPress={() => router.push('/account/rewards' as any)}
            />
            <QuickAction
              icon="heart-outline"
              label="Saved"
              onPress={() => router.push('/account/saved' as any)}
            />
          </View>
        </View>

        <TouchableOpacity
          style={styles.infoBar}
          activeOpacity={0.9}
          onPress={() => router.push('/account/deals' as any)}
        >
          <Ionicons name="checkmark-circle" size={18} color="#ff6a00" />
          <Text style={styles.infoText}>Free Shipping</Text>
          <View style={styles.infoDot} />
          <Ionicons name="flash-outline" size={18} color="#ff6a00" />
          <Text style={styles.infoText}>Fast Checkout</Text>
        </TouchableOpacity>

        <View style={styles.productsSection}>
          <View style={styles.productsHeader}>
            <Text style={styles.sectionTitleNoPad}>Recommended</Text>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => router.push('/(tabs)/categories' as any)}
            >
              <Text style={styles.viewAllText}>View all</Text>
            </TouchableOpacity>
          </View>

          {loadingProducts ? (
            <View style={styles.productsLoadingWrap}>
              <NoodSpinner size={40} />
            </View>
          ) : recommendedProducts.length === 0 ? (
            <View style={styles.emptyProductsWrap}>
              <Text style={styles.emptyProductsText}>No products found</Text>
            </View>
          ) : (
            <View style={styles.productsGrid}>
              {recommendedProducts.map((product) => (
                <ProductCard
                  key={product.id}
                  image={product.image}
                  title={product.title}
                  price={displayMoney(product.priceAmount, product.currencyCode)}
                  onPress={() => goToProduct(product.handle)}
                />
              ))}
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
    height: 8,
  },

  logoWrap: {
    alignItems: 'center',
    paddingVertical: 10,
  },

  logo: {
    width: 110,
    height: 38,
  },

  logoCompact: {
    width: 86,
    height: 30,
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

  avatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 3,
  },

  avatarText: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '900',
  },

  googleAvatar: {
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
  },

  googleAvatarCompact: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },

  googleAvatarLogo: {
    width: 30,
    height: 30,
  },

  googleAvatarLogoCompact: {
    width: 26,
    height: 26,
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
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e8ded8',
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
    color: '#111',
    fontSize: 15,
    fontWeight: '900',
    flexShrink: 1,
  },

  googleSignInButtonTextCompact: {
    fontSize: 14,
  },

  signInButton: {
    minHeight: 52,
    width: '100%',
    backgroundColor: '#ff6a00',
    borderRadius: 18,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  signInButtonCompact: {
    minHeight: 50,
    borderRadius: 16,
  },

  signInButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
    marginLeft: 8,
  },

  signInButtonTextCompact: {
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
    justifyContent: 'space-around',
    marginTop: 6,
  },

  quickItem: {
    alignItems: 'center',
    width: '22%',
  },

  quickIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },

  quickText: {
    marginTop: 8,
    fontSize: 12,
    color: '#333',
    fontWeight: '700',
    textAlign: 'center',
  },

  infoBar: {
    marginTop: 14,
    backgroundColor: '#fff0e7',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ffe1d1',
  },

  infoText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '900',
    marginLeft: 6,
  },

  infoDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ffb184',
    marginHorizontal: 12,
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

  productsLoadingWrap: {
    paddingVertical: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },

  emptyProductsWrap: {
    paddingVertical: 24,
    alignItems: 'center',
  },

  emptyProductsText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600',
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
    height: 180,
    backgroundColor: '#eee',
  },

  productBody: {
    padding: 10,
  },

  productTitle: {
    fontSize: 13,
    color: '#333',
    fontWeight: '700',
    minHeight: 36,
  },

  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },

  stars: {
    fontSize: 13,
    color: '#111',
    letterSpacing: 1,
  },

  soldLabel: {
    marginLeft: 8,
    fontSize: 11,
    color: '#888',
    fontWeight: '700',
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
