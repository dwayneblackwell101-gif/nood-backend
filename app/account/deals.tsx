import React, { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import NoodSpinner from '../../components/NoodSpinner';
import { useCart } from '../../context/CartContext';
import { useUser } from '../../context/UserContext';
import { BASE_CURRENCY } from '../../utils/currency';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { noodAlert } from '../../utils/nood-alert';
import {
  fetchShopifyDiscounts,
  formatDiscountExpiry,
  getShippingOfferCopy,
  type NoodDiscount,
} from '../../utils/shopify-discounts';

const NOOD_LOGO_SOURCE = require('../../assets/images/nood-brand-logo.png');

type BadgeTone = 'automatic' | 'coupon' | 'wallet' | 'shipping' | 'active' | 'expired';

function DealBadge({ label, tone }: { label: string; tone: BadgeTone }) {
  const palette = {
    automatic: { bg: '#fff7f2', border: '#ffd9c6', text: '#b35a12' },
    coupon: { bg: '#fff7f2', border: '#ffd9c6', text: '#b35a12' },
    wallet: { bg: '#f8f5ff', border: '#e4dcff', text: '#5c31ff' },
    shipping: { bg: '#f3f8ff', border: '#d7e7ff', text: '#2563eb' },
    active: { bg: '#eefaf3', border: '#c9efd8', text: '#2f9d63' },
    expired: { bg: '#fff5f5', border: '#ffd0cc', text: '#d64545' },
  }[tone];

  return (
    <View style={[styles.badge, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <Text style={[styles.badgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

function SectionHeader({
  title,
  subtitle,
  icon,
  iconColor,
}: {
  title: string;
  subtitle: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionIconWrap, { backgroundColor: `${iconColor}14` }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={styles.sectionHeaderText}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

function DiscountCard({
  discount,
  showCode = false,
  onCopyCode,
  onApply,
}: {
  discount: NoodDiscount;
  showCode?: boolean;
  onCopyCode?: (code: string) => void;
  onApply?: (code: string) => void;
}) {
  const tone: BadgeTone =
    discount.kind === 'free_shipping'
      ? 'shipping'
      : discount.appliesAutomatically
        ? 'automatic'
        : 'coupon';

  return (
    <View style={styles.dealCard}>
      <View style={styles.dealCardTop}>
        <View style={[styles.dealIconWrap, { backgroundColor: '#fff7f2' }]}>
          <Ionicons
            name={
              discount.kind === 'free_shipping'
                ? 'airplane-outline'
                : discount.appliesAutomatically
                  ? 'flash-outline'
                  : 'ticket-outline'
            }
            size={20}
            color="#ff6a00"
          />
        </View>

        <View style={styles.dealCardBody}>
          <View style={styles.dealTitleRow}>
            <Text style={styles.dealTitle}>{discount.title}</Text>
            <DealBadge
              label={discount.appliesAutomatically ? 'Automatic' : 'Coupon'}
              tone={tone}
            />
          </View>

          <Text style={styles.dealValue}>{discount.valueLabel}</Text>

          {discount.appliesAutomatically ? (
            <Text style={styles.dealSummary}>Applied automatically at checkout</Text>
          ) : null}

          {discount.summary ? <Text style={styles.dealSummary}>{discount.summary}</Text> : null}

          {discount.minimumRequirement ? (
            <Text style={styles.dealMeta}>{discount.minimumRequirement}</Text>
          ) : null}

          <Text style={styles.dealMeta}>{formatDiscountExpiry(discount.endsAt)}</Text>

          {showCode && discount.code ? (
            <View style={styles.codeBadge}>
              <Text style={styles.codeBadgeText}>{discount.code}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {showCode && discount.code ? (
        <View style={styles.dealActions}>
          <TouchableOpacity
            style={styles.secondaryActionBtn}
            activeOpacity={0.88}
            onPress={() => onCopyCode?.(discount.code || '')}
          >
            <Ionicons name="copy-outline" size={16} color="#ff6a00" />
            <Text style={styles.secondaryActionText}>Copy code</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.primaryActionBtn}
            activeOpacity={0.88}
            onPress={() => onApply?.(discount.code || '')}
          >
            <Text style={styles.primaryActionText}>Apply in cart</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function WalletRewardsCard({
  isSignedIn,
  hasBalance,
  balanceLabel,
  onOpenWallet,
  onSignIn,
}: {
  isSignedIn: boolean;
  hasBalance: boolean;
  balanceLabel: string;
  onOpenWallet: () => void;
  onSignIn: () => void;
}) {
  return (
    <View style={styles.walletCard}>
      <View style={styles.walletTop}>
        <View style={styles.walletIconWrap}>
          <Ionicons name="wallet-outline" size={22} color="#5c31ff" />
        </View>
        <View style={styles.walletTextWrap}>
          <View style={styles.dealTitleRow}>
            <Text style={styles.dealTitle}>NOOD Balance</Text>
            <DealBadge label="Wallet" tone="wallet" />
          </View>

          {isSignedIn && hasBalance ? (
            <>
              <Text style={styles.walletValue}>Use NOOD Balance</Text>
              <Text style={styles.walletSubtitle}>You have {balanceLabel} available</Text>
              <Text style={styles.walletHint}>
                Wallet balance is applied through checkout wallet payment, not as a coupon code.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.walletValue}>
                {isSignedIn ? 'No balance available yet' : 'Sign in or top up to use wallet balance'}
              </Text>
              <Text style={styles.walletSubtitle}>
                {isSignedIn
                  ? 'Top up your wallet to use balance at checkout.'
                  : 'Sign in to view your wallet and use balance on eligible orders.'}
              </Text>
            </>
          )}
        </View>
      </View>

      <TouchableOpacity
        style={styles.walletBtn}
        activeOpacity={0.9}
        onPress={isSignedIn ? onOpenWallet : onSignIn}
      >
        <Text style={styles.walletBtnText}>
          {isSignedIn ? (hasBalance ? 'Use at checkout' : 'Top up wallet') : 'Go to sign in'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function EmptyDiscountsCard() {
  return (
    <View style={styles.emptyCard}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="pricetag-outline" size={28} color="#ff6a00" />
      </View>
      <Text style={styles.emptyTitle}>No active coupons right now</Text>
      <Text style={styles.emptySubtitle}>
        Automatic savings and wallet rewards will appear here when available.
      </Text>
    </View>
  );
}

export default function DealsScreen() {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const {
    balance = 0,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = useCart();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [discountsLoaded, setDiscountsLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadErrorCode, setLoadErrorCode] = useState('');
  const [automaticDeals, setAutomaticDeals] = useState<NoodDiscount[]>([]);
  const [couponDeals, setCouponDeals] = useState<NoodDiscount[]>([]);
  const [shippingDeals, setShippingDeals] = useState<NoodDiscount[]>([]);

  const displayBalance = formatMoney(
    convertPrice(Number(balance || 0), BASE_CURRENCY, selectedCurrency),
    selectedCurrency
  );
  const hasWalletBalance = isSignedIn && Number(balance || 0) > 0;

  const loadDiscounts = useCallback(async (options?: { refresh?: boolean; silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }

    try {
      const response = await fetchShopifyDiscounts({ refresh: options?.refresh });
      setAutomaticDeals(response.automatic.filter((entry) => entry.isActive));
      setCouponDeals(response.coupons.filter((entry) => entry.isActive && entry.code));
      setShippingDeals(response.shipping.filter((entry) => entry.isActive));
      setLoadError(response.success ? '' : response.message || 'Could not load Shopify discounts.');
      setLoadErrorCode(response.success ? '' : response.code || '');
      setDiscountsLoaded(response.success);
    } catch (error) {
      console.log('Deals screen load error:', error);
      setAutomaticDeals([]);
      setCouponDeals([]);
      setShippingDeals([]);
      setLoadError('Could not load Shopify discounts.');
      setLoadErrorCode('');
      setDiscountsLoaded(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadDiscounts();
    }, [loadDiscounts])
  );

  const hasShopifyDiscounts = useMemo(
    () => automaticDeals.length > 0 || couponDeals.length > 0 || shippingDeals.length > 0,
    [automaticDeals.length, couponDeals.length, shippingDeals.length]
  );

  const shopifyNotice = useMemo(() => {
    if (loadErrorCode === 'SHOPIFY_DISCOUNTS_SCOPE_REQUIRED') {
      return 'Shopify discounts are not available yet because the backend token needs the read_discounts scope.';
    }

    if (loadErrorCode === 'SHOPIFY_DISCOUNTS_NOT_CONFIGURED') {
      return 'Shopify discount sync is not configured on the backend yet.';
    }

    if (loadError) {
      return 'Live Shopify discounts are unavailable right now. Wallet rewards still reflect your real balance.';
    }

    return '';
  }, [loadError, loadErrorCode]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void loadDiscounts({ refresh: true, silent: true });
  }, [loadDiscounts]);

  const handleCopyCode = useCallback(async (code: string) => {
    const copied = await copyToClipboard(code);
    if (copied) {
      noodAlert('Code copied', `${code} is ready to paste at checkout.`);
      return;
    }

    noodAlert('Copy code', code);
  }, []);

  const handleApplyInCart = useCallback(
    async (code: string) => {
      const copied = await copyToClipboard(code);
      router.push('/(tabs)/cart' as any);

      if (copied) {
        noodAlert(
          'Coupon copied',
          `${code} was copied. Enter it during checkout when discount codes are supported.`
        );
        return;
      }

      noodAlert('Apply in cart', `${code} — enter this code during checkout.`);
    },
    [router]
  );

  const openWallet = useCallback(() => {
    router.push('/account/wallet' as any);
  }, [router]);

  const goToSignIn = useCallback(() => {
    router.replace('/(tabs)/account' as any);
  }, [router]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Deals</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#ff6a00"
            colors={['#ff6a00']}
          />
        }
      >
        <View style={styles.heroShell}>
          <LinearGradient
            colors={['#fff4ea', '#fff9f3', '#f8f5ff']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroGradient}
          >
            <View style={styles.heroWatermarkWrap} pointerEvents="none">
              <Image source={NOOD_LOGO_SOURCE} style={styles.heroWatermark} resizeMode="contain" />
            </View>

            <View style={styles.heroContent}>
              <View style={styles.heroAccentDot} />
              <Text style={styles.heroTitle}>NOOD Deals Hub</Text>
              <Text style={styles.heroSubtitle}>
                Your available coupons, automatic discounts, wallet rewards, and free shipping offers.
              </Text>

              {discountsLoaded ? (
                <View style={styles.liveBadge}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveBadgeText}>Live from Shopify</Text>
                </View>
              ) : null}
            </View>
          </LinearGradient>
        </View>

        {loading ? (
          <View style={styles.loadingCard}>
            <NoodSpinner size={42} />
            <Text style={styles.loadingText}>Loading live Shopify discounts...</Text>
          </View>
        ) : null}

        {!loading && shopifyNotice ? (
          <View style={styles.noticeCard}>
            <Ionicons name="cloud-offline-outline" size={18} color="#b35a12" />
            <Text style={styles.noticeText}>{shopifyNotice}</Text>
          </View>
        ) : null}

        <View style={styles.sectionBlock}>
          <SectionHeader
            title="Automatic deals"
            subtitle="Savings that apply automatically at checkout"
            icon="flash-outline"
            iconColor="#ff6a00"
          />

          {automaticDeals.map((discount) => (
            <DiscountCard key={discount.id} discount={discount} />
          ))}

          {!loading && automaticDeals.length === 0 ? (
            <Text style={styles.sectionEmptyText}>No automatic Shopify discounts are active right now.</Text>
          ) : null}
        </View>

        <View style={styles.sectionDivider} />

        <View style={styles.sectionBlock}>
          <SectionHeader
            title="Coupons"
            subtitle="Discount codes you can copy and use at checkout"
            icon="ticket-outline"
            iconColor="#ff6a00"
          />

          {couponDeals.map((discount) => (
            <DiscountCard
              key={discount.id}
              discount={discount}
              showCode
              onCopyCode={(code) => void handleCopyCode(code)}
              onApply={(code) => void handleApplyInCart(code)}
            />
          ))}

          {!loading && couponDeals.length === 0 ? (
            <Text style={styles.sectionEmptyText}>No active coupon codes from Shopify right now.</Text>
          ) : null}
        </View>

        <View style={styles.sectionDivider} />

        <View style={styles.sectionBlock}>
          <SectionHeader
            title="Wallet rewards"
            subtitle="Real NOOD Balance available at checkout"
            icon="wallet-outline"
            iconColor="#5c31ff"
          />

          <WalletRewardsCard
            isSignedIn={isSignedIn}
            hasBalance={hasWalletBalance}
            balanceLabel={displayBalance}
            onOpenWallet={openWallet}
            onSignIn={goToSignIn}
          />
        </View>

        <View style={styles.sectionDivider} />

        <View style={styles.sectionBlock}>
          <SectionHeader
            title="Shipping offers"
            subtitle="Free or reduced shipping from Shopify when available"
            icon="airplane-outline"
            iconColor="#2563eb"
          />

          {shippingDeals.map((discount) => (
            <View key={discount.id} style={styles.dealCard}>
              <View style={styles.dealCardTop}>
                <View style={[styles.dealIconWrap, { backgroundColor: '#f3f8ff' }]}>
                  <Ionicons name="airplane-outline" size={20} color="#2563eb" />
                </View>
                <View style={styles.dealCardBody}>
                  <View style={styles.dealTitleRow}>
                    <Text style={styles.dealTitle}>{discount.title || 'Free Shipping'}</Text>
                    <DealBadge label="Shipping" tone="shipping" />
                  </View>
                  <Text style={styles.dealValue}>{discount.valueLabel}</Text>
                  <Text style={styles.dealSummary}>{getShippingOfferCopy(discount)}</Text>
                  <Text style={styles.dealMeta}>{formatDiscountExpiry(discount.endsAt)}</Text>
                  {discount.code ? (
                    <View style={styles.codeBadge}>
                      <Text style={styles.codeBadgeText}>{discount.code}</Text>
                    </View>
                  ) : null}
                </View>
              </View>

              {discount.code ? (
                <View style={styles.dealActions}>
                  <TouchableOpacity
                    style={styles.secondaryActionBtn}
                    activeOpacity={0.88}
                    onPress={() => void handleCopyCode(discount.code || '')}
                  >
                    <Ionicons name="copy-outline" size={16} color="#ff6a00" />
                    <Text style={styles.secondaryActionText}>Copy code</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ))}

          {!loading && shippingDeals.length === 0 ? (
            <Text style={styles.sectionEmptyText}>
              No active free shipping offers from Shopify right now.
            </Text>
          ) : null}
        </View>

        {!loading && !hasShopifyDiscounts ? <EmptyDiscountsCard /> : null}

        <TouchableOpacity
          style={styles.shopCta}
          activeOpacity={0.9}
          onPress={() => router.push('/(tabs)/categories' as any)}
        >
          <Ionicons name="bag-handle-outline" size={18} color="#ff6a00" />
          <Text style={styles.shopCtaText}>Shop now and save at checkout</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
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
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },
  headerSpacer: {
    width: 42,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  heroShell: {
    borderRadius: 26,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginBottom: 16,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 10px 28px rgba(255, 106, 0, 0.1)' }
      : {
          shadowColor: '#ff6a00',
          shadowOpacity: 0.1,
          shadowRadius: 14,
          elevation: 3,
        }),
  },
  heroGradient: {
    minHeight: 148,
    position: 'relative',
  },
  heroWatermarkWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroWatermark: {
    width: 150,
    height: 96,
    opacity: 0.05,
  },
  heroContent: {
    padding: 20,
    position: 'relative',
    zIndex: 2,
  },
  heroAccentDot: {
    width: 42,
    height: 5,
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    marginBottom: 12,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  heroSubtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    fontWeight: '600',
    maxWidth: 320,
  },
  liveBadge: {
    marginTop: 14,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#c9efd8',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#2f9d63',
  },
  liveBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#2f9d63',
  },
  loadingCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 24,
    alignItems: 'center',
    marginBottom: 14,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
    fontWeight: '700',
  },
  noticeCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffd9c6',
    padding: 14,
    marginBottom: 14,
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: '#6f5a4e',
    fontWeight: '600',
  },
  sectionBlock: {
    gap: 10,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: '#f1e4da',
    marginVertical: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  sectionIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionHeaderText: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
  },
  sectionSubtitle: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    color: '#666',
    fontWeight: '600',
  },
  sectionEmptyText: {
    fontSize: 13,
    lineHeight: 19,
    color: '#8d7a6f',
    fontWeight: '600',
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 14,
  },
  dealCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 14,
  },
  dealCardTop: {
    flexDirection: 'row',
    gap: 12,
  },
  dealIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  dealCardBody: {
    flex: 1,
    minWidth: 0,
  },
  dealTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  dealTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
  },
  dealValue: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: '800',
    color: '#ff6a00',
  },
  dealSummary: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    color: '#666',
    fontWeight: '600',
  },
  dealMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#8d7a6f',
    fontWeight: '600',
  },
  badge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  codeBadge: {
    alignSelf: 'flex-start',
    marginTop: 10,
    backgroundColor: '#fff7f2',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ffd9c6',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  codeBadgeText: {
    fontSize: 14,
    fontWeight: '900',
    color: '#4e260d',
    letterSpacing: 0.6,
  },
  dealActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  secondaryActionBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    backgroundColor: '#fff7f2',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  secondaryActionText: {
    color: '#ff6a00',
    fontSize: 13,
    fontWeight: '800',
  },
  primaryActionBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
  walletCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e4dcff',
    padding: 14,
  },
  walletTop: {
    flexDirection: 'row',
    gap: 12,
  },
  walletIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#f8f5ff',
    borderWidth: 1,
    borderColor: '#e4dcff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  walletValue: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: '800',
    color: '#5c31ff',
  },
  walletSubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    color: '#666',
    fontWeight: '600',
  },
  walletHint: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 17,
    color: '#8d7a6f',
    fontWeight: '600',
  },
  walletBtn: {
    marginTop: 14,
    minHeight: 44,
    borderRadius: 14,
    backgroundColor: '#5c31ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  emptyCard: {
    marginTop: 4,
    backgroundColor: '#fff',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 24,
    alignItems: 'center',
  },
  emptyIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    marginTop: 14,
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
  },
  emptySubtitle: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 20,
    color: '#666',
    textAlign: 'center',
    fontWeight: '600',
    maxWidth: 300,
  },
  shopCta: {
    marginTop: 16,
    backgroundColor: '#fff0e7',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ffe1d1',
    gap: 8,
  },
  shopCtaText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '800',
  },
});