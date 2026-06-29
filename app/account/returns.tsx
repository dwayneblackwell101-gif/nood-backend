import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import NoodSpinner from '../../components/NoodSpinner';
import { useCart } from '../../context/CartContext';
import { useUser } from '../../context/UserContext';
import { type CustomerOrder } from '../../utils/customer-orders';
import { getCustomerProfile } from '../../utils/customer-profile';
import {
  getEligibleOrders,
  getOrderEligibility,
  getOrderItems,
  RETURN_WINDOW_DAYS,
} from '../../utils/order-refund-eligibility';
import {
  syncApprovedReturnRefunds,
  syncReturnRequestsWithBackend,
  syncReturnRequestsWithShopifyRefunds,
  submitReturnRequest,
} from '../../utils/refund-processing';
import { PAYMENT_TEST_CUSTOMER_EMAIL } from '../../utils/payment-testing';
import {
  clearUnconfirmedReturnRequests,
  getCustomerStorageKey,
  getRefundDestinationLabel,
  getRefundRequestHeadline,
  getReturnStatusColor,
  getReturnStatusLabel,
  resetLocalRefundCache,
  RefundMethod,
  ReturnRequest,
  ReturnRequestItem,
} from '../../utils/return-requests';
import { BASE_CURRENCY } from '../../utils/currency';
import { noodAlert } from '../../utils/nood-alert';
import { ACCOUNT_SIGN_IN_GATE_DISABLED } from '../../components/RequireSignIn';

const REASON_OPTIONS = [
  'Wrong item received',
  'Damaged or defective',
  'Not as described',
  'Missing items',
  'Late delivery',
  'Changed my mind',
  'Other',
];

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/72x72.png?text=NOOD';

function formatOrderNumber(order: any): string {
  const raw = String(order?.shopifyOrderName || order?.id || '').trim();
  if (!raw) {
    return 'Order';
  }

  return raw.startsWith('#') ? raw : `#${raw}`;
}

function getFulfillmentStatus(order: any): string {
  if (order?.fulfillmentStatus) {
    return String(order.fulfillmentStatus);
  }

  return (
    order?.fulfillment_status ||
    order?.fulfillment?.status ||
    order?.fulfillments?.[0]?.status ||
    (order?.trackingNumber || order?.tracking_number ? 'Shipped' : 'Preparing shipment')
  );
}

function getPaidStatus(order: any): string {
  const financialStatus = String(order?.displayFinancialStatus || order?.financialStatus || '')
    .trim()
    .toUpperCase();

  if (financialStatus === 'PARTIALLY_REFUNDED') {
    return 'Partially refunded';
  }

  if (financialStatus === 'REFUNDED') {
    return 'Refunded';
  }

  if (order?.financialStatus) {
    return String(order.financialStatus);
  }

  const status = String(order?.status || '').trim();
  if (status.toLowerCase() === 'partially refunded') {
    return 'Partially refunded';
  }

  if (order?.refunded || status.toLowerCase() === 'refunded') {
    return 'Refunded';
  }

  return status || 'Paid';
}

