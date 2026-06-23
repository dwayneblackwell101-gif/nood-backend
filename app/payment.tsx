import React, { useEffect, useRef } from 'react';
import {
  View,
  StyleSheet,
  Alert,
  Platform,
  SafeAreaView,
  TouchableOpacity,
  Text,
  StatusBar,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCart } from '../context/CartContext';
import { useHistoryEvents } from '../context/HistoryContext';
import { useAddressBook } from '../context/AddressContext';
import { BASE_CURRENCY } from '../utils/currency';
import { getBackendJsonFromUrl } from '../utils/backend';
import NoodSpinner from '../components/NoodSpinner';

export default function PaymentScreen() {
  const { url, total, currency, returnUrl } = useLocalSearchParams<{
    url?: string;
    total?: string;
    currency?: string;
    returnUrl?: string;
  }>();

  const router = useRouter();
  const { addOrder, clearCart, cartItems = [], selectedCurrency = BASE_CURRENCY, formatMoney } = useCart();
  const { defaultAddress } = useAddressBook();
  const { addHistoryEvent } = useHistoryEvents();
  const handledRef = useRef(false);
  const webViewRef = useRef<WebView>(null);
  const paymentCurrency = String(currency || selectedCurrency || BASE_CURRENCY);
  const paymentUrl = String(url || '').trim();
  const backendReturnUrl = String(returnUrl || '').trim();
  const isValidPaymentUrl = paymentUrl.startsWith('https://');
  const didTriggerBackendReturnRef = useRef(false);

  useEffect(() => {
    if (!paymentUrl || isValidPaymentUrl || Platform.OS === 'web') return;

    Alert.alert('Payment Error', 'Payment link could not be created. Please try again.');
  }, [isValidPaymentUrl, paymentUrl]);

  const finishSuccess = (
    paymentMethod: string,
    shopifyOrderName: string,
    shopifyOrderId?: string,
    transactionId?: string
  ) => {
    if (handledRef.current) return;
    console.log('[NOOD payment] success received', {
      paymentMethod,
      shopifyOrderName,
      shopifyOrderId,
      transactionId,
    });

    if (!shopifyOrderName && !shopifyOrderId) {
      finishFailure('Payment was received, but Shopify did not confirm the order. Please contact support before trying again.');
      return;
    }

    handledRef.current = true;

    addOrder({
      id: shopifyOrderName || shopifyOrderId || Date.now().toString(),
      date: new Date().toISOString(),
      total: Number(total || 0),
      currency: paymentCurrency,
      status: 'paid',
      paymentMethod: shopifyOrderName ? `${paymentMethod} (${shopifyOrderName})` : paymentMethod,
      shopifyOrderId,
      shopifyOrderName,
      paymentTransactionId: transactionId,
      customer: {
        name: defaultAddress?.fullName || '',
        email: (defaultAddress as any)?.email || '',
        phone: defaultAddress?.phone || '',
      },
      shippingAddress: defaultAddress,
      items: cartItems,
    });
    console.log('[NOOD order] app order saved');
    console.log('[NOOD payment] saved app order after Shopify confirmation', {
      shopifyOrderName,
      shopifyOrderId,
      paymentTransactionId: transactionId,
      items: cartItems,
      customer: {
        name: defaultAddress?.fullName || '',
        email: (defaultAddress as any)?.email || '',
        phone: defaultAddress?.phone || '',
      },
      shippingAddress: defaultAddress,
    });
    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment completed',
      description: `${paymentMethod} payment completed for Shopify order ${shopifyOrderName || shopifyOrderId}.`,
      amount: Number(total || 0),
      currency: paymentCurrency,
      status: 'success',
    });

    clearCart();
    console.log('[NOOD order] cart cleared');

    Alert.alert(
      'Payment Successful',
      shopifyOrderName
        ? `Order ${shopifyOrderName} was created successfully.`
        : 'Your order was created successfully.',
      [
        {
          text: 'View Orders',
          onPress: () => router.replace('/account/orders'),
        },
      ]
    );
  };

  const finishFailure = (message?: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    console.log('[NOOD payment] failure received', {
      message: message || 'Payment was cancelled or failed.',
    });

    Alert.alert(
      'Payment Not Completed',
      message || 'Payment was cancelled or failed.',
      [
        {
          text: 'Back',
          onPress: () => router.back(),
        },
      ]
    );
    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment not completed',
      description: message || 'Payment was cancelled or failed.',
      amount: Number(total || 0),
      currency: paymentCurrency,
      status: 'failed',
    });
  };

  const finishPaymentReceivedOrderIssue = (
    paymentMethod: string,
    transactionId: string,
    orderId?: string,
    recoveryId?: string
  ) => {
    if (handledRef.current) return;
    handledRef.current = true;

    console.log('[NOOD payment] payment received but Shopify order needs recovery', {
      paymentMethod,
      transactionId,
      orderId,
      recoveryId,
      items: cartItems,
    });

    addOrder({
      id: orderId || recoveryId || transactionId || Date.now().toString(),
      date: new Date().toISOString(),
      total: Number(total || 0),
      currency: paymentCurrency,
      status: 'failed-paid',
      paymentMethod: transactionId ? `${paymentMethod} (${transactionId})` : paymentMethod,
      paymentTransactionId: transactionId,
      customer: {
        name: defaultAddress?.fullName || '',
        email: (defaultAddress as any)?.email || '',
        phone: defaultAddress?.phone || '',
      },
      shippingAddress: defaultAddress,
      items: cartItems,
    });

    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment received - order needs review',
      description: `Payment was successful, but Shopify order creation needs review. Transaction ID: ${transactionId || 'not provided'}.`,
      amount: Number(total || 0),
      currency: paymentCurrency,
      status: 'needs_review',
      relatedId: recoveryId || orderId || transactionId,
    });

    Alert.alert(
      'Payment Received - Order Processing Issue',
      `Your payment was successful, but your order needs review. Please contact support with transaction ID: ${transactionId || 'not provided'}.`,
      [
        {
          text: 'View Orders',
          onPress: () => router.replace('/account/orders'),
        },
      ]
    );
  };

  const handleSpecialUrl = (currentUrl: string) => {
    if (!currentUrl) return false;

    if (currentUrl.startsWith('noodapp://payment-result')) {
      try {
        console.log('[NOOD payment] app return URL', currentUrl);
        const parsed = new URL(currentUrl);
        const status = parsed.searchParams.get('status') || '';
        const type = parsed.searchParams.get('type') || '';
        const method = parsed.searchParams.get('method') || 'WiPay';
        const shopifyOrderName =
          parsed.searchParams.get('shopify_order_name') || '';
        const shopifyOrderId =
          parsed.searchParams.get('shopify_order_id') || '';
        const transactionId =
          parsed.searchParams.get('transaction_id') || '';
        const orderId = parsed.searchParams.get('order_id') || '';
        const recoveryId = parsed.searchParams.get('recovery_id') || '';
        const reason = parsed.searchParams.get('reason') || '';

        if (status === 'success' && type === 'checkout' && (shopifyOrderName || shopifyOrderId)) {
          finishSuccess(method, shopifyOrderName, shopifyOrderId, transactionId);
        } else if (status === 'payment_received_order_review' && type === 'checkout') {
          finishPaymentReceivedOrderIssue(method, transactionId, orderId, recoveryId);
        } else if (status === 'success' && type === 'checkout') {
          finishPaymentReceivedOrderIssue(method, transactionId, orderId, recoveryId);
        } else {
          finishFailure(reason);
        }
      } catch (error) {
        console.log('Deep link parse error:', error);
        finishFailure('Could not read payment result.');
      }
      return true;
    }

    if (currentUrl.includes('/payment-return')) {
      return false;
    }

    if (currentUrl.includes('status=payment_received_order_review')) {
      try {
        console.log('[NOOD payment] payment received review URL', currentUrl);
        const parsed = new URL(currentUrl);
        finishPaymentReceivedOrderIssue(
          parsed.searchParams.get('method') || 'WiPay',
          parsed.searchParams.get('transaction_id') || '',
          parsed.searchParams.get('order_id') || '',
          parsed.searchParams.get('recovery_id') || ''
        );
      } catch (error) {
        console.log('Payment review URL parse error:', error);
        finishPaymentReceivedOrderIssue('WiPay', '', '', '');
      }
      return true;
    }

    if (currentUrl.includes('status=success')) {
      try {
        console.log('[NOOD payment] web return URL', currentUrl);
        const parsed = new URL(currentUrl);
        const method = parsed.searchParams.get('method') || 'WiPay';
        const shopifyOrderName =
          parsed.searchParams.get('shopify_order_name') || '';
        const shopifyOrderId =
          parsed.searchParams.get('shopify_order_id') || '';
        const transactionId =
          parsed.searchParams.get('transaction_id') || '';
        const orderId = parsed.searchParams.get('order_id') || '';
        const recoveryId = parsed.searchParams.get('recovery_id') || '';

        if (!shopifyOrderName && !shopifyOrderId) {
          finishPaymentReceivedOrderIssue(method, transactionId, orderId, recoveryId);
        } else {
          finishSuccess(method, shopifyOrderName, shopifyOrderId, transactionId);
        }
      } catch (error) {
        console.log('Success URL parse error:', error);
        finishPaymentReceivedOrderIssue('WiPay', '', '', '');
      }
      return true;
    }

    if (
      currentUrl.includes('status=failed') ||
      currentUrl.includes('status=cancelled')
    ) {
      try {
        console.log('[NOOD payment] failed return URL', currentUrl);
        const parsed = new URL(currentUrl);
        const reason = parsed.searchParams.get('reason') || '';
        const transactionId = parsed.searchParams.get('transaction_id') || '';
        const orderId = parsed.searchParams.get('order_id') || '';
        const recoveryId = parsed.searchParams.get('recovery_id') || '';

        if (reason === 'shopify_order_create_failed' && transactionId) {
          finishPaymentReceivedOrderIssue(
            parsed.searchParams.get('method') || 'WiPay',
            transactionId,
            orderId,
            recoveryId
          );
        } else {
          finishFailure(reason);
        }
      } catch (error) {
        console.log('Failure URL parse error:', error);
        finishFailure();
      }
      return true;
    }

    return false;
  };

  const triggerBackendReturn = async () => {
    if (didTriggerBackendReturnRef.current || handledRef.current) return;
    if (!backendReturnUrl.startsWith('http://') && !backendReturnUrl.startsWith('https://')) return;

    didTriggerBackendReturnRef.current = true;
    console.log('[NOOD payment] WiPay success screen detected; calling backend return URL', backendReturnUrl);

    try {
      const data = await getBackendJsonFromUrl(backendReturnUrl, { timeoutMs: 45000 });
      console.log('[NOOD payment] backend payment return response', data);

      const redirectUrl = String(data?.redirect_url || '').trim();
      if (redirectUrl && handleSpecialUrl(redirectUrl)) {
        return;
      }

      if (data?.status === 'success' && data?.type === 'checkout') {
        finishSuccess(
          data?.method || 'WiPay',
          data?.shopify_order_name || '',
          data?.shopify_order_id || '',
          data?.transaction_id || ''
        );
        return;
      }

      if (data?.status === 'payment_received_order_review') {
        finishPaymentReceivedOrderIssue(
          data?.method || 'WiPay',
          data?.transaction_id || '',
          data?.order_id || '',
          data?.recovery_id || ''
        );
        return;
      }

      finishFailure(data?.reason || 'Payment return could not be completed.');
    } catch (error: any) {
      console.log('[NOOD payment] backend return call failed', error);
      didTriggerBackendReturnRef.current = false;
      finishPaymentReceivedOrderIssue('WiPay', '', '', '');
    }
  };

  const wipaySuccessDetectionScript = `
    (function () {
      if (window.__NOOD_WIPAY_SUCCESS_WATCHER__) return true;
      window.__NOOD_WIPAY_SUCCESS_WATCHER__ = true;

      function checkForSuccess() {
        var text = (document.body && document.body.innerText || '').toLowerCase();
        if (
          text.indexOf('transaction complete') !== -1 &&
          (text.indexOf('success') !== -1 || text.indexOf('successful') !== -1)
        ) {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'wipay_success_detected'
          }));
        }
      }

      checkForSuccess();
      setInterval(checkForSuccess, 1000);
      true;
    })();
  `;

  if (Platform.OS === 'web') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
        <View style={styles.loadingWrap}>
          <NoodSpinner size={48} />
        </View>
      </SafeAreaView>
    );
  }

  if (!isValidPaymentUrl) {
    console.log('[NOOD payment] invalid paymentUrl:', paymentUrl);
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-back" size={22} color="#111" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text numberOfLines={1} style={styles.headerTitle}>
              Secure Payment
            </Text>
            <Text style={styles.headerSubtitle}>
              {total ? formatMoney(Number(total || 0), paymentCurrency) : 'Checkout'}
            </Text>
          </View>
          <View style={styles.refreshButton} />
        </View>
        <View style={styles.errorWrap}>
          <Text style={styles.errorTitle}>Payment Error</Text>
          <Text style={styles.errorText}>
            Payment link could not be created. Please try again.
          </Text>
          <TouchableOpacity style={styles.errorButton} onPress={() => router.back()}>
            <Text style={styles.errorButtonText}>Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            Secure Payment
          </Text>
          <Text style={styles.headerSubtitle}>
            {total ? formatMoney(Number(total || 0), paymentCurrency) : 'Checkout'}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.refreshButton}
          onPress={() => webViewRef.current?.reload()}
          activeOpacity={0.8}
        >
          <Ionicons name="refresh" size={20} color="#111" />
        </TouchableOpacity>
      </View>

      <View style={styles.webviewWrap}>
        <WebView
          ref={webViewRef}
          source={{ uri: paymentUrl }}
          startInLoadingState
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          javaScriptCanOpenWindowsAutomatically
          setSupportMultipleWindows={false}
          bounces={false}
          contentInsetAdjustmentBehavior="never"
          renderLoading={() => (
            <View style={styles.loadingWrap}>
              <NoodSpinner size={48} />
            </View>
          )}
          onShouldStartLoadWithRequest={(request) => {
            const intercepted = handleSpecialUrl(request.url);
            return !intercepted;
          }}
          onNavigationStateChange={(navState) => {
            handleSpecialUrl(navState.url);
          }}
          injectedJavaScript={wipaySuccessDetectionScript}
          onMessage={(event) => {
            try {
              const message = JSON.parse(event.nativeEvent.data || '{}');
              if (message?.type === 'wipay_success_detected') {
                void triggerBackendReturn();
              }
            } catch (error) {
              console.log('[NOOD payment] WebView message parse error', error);
            }
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    height: 64,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#ececec',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  refreshButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  headerCenter: {
    flex: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111',
  },
  headerSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  webviewWrap: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  errorWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: '#ffffff',
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111111',
    textAlign: 'center',
    marginBottom: 10,
  },
  errorText: {
    fontSize: 16,
    lineHeight: 23,
    color: '#666666',
    textAlign: 'center',
    marginBottom: 22,
  },
  errorButton: {
    minHeight: 48,
    minWidth: 140,
    borderRadius: 24,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  errorButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#ffffff',
  },
});
