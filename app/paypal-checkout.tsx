import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { getConfiguredBackendUrl, getPaymentBackendUrl } from '../utils/backend';
import { BASE_CURRENCY } from '../utils/currency';
import { SHOPIFY_CHECKOUT_CURRENCY } from '../utils/checkout-totals';
import { getCheckoutSessionId, resetCheckoutSessionId } from '../utils/checkout-session';
import {
  PAYMENT_REVIEW_MESSAGE,
  validateCheckoutPrerequisites,
} from '../utils/checkout-validation';
import { getCheckoutCustomer, getPaymentCustomerEmail } from '../utils/customer';
import { PAYMENT_TESTING_MODE } from '../utils/payment-testing';
import { getCustomerProfile } from '../utils/customer-profile';
import NoodSpinner from '../components/NoodSpinner';
import { noodAlert } from '../utils/nood-alert';

const PAYPAL_CLIENT_ID = String(process.env.EXPO_PUBLIC_PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_ENV = String(process.env.EXPO_PUBLIC_PAYPAL_ENV || 'sandbox').trim().toLowerCase();
const PAYPAL_SDK_CURRENCY = 'USD';

type PayPalMessage =
  | { type: 'paypal-ready' }
  | { type: 'paypal-sdk-loaded' }
  | { type: 'paypal-rendering-buttons' }
  | { type: 'paypal-buttons-rendered' }
  | { type: 'PAYPAL_BUTTONS_RENDERED' }
  | { type: 'paypal-loading-hidden' }
  | { type: 'PAYPAL_SUCCESS'; payload?: any }
  | { type: 'PAYPAL_CANCEL'; payload?: any }
  | { type: 'PAYPAL_ERROR'; message?: string };

type ShopifyOrderResult = {
  shopifyOrderId: string;
  shopifyOrderName: string;
  paymentTransactionId: string;
};

function escapeForScript(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function getPayPalBackendUrl() {
  return getConfiguredBackendUrl() || getPaymentBackendUrl();
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

function buildPayPalSdkScriptUrl(clientId: string, paypalEnv: string) {
  const host = paypalEnv === 'live' ? 'www.paypal.com' : 'www.sandbox.paypal.com';
  const enableFunding =
    paypalEnv === 'sandbox' ? 'venmo,paylater,card' : 'venmo,paylater,card';
  const buyerCountry = paypalEnv === 'sandbox' ? '&buyer-country=US' : '';

  return `https://${host}/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${PAYPAL_SDK_CURRENCY}&intent=capture&components=buttons&enable-funding=${enableFunding}${buyerCountry}`;
}

function makePayPalHtml(
  clientId: string,
  paypalEnv: string,
  backendUrl: string,
  orderPayloadJson: string,
  capturePayloadJson: string
) {
  const sdkUrl = buildPayPalSdkScriptUrl(clientId, paypalEnv);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        min-height: 100%;
        background: #0b0b0b;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #111827;
      }
      .page {
        min-height: 100vh;
        padding: 24px 16px 32px;
        display: flex;
        align-items: flex-start;
        justify-content: center;
      }
      .paypal-card {
        width: 100%;
        max-width: 520px;
        background: #ffffff;
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      }
      .message {
        margin: 0 0 16px;
        font-size: 14px;
        line-height: 20px;
        font-weight: 600;
        color: #2c2e2f;
        text-align: left;
      }
      .paypal-p {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        margin-right: 6px;
        border-radius: 4px;
        background: #003087;
        color: #ffffff;
        font-size: 12px;
        font-weight: 900;
        vertical-align: middle;
      }
      .message a {
        color: #0070ba;
        text-decoration: none;
        font-weight: 700;
      }
      .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        min-height: 220px;
        color: #4b5563;
        font-size: 14px;
        font-weight: 700;
      }
      .loading-state[hidden],
      .loading-state.paypal-hidden {
        display: none !important;
      }
      .loading-spinner {
        width: 30px;
        height: 30px;
        border: 3px solid #e5e7eb;
        border-top-color: #0070ba;
        border-radius: 50%;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      .button-panel[hidden] {
        display: none !important;
      }
      #paypal-button-container {
        width: 100%;
        min-height: 200px;
      }
      #paypal-button-container > div,
      #paypal-button-container iframe {
        width: 100% !important;
        max-width: 100% !important;
      }
      .powered-row {
        margin-top: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        font-size: 12px;
        color: #6c7378;
        font-weight: 600;
      }
      .powered-brand {
        color: #003087;
        font-weight: 900;
        font-style: italic;
        letter-spacing: -0.2px;
      }
      #result-message {
        min-height: 20px;
        margin-top: 14px;
        padding: 10px 12px;
        border-radius: 12px;
        background: #fff4ed;
        color: #b42318;
        font-size: 13px;
        line-height: 18px;
        font-weight: 700;
        text-align: center;
      }
      #result-message.info {
        background: #eff6ff;
        color: #1d4ed8;
      }
      #result-message:empty {
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="paypal-card">
        <div class="message">
          <span class="paypal-p">P</span>
          Pay in full or eligible installments
          <br />
          <a href="https://www.paypal.com/us/webapps/mpp/pay-in-4" target="_blank" rel="noopener noreferrer">Learn more</a>
        </div>

        <div id="paypal-loading" class="loading-state">
          <div class="loading-spinner"></div>
          <span>Loading PayPal buttons...</span>
        </div>

        <div id="button-panel" class="button-panel" hidden>
          <div id="paypal-button-container"></div>
          <div class="powered-row">
            <span>Powered by</span>
            <span class="powered-brand">PayPal</span>
          </div>
        </div>

        <div id="result-message"></div>
      </div>
    </div>
    <script>
      const BACKEND_URL = "${escapeForScript(backendUrl)}";
      const ORDER_PAYLOAD = ${orderPayloadJson};
      const CAPTURE_PAYLOAD = ${capturePayloadJson};

      function postAppMessage(message) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }

      function resultMessage(message, tone) {
        const node = document.querySelector("#result-message");
        if (!node) return;
        node.textContent = message || "";
        node.classList.remove("info");
        if (tone === "info") {
          node.classList.add("info");
        }
      }

      var paypalLoadingHidden = false;

      function hidePayPalLoadingUi() {
        if (paypalLoadingHidden) {
          return;
        }
        paypalLoadingHidden = true;

        var loading = document.getElementById("paypal-loading");
        var panel = document.getElementById("button-panel");
        if (loading) {
          loading.setAttribute("hidden", "hidden");
          loading.classList.add("paypal-hidden");
          loading.style.display = "none";
        }
        if (panel) {
          panel.removeAttribute("hidden");
          panel.style.display = "block";
        }
        document.body.classList.add("paypal-ready");

        postAppMessage({ type: "PAYPAL_BUTTONS_RENDERED" });
        postAppMessage({ type: "paypal-buttons-rendered" });
        postAppMessage({ type: "paypal-loading-hidden" });
        postAppMessage({ type: "paypal-ready" });
      }

      function getErrorDetail(orderData) {
        return orderData && orderData.details && orderData.details[0]
          ? orderData.details[0]
          : null;
      }

      function formatOrderError(orderData) {
        const errorDetail = getErrorDetail(orderData);
        if (errorDetail) {
          return errorDetail.issue + " " + errorDetail.description + (orderData.debug_id ? " (" + orderData.debug_id + ")" : "");
        }
        if (orderData && orderData.message) {
          return String(orderData.message);
        }
        return JSON.stringify(orderData || {});
      }

      function isInstrumentDeclined(orderData, message) {
        const errorDetail = getErrorDetail(orderData);
        if (errorDetail && errorDetail.issue === "INSTRUMENT_DECLINED") {
          return true;
        }
        return /INSTRUMENT_DECLINED/i.test(String(message || ""));
      }

      function buildButtonHandlers() {
        return {
          createOrder: async function() {
            resultMessage("");
            const response = await fetch(BACKEND_URL + "/api/orders", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(ORDER_PAYLOAD)
            });

            const orderData = await response.json().catch(function() {
              return {};
            });

            if (orderData && orderData.id) {
              return orderData.id;
            }

            const message = formatOrderError(orderData);
            resultMessage(message);
            postAppMessage({ type: "PAYPAL_ERROR", message });
            throw new Error(message);
          },
          onApprove: async function(data, actions) {
            resultMessage("Finalizing payment...", "info");

            const response = await fetch(
              BACKEND_URL + "/api/orders/" + encodeURIComponent(data.orderID) + "/capture",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(CAPTURE_PAYLOAD)
              }
            );

            const orderData = await response.json().catch(function() {
              return {};
            });
            const errorDetail = getErrorDetail(orderData);

            if (errorDetail && errorDetail.issue === "INSTRUMENT_DECLINED") {
              resultMessage("Payment method declined. Choose another option and try again.");
              return actions.restart();
            }

            if (!response.ok || orderData.error || orderData.success === false) {
              const message = formatOrderError(orderData);
              if (isInstrumentDeclined(orderData, message) && actions && typeof actions.restart === "function") {
                resultMessage("Payment method declined. Choose another option and try again.");
                return actions.restart();
              }
              resultMessage(message);
              postAppMessage({ type: "PAYPAL_ERROR", message });
              throw new Error(message);
            }

            resultMessage("");
            postAppMessage({ type: "PAYPAL_SUCCESS", payload: orderData });
          },
          onCancel: function(data) {
            resultMessage("PayPal checkout was cancelled. Your cart is unchanged.", "info");
            postAppMessage({ type: "PAYPAL_CANCEL", payload: data || {} });
          },
          onError: function(error) {
            const message = error && error.message ? error.message : String(error || "PayPal checkout failed.");
            if (isInstrumentDeclined(null, message)) {
              resultMessage("Payment method declined. Choose another option and try again.");
              return;
            }
            resultMessage("Sorry, PayPal could not process this payment.");
            postAppMessage({ type: "PAYPAL_ERROR", message });
          }
        };
      }

      function mountPayPalButtons() {
        if (!window.paypal || !window.paypal.Buttons) {
          resultMessage("PayPal could not load. Check your internet connection.");
          postAppMessage({ type: "PAYPAL_ERROR", message: "PayPal SDK did not load." });
          return Promise.reject(new Error("PayPal SDK did not load."));
        }

        postAppMessage({ type: "paypal-rendering-buttons" });

        const container = document.querySelector("#paypal-button-container");
        container.innerHTML = "";
        const panel = document.getElementById("button-panel");
        if (panel) {
          panel.removeAttribute("hidden");
          panel.style.display = "block";
        }
        const handlers = buildButtonHandlers();
        const fundingButtons = [
          {
            fundingSource: window.paypal.FUNDING.PAYPAL,
            style: { shape: "rect", layout: "vertical", color: "gold", label: "paypal", height: 50, tagline: false }
          },
          {
            fundingSource: window.paypal.FUNDING.VENMO,
            style: { shape: "rect", layout: "vertical", color: "blue", height: 50, tagline: false }
          },
          {
            fundingSource: window.paypal.FUNDING.PAYLATER,
            style: { shape: "rect", layout: "vertical", color: "gold", height: 50, tagline: false }
          },
          {
            fundingSource: window.paypal.FUNDING.CARD,
            style: { shape: "rect", layout: "vertical", color: "black", height: 50, tagline: false }
          }
        ];

        const renderJobs = [];

        fundingButtons.forEach(function(entry) {
          const button = window.paypal.Buttons(Object.assign({}, handlers, {
            fundingSource: entry.fundingSource,
            style: entry.style
          }));

          if (!button.isEligible || !button.isEligible()) {
            return;
          }

          renderJobs.push(button.render(container));
        });

        if (!renderJobs.length) {
          renderJobs.push(
            window.paypal.Buttons(Object.assign({}, handlers, {
              style: {
                shape: "rect",
                layout: "vertical",
                color: "gold",
                label: "paypal",
                height: 50,
                tagline: false
              }
            })).render(container)
          );
        }

        var loadingFallbackTimer = setTimeout(function() {
          if (container && container.children.length) {
            hidePayPalLoadingUi();
          }
        }, 4000);

        return Promise.all(renderJobs)
          .then(function() {
            clearTimeout(loadingFallbackTimer);
            hidePayPalLoadingUi();
          })
          .catch(function(error) {
            clearTimeout(loadingFallbackTimer);
            if (container && container.children.length) {
              hidePayPalLoadingUi();
              return;
            }
            throw error;
          });
      }

      function onPayPalSdkLoaded() {
        postAppMessage({ type: "paypal-sdk-loaded" });
        mountPayPalButtons().catch(function(error) {
          const message = error && error.message ? error.message : "PayPal buttons could not be rendered.";
          resultMessage(message);
          postAppMessage({ type: "PAYPAL_ERROR", message });
        });
      }

      function onPayPalSdkError() {
        var loading = document.getElementById("paypal-loading");
        if (loading) {
          loading.setAttribute("hidden", "hidden");
          loading.classList.add("paypal-hidden");
          loading.style.display = "none";
        }
        resultMessage("PayPal SDK failed to load. Check your connection and try again.");
        postAppMessage({ type: "PAYPAL_ERROR", message: "PayPal SDK failed to load." });
      }
    </script>
    <script src="${sdkUrl}" onload="onPayPalSdkLoaded()" onerror="onPayPalSdkError()"></script>
  </body>
