import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
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
import { getCustomerProfile } from '../utils/customer-profile';
import { BASE_CURRENCY } from '../utils/currency';
import { SHOPIFY_CHECKOUT_CURRENCY } from '../utils/checkout-totals';
import { resetCheckoutSessionId } from '../utils/checkout-session';
import { PAYMENT_REVIEW_MESSAGE } from '../utils/checkout-validation';
import { noodAlert } from '../utils/nood-alert';
import {
  getBackendJsonFromUrl,
  getPaymentReturnHost,
  isBlockedLocalPaymentHost,
  logPaymentBackendDiagnostics,
  resolvePaymentReturnUrl,
} from '../utils/backend';
import NoodSpinner from '../components/NoodSpinner';

export default function PaymentScreen() {
  const { url, total, currency, returnUrl } = useLocalSearchParams<{
    url?: string;
    total?: string;
    currency?: string;
    returnUrl?: string;
  }>();

  const router = useRouter();
  const {
    saveOrderAfterPayment,
    clearCart,
    cartItems = [],
    selectedCurrency = BASE_CURRENCY,
    formatMoney,
  } = useCart();
  const { defaultAddress } = useAddressBook();
  const { addHistoryEvent } = useHistoryEvents();
  const handledRef = useRef(false);
  const webViewRef = useRef<WebView>(null);
  const paymentCurrency = String(currency || selectedCurrency || BASE_CURRENCY);
  const paymentUrl = String(url || '').trim();
  const backendReturnUrl = String(returnUrl || '').trim();
  const resolvedBackendReturnUrl = resolvePaymentReturnUrl(backendReturnUrl);
  const isValidPaymentUrl = paymentUrl.startsWith('https://');
  const didTriggerBackendReturnRef = useRef(false);
  const paymentReturnInFlightRef = useRef(false);
  const handledOrderIdsRef = useRef(new Set<string>());
  const handledReturnKeysRef = useRef(new Set<string>());
  const orderSaveInFlightRef = useRef(false);
  const [webViewEnabled, setWebViewEnabled] = useState(true);

  const getReturnIdentifiers = useCallback((targetUrl: string) => {
    try {
      const parsed = new URL(targetUrl);
      const orderId = String(
        parsed.searchParams.get('order_id') ||
          parsed.searchParams.get('orderId') ||
          parsed.searchParams.get('orderid') ||
          ''
      ).trim();
      const returnToken = String(
        parsed.searchParams.get('return_token') || parsed.searchParams.get('token') || ''
      ).trim();
      const returnKey = orderId && returnToken ? `${orderId}:${returnToken}` : orderId;

      return { orderId, returnToken, returnKey };
    } catch {
      return { orderId: '', returnToken: '', returnKey: '' };
    }
  }, []);

  const stopWebViewNavigation = useCallback(() => {
    setWebViewEnabled(false);
    try {
      webViewRef.current?.stopLoading();
    } catch (error) {
      console.log('[NOOD payment] WebView stopLoading failed', error);
    }
  }, []);

  const markReturnHandled = useCallback(
    (identifiers?: { orderId?: string; returnKey?: string; transactionId?: string }) => {
      handledRef.current = true;

      const orderId = String(identifiers?.orderId || '').trim();
      const returnKey = String(identifiers?.returnKey || '').trim();
      const transactionId = String(identifiers?.transactionId || '').trim();

      if (orderId) {
        handledOrderIdsRef.current.add(orderId);
      }
      if (returnKey) {
        handledReturnKeysRef.current.add(returnKey);
      }
      if (transactionId) {
        handledOrderIdsRef.current.add(transactionId);
      }

      stopWebViewNavigation();
    },
    [stopWebViewNavigation]
  );

  const isReturnAlreadyHandled = useCallback(
    (identifiers?: { orderId?: string; returnKey?: string }) => {
      if (handledRef.current) {
        return true;
      }

      const orderId = String(identifiers?.orderId || '').trim();
      const returnKey = String(identifiers?.returnKey || '').trim();

      if (orderId && handledOrderIdsRef.current.has(orderId)) {
        return true;
      }

      if (returnKey && handledReturnKeysRef.current.has(returnKey)) {
        return true;
      }

      return false;
    },
    []
  );

  const ignoreDuplicateReturn = useCallback((context: string, details: Record<string, unknown> = {}) => {
    console.log('[PAYMENT RETURN DUPLICATE IGNORED]', { context, ...details });
  }, []);

  const logReturnAlreadyHandled = useCallback((context: string, details: Record<string, unknown> = {}) => {
    console.log('[PAYMENT RETURN ALREADY HANDLED]', { context, ...details });
  }, []);

  useEffect(() => {
    logPaymentBackendDiagnostics(resolvedBackendReturnUrl);
    if (backendReturnUrl && resolvedBackendReturnUrl !== backendReturnUrl) {
      console.log('[PAYMENT RETURN URL] remapped from route params', {
        original: backendReturnUrl,
        resolved: resolvedBackendReturnUrl,
        host: getPaymentReturnHost(resolvedBackendReturnUrl),
      });
    }
  }, [backendReturnUrl, resolvedBackendReturnUrl]);

  useEffect(() => {
    if (!paymentUrl || isValidPaymentUrl || Platform.OS === 'web') return;

    noodAlert('Payment Error', 'Payment link could not be created. Please try again.');
  }, [isValidPaymentUrl, paymentUrl]);

  const finishSuccess = async (
    paymentMethod: string,
    shopifyOrderName: string,
    shopifyOrderId?: string,
    transactionId?: string,
    orderId?: string,
    returnKey?: string,
    paidTotal?: number
  ) => {
    if (handledRef.current || orderSaveInFlightRef.current) {
      logReturnAlreadyHandled('finishSuccess', { shopifyOrderName, orderId, returnKey });
      return;
    }

    orderSaveInFlightRef.current = true;

    console.log('[ORDER CREATE SUCCESS] payment flow completed in app', {
      paymentMethod,
      shopifyOrderName,
      shopifyOrderId,
      transactionId,
      orderId,
    });

    if (!shopifyOrderName && !shopifyOrderId) {
      orderSaveInFlightRef.current = false;
      finishFailure('Payment was received, but Shopify did not confirm the order. Please contact support before trying again.');
      return;
    }

    const profile = await getCustomerProfile();
    const orderTotal = Number(
      paidTotal !== undefined && paidTotal !== null ? paidTotal : total || 0
    );
    const saved = await saveOrderAfterPayment({
      shopifyOrderId,
      shopifyOrderName,
      checkoutOrderId: orderId,
      transactionId,
      paymentMethod,
      total: orderTotal,
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      items: cartItems,
      customer: {
        name: defaultAddress?.fullName || profile?.displayName || '',
        email: profile?.email || (defaultAddress as any)?.email || '',
        phone: defaultAddress?.phone || '',
      },
      shippingAddress: defaultAddress,
    });

    if (!saved) {
      orderSaveInFlightRef.current = false;
      noodAlert(
        'Order Save Issue',
        'Payment succeeded, but the order could not be saved in the app. Please check Orders or contact support.'
      );
      return;
    }

    markReturnHandled({ orderId, returnKey, transactionId });
    orderSaveInFlightRef.current = false;

    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment completed',
      description: `${paymentMethod} payment completed for Shopify order ${shopifyOrderName || shopifyOrderId}.`,
      amount: orderTotal,
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      status: 'success',
    });

    clearCart();
    resetCheckoutSessionId();
    console.log('[NOOD order] cart cleared');

    noodAlert(
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
    if (handledRef.current) {
      ignoreDuplicateReturn('finishFailure', { message: message || null });
      return;
    }
    markReturnHandled();
    console.log('[NOOD payment] failure received', {
      message: message || 'Payment was cancelled or failed.',
    });

    noodAlert(
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
    recoveryId?: string,
    reason?: string
  ) => {
    if (handledRef.current) {
      logReturnAlreadyHandled('finishPaymentReceivedOrderIssue', { orderId, reason });
      return;
    }
    markReturnHandled({ orderId, transactionId });

    console.log('[ORDER CREATE FAILED] payment received but Shopify order was not created', {
      paymentMethod,
      transactionId,
      orderId,
      recoveryId,
      reason: reason || 'unknown',
      items: cartItems,
    });

    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment received - order needs review',
      description: `${PAYMENT_REVIEW_MESSAGE} Transaction ID: ${transactionId || 'not provided'}.`,
      amount: Number(total || 0),
      currency: paymentCurrency || SHOPIFY_CHECKOUT_CURRENCY,
      status: 'needs_review',
      relatedId: recoveryId || orderId || transactionId,
    });

    noodAlert(
      'Payment Received - Order Processing Issue',
      transactionId
        ? `${PAYMENT_REVIEW_MESSAGE} ${transactionId}`
        : PAYMENT_REVIEW_MESSAGE,
      [{ text: 'Back to Checkout', onPress: () => router.back() }]
    );
  };

  const handleSpecialUrl = (currentUrl: string) => {
    if (!currentUrl) return false;

    if (handledRef.current) {
      if (
        currentUrl.includes('/payment-return') ||
        currentUrl.includes('invalid_return_token') ||
        currentUrl.includes('status=failed') ||
        currentUrl.includes('status=cancelled')
      ) {
        ignoreDuplicateReturn('handleSpecialUrl', { url: currentUrl });
        return true;
      }
    }

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
          void finishSuccess(method, shopifyOrderName, shopifyOrderId, transactionId, orderId);
        } else if (status === 'payment_received_order_review' && type === 'checkout') {
          finishPaymentReceivedOrderIssue(method, transactionId, orderId, recoveryId, reason);
        } else if (status === 'success' && type === 'checkout') {
          finishPaymentReceivedOrderIssue(method, transactionId, orderId, recoveryId, reason || 'success_without_shopify_order');
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
      const coercedReturnUrl = resolvePaymentReturnUrl(currentUrl);
      const identifiers = getReturnIdentifiers(coercedReturnUrl);

      if (isReturnAlreadyHandled(identifiers)) {
        logReturnAlreadyHandled('payment-return-navigation', identifiers);
        return true;
      }

      if (isBlockedLocalPaymentHost(currentUrl)) {
        console.log('[PAYMENT URL BLOCKED LOCAL]', {
          original: currentUrl,
          replacedWith: coercedReturnUrl,
        });
      }
      console.log('[PAYMENT RETURN HOST]', getPaymentReturnHost(coercedReturnUrl) || '(invalid)');
      void triggerBackendReturn(coercedReturnUrl);
      return true;
    }

    if (currentUrl.includes('status=payment_received_order_review')) {
      try {
        console.log('[NOOD payment] payment received review URL', currentUrl);
        const parsed = new URL(currentUrl);
        finishPaymentReceivedOrderIssue(
          parsed.searchParams.get('method') || 'WiPay',
          parsed.searchParams.get('transaction_id') || '',
          parsed.searchParams.get('order_id') || '',
          parsed.searchParams.get('recovery_id') || '',
          parsed.searchParams.get('reason') || 'payment_received_order_review'
        );
      } catch (error) {
        console.log('Payment review URL parse error:', error);
        finishPaymentReceivedOrderIssue('WiPay', '', '', '', 'payment_review_url_parse_error');
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
          finishPaymentReceivedOrderIssue(
            method,
            transactionId,
            orderId,
            recoveryId,
            parsed.searchParams.get('reason') || 'success_without_shopify_order'
          );
        } else {
          void finishSuccess(method, shopifyOrderName, shopifyOrderId, transactionId, orderId);
        }
      } catch (error) {
        console.log('Success URL parse error:', error);
        finishPaymentReceivedOrderIssue('WiPay', '', '', '', 'success_url_parse_error');
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

        if (reason === 'invalid_return_token') {
          if (isReturnAlreadyHandled({ orderId })) {
            ignoreDuplicateReturn('failed-return-url', { orderId, reason });
            return true;
          }
        }

        if (reason === 'shopify_order_create_failed' && transactionId) {
          finishPaymentReceivedOrderIssue(
            parsed.searchParams.get('method') || 'WiPay',
            transactionId,
            orderId,
            recoveryId,
            reason || 'shopify_order_create_failed'
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

  const triggerBackendReturn = async (overrideReturnUrl?: string) => {
    const targetReturnUrl = resolvePaymentReturnUrl(
      String(overrideReturnUrl || resolvedBackendReturnUrl || '').trim()
    );
    const identifiers = getReturnIdentifiers(targetReturnUrl);

    if (isReturnAlreadyHandled(identifiers)) {
      logReturnAlreadyHandled('triggerBackendReturn', identifiers);
      return;
    }

    if (paymentReturnInFlightRef.current) {
      ignoreDuplicateReturn('triggerBackendReturn', {
        ...identifiers,
        reason: 'in_flight',
      });
      return;
    }

    if (
      !targetReturnUrl.startsWith('http://') &&
      !targetReturnUrl.startsWith('https://')
    ) {
      return;
    }

    paymentReturnInFlightRef.current = true;
    didTriggerBackendReturnRef.current = true;
    console.log('[WIPAY SUCCESS] app detected WiPay success screen; calling backend return URL', {
      backendReturnUrl,
      resolvedBackendReturnUrl: targetReturnUrl,
      paymentReturnHost: getPaymentReturnHost(targetReturnUrl),
    });
    console.log('[PAYMENT RETURN URL]', targetReturnUrl);
    console.log('[PAYMENT RETURN HOST]', getPaymentReturnHost(targetReturnUrl) || '(invalid)');

    try {
      const data = await getBackendJsonFromUrl(targetReturnUrl, { timeoutMs: 45000 });
      console.log('[PAYMENT RESULT REDIRECT] backend payment-return JSON response', data);

      const redirectUrl = String(data?.redirect_url || '').trim();
      if (redirectUrl) {
        console.log('[PAYMENT RESULT REDIRECT] redirect_url from backend', redirectUrl);
      }

      if (redirectUrl && handleSpecialUrl(redirectUrl)) {
        return;
      }

      const responseOrderId = String(data?.order_id || identifiers.orderId || '').trim();
      const responseReturnKey =
        identifiers.returnKey ||
        (responseOrderId && identifiers.returnToken
          ? `${responseOrderId}:${identifiers.returnToken}`
          : responseOrderId);

      if (data?.reason === 'invalid_return_token') {
        if (isReturnAlreadyHandled({ orderId: responseOrderId, returnKey: responseReturnKey })) {
          ignoreDuplicateReturn('backend-return-response', {
            orderId: responseOrderId,
            returnKey: responseReturnKey,
            reason: 'invalid_return_token',
          });
          return;
        }
      }

      if (data?.status === 'success' && data?.type === 'checkout') {
        if (!data?.shopify_order_name && !data?.shopify_order_id) {
          finishPaymentReceivedOrderIssue(
            data?.method || 'WiPay',
            data?.transaction_id || '',
            responseOrderId,
            data?.recovery_id || '',
            'success_without_shopify_order'
          );
          return;
        }

        void finishSuccess(
          data?.method || 'WiPay',
          data?.shopify_order_name || '',
          data?.shopify_order_id || '',
          data?.transaction_id || '',
          responseOrderId,
          responseReturnKey,
          Number(data?.amount ?? data?.total ?? total ?? 0)
        );
        return;
      }

      if (data?.status === 'payment_received_order_review') {
        finishPaymentReceivedOrderIssue(
          data?.method || 'WiPay',
          data?.transaction_id || '',
          data?.order_id || '',
          data?.recovery_id || '',
          data?.reason || 'payment_received_order_review'
        );
        return;
      }

      if (data?.reason === 'invalid_return_token' && isReturnAlreadyHandled(identifiers)) {
        ignoreDuplicateReturn('backend-return-failed-response', {
          ...identifiers,
          reason: 'invalid_return_token',
        });
        return;
      }

      finishFailure(data?.reason || 'Payment return could not be completed.');
    } catch (error: any) {
      console.log('[ORDER CREATE FAILED] backend payment-return call failed', {
        message: error?.message || String(error),
        backendReturnUrl,
        resolvedBackendReturnUrl: targetReturnUrl,
        paymentReturnHost: getPaymentReturnHost(targetReturnUrl),
      });
      if (!handledRef.current) {
        didTriggerBackendReturnRef.current = false;
        finishPaymentReceivedOrderIssue('WiPay', '', '', '', 'backend_return_request_failed');
      }
    } finally {
      paymentReturnInFlightRef.current = false;
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
        {webViewEnabled ? (
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
              if (handledRef.current) {
                ignoreDuplicateReturn('onShouldStartLoadWithRequest', { url: request.url });
                return false;
              }
              const intercepted = handleSpecialUrl(request.url);
              return !intercepted;
            }}
            onNavigationStateChange={(navState) => {
              if (handledRef.current) {
                return;
              }
              handleSpecialUrl(navState.url);
            }}
            injectedJavaScript={wipaySuccessDetectionScript}
            onMessage={(event) => {
              if (handledRef.current) {
                return;
              }
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
        ) : (
          <View style={styles.loadingWrap}>
            <NoodSpinner size={48} />
          </View>
        )}
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
