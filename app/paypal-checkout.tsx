import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCart } from '../context/CartContext';
import { useAddressBook } from '../context/AddressContext';
import { useHistoryEvents } from '../context/HistoryContext';
import { useUser } from '../context/UserContext';
import { postBackendJson } from '../utils/backend';
import { BASE_CURRENCY } from '../utils/currency';
import { getCheckoutCustomer, getPaymentTestingEmail } from '../utils/customer';
import NoodSpinner from '../components/NoodSpinner';

const PAYPAL_CLIENT_ID = String(process.env.EXPO_PUBLIC_PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_ENV = String(process.env.EXPO_PUBLIC_PAYPAL_ENV || 'sandbox').trim().toLowerCase();

type PayPalMessage =
  | { type: 'paypal-ready' }
  | { type: 'create-order'; requestId: string }
  | { type: 'capture-order'; requestId: string; orderID: string }
  | { type: 'cancel' }
  | { type: 'error'; message?: string };

type ShopifyOrderResult = {
  shopifyOrderId: string;
  shopifyOrderName: string;
  paymentTransactionId: string;
};

function escapeForScript(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function getShopifyOrderResult(data: any): ShopifyOrderResult {
  const shopifyOrderId =
    data?.shopify_order_id ||
    data?.shopifyOrderId ||
    data?.shopifyOrder?.id ||
    data?.shopify_order?.id ||
    data?.order?.id ||
    '';
  const shopifyOrderName =
    data?.shopify_order_name ||
    data?.shopifyOrderName ||
    data?.shopifyOrder?.name ||
    data?.shopify_order?.name ||
    data?.order?.name ||
    '';
  const paymentTransactionId =
    data?.transaction_id ||
    data?.paymentTransactionId ||
    data?.captureId ||
    data?.capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
    data?.paypal?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
    data?.capture?.id ||
    data?.paypal?.id ||
    '';

  return {
    shopifyOrderId: String(shopifyOrderId || ''),
    shopifyOrderName: String(shopifyOrderName || ''),
    paymentTransactionId: String(paymentTransactionId || ''),
  };
}

function makePayPalHtml(clientId: string, currency: string, amount: string, paypalEnv: string) {
  const sdkUrl =
    paypalEnv === 'live'
      ? 'https://www.paypal.com/web-sdk/v6/core'
      : 'https://www.sandbox.paypal.com/web-sdk/v6/core';

  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #f6f3ef;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wrap {
        min-height: 100vh;
        padding: 18px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .card {
        width: 100%;
        max-width: 430px;
        background: #fff;
        border-radius: 20px;
        padding: 18px;
        border: 1px solid #e7e0d8;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
        box-sizing: border-box;
      }
      .title {
        font-size: 22px;
        line-height: 28px;
        font-weight: 800;
        color: #111;
        text-align: center;
        margin: 4px 0 6px;
      }
      .subtitle {
        color: #677083;
        font-size: 14px;
        font-weight: 600;
        text-align: center;
        margin: 0 0 16px;
      }
      .button-stack {
        display: grid;
        gap: 10px;
      }
      paypal-button,
      paypal-pay-later-button,
      paypal-credit-button {
        width: 100%;
        min-height: 50px;
        display: block;
      }
      .status {
        min-height: 18px;
        color: #a33a00;
        font-size: 13px;
        line-height: 18px;
        font-weight: 700;
        text-align: center;
        margin-top: 8px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <p class="title">Pay securely with PayPal</p>
        <p class="subtitle">Total ${escapeForScript(currency)} ${escapeForScript(amount)}</p>
        <div class="button-stack">
          <paypal-button hidden></paypal-button>
          <paypal-pay-later-button hidden></paypal-pay-later-button>
          <paypal-credit-button hidden></paypal-credit-button>
        </div>
        <div id="result-message" class="status"></div>
      </div>
    </div>
    <script src="${sdkUrl}"></script>
    <script>
      const pending = {};

      function send(message) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }

      function resultMessage(message) {
        document.querySelector("#result-message").textContent = message || "";
      }

      window.NoodPayPal = {
        resolve(requestId, value) {
          if (pending[requestId]) {
            pending[requestId].resolve(value);
            delete pending[requestId];
          }
        },
        reject(requestId, message) {
          if (pending[requestId]) {
            pending[requestId].reject(new Error(message || "PayPal request failed."));
            delete pending[requestId];
          }
        }
      };

      function requestNative(type, payload) {
        const requestId = String(Date.now()) + "-" + Math.random().toString(16).slice(2);
        send({ type, requestId, ...(payload || {}) });
        return new Promise((resolve, reject) => {
          pending[requestId] = { resolve, reject };
        });
      }

      async function createOrder() {
        const orderId = await requestNative("create-order");
        return { orderId };
      }

      const paymentSessionOptions = {
        async onApprove(data) {
          const orderID = data && (data.orderId || data.orderID || data.id);
          if (!orderID) {
            throw new Error("PayPal did not return an order ID.");
          }
          resultMessage("Finalizing payment...");
          await requestNative("capture-order", { orderID });
        },
        onCancel() {
          send({ type: "cancel" });
        },
        onError(error) {
          resultMessage("Sorry, PayPal could not process this payment.");
          send({
            type: "error",
            message: error && error.message ? error.message : String(error || "PayPal error")
          });
        }
      };

      async function configurePayPalButton(sdkInstance) {
        const paypalPaymentSession = sdkInstance.createPayPalOneTimePaymentSession(paymentSessionOptions);
        const paypalButton = document.querySelector("paypal-button");
        paypalButton.removeAttribute("hidden");
        paypalButton.addEventListener("click", async () => {
          try {
            resultMessage("");
            await paypalPaymentSession.start({ presentationMode: "auto" }, createOrder());
          } catch (error) {
            paymentSessionOptions.onError(error);
          }
        });
      }

      async function setupPayLaterButton(sdkInstance, paymentMethodDetails) {
        if (!sdkInstance.createPayLaterOneTimePaymentSession) return;
        const payLaterPaymentSession = sdkInstance.createPayLaterOneTimePaymentSession(paymentSessionOptions);
        const payLaterButton = document.querySelector("paypal-pay-later-button");
        if (paymentMethodDetails) {
          payLaterButton.productCode = paymentMethodDetails.productCode;
          payLaterButton.countryCode = paymentMethodDetails.countryCode;
        }
        payLaterButton.removeAttribute("hidden");
        payLaterButton.addEventListener("click", async () => {
          try {
            resultMessage("");
            await payLaterPaymentSession.start({ presentationMode: "auto" }, createOrder());
          } catch (error) {
            paymentSessionOptions.onError(error);
          }
        });
      }

      async function setupPayPalCreditButton(sdkInstance, paymentMethodDetails) {
        if (!sdkInstance.createPayPalCreditOneTimePaymentSession) return;
        const paypalCreditPaymentSession = sdkInstance.createPayPalCreditOneTimePaymentSession(paymentSessionOptions);
        const paypalCreditButton = document.querySelector("paypal-credit-button");
        if (paymentMethodDetails) {
          paypalCreditButton.countryCode = paymentMethodDetails.countryCode;
        }
        paypalCreditButton.removeAttribute("hidden");
        paypalCreditButton.addEventListener("click", async () => {
          try {
            resultMessage("");
            await paypalCreditPaymentSession.start({ presentationMode: "auto" }, createOrder());
          } catch (error) {
            paymentSessionOptions.onError(error);
          }
        });
      }

      async function mountButtons() {
        if (!window.paypal || !window.paypal.createInstance) {
          resultMessage("PayPal could not load. Check your internet connection.");
          send({ type: "error", message: "PayPal SDK did not load." });
          return;
        }

        try {
          const sdkInstance = await window.paypal.createInstance({
            clientId: "${escapeForScript(clientId)}",
            components: ["paypal-payments"],
            pageType: "checkout"
          });

          const paymentMethods = await sdkInstance.findEligibleMethods({
            currencyCode: "${escapeForScript(currency)}"
          });

          if (paymentMethods.isEligible("paypal")) {
            await configurePayPalButton(sdkInstance);
          }

          if (paymentMethods.isEligible("paylater")) {
            await setupPayLaterButton(sdkInstance, paymentMethods.getDetails("paylater"));
          }

          if (paymentMethods.isEligible("credit")) {
            await setupPayPalCreditButton(sdkInstance, paymentMethods.getDetails("credit"));
          }

          if (
            !paymentMethods.isEligible("paypal") &&
            !paymentMethods.isEligible("paylater") &&
            !paymentMethods.isEligible("credit")
          ) {
            throw new Error("No eligible PayPal payment methods are available for this device or currency.");
          }

          send({ type: "paypal-ready" });
        } catch (error) {
          resultMessage(error && error.message ? error.message : "PayPal setup failed.");
          send({
            type: "error",
            message: error && error.message ? error.message : String(error || "PayPal setup failed.")
          });
        }
      }

      mountButtons();
    </script>
  </body>
</html>`;
}

export default function PayPalCheckoutScreen() {
  const router = useRouter();
  const webViewRef = useRef<WebView>(null);
  const handledRef = useRef(false);
  const { total, currency } = useLocalSearchParams<{ total?: string; currency?: string }>();
  const {
    addOrder,
    cartItems = [],
    clearCart,
    convertPrice,
    formatMoney,
    selectedCurrency = BASE_CURRENCY,
  } = useCart();
  const { defaultAddress } = useAddressBook();
  const { addHistoryEvent } = useHistoryEvents();
  const { displayName, isSignedIn } = useUser();
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);

  const paymentCurrency = String(currency || selectedCurrency || BASE_CURRENCY).toUpperCase();
  const paypalCurrency = 'USD';
  const shopifyCurrency = 'TTD';
  const paymentTotal = Number(total || 0);
  const paypalAmount = useMemo(
    () => convertPrice(paymentTotal, paymentCurrency, paypalCurrency),
    [convertPrice, paymentCurrency, paymentTotal]
  );
  const shopifyAmount = useMemo(
    () => convertPrice(paymentTotal, paymentCurrency, shopifyCurrency),
    [convertPrice, paymentCurrency, paymentTotal]
  );
  const amount = useMemo(() => paypalAmount.toFixed(2), [paypalAmount]);

  const cartPayload = useMemo(
    () =>
      cartItems.map((item: any) => {
        const itemBaseCurrency = item?.baseCurrency || BASE_CURRENCY;
        const convertedUnitPrice = convertPrice(
          Number(item?.price || 0),
          itemBaseCurrency,
          shopifyCurrency
        );

        return {
          title: item?.title || 'Product',
          productId: item?.productId ? String(item.productId) : '',
          quantity: Number(item?.quantity || 1),
          price: Number(convertedUnitPrice.toFixed(2)),
          currency: shopifyCurrency,
          variantId: item?.variantId ? String(item.variantId) : '',
          image: item?.image || '',
          handle: item?.handle || '',
          variantTitle: item?.variantTitle || '',
        };
      }),
    [cartItems, convertPrice]
  );
  const checkoutCustomer = useMemo(
    () => getCheckoutCustomer({ defaultAddress, displayName, isSignedIn }),
    [defaultAddress, displayName, isSignedIn]
  );
  const paymentCustomerEmail = useMemo(
    () => getPaymentTestingEmail(checkoutCustomer.email),
    [checkoutCustomer.email]
  );

  const html = useMemo(
    () => makePayPalHtml(PAYPAL_CLIENT_ID, paypalCurrency, amount, PAYPAL_ENV),
    [amount]
  );

  const respondToWebView = (requestId: string, ok: boolean, value: string) => {
    const fn = ok ? 'resolve' : 'reject';
    webViewRef.current?.injectJavaScript(
      `window.NoodPayPal && window.NoodPayPal.${fn}(${JSON.stringify(requestId)}, ${JSON.stringify(value)}); true;`
    );
  };

  const finishSuccess = (orderId: string, captureData: any, shopifyResult: ShopifyOrderResult) => {
    if (handledRef.current) return;
    handledRef.current = true;

    const captureId =
      shopifyResult.paymentTransactionId ||
      captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      captureData?.paypal?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      captureData?.capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      captureData?.id ||
      orderId;

    addOrder({
      id: shopifyResult.shopifyOrderName || shopifyResult.shopifyOrderId || Date.now().toString(),
      date: new Date().toISOString(),
      total: paymentTotal,
      currency: paymentCurrency,
      status: 'paid',
      paymentMethod: shopifyResult.shopifyOrderName
        ? `PayPal (${shopifyResult.shopifyOrderName})`
        : `PayPal (${captureId})`,
      shopifyOrderId: shopifyResult.shopifyOrderId,
      shopifyOrderName: shopifyResult.shopifyOrderName,
      paymentTransactionId: captureId,
      customer: checkoutCustomer,
      shippingAddress: defaultAddress,
      items: cartItems,
    });
    console.log('[NOOD order] app order saved');
    console.log('[NOOD PayPal] saved app order after Shopify confirmation', {
      shopifyOrderId: shopifyResult.shopifyOrderId,
      shopifyOrderName: shopifyResult.shopifyOrderName,
      paymentTransactionId: captureId,
      items: cartItems,
      customer: checkoutCustomer,
      shippingAddress: defaultAddress,
    });
    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment completed',
      description: `PayPal payment completed for Shopify order ${shopifyResult.shopifyOrderName || shopifyResult.shopifyOrderId}.`,
      amount: paymentTotal,
      currency: paymentCurrency,
      status: 'success',
    });
    clearCart();
    console.log('[NOOD order] cart cleared');

    Alert.alert(
      'Payment Successful',
      shopifyResult.shopifyOrderName
        ? `Order ${shopifyResult.shopifyOrderName} was created successfully.`
        : 'Your PayPal payment was completed and the Shopify order was created.',
      [
      { text: 'View Orders', onPress: () => router.replace('/account/orders') },
      ]
    );
  };

  const finishFailure = (message: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    void addHistoryEvent({
      type: 'checkout',
      title: 'PayPal checkout failed',
      description: message,
      amount: paymentTotal,
      currency: paymentCurrency,
      status: 'failed',
    });
    Alert.alert('Payment Not Completed', message, [
      { text: 'Back', onPress: () => router.back() },
    ]);
  };

  const finishPaymentReceivedOrderIssue = (data: any, message?: string) => {
    if (handledRef.current) return;
    handledRef.current = true;

    const transactionId =
      data?.transaction_id ||
      data?.paypal?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      data?.capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      data?.paypal?.id ||
      '';
    const recoveryId = data?.recovery_id || '';

    addOrder({
      id: recoveryId || transactionId || Date.now().toString(),
      date: new Date().toISOString(),
      total: paymentTotal,
      currency: paymentCurrency,
      status: 'failed-paid',
      paymentMethod: transactionId ? `PayPal (${transactionId})` : 'PayPal',
      paymentTransactionId: transactionId,
      customer: checkoutCustomer,
      shippingAddress: defaultAddress,
      items: cartItems,
    });

    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment received - order needs review',
      description: `Payment was successful, but Shopify order creation needs review. Transaction ID: ${transactionId || 'not provided'}.`,
      amount: paymentTotal,
      currency: paymentCurrency,
      status: 'needs_review',
      relatedId: recoveryId || transactionId,
    });

    Alert.alert(
      'Payment Received - Order Processing Issue',
      message ||
        `Your payment was successful, but your order needs review. Please contact support with transaction ID: ${transactionId || 'not provided'}.`,
      [{ text: 'View Orders', onPress: () => router.replace('/account/orders') }]
    );
  };

  const handleCreateOrder = async (requestId: string) => {
    try {
      setIsProcessing(true);
      const itemsMissingVariantIds = cartPayload.filter((item: any) => !String(item?.variantId || '').trim());
      if (itemsMissingVariantIds.length) {
        console.log('[NOOD PayPal] blocked create order missing Shopify variantId', itemsMissingVariantIds);
        throw new Error('One or more cart items is missing its Shopify variant ID. Please remove it and add it again before checkout.');
      }
      console.log('[NOOD PayPal] create order cart line items', cartPayload);
      const data = await postBackendJson(
        '/api/orders',
        {
          total: Number(amount),
          currency: paypalCurrency,
          paypalTotalUsd: Number(amount),
          shopifyTotalTtd: Number(shopifyAmount.toFixed(2)),
          name: checkoutCustomer.name,
          email: paymentCustomerEmail,
          phone: checkoutCustomer.phone,
          cart: cartPayload,
          cartItems: cartPayload,
          shippingAddress: defaultAddress,
        },
        { timeoutMs: 45000 }
      );
      console.log('[NOOD PayPal] create order response', data);

      const orderId = data?.id || data?.orderID || data?.orderId || '';
      if (!orderId) {
        throw new Error('No PayPal order ID received from backend.');
      }

      respondToWebView(requestId, true, orderId);
    } catch (error: any) {
      const message = error?.message || 'Could not create PayPal order.';
      respondToWebView(requestId, false, message);
      Alert.alert('PayPal Error', message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCaptureOrder = async (requestId: string, orderID: string) => {
    try {
      setIsProcessing(true);
      console.log('[NOOD PayPal] capture order request', {
        orderID,
        cartItems: cartPayload,
        total: Number(amount),
        currency: paypalCurrency,
      });
      const data = await postBackendJson(
        `/api/orders/${encodeURIComponent(orderID)}/capture`,
        {
          total: Number(amount),
          currency: paypalCurrency,
          paypalTotalUsd: Number(amount),
          shopifyTotalTtd: Number(shopifyAmount.toFixed(2)),
          cart: cartPayload,
          cartItems: cartPayload,
          shippingAddress: defaultAddress,
        },
        { timeoutMs: 45000 }
      );
      console.log('[NOOD PayPal] capture/order success response', data);

      if (data?.payment_received || data?.status === 'payment_received_order_review') {
        respondToWebView(requestId, true, 'captured');
        finishPaymentReceivedOrderIssue(data);
        return;
      }

      const shopifyResult = getShopifyOrderResult(data);

      if (!shopifyResult.shopifyOrderId && !shopifyResult.shopifyOrderName) {
        respondToWebView(requestId, true, 'captured');
        finishPaymentReceivedOrderIssue(
          data,
          'Your payment was successful, but your order needs review. Please contact support with transaction ID: not provided.'
        );
        return;
      }

      respondToWebView(requestId, true, 'captured');
      finishSuccess(orderID, data, shopifyResult);
    } catch (error: any) {
      const message = error?.message || 'Could not capture PayPal payment.';
      respondToWebView(requestId, false, message);
      finishFailure(message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    let message: PayPalMessage | null = null;

    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (!message) return;

    if (message.type === 'paypal-ready') {
      setIsLoading(false);
      return;
    }

    if (message.type === 'create-order') {
      void handleCreateOrder(message.requestId);
      return;
    }

    if (message.type === 'capture-order') {
      void handleCaptureOrder(message.requestId, message.orderID);
      return;
    }

    if (message.type === 'cancel') {
      finishFailure('PayPal checkout was cancelled.');
      return;
    }

    if (message.type === 'error') {
      finishFailure(message.message || 'PayPal checkout failed.');
    }
  };

  if (!PAYPAL_CLIENT_ID) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
        <View style={styles.header}>
          <TouchableOpacity style={styles.roundButton} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={22} color="#111111" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>PayPal Checkout</Text>
          <View style={styles.roundButtonPlaceholder} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons name="logo-paypal" size={42} color="#0070ba" />
          <Text style={styles.emptyTitle}>PayPal is not configured</Text>
          <Text style={styles.emptyText}>
            Missing EXPO_PUBLIC_PAYPAL_CLIENT_ID in app .env
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={styles.header}>
        <TouchableOpacity style={styles.roundButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111111" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>PayPal Checkout</Text>
          <Text style={styles.headerSubtitle}>{formatMoney(paymentTotal, paymentCurrency)}</Text>
        </View>
        <TouchableOpacity style={styles.roundButton} onPress={() => webViewRef.current?.reload()}>
          <Ionicons name="refresh" size={20} color="#111111" />
        </TouchableOpacity>
      </View>

      <View style={styles.webviewWrap}>
        {(isLoading || isProcessing) && (
          <View style={styles.loadingOverlay}>
            <NoodSpinner size={42} />
            <Text style={styles.loadingText}>
              {isProcessing ? 'Talking to PayPal...' : 'Loading PayPal...'}
            </Text>
          </View>
        )}
        <WebView
          ref={webViewRef}
          source={{ html, baseUrl: 'https://noodcaribbean.com' }}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically
          bounces={false}
          originWhitelist={['*']}
          mixedContentMode="compatibility"
          onMessage={handleMessage}
          onLoadEnd={() => setIsLoading(false)}
          renderLoading={() => (
            <View style={styles.loadingOverlay}>
              <NoodSpinner size={42} />
            </View>
          )}
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
  headerCenter: {
    flex: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '900',
    color: '#111111',
  },
  headerSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '700',
  },
  roundButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  roundButtonPlaceholder: {
    width: 42,
  },
  webviewWrap: {
    flex: 1,
    backgroundColor: '#f6f3ef',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    backgroundColor: 'rgba(246, 243, 239, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 14,
    color: '#111111',
    fontWeight: '800',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 26,
  },
  emptyTitle: {
    marginTop: 16,
    fontSize: 22,
    color: '#111111',
    fontWeight: '900',
    textAlign: 'center',
  },
  emptyText: {
    marginTop: 8,
    fontSize: 15,
    color: '#6b7280',
    fontWeight: '700',
    lineHeight: 22,
    textAlign: 'center',
  },
});