</html>`;
}

export default function PayPalCheckoutScreen() {
  const router = useRouter();
  const webViewRef = useRef<WebView>(null);
  const handledRef = useRef(false);
  const payPalLoadingHiddenRef = useRef(false);
  const { checkoutSessionId: checkoutSessionIdParam } = useLocalSearchParams<{
    checkoutSessionId?: string;
  }>();
  const {
    addOrder,
    cartItems = [],
    checkoutTotals,
    clearCart,
    convertPrice,
    formatMoney,
    selectedCurrency = BASE_CURRENCY,
  } = useCart();
  const { defaultAddress, loadingAddresses } = useAddressBook();
  const { addHistoryEvent } = useHistoryEvents();
  const { displayName, isSignedIn } = useUser();
  const [isLoading, setIsLoading] = useState(true);
  const [setupWarning, setSetupWarning] = useState('');
  const [profileEmail, setProfileEmail] = useState('');

  const checkoutSessionId = String(checkoutSessionIdParam || '').trim() || getCheckoutSessionId();
  const total = checkoutTotals.total;
  const cartPayload = checkoutTotals.cartLines;
  const displayTotal = useMemo(
    () => convertPrice(total, SHOPIFY_CHECKOUT_CURRENCY, selectedCurrency),
    [convertPrice, selectedCurrency, total]
  );

  useEffect(() => {
    console.log('[NOOD paypal] screen mounted');
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      setProfileEmail('');
      return;
    }

    void getCustomerProfile().then((profile) => {
      setProfileEmail(String(profile?.email || '').trim());
    });
  }, [isSignedIn]);

  const checkoutCustomer = useMemo(
    () => getCheckoutCustomer({ defaultAddress, displayName, isSignedIn, profileEmail }),
    [defaultAddress, displayName, isSignedIn, profileEmail]
  );
  const paymentCustomerEmail = getPaymentCustomerEmail(checkoutCustomer.email);

  const backendUrl = useMemo(() => getPayPalBackendUrl(), []);

  const orderPayload = useMemo(
    () => ({
      checkoutSessionId,
      clientOrderId: checkoutSessionId,
      total: Number(total.toFixed(2)),
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      shopifyTotalTtd: Number(total.toFixed(2)),
      name: checkoutCustomer.name,
      email: paymentCustomerEmail,
      phone: checkoutCustomer.phone,
      cart: cartPayload,
      cartItems: cartPayload,
      shippingAddress: defaultAddress,
    }),
    [
      cartPayload,
      checkoutCustomer.name,
      checkoutCustomer.phone,
      checkoutSessionId,
      defaultAddress,
      paymentCustomerEmail,
      total,
    ]
  );

  const capturePayload = useMemo(
    () => ({
      checkoutSessionId,
      clientOrderId: checkoutSessionId,
      total: Number(total.toFixed(2)),
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      shopifyTotalTtd: Number(total.toFixed(2)),
      cart: cartPayload,
      cartItems: cartPayload,
      shippingAddress: defaultAddress,
    }),
    [cartPayload, checkoutSessionId, defaultAddress, total]
  );

  const html = useMemo(
    () =>
      makePayPalHtml(
        PAYPAL_CLIENT_ID,
        PAYPAL_ENV,
        backendUrl,
        JSON.stringify(orderPayload),
        JSON.stringify(capturePayload)
      ),
    [backendUrl, capturePayload, orderPayload]
  );

  useEffect(() => {
    const validation = validateCheckoutPrerequisites({
      cartItems,
      defaultAddress,
      profileEmail,
      loadingAddresses,
      requireEmail: !PAYMENT_TESTING_MODE,
    });

    if (!validation.ok) {
      const reason = validation.message || validation.title || 'Checkout unavailable';
      console.log('[NOOD paypal] setup issue:', reason);
      setSetupWarning(reason);
      return;
    }

    if (!PAYPAL_CLIENT_ID) {
      console.log('[NOOD paypal] setup issue: PayPal client ID missing');
      setSetupWarning('Missing EXPO_PUBLIC_PAYPAL_CLIENT_ID in app .env');
      return;
    }

    if (!backendUrl) {
      console.log('[NOOD paypal] setup issue: backend URL missing');
      setSetupWarning('Payment backend URL is not configured.');
      return;
    }

    setSetupWarning('');
  }, [backendUrl, cartItems, defaultAddress, loadingAddresses, profileEmail]);

  const finishSuccess = (captureData: any, shopifyResult: ShopifyOrderResult) => {
    if (handledRef.current) return;
    handledRef.current = true;

    const captureId =
      shopifyResult.paymentTransactionId ||
      captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      captureData?.paypal?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      captureData?.capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      captureData?.id ||
      '';

    addOrder({
      id: shopifyResult.shopifyOrderName || shopifyResult.shopifyOrderId || Date.now().toString(),
      date: new Date().toISOString(),
      total,
      currency: SHOPIFY_CHECKOUT_CURRENCY,
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
    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment completed',
      description: `PayPal payment completed for Shopify order ${shopifyResult.shopifyOrderName || shopifyResult.shopifyOrderId}.`,
      amount: total,
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      status: 'success',
    });
    clearCart();
    resetCheckoutSessionId();

    noodAlert(
      'Payment Successful',
      shopifyResult.shopifyOrderName
        ? `Order ${shopifyResult.shopifyOrderName} was created successfully.`
        : 'Your PayPal payment was completed and the Shopify order was created.',
      [{ text: 'View Orders', onPress: () => router.replace('/account/orders') }]
    );
  };

  const finishFailure = (message: string) => {
    void addHistoryEvent({
      type: 'checkout',
      title: 'PayPal checkout failed',
      description: message,
      amount: total,
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      status: 'failed',
    });
    noodAlert('Payment Not Completed', message, [{ text: 'Back', onPress: () => router.back() }]);
  };

  const finishPaymentReceivedOrderIssue = (data: any) => {
    if (handledRef.current) return;
    handledRef.current = true;

    const transactionId =
      data?.transaction_id ||
      data?.paypal?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      data?.capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      data?.paypal?.id ||
      '';

    void addHistoryEvent({
      type: 'checkout',
      title: 'Payment received - order needs review',
      description: `${PAYMENT_REVIEW_MESSAGE} Transaction ID: ${transactionId || 'not provided'}.`,
      amount: total,
      currency: SHOPIFY_CHECKOUT_CURRENCY,
      status: 'needs_review',
      relatedId: data?.recovery_id || transactionId,
    });

    noodAlert(
      'Payment Received - Order Processing Issue',
      transactionId
        ? `${PAYMENT_REVIEW_MESSAGE} ${transactionId}`
        : PAYMENT_REVIEW_MESSAGE,
      [{ text: 'Back to Checkout', onPress: () => router.back() }]
    );
  };

  const handlePayPalSuccess = (payload: any) => {
    if (payload?.payment_received || payload?.status === 'payment_received_order_review') {
      finishPaymentReceivedOrderIssue(payload);
      return;
    }

    const shopifyResult = getShopifyOrderResult(payload);

    if (!shopifyResult.shopifyOrderId && !shopifyResult.shopifyOrderName) {
      finishPaymentReceivedOrderIssue(payload);
      return;
    }

    finishSuccess(payload, shopifyResult);
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    let message: PayPalMessage | null = null;

    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (!message) return;

    if (message.type === 'paypal-sdk-loaded') {
      console.log('[NOOD paypal] sdk loaded');
      return;
    }

    if (message.type === 'paypal-rendering-buttons') {
      console.log('[NOOD paypal] rendering buttons');
      return;
    }

    if (message.type === 'paypal-buttons-rendered' || message.type === 'PAYPAL_BUTTONS_RENDERED') {
      console.log('[NOOD paypal] buttons rendered');
      return;
    }

    if (message.type === 'paypal-loading-hidden' || message.type === 'paypal-ready') {
      if (!payPalLoadingHiddenRef.current) {
        payPalLoadingHiddenRef.current = true;
        console.log('[NOOD paypal] loading hidden');
        setIsLoading(false);
      }
      return;
    }

    if (message.type === 'PAYPAL_SUCCESS') {
      setIsLoading(false);
      handlePayPalSuccess(message.payload);
      return;
    }

    if (message.type === 'PAYPAL_CANCEL') {
      setIsLoading(false);
      void addHistoryEvent({
        type: 'checkout',
        title: 'PayPal checkout cancelled',
        description: 'Buyer cancelled PayPal before payment completed.',
        amount: total,
        currency: SHOPIFY_CHECKOUT_CURRENCY,
        status: 'cancelled',
      });
      return;
    }

    if (message.type === 'PAYPAL_ERROR') {
      payPalLoadingHiddenRef.current = true;
      setIsLoading(false);
      void addHistoryEvent({
        type: 'checkout',
        title: 'PayPal checkout error',
        description: message.message || 'PayPal checkout failed.',
        amount: total,
        currency: SHOPIFY_CHECKOUT_CURRENCY,
        status: 'failed',
      });
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
          <Text style={styles.headerTitle}>Pay with PayPal / Card</Text>
          <Text style={styles.headerSubtitle}>{formatMoney(displayTotal, selectedCurrency)}</Text>
        </View>
        <TouchableOpacity
          style={styles.roundButton}
          onPress={() => {
            payPalLoadingHiddenRef.current = false;
            setIsLoading(true);
            webViewRef.current?.reload();
          }}
        >
          <Ionicons name="refresh" size={20} color="#111111" />
        </TouchableOpacity>
      </View>

      {!!setupWarning ? (
        <View style={styles.setupWarningBanner}>
          <Text style={styles.setupWarningText}>{setupWarning}</Text>
        </View>
      ) : null}

      <View style={styles.webviewWrap}>
        {isLoading && (
          <View style={styles.loadingOverlay}>
            <NoodSpinner size={42} />
            <Text style={styles.loadingText}>Loading PayPal...</Text>
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
          onLoadStart={() => {
            payPalLoadingHiddenRef.current = false;
            setIsLoading(true);
          }}
          onLoadEnd={() => {
            console.log('[NOOD paypal] webview html loaded');
          }}
          onError={(event) => {
            console.log(
              '[NOOD paypal] webview load error',
              event.nativeEvent.description || event.nativeEvent
            );
          }}
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
  setupWarningBanner: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#fff4ed',
    borderWidth: 1,
    borderColor: '#ffd6bf',
  },
  setupWarningText: {
    color: '#9a3412',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  webviewWrap: {
    flex: 1,
    backgroundColor: '#0b0b0b',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    backgroundColor: 'rgba(11, 11, 11, 0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 14,
    color: '#ffffff',
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