function findOrderByLinkId(orders: CustomerOrder[], linkedOrderId: string): CustomerOrder | undefined {
  const needle = String(linkedOrderId || '').trim();
  if (!needle) {
    return undefined;
  }

  const normalizedNeedle = needle.replace(/^#/, '');

  return orders.find((order) => {
    const id = String(order.id || '').trim();
    const name = String(order.shopifyOrderName || '').trim();
    const shopifyId = String(order.shopifyOrderId || '').trim();

    return (
      id === needle ||
      name === needle ||
      shopifyId === needle ||
      id.replace(/^#/, '') === normalizedNeedle ||
      name.replace(/^#/, '') === normalizedNeedle
    );
  });
}

function GuestReturnsState() {
  const router = useRouter();

  const goToSignIn = () => {
    router.replace('/(tabs)/account' as any);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Returns & refunds</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.guestStateWrap}>
        <View style={styles.guestIconWrap}>
          <Ionicons name="return-down-back-outline" size={36} color="#ff6a00" />
        </View>
        <Text style={styles.guestTitle}>Sign in to view returns and refunds</Text>
        <Text style={styles.guestSubtitle}>
          Your eligible orders and refund requests will appear here after you sign in.
        </Text>
        <TouchableOpacity style={styles.guestButton} activeOpacity={0.9} onPress={goToSignIn}>
          <Ionicons name="person-circle-outline" size={18} color="#fff" />
          <Text style={styles.guestButtonText}>Go to sign in</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function ReturnsContent() {
  const router = useRouter();
  const { orderId: linkedOrderId } = useLocalSearchParams<{ orderId?: string }>();
  const { profileId, isSignedIn } = useUser();
  const {
    orders: visibleOrders = [],
    refreshOrdersFromShopify,
    ordersSyncing = false,
    formatMoney,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    refundToBalance,
    markOrderRefunded,
  } = useCart();

  const [customerEmail, setCustomerEmail] = useState('');
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [requestsReady, setRequestsReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [activeOrder, setActiveOrder] = useState<any | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [selectedReason, setSelectedReason] = useState('');
  const [notes, setNotes] = useState('');
  const [refundMethod, setRefundMethod] = useState<RefundMethod>('original_payment');
  const [clearingStaleCache, setClearingStaleCache] = useState(false);
  const linkedOrderOpenedRef = useRef(false);

  const canAccessReturns = isSignedIn || ACCOUNT_SIGN_IN_GATE_DISABLED;

  const customerKey = useMemo(
    () => getCustomerStorageKey(profileId, customerEmail, canAccessReturns),
    [canAccessReturns, customerEmail, profileId]
  );

  const sortedOrders = useMemo(
    () =>
      (Array.isArray(visibleOrders) ? visibleOrders : [])
        .slice()
        .sort((a: CustomerOrder, b: CustomerOrder) => {
          const aTime = new Date(a?.date || a?.createdAt || 0).getTime();
          const bTime = new Date(b?.date || b?.createdAt || 0).getTime();
          return bTime - aTime;
        }),
    [visibleOrders]
  );

  const eligibleOrders = useMemo(
    () => getEligibleOrders(sortedOrders, requests),
    [requests, sortedOrders]
  );

  const displayMoney = useCallback(
    (amount: number, fromCurrency = BASE_CURRENCY) =>
      formatMoney(
        convertPrice(Number(amount || 0), fromCurrency || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      ),
    [convertPrice, formatMoney, selectedCurrency]
  );

  const loadCustomer = useCallback(async () => {
    if (!canAccessReturns) {
      setCustomerEmail('');
      return;
    }

    const profile = await getCustomerProfile();
    setCustomerEmail(
      profile?.email || (ACCOUNT_SIGN_IN_GATE_DISABLED ? PAYMENT_TEST_CUSTOMER_EMAIL : '')
    );
  }, [canAccessReturns]);

  const loadRequests = useCallback(
    async (ordersSnapshot = sortedOrders) => {
      if (!customerKey) {
        setRequests([]);
        setRequestsReady(true);
        return [];
      }

      setRequestsReady(false);
      const synced = await syncReturnRequestsWithBackend(customerKey, customerEmail);
      const withShopifyRefunds = await syncReturnRequestsWithShopifyRefunds(
        customerKey,
        ordersSnapshot
      );
      const finalRequests = withShopifyRefunds.length ? withShopifyRefunds : synced;
      setRequests(finalRequests);
      setRequestsReady(true);
      return finalRequests;
    },
    [customerEmail, customerKey, sortedOrders]
  );

  const syncApprovedRefunds = useCallback(async () => {
    if (!canAccessReturns || !customerKey || !refundToBalance) {
      return;
    }

    await syncApprovedReturnRefunds(
      customerKey,
      sortedOrders,
      refundToBalance,
      markOrderRefunded
    );
    await loadRequests();
  }, [canAccessReturns, customerKey, loadRequests, markOrderRefunded, refundToBalance, sortedOrders]);

  useEffect(() => {
    console.log('[RETURNS PAGE ORDERS LOAD]', {
      orderCount: sortedOrders.length,
      ordersSyncing,
      canAccessReturns,
      customerKey,
      orderNumbers: sortedOrders.map((order) => order.shopifyOrderName || order.id),
    });
  }, [canAccessReturns, customerKey, ordersSyncing, sortedOrders]);

  useEffect(() => {
    const eligibilityReport = sortedOrders.map((order) => {
      const eligibility = getOrderEligibility(order, requests);
      return {
        order: order.shopifyOrderName || order.id,
        eligible: eligibility.eligible,
        reason: eligibility.label,
      };
    });

    console.log('[RETURNS ELIGIBLE ORDERS]', {
      eligibleCount: eligibleOrders.length,
      orderCount: sortedOrders.length,
      eligible: eligibleOrders.map((order) => order.shopifyOrderName || order.id),
      report: eligibilityReport,
    });
  }, [eligibleOrders, requests, sortedOrders]);

  useEffect(() => {
    if (!canAccessReturns) {
      setCustomerEmail('');
      setRequests([]);
      setActiveOrder(null);
      setModalVisible(false);
      return;
    }

    void loadCustomer();
  }, [canAccessReturns, loadCustomer]);

  useEffect(() => {
    if (!canAccessReturns || !customerKey) {
      return;
    }

    void loadRequests();
  }, [canAccessReturns, customerEmail, customerKey, loadRequests]);

  useFocusEffect(
    useCallback(() => {
      if (!canAccessReturns) {
        setRequests([]);
        return;
      }

      const refreshReturns = async () => {
        console.log('[RETURNS PAGE ORDERS LOAD]', {
          source: 'focus_refresh',
          orderCount: sortedOrders.length,
        });
        const refreshedOrders = (await refreshOrdersFromShopify?.()) || sortedOrders;
        await loadCustomer();
        await loadRequests(refreshedOrders);
        await syncApprovedRefunds();
      };

      void refreshReturns();
    }, [
      canAccessReturns,
      loadCustomer,
      loadRequests,
      refreshOrdersFromShopify,
      sortedOrders,
      syncApprovedRefunds,
    ])
  );

  const handleClearStaleRefundCache = useCallback(async () => {
    if (!customerKey) {
      return;
    }

    try {
      setClearingStaleCache(true);
      await resetLocalRefundCache(customerKey);
      const refreshedOrders = (await refreshOrdersFromShopify?.()) || sortedOrders;
      await loadRequests(refreshedOrders);
      noodAlert('Cache cleared', 'Stale local refund requests were removed. Eligibility refreshed.');
    } catch (error) {
      console.log('[REFUND STALE LOCAL CLEARED]', { failed: true, error });
      noodAlert('Could not clear cache', 'Please try again.');
    } finally {
      setClearingStaleCache(false);
    }
  }, [customerKey, loadRequests, refreshOrdersFromShopify, sortedOrders]);

  const resetRefundModalDraft = useCallback(() => {
    setSelectedItemIds([]);
    setSelectedReason('');
    setNotes('');
    setRefundMethod('original_payment');
    setSubmitting(false);
  }, []);

  const refreshRequestsForEligibility = useCallback(async () => {
    if (!customerKey) {
      return [] as ReturnRequest[];
    }

    const { kept, removedCount } = await clearUnconfirmedReturnRequests(customerKey);
    if (removedCount > 0) {
      setRequests(kept);
    }

    const synced = await syncReturnRequestsWithBackend(customerKey, customerEmail);
    const nextRequests = synced;
    setRequests(nextRequests);
    return nextRequests;
  }, [customerEmail, customerKey]);

  const openRequestModal = useCallback(
    async (order: any) => {
      setSubmitting(false);

      console.log('[NOOD refund] eligibility check start', {
        orderId: order?.id,
        orderName: order?.shopifyOrderName,
        shopifyOrderId: order?.shopifyOrderId,
        phase: 'modal_open',
      });

      const latestRequests = await refreshRequestsForEligibility();
      const eligibility = getOrderEligibility(order, latestRequests);

      console.log('[NOOD refund] modal opened', {
        orderId: order?.id,
        orderName: order?.shopifyOrderName,
        shopifyOrderId: order?.shopifyOrderId,
      });
      console.log('[NOOD refund] eligibility result', eligibility);

      if (!eligibility.eligible) {
        noodAlert('Not eligible', eligibility.detail);
        return;
      }

      const items = getOrderItems(order);
      setActiveOrder(order);
      setSelectedItemIds(items.map((item) => item.id));
      setSelectedReason('');
      setNotes('');
      setRefundMethod('original_payment');
      setModalVisible(true);
    },
    [refreshRequestsForEligibility]
  );

  useEffect(() => {
    linkedOrderOpenedRef.current = false;
  }, [linkedOrderId]);

  useEffect(() => {
    if (!linkedOrderId || !sortedOrders.length || !requestsReady || linkedOrderOpenedRef.current) {
      return;
    }

    const linkedOrder = findOrderByLinkId(sortedOrders, String(linkedOrderId));
    if (linkedOrder) {
      linkedOrderOpenedRef.current = true;
      void openRequestModal(linkedOrder);
    }
  }, [linkedOrderId, openRequestModal, requestsReady, sortedOrders]);

  const closeRequestModal = useCallback(() => {
    console.log('[NOOD refund] modal closed reset draft');
    setModalVisible(false);
    setActiveOrder(null);
    resetRefundModalDraft();

    if (linkedOrderId) {
      router.setParams({ orderId: undefined } as any);
    }
  }, [linkedOrderId, resetRefundModalDraft, router]);

  const toggleItem = (itemId: string) => {
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
  };

  const selectedItems = useMemo(() => {
    if (!activeOrder) {
      return [] as ReturnRequestItem[];
    }

    return getOrderItems(activeOrder).filter((item) => selectedItemIds.includes(item.id));
  }, [activeOrder, selectedItemIds]);

  const requestAmount = useMemo(() => {
    if (!activeOrder) {
      return 0;
    }

    const orderItems = getOrderItems(activeOrder);
    if (!orderItems.length || selectedItems.length === orderItems.length) {
      return Number(activeOrder.total || 0);
    }

    const perItemAmount = Number(activeOrder.total || 0) / Math.max(orderItems.length, 1);
    return perItemAmount * selectedItems.length;
  }, [activeOrder, selectedItems]);

  const submitRequest = async () => {
    if (!activeOrder || (!customerKey && !ACCOUNT_SIGN_IN_GATE_DISABLED)) {
      if (!ACCOUNT_SIGN_IN_GATE_DISABLED) {
        noodAlert('Sign in required', 'Sign in on Account to submit a return or refund request.');
      }
      return;
    }

    if (!selectedItems.length) {
      noodAlert('Items required', 'Select at least one item to return or refund.');
      return;
    }

    if (!selectedReason.trim()) {
      noodAlert('Reason required', 'Choose why you are requesting a return or refund.');
      return;
    }

    try {
      setSubmitting(true);
      console.log('[NOOD refund] submitting true');
      console.log('[NOOD refund] submit started', {
        orderId: activeOrder.id,
        orderName: activeOrder.shopifyOrderName,
        shopifyOrderId: activeOrder.shopifyOrderId,
      });

      console.log('[NOOD refund] eligibility check start', {
        orderId: activeOrder.id,
        orderName: activeOrder.shopifyOrderName,
        shopifyOrderId: activeOrder.shopifyOrderId,
        phase: 'submit',
        selectedItemCount: selectedItemIds.length,
      });

      const latestRequests = await refreshRequestsForEligibility();
      const submitEligibility = getOrderEligibility(activeOrder, latestRequests, selectedItemIds);
      console.log('[NOOD refund] eligibility result', submitEligibility);

      if (!submitEligibility.eligible) {
        noodAlert('Not eligible', submitEligibility.detail);
        return;
      }

      const result = await submitReturnRequest(
        customerKey,
        {
          orderId: String(activeOrder.id),
          orderNumber: String(activeOrder.shopifyOrderName || activeOrder.id),
          reason: selectedReason.trim(),
          notes: notes.trim(),
          items: selectedItems,
          refundMethod,
          amount: requestAmount,
          currency: String(activeOrder.currency || BASE_CURRENCY),
          paymentMethod: String(activeOrder.paymentMethod || 'Checkout'),
          paymentTransactionId: activeOrder.paymentTransactionId
            ? String(activeOrder.paymentTransactionId)
            : undefined,
          shopifyOrderId: activeOrder.shopifyOrderId ? String(activeOrder.shopifyOrderId) : undefined,
        },
        activeOrder as CustomerOrder,
        customerEmail
      );

      if (!result.saved) {
        console.log('[NOOD refund] pending request saved', false);
        noodAlert('Request not submitted', result.message);
        return;
      }

      console.log('[NOOD refund] pending request saved', true);
      await loadRequests();
      closeRequestModal();

      const destination =
        refundMethod === 'wallet'
          ? 'NOOD Wallet only after approval'
          : 'your original payment method only after the real provider refund succeeds';

      noodAlert(
        'Request submitted',
        `${result.message} Status: Pending review. If approved, your refund will go to ${destination}.`
      );
    } catch (error) {
      console.log('[NOOD refund] backend create fail', { reason: 'local_save_error', error });
      console.log('[NOOD refund] pending request saved', false);
      noodAlert('Could not save request', 'Please try again.');
    } finally {
      setSubmitting(false);
      console.log('[NOOD refund] submitting false in finally');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Returns & refunds</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>How refunds work</Text>
          <Text style={styles.infoText}>
            Choose an eligible order, select the items, and tell us why you need a return or refund.
            Requests are reviewed before any money is returned.
          </Text>

          <View style={styles.destinationRow}>
            <View style={styles.destinationCard}>
              <Ionicons name="card-outline" size={18} color="#0070ba" />
              <Text style={styles.destinationTitle}>Original payment method</Text>
              <Text style={styles.destinationCopy}>
                PayPal, WiPay, Shopify checkout, or the method used at purchase.
              </Text>
            </View>
            <View style={styles.destinationCard}>
              <Ionicons name="wallet-outline" size={18} color="#ff6a00" />
              <Text style={styles.destinationTitle}>NOOD Wallet</Text>
              <Text style={styles.destinationCopy}>
                Approved wallet refunds appear as green credit in your wallet activity.
              </Text>
            </View>
          </View>

          <Text style={styles.windowNote}>
            Eligible orders can be requested within {RETURN_WINDOW_DAYS} days of purchase.
          </Text>

          <TouchableOpacity
            style={styles.clearCacheBtn}
            activeOpacity={0.88}
            disabled={clearingStaleCache}
            onPress={() => void handleClearStaleRefundCache()}
          >
            <Ionicons name="refresh-outline" size={16} color="#5c31ff" />
            <Text style={styles.clearCacheBtnText}>
              {clearingStaleCache ? 'Refreshing eligibility...' : 'Clear stale refund cache'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Eligible orders</Text>

          {eligibleOrders.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconWrap}>
                <Ionicons name="cube-outline" size={30} color="#ff6a00" />
              </View>
              <Text style={styles.emptyTitle}>
                {sortedOrders.length === 0
                  ? 'No orders eligible for return or refund yet'
                  : 'No eligible orders right now'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {sortedOrders.length === 0
                  ? 'Orders you place will appear here.'
                  : 'Paid orders within 30 days without an open request will appear here.'}
              </Text>
            </View>
          ) : (
            eligibleOrders.map((order: any) => {
              const eligibility = getOrderEligibility(order, requests);
              const items = getOrderItems(order);
              const orderNumber = formatOrderNumber(order);
              const orderDate = order?.date ? new Date(order.date).toLocaleDateString() : 'Recent';
              const fulfillmentStatus = getFulfillmentStatus(order);
              const paidStatus = getPaidStatus(order);

              return (
                <TouchableOpacity
                  key={String(order.id)}
                  style={[styles.orderCard, styles.orderCardEligible]}
                  activeOpacity={0.9}
                  onPress={() => void openRequestModal(order)}
                >
                  <View style={styles.orderTopRow}>
                    <View style={styles.orderTitleWrap}>
                      <Text style={styles.orderNumber}>Order {orderNumber}</Text>
                      <Text style={styles.orderDate}>{orderDate}</Text>
                    </View>
                    <View
                      style={[
                        styles.eligibilityBadge,
                        {
                          backgroundColor: '#eaf8f0',
                          borderColor: '#bfe8cf',
                        },
                      ]}
                    >
                      <Text style={[styles.eligibilityBadgeText, { color: '#22a06b' }]}>
                        {eligibility.label}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.orderMetaRow}>
                    <Text style={styles.orderMetaLabel}>Total</Text>
                    <Text style={styles.orderMetaValue}>
                      {displayMoney(Number(order.total || 0), order.currency || BASE_CURRENCY)}
                    </Text>
                  </View>
                  <View style={styles.orderMetaRow}>
                    <Text style={styles.orderMetaLabel}>Payment</Text>
                    <Text style={styles.orderMetaValue} numberOfLines={1}>
                      {order.paymentMethod || 'Checkout'}
                    </Text>
                  </View>
                  <View style={styles.orderMetaRow}>
                    <Text style={styles.orderMetaLabel}>Fulfillment</Text>
                    <Text style={styles.orderMetaValue}>{fulfillmentStatus}</Text>
                  </View>
                  <View style={styles.orderMetaRow}>
                    <Text style={styles.orderMetaLabel}>Paid status</Text>
                    <Text style={styles.orderMetaValue}>{paidStatus}</Text>
                  </View>

                  {items.length ? (
                    <View style={styles.itemsPreview}>
                      {items.slice(0, 2).map((item) => (
                        <View key={item.id} style={styles.itemPreviewRow}>
                          <Image
                            source={{ uri: item.image || PLACEHOLDER_IMAGE }}
                            style={styles.itemPreviewImage}
                          />
                          <Text style={styles.itemPreviewText} numberOfLines={1}>
                            {item.title} x{item.quantity}
                          </Text>
                        </View>
                      ))}
                      {items.length > 2 ? (
                        <Text style={styles.moreItemsText}>+{items.length - 2} more items</Text>
                      ) : null}
                    </View>
                  ) : null}

                  <Text style={styles.eligibilityDetail}>{eligibility.detail}</Text>

                  <View style={styles.requestCta}>
                    <Text style={styles.requestCtaText}>Request return or refund</Text>
                    <Ionicons name="chevron-forward" size={16} color="#ff6a00" />
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Your requests</Text>

          {requests.length === 0 ? (
            <Text style={styles.requestsEmpty}>No return or refund requests yet.</Text>
          ) : (
            requests.map((request) => (
              <View key={request.id} style={styles.requestCard}>
                <View style={styles.requestTop}>
                  <Text style={styles.requestOrder}>Order #{request.orderNumber || request.orderId}</Text>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: `${getReturnStatusColor(request.status)}14` },
                    ]}
                  >
                    <Text style={[styles.statusBadgeText, { color: getReturnStatusColor(request.status) }]}>
                      {getReturnStatusLabel(request.status)}
                    </Text>
                  </View>
                </View>

                {request.status === 'pending_review' ? (
                  <Text style={styles.requestHeadline}>{getRefundRequestHeadline(request)}</Text>
                ) : null}

                <View style={styles.requestMetaGrid}>
                  <View style={styles.requestMetaItem}>
                    <Text style={styles.requestMetaLabel}>Requested</Text>
                    <Text style={styles.requestMetaValue}>
                      {request.createdAt ? new Date(request.createdAt).toLocaleDateString() : 'Recent'}
                    </Text>
                  </View>
                  <View style={styles.requestMetaItem}>
                    <Text style={styles.requestMetaLabel}>Amount</Text>
                    <Text style={styles.requestMetaValue}>
                      {displayMoney(request.amount, request.currency || BASE_CURRENCY)}
                    </Text>
                  </View>
                  <View style={styles.requestMetaItem}>
                    <Text style={styles.requestMetaLabel}>Refund to</Text>
                    <Text style={styles.requestMetaValue}>
                      {getRefundDestinationLabel(
                        request.refundMethod,
                        request.refundDestinationLabel
                      )}
                    </Text>
                  </View>
                </View>

                <Text style={styles.requestReasonLabel}>Reason</Text>
                <Text style={styles.requestReason}>{request.reason}</Text>

                {request.notes ? (
                  <>
                    <Text style={styles.requestReasonLabel}>Notes</Text>
                    <Text style={styles.requestReason}>{request.notes}</Text>
                  </>
                ) : null}

                {request.items?.length ? (
                  <>
                    <Text style={styles.requestReasonLabel}>Items requested</Text>
                    {request.items.map((item) => (
                      <Text key={`${request.id}-${item.id}`} style={styles.requestItemLine}>
                        • {item.title} x{item.quantity}
                      </Text>
                    ))}
                  </>
                ) : null}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      <Modal visible={modalVisible} transparent animationType="slide" onRequestClose={closeRequestModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Request return or refund</Text>
              <TouchableOpacity style={styles.modalCloseBtn} onPress={closeRequestModal}>
                <Ionicons name="close" size={20} color="#555" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalContent}>
              {activeOrder ? (
                <>
                  <Text style={styles.modalOrderLabel}>
                    Order {formatOrderNumber(activeOrder)}
                  </Text>
                  <Text style={styles.modalOrderMeta}>
                    Refund amount estimate:{' '}
                    {displayMoney(requestAmount, activeOrder.currency || BASE_CURRENCY)}
                  </Text>

                  <Text style={styles.fieldLabel}>Select items</Text>
                  {getOrderItems(activeOrder).map((item) => {
                    const selected = selectedItemIds.includes(item.id);
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.itemSelectRow, selected && styles.itemSelectRowActive]}
                        activeOpacity={0.88}
                        onPress={() => toggleItem(item.id)}
                      >
                        <Image source={{ uri: item.image || PLACEHOLDER_IMAGE }} style={styles.itemSelectImage} />
                        <View style={styles.itemSelectTextWrap}>
                          <Text style={styles.itemSelectTitle} numberOfLines={2}>
                            {item.title}
                          </Text>
                          <Text style={styles.itemSelectMeta}>Qty {item.quantity}</Text>
                        </View>
                        <Ionicons
                          name={selected ? 'checkbox' : 'square-outline'}
                          size={22}
                          color={selected ? '#ff6a00' : '#c4b5aa'}
                        />
                      </TouchableOpacity>
                    );
                  })}

                  <Text style={styles.fieldLabel}>Reason</Text>
                  <View style={styles.reasonWrap}>
                    {REASON_OPTIONS.map((reason) => {
                      const active = selectedReason === reason;
                      return (
                        <TouchableOpacity
                          key={reason}
                          style={[styles.reasonChip, active && styles.reasonChipActive]}
                          activeOpacity={0.88}
                          onPress={() => {
                            setSelectedReason(reason);
                            console.log('[NOOD refund] reason selected', reason);
                          }}
                        >
                          <Text style={[styles.reasonChipText, active && styles.reasonChipTextActive]}>
                            {reason}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>Notes optional</Text>
                  <TextInput
                    style={styles.notesInput}
                    value={notes}
                    onChangeText={setNotes}
                    placeholder="Add any extra details for support"
                    placeholderTextColor="#999"
                    multiline
                  />

                  <Text style={styles.fieldLabel}>Refund destination</Text>
                  <TouchableOpacity
                    style={[styles.refundMethodRow, refundMethod === 'original_payment' && styles.refundMethodRowActive]}
                    activeOpacity={0.88}
                    onPress={() => {
                      setRefundMethod('original_payment');
                      console.log('[NOOD refund] refund method selected', 'original_payment');
                    }}
                  >
                    <Ionicons name="card-outline" size={20} color="#0070ba" />
                    <View style={styles.refundMethodTextWrap}>
                      <Text style={styles.refundMethodTitle}>Original payment method</Text>
                      <Text style={styles.refundMethodCopy}>
                        Refund goes back through PayPal, WiPay, Shopify checkout, or the method used at purchase.
                        Status stays pending review until the provider refund succeeds.
                      </Text>
                    </View>
                    <Ionicons
                      name={refundMethod === 'original_payment' ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color="#ff6a00"
                    />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.refundMethodRow, refundMethod === 'wallet' && styles.refundMethodRowActive]}
                    activeOpacity={0.88}
                    onPress={() => {
                      setRefundMethod('wallet');
                      console.log('[NOOD refund] refund method selected', 'wallet');
                    }}
                  >
                    <Ionicons name="wallet-outline" size={20} color="#ff6a00" />
                    <View style={styles.refundMethodTextWrap}>
                      <Text style={styles.refundMethodTitle}>NOOD Wallet</Text>
                      <Text style={styles.refundMethodCopy}>
                        Approved wallet refunds are added as green credit in your wallet activity. Wallet balance is
                        not updated until the request is approved.
                      </Text>
                    </View>
                    <Ionicons
                      name={refundMethod === 'wallet' ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color="#ff6a00"
                    />
                  </TouchableOpacity>

                </>
              ) : null}
            </ScrollView>

            {activeOrder ? (
              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                  activeOpacity={0.9}
                  disabled={submitting}
                  onPress={() => void submitRequest()}
                >
                  <Text style={styles.submitBtnText}>
                    {submitting ? 'Submitting...' : 'Submit refund request'}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

export default function ReturnsScreen() {
  const { isReady, isSignedIn } = useUser();

  if (!isReady) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingWrap}>
          <NoodSpinner size={48} />
        </View>
      </SafeAreaView>
    );
  }

  if (!isSignedIn && !ACCOUNT_SIGN_IN_GATE_DISABLED) {
    return <GuestReturnsState />;
  }

  return <ReturnsContent />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guestStateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingBottom: 40,
  },
  guestIconWrap: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  guestTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
    marginBottom: 10,
  },
  guestSubtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    textAlign: 'center',
    maxWidth: 320,
    marginBottom: 22,
  },
  guestButton: {
    minHeight: 50,
    paddingHorizontal: 22,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  guestButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
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
    paddingBottom: 28,
  },
  infoCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 18,
    marginBottom: 14,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    marginBottom: 14,
  },
  destinationRow: {
    gap: 10,
    marginBottom: 12,
  },
  destinationCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 14,
    gap: 6,
  },
  destinationTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: '#111',
  },
  destinationCopy: {
    fontSize: 12,
    lineHeight: 18,
    color: '#666',
    fontWeight: '600',
  },
  windowNote: {
    fontSize: 12,
    color: '#8d7a6f',
    fontWeight: '700',
  },
  clearCacheBtn: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e4dcff',
    backgroundColor: '#f8f5ff',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  clearCacheBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#5c31ff',
  },
  sectionCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 18,
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginBottom: 12,
  },
  inlineNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#f8f5ff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e4dcff',
    padding: 12,
    marginBottom: 12,
  },
  inlineNoticeText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: '#4d33b8',
    fontWeight: '700',
  },
  emptyState: {
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 22,
    alignItems: 'center',
  },
  emptyIconWrap: {
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
  },
  emptySubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 20,
    color: '#666',
    textAlign: 'center',
    fontWeight: '600',
  },
  orderCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 14,
    marginBottom: 10,
  },
  orderCardEligible: {
    borderColor: '#ffd2b8',
  },
  orderTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  orderTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  orderNumber: {
    fontSize: 16,
    fontWeight: '900',
    color: '#111',
  },
  orderDate: {
    marginTop: 3,
    fontSize: 12,
    color: '#777',
    fontWeight: '700',
  },
  eligibilityBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  eligibilityBadgeText: {
    fontSize: 11,
    fontWeight: '900',
  },
  orderMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 4,
  },
  orderMetaLabel: {
    fontSize: 12,
    color: '#8d7a6f',
    fontWeight: '700',
  },
  orderMetaValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 13,
    color: '#111',
    fontWeight: '800',
  },
  itemsPreview: {
    marginTop: 10,
    gap: 8,
  },
  itemPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  itemPreviewImage: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  itemPreviewText: {
    flex: 1,
    fontSize: 12,
    color: '#444',
    fontWeight: '700',
  },
  moreItemsText: {
    fontSize: 12,
    color: '#8d7a6f',
    fontWeight: '700',
  },
  eligibilityDetail: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 18,
    color: '#666',
    fontWeight: '600',
  },
  requestCta: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#f0e4da',
    paddingTop: 10,
  },
  requestCtaText: {
    fontSize: 14,
    fontWeight: '900',
    color: '#ff6a00',
  },
  requestsEmpty: {
    fontSize: 14,
    lineHeight: 20,
    color: '#666',
    fontWeight: '600',
  },
  requestCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 14,
    marginBottom: 10,
  },
  requestTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  requestOrder: {
    flex: 1,
    fontSize: 15,
    fontWeight: '900',
    color: '#111',
  },
  requestHeadline: {
    marginBottom: 10,
    fontSize: 14,
    lineHeight: 20,
    color: '#444',
    fontWeight: '800',
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '900',
  },
  requestMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 10,
  },
  requestMetaItem: {
    minWidth: '30%',
    flexGrow: 1,
  },
  requestMetaLabel: {
    fontSize: 11,
    color: '#8d7a6f',
    fontWeight: '700',
    marginBottom: 2,
  },
  requestMetaValue: {
    fontSize: 13,
    color: '#111',
    fontWeight: '800',
  },
  requestReasonLabel: {
    marginTop: 4,
    fontSize: 11,
    color: '#8d7a6f',
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  requestReason: {
    marginTop: 2,
    fontSize: 14,
    lineHeight: 20,
    color: '#444',
    fontWeight: '600',
  },
  requestItemLine: {
    marginTop: 2,
    fontSize: 13,
    color: '#444',
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    maxHeight: '90%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 16,
    paddingHorizontal: 18,
    paddingBottom: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },
  modalCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff7f2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalContent: {
    paddingBottom: 16,
  },
  modalFooter: {
    borderTopWidth: 1,
    borderTopColor: '#f0e4da',
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: '#fff',
  },
  modalOrderLabel: {
    fontSize: 16,
    fontWeight: '900',
    color: '#111',
  },
  modalOrderMeta: {
    marginTop: 4,
    marginBottom: 14,
    fontSize: 13,
    color: '#666',
    fontWeight: '700',
  },
  fieldLabel: {
    marginTop: 8,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '900',
    color: '#8d7a6f',
  },
  itemSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#f0e4da',
    backgroundColor: '#fff7f2',
    borderRadius: 14,
    padding: 10,
    marginBottom: 8,
  },
  itemSelectRowActive: {
    borderColor: '#ff6a00',
    backgroundColor: '#fff1e7',
  },
  itemSelectImage: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  itemSelectTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  itemSelectTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111',
  },
  itemSelectMeta: {
    marginTop: 2,
    fontSize: 12,
    color: '#666',
    fontWeight: '700',
  },
  reasonWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  reasonChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#f0e4da',
    backgroundColor: '#fff7f2',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reasonChipActive: {
    borderColor: '#ff6a00',
    backgroundColor: '#fff1e7',
  },
  reasonChipText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#6b5549',
  },
  reasonChipTextActive: {
    color: '#ff6a00',
  },
  notesInput: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: '#f0e4da',
    borderRadius: 14,
    backgroundColor: '#fff7f2',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111',
    textAlignVertical: 'top',
    marginBottom: 4,
  },
  refundMethodRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: '#f0e4da',
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
  },
  refundMethodRowActive: {
    borderColor: '#ff6a00',
    backgroundColor: '#fff1e7',
  },
  refundMethodTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  refundMethodTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: '#111',
  },
  refundMethodCopy: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 18,
    color: '#666',
    fontWeight: '600',
  },
  submitBtn: {
    marginTop: 14,
    backgroundColor: '#ff6a00',
    borderRadius: 16,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
});