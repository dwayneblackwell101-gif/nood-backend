import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  SafeAreaView,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCart } from '../context/CartContext';
import { useAddressBook } from '../context/AddressContext';
import { useHistoryEvents } from '../context/HistoryContext';
import { useUser } from '../context/UserContext';
import { postBackendJson } from '../utils/backend';
import { BASE_CURRENCY } from '../utils/currency';
import { getCheckoutCustomer, getPaymentTestingEmail } from '../utils/customer';

const COLORS = {
  bg: '#f6f3ef',
  card: '#ffffff',
  text: '#111111',
  muted: '#6b7280',
  line: '#ece7df',
  orange: '#ff8a00',
  orangeSoft: '#fff1df',
  red: '#ff3b30',
  green: '#5c31ff',
  blue: '#0070ba',
};

const WIPAY_LOGO =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/IMG_2415.jpg?v=1772139039';
const PAYPAL_LOGO =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/paypal-logo-symbol-icon-transparent-png-701751695036660okg9nooua3.png?v=1781243217';

type LoadingMethod = '' | 'wallet' | 'wipay' | 'paypal';

const isValidHttpsUrl = (value: unknown) => {
  const url = String(value || '').trim();
  return url.startsWith('https://');
};

export default function CheckoutScreen() {
  const router = useRouter();

  const {
    cartItems = [],
    cartSubtotalRaw = 0,
    spendWalletFunds,
    addWalletFunds,
    balanceConverted = 0,
    balanceFormatted = 'USD 0.00',
    addOrder,
    clearCart,
    selectedCurrency = 'USD',
    convertPrice,
    formatMoney,
  } = useCart();
  const { isSignedIn, displayName } = useUser();
  const { defaultAddress, loadingAddresses } = useAddressBook();
  const { addHistoryEvent } = useHistoryEvents();

  const [loadingMethod, setLoadingMethod] = useState<LoadingMethod>('');

  const total = useMemo(() => Number(cartSubtotalRaw || 0), [cartSubtotalRaw]);
  const walletBalance = useMemo(
    () => Number(balanceConverted || 0),
    [balanceConverted]
  );
  const enoughBalance = walletBalance >= total && total > 0;
  const hasItems = cartItems.length > 0;
  const hasCompleteAddress = Boolean(
    defaultAddress?.fullName?.trim() &&
      defaultAddress?.phone?.trim() &&
      defaultAddress?.address1?.trim() &&
      defaultAddress?.city?.trim() &&
      defaultAddress?.region?.trim()
  );

  const showMessage = (title: string, message: string) => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(`${title}\n\n${message}`);
      return;
    }
    Alert.alert(title, message);
  };

  const showActionMessage = (
    title: string,
    message: string,
    actionLabel: string,
    onAction: () => void
  ) => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(`${title}\n\n${message}`);
      onAction();
      return;
    }

    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: actionLabel, onPress: onAction },
    ]);
  };

  const getCartItemsMissingVariantIds = () =>
    cartItems.filter((item: any) => !String(item?.variantId || '').trim());

  const getCartItemsWithInvalidQuantityOrPrice = () =>
    cartItems.filter((item: any) => {
      const quantity = Number(item?.quantity);
      const price = Number(item?.price);
      return (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(price) ||
        price <= 0
      );
    });

  const ensureCheckoutReady = () => {
    if (!hasItems) {
      showMessage('Cart is empty', 'Add items before checking out.');
      return false;
    }

    const itemsMissingVariantIds = getCartItemsMissingVariantIds();
    if (itemsMissingVariantIds.length) {
      console.log('[NOOD checkout] blocked checkout missing Shopify variantId', itemsMissingVariantIds);
      showMessage(
        'Product needs to be re-added',
        'One or more cart items is missing its Shopify variant ID. Please remove it and add it again before checkout.'
      );
      return false;
    }

    const invalidItems = getCartItemsWithInvalidQuantityOrPrice();
    if (invalidItems.length) {
      console.log('[NOOD checkout] blocked checkout invalid quantity or price', invalidItems);
      showMessage(
        'Product needs to be re-added',
        'One or more cart items has an invalid quantity or price. Please remove it and add it again before checkout.'
      );
      return false;
    }

    if (loadingAddresses) {
      showMessage('Address loading', 'Please wait while your saved address is loading.');
      return false;
    }

    if (!hasCompleteAddress) {
      showActionMessage(
        'Shipping address required',
        'Please add your shipping address before checkout.',
        'Add address',
        () => router.push('/account/address' as any)
      );
      return false;
    }

    return true;
  };

  const buildCartPayload = () =>
    cartItems.map((item: any) => {
      const itemBaseCurrency = item?.baseCurrency || BASE_CURRENCY;
      const convertedUnitPrice = convertPrice(
        Number(item?.price || 0),
        itemBaseCurrency,
        selectedCurrency
      );

      return {
        title: item?.title || 'Product',
        productId: item?.productId ? String(item.productId) : '',
        quantity: Number(item?.quantity || 1),
        price: Number(convertedUnitPrice.toFixed(2)),
        currency: selectedCurrency,
        variantId: item?.variantId ? String(item.variantId) : '',
        image: item?.image || '',
        handle: item?.handle || '',
        variantTitle: item?.variantTitle || '',
      };
    });

  const checkoutCustomer = getCheckoutCustomer({ defaultAddress, displayName, isSignedIn });
  const paymentCustomerEmail = getPaymentTestingEmail(checkoutCustomer.email);

  const createLocalOrder = (
    paymentMethod: string,
    orderName?: string,
    shopifyOrderId?: string,
    paymentTransactionId?: string
  ) => {
    addOrder({
      id: orderName || shopifyOrderId || Date.now().toString(),
      date: new Date().toISOString(),
      total,
      currency: selectedCurrency,
      status: 'Paid',
      paymentMethod: orderName ? `${paymentMethod} (${orderName})` : paymentMethod,
      shopifyOrderId,
      shopifyOrderName: orderName,
      paymentTransactionId,
      shippingAddress: defaultAddress,
      items: cartItems,
    });

    clearCart();
  };

  const handleWalletPayment = async () => {
    if (loadingMethod) return;
    if (!ensureCheckoutReady()) return;

    if (!enoughBalance) {
      showMessage(
        'Not enough balance',
        `Wallet: ${formatMoney(walletBalance, selectedCurrency)}\nTotal: ${formatMoney(
          total,
          selectedCurrency
        )}`
      );
      return;
    }

    setLoadingMethod('wallet');
    console.log('[NOOD checkout] wallet cart line items before checkout', buildCartPayload());
    void addHistoryEvent({
      type: 'checkout',
      title: 'Wallet payment attempted',
      description: `Wallet checkout for ${formatMoney(total, selectedCurrency)}.`,
      amount: total,
      currency: selectedCurrency,
      status: 'attempted',
    });

    try {
      const paid = spendWalletFunds(total, 'Order payment');

      if (!paid) {
        showMessage('Payment failed', 'Could not charge wallet.');
        return;
      }

      const shopifyOrder = await postBackendJson(
        '/api/shopify/orders',
        {
          total: Number(total.toFixed(2)),
          currency: selectedCurrency,
          paymentMethod: 'NOOD Wallet',
          name: checkoutCustomer.name,
          email: paymentCustomerEmail,
          phone: checkoutCustomer.phone,
          cartItems: buildCartPayload(),
          shippingAddress: defaultAddress,
        },
        { timeoutMs: 45000 }
      );
      console.log('[NOOD checkout] wallet Shopify order response', shopifyOrder);

      const shopifyOrderId =
        shopifyOrder?.shopify_order_id ||
        shopifyOrder?.shopifyOrderId ||
        shopifyOrder?.shopifyOrder?.id ||
        shopifyOrder?.order?.id ||
        '';
      const shopifyOrderName =
        shopifyOrder?.shopify_order_name ||
        shopifyOrder?.shopifyOrderName ||
        shopifyOrder?.shopifyOrder?.name ||
        shopifyOrder?.order?.name ||
        '';

      if (!shopifyOrderId && !shopifyOrderName) {
        addWalletFunds(total, 'Wallet refund: Shopify order was not created');
        showMessage(
          'Order not completed',
          'Wallet was refunded because Shopify did not confirm the order. Please try again.'
        );
        return;
      }

      createLocalOrder('Wallet', shopifyOrderName, shopifyOrderId, 'NOOD Wallet');

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert('Success\n\nOrder placed successfully.');
        router.replace('/account/orders');
      } else {
        Alert.alert('Success', 'Order placed successfully.', [
          {
            text: 'View Orders',
            onPress: () => router.replace('/account/orders'),
          },
        ]);
      }
    } catch (error) {
      console.log('Wallet payment error:', error);
      showMessage('Error', 'Something went wrong.');
    } finally {
      setLoadingMethod('');
    }
  };

  const handleWiPayPayment = async () => {
    if (loadingMethod) return;
    if (!ensureCheckoutReady()) return;

    setLoadingMethod('wipay');
    const cartPayload = buildCartPayload();
    console.log('[NOOD checkout] WiPay cart line items before checkout', cartPayload);
    void addHistoryEvent({
      type: 'checkout',
      title: 'WiPay checkout started',
      description: `WiPay checkout for ${formatMoney(total, selectedCurrency)}.`,
      amount: total,
      currency: selectedCurrency,
      status: 'started',
    });

    try {
      const data = await postBackendJson('/create-wipay-payment', {
        total: Number(total.toFixed(2)),
        currency: selectedCurrency,
        name: checkoutCustomer.name,
        email: paymentCustomerEmail,
        phone: checkoutCustomer.phone,
        returnMode: Platform.OS === 'web' ? 'web' : 'app',
        cartItems: cartPayload,
        shippingAddress: defaultAddress,
      }, { timeoutMs: 45000 });
      console.log('[NOOD checkout] WiPay payment create response', data);

      const paymentUrl =
        String(data?.payment_url || data?.url || data?.redirect_url || '').trim();
      console.log('[NOOD checkout] WiPay payment_url before WebView opens', paymentUrl);

      if (!data?.success || !isValidHttpsUrl(paymentUrl)) {
        console.log('[NOOD payment] invalid paymentUrl:', paymentUrl, data);
        showMessage('Payment Error', 'Payment link could not be created. Please try again.');
        return;
      }

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.location.href = paymentUrl;
        return;
      }

      router.push({
        pathname: '/payment',
        params: {
          url: paymentUrl,
          returnUrl: String(data?.return_url || ''),
          total: String(total),
          currency: selectedCurrency,
        },
      });
    } catch (error: any) {
      const message =
        error?.name === 'AbortError'
          ? 'WiPay request timed out. Make sure your backend is running and your phone is on the same Wi-Fi.'
          : error?.message || 'Failed to connect to WiPay.';

      showMessage('WiPay Error', `WiPay checkout was selected. ${message}`);
      void addHistoryEvent({
        type: 'checkout',
        title: 'WiPay checkout failed',
        description: message,
        amount: total,
        currency: selectedCurrency,
        status: 'failed',
      });
      console.log('WiPay checkout error:', error);
    } finally {
      setLoadingMethod('');
    }
  };

  const handlePayPalPayment = async () => {
    console.log('PayPal checkout pressed');

    if (loadingMethod) return;
    if (!ensureCheckoutReady()) return;

    setLoadingMethod('paypal');
    console.log('[NOOD checkout] PayPal cart line items before checkout', buildCartPayload());
    void addHistoryEvent({
      type: 'checkout',
      title: 'PayPal checkout started',
      description: `PayPal checkout for ${formatMoney(total, selectedCurrency)}.`,
      amount: total,
      currency: selectedCurrency,
      status: 'started',
    });

    router.push({
      pathname: '/paypal-checkout',
      params: {
        total: String(total),
        currency: selectedCurrency,
      },
    });
    setLoadingMethod('');
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Checkout</Text>

        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.containerContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Wallet Balance</Text>
          <Text style={styles.balanceValue}>{balanceFormatted}</Text>
          <Text
            style={[
              styles.balanceStatus,
              { color: enoughBalance ? COLORS.green : COLORS.red },
            ]}
          >
            {enoughBalance ? 'Enough balance' : 'Not enough balance'}
          </Text>
        </View>

        <View style={styles.shippingCard}>
          <View style={styles.shippingHeader}>
            <View>
              <Text style={styles.sectionTitle}>Shipping Address</Text>
              <Text style={styles.shippingSubtitle}>
                {defaultAddress ? 'Default shipping address' : 'Add an address before checkout'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.changeAddressBtn}
              activeOpacity={0.88}
              onPress={() => router.push('/account/address' as any)}
            >
              <Text style={styles.changeAddressText}>{defaultAddress ? 'Change' : 'Add'}</Text>
            </TouchableOpacity>
          </View>

          {defaultAddress ? (
            <View style={styles.shippingBody}>
              <Text style={styles.shippingName}>{defaultAddress.fullName}</Text>
              <Text style={styles.shippingLine}>{defaultAddress.phone}</Text>
              <Text style={styles.shippingLine}>{defaultAddress.address1}</Text>
              {!!defaultAddress.address2 ? (
                <Text style={styles.shippingLine}>{defaultAddress.address2}</Text>
              ) : null}
              <Text style={styles.shippingLine}>
                {[defaultAddress.city, defaultAddress.region, defaultAddress.postalCode].filter(Boolean).join(', ')}
              </Text>
              {!!defaultAddress.notes ? (
                <Text style={styles.shippingNotes}>Notes: {defaultAddress.notes}</Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.shippingEmpty}>
              Checkout will use your default address once one is saved.
            </Text>
          )}
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.sectionTitle}>Order Summary</Text>

          {!hasItems ? (
            <Text style={styles.emptyText}>No items in cart.</Text>
          ) : (
            cartItems.map((item: any, index: number) => {
              const lineTotal = convertPrice(
                Number(item?.price || 0) * Number(item?.quantity || 1),
                item?.baseCurrency || BASE_CURRENCY,
                selectedCurrency
              );

              return (
                <View key={`${item.id}-${index}`} style={styles.itemRow}>
                  <View style={styles.itemLeft}>
                    <Text style={styles.itemTitle} numberOfLines={2}>
                      {item?.title || 'Product'}
                    </Text>

                    {!!item?.variantTitle &&
                      item.variantTitle !== 'Default Title' && (
                        <Text style={styles.itemVariant}>{item.variantTitle}</Text>
                      )}

                    <Text style={styles.itemQty}>
                      Qty: {Number(item?.quantity || 1)}
                    </Text>
                  </View>

                  <Text style={styles.itemPrice}>
                    {formatMoney(lineTotal, selectedCurrency)}
                  </Text>
                </View>
              );
            })
          )}
        </View>

        <View style={styles.totalsCard}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValueDark}>
              {formatMoney(total, selectedCurrency)}
            </Text>
          </View>

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Shipping</Text>
            <Text style={styles.totalValueDark}>Free</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.totalRow}>
            <Text style={styles.totalLabelBig}>Total</Text>
            <Text style={styles.totalValueBig}>
              {formatMoney(total, selectedCurrency)}
            </Text>
          </View>
        </View>

        <View style={styles.methodCard}>
          <Text style={styles.sectionTitle}>Choose Payment Method</Text>

          <TouchableOpacity
            style={[
              styles.walletMethodButton,
              ((isSignedIn && hasCompleteAddress && !enoughBalance) ||
                (loadingMethod !== '' && loadingMethod !== 'wallet'))
                ? styles.disabledButton
                : null,
            ]}
            activeOpacity={0.9}
            onPress={handleWalletPayment}
            disabled={
              (isSignedIn && hasCompleteAddress && !enoughBalance) ||
              (loadingMethod !== '' && loadingMethod !== 'wallet')
            }
          >
            <View style={styles.methodButtonLeft}>
              <View style={styles.walletLogoBadge}>
                <Ionicons name="wallet-outline" size={22} color={COLORS.green} />
              </View>
              <View style={styles.methodTextWrap}>
                <Text style={styles.methodButtonTitleDark}>Wallet</Text>
                <Text style={styles.methodButtonSubtitleDark}>
                  Available: {balanceFormatted}
                </Text>
              </View>
            </View>
            <Text style={[styles.walletAction, enoughBalance ? styles.walletActionReady : styles.walletActionLow]}>
              {loadingMethod === 'wallet'
                ? 'Processing...'
                : enoughBalance
                  ? 'Pay'
                  : 'Insufficient balance'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.wipayMethodButton,
              loadingMethod !== '' && loadingMethod !== 'wipay'
                ? styles.disabledButton
                : null,
            ]}
            activeOpacity={0.9}
            onPress={handleWiPayPayment}
            disabled={loadingMethod !== '' && loadingMethod !== 'wipay'}
          >
            <View style={styles.methodButtonLeft}>
              <View style={styles.logoBadgeLight}>
                <Image source={{ uri: WIPAY_LOGO }} style={styles.wipayLogo} resizeMode="contain" />
              </View>
              <View style={styles.methodTextWrap}>
                <Text style={styles.methodButtonTitleLight}>Pay securely with WiPay</Text>
                <Text style={styles.methodButtonSubtitleLight}>
                  Card checkout for your order
                </Text>
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
            <Text style={styles.methodButtonActionLight}>
              {loadingMethod === 'wipay' ? 'Opening...' : 'Pay with WiPay'}
            </Text>
          </TouchableOpacity>

          <View
            style={[
              styles.paypalSmartCard,
              loadingMethod !== '' && loadingMethod !== 'paypal'
                ? styles.disabledButton
                : null,
            ]}
          >
            <Text style={styles.paypalSmartIntro}>
              Pay in full or choose eligible PayPal payment options.
            </Text>

            <TouchableOpacity
              style={[styles.paypalSmartButton, styles.paypalButtonGold]}
              activeOpacity={0.9}
              onPress={handlePayPalPayment}
              disabled={loadingMethod !== '' && loadingMethod !== 'paypal'}
            >
              <Image source={{ uri: PAYPAL_LOGO }} style={styles.paypalSmartLogo} resizeMode="contain" />
              <Text style={styles.paypalSmartPayPalText}>
                {loadingMethod === 'paypal' ? 'Opening...' : 'PayPal'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.paypalSmartButton, styles.venmoButton]}
              activeOpacity={0.9}
              onPress={handlePayPalPayment}
              disabled={loadingMethod !== '' && loadingMethod !== 'paypal'}
            >
              <Text style={styles.venmoButtonText}>venmo</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.paypalSmartButton, styles.payLaterButton]}
              activeOpacity={0.9}
              onPress={handlePayPalPayment}
              disabled={loadingMethod !== '' && loadingMethod !== 'paypal'}
            >
              <Image source={{ uri: PAYPAL_LOGO }} style={styles.payLaterLogo} resizeMode="contain" />
              <Text style={styles.payLaterButtonText}>Pay Later</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.paypalSmartButton, styles.cardButtonDark]}
              activeOpacity={0.9}
              onPress={handlePayPalPayment}
              disabled={loadingMethod !== '' && loadingMethod !== 'paypal'}
            >
              <Ionicons name="card-outline" size={24} color="#ffffff" />
              <Text style={styles.cardButtonText}>Debit or Credit Card</Text>
            </TouchableOpacity>

            <View style={styles.paypalPoweredRow}>
              <Text style={styles.paypalPoweredText}>Powered by </Text>
              <Text style={styles.paypalPoweredBrand}>PayPal</Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.backToCartBtn}
            activeOpacity={0.9}
            onPress={() => router.back()}
          >
            <Text style={styles.backToCartText}>Back to Cart</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 28 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    paddingTop: 10,
    paddingBottom: 14,
    paddingHorizontal: 14,
    backgroundColor: COLORS.card,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: COLORS.text,
  },
  headerSpacer: {
    width: 42,
  },
  container: {
    flex: 1,
  },
  containerContent: {
    padding: 14,
    paddingBottom: 20,
  },
  balanceCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 12,
  },
  balanceLabel: {
    fontSize: 13,
    color: COLORS.muted,
    fontWeight: '700',
  },
  balanceValue: {
    fontSize: 28,
    color: COLORS.orange,
    fontWeight: '900',
    marginTop: 4,
  },
  balanceStatus: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '800',
  },
  shippingCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 12,
  },
  shippingHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  shippingSubtitle: {
    marginTop: -8,
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  changeAddressBtn: {
    borderRadius: 999,
    backgroundColor: COLORS.orange,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  changeAddressText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  shippingBody: {
    marginTop: 14,
    backgroundColor: '#fff7f2',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 12,
  },
  shippingName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
    marginBottom: 5,
  },
  shippingLine: {
    color: '#555',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
  shippingNotes: {
    marginTop: 7,
    color: '#6f5a4e',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
  shippingEmpty: {
    marginTop: 12,
    backgroundColor: '#fff7f2',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 12,
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
  summaryCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: COLORS.text,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 14,
    color: COLORS.muted,
    fontWeight: '600',
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#f5f1eb',
  },
  itemLeft: {
    flex: 1,
    paddingRight: 10,
  },
  itemTitle: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '800',
  },
  itemVariant: {
    marginTop: 4,
    fontSize: 12,
    color: COLORS.muted,
    fontWeight: '600',
  },
  itemQty: {
    marginTop: 4,
    fontSize: 12,
    color: COLORS.muted,
    fontWeight: '700',
  },
  itemPrice: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '800',
  },
  totalsCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
    marginBottom: 12,
  },
  totalRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalLabel: {
    fontSize: 14,
    color: COLORS.muted,
    fontWeight: '700',
  },
  totalValueDark: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '800',
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.line,
    marginVertical: 10,
  },
  totalLabelBig: {
    fontSize: 18,
    color: COLORS.text,
    fontWeight: '900',
  },
  totalValueBig: {
    fontSize: 22,
    color: COLORS.orange,
    fontWeight: '900',
  },
  methodCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.line,
  },
  walletMethodButton: {
    minHeight: 76,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#d9ccff',
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  wipayMethodButton: {
    minHeight: 96,
    borderRadius: 18,
    backgroundColor: COLORS.orange,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  paypalSmartCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#dfe5ec',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 12,
    marginBottom: 12,
  },
  paypalSmartIntro: {
    color: '#1f2937',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 10,
  },
  paypalSmartButton: {
    minHeight: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    paddingHorizontal: 16,
  },
  paypalButtonGold: {
    backgroundColor: '#ffc439',
  },
  venmoButton: {
    backgroundColor: '#008cff',
  },
  payLaterButton: {
    backgroundColor: '#ffc439',
  },
  cardButtonDark: {
    backgroundColor: '#2c2e2f',
    marginBottom: 12,
  },
  paypalSmartLogo: {
    width: 24,
    height: 24,
    marginRight: 7,
  },
  payLaterLogo: {
    width: 22,
    height: 22,
    marginRight: 7,
  },
  paypalSmartPayPalText: {
    color: '#003087',
    fontSize: 19,
    fontWeight: '900',
  },
  venmoButtonText: {
    color: '#ffffff',
    fontSize: 21,
    fontWeight: '900',
    fontStyle: 'italic',
  },
  payLaterButtonText: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '900',
  },
  cardButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
    marginLeft: 8,
  },
  paypalPoweredRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  paypalPoweredText: {
    color: COLORS.muted,
    fontSize: 12,
    fontStyle: 'italic',
    fontWeight: '700',
  },
  paypalPoweredBrand: {
    color: COLORS.blue,
    fontSize: 13,
    fontWeight: '900',
    fontStyle: 'italic',
  },
  disabledButton: {
    opacity: 0.65,
  },
  methodButtonLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 12,
  },
  walletLogoBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f1ecff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoBadgeLight: {
    width: 54,
    height: 54,
    borderRadius: 17,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoBadgeDark: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#d7e6f7',
  },
  wipayLogo: {
    width: 50,
    height: 50,
  },
  paypalLogo: {
    width: 31,
    height: 31,
  },
  methodTextWrap: {
    marginLeft: 10,
    flex: 1,
  },
  methodButtonTitleDark: {
    fontSize: 16,
    color: COLORS.text,
    fontWeight: '900',
  },
  methodButtonTitleLight: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '900',
  },
  methodButtonTitlePaypal: {
    fontSize: 16,
    color: COLORS.blue,
    fontWeight: '900',
  },
  methodButtonSubtitleDark: {
    marginTop: 3,
    fontSize: 12,
    color: '#4e6b86',
    fontWeight: '700',
  },
  methodButtonSubtitleLight: {
    marginTop: 3,
    fontSize: 12,
    color: '#fff4e8',
    fontWeight: '700',
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
    color: '#ff7300',
    fontSize: 9,
    fontWeight: '900',
  },
  walletAction: {
    fontSize: 12,
    fontWeight: '900',
    textAlign: 'right',
    maxWidth: 104,
  },
  walletActionReady: {
    color: COLORS.green,
  },
  walletActionLow: {
    color: COLORS.red,
  },
  methodButtonActionLight: {
    fontSize: 13,
    color: '#fff',
    fontWeight: '900',
    textAlign: 'right',
    maxWidth: 92,
  },
  methodButtonActionPaypal: {
    fontSize: 13,
    color: COLORS.blue,
    fontWeight: '900',
    textAlign: 'right',
    maxWidth: 108,
  },
  backToCartBtn: {
    marginTop: 6,
    height: 52,
    borderRadius: 14,
    backgroundColor: COLORS.orangeSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backToCartText: {
    color: COLORS.orange,
    fontSize: 15,
    fontWeight: '900',
  },
});
