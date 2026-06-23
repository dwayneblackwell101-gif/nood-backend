import React, { useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCart } from '../../context/CartContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import { BASE_CURRENCY } from '../../utils/currency';

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/140x140.png?text=NOOD';

function getTrackingNumber(order: any) {
  return (
    order?.trackingNumber ||
    order?.tracking_number ||
    order?.fulfillment?.trackingNumber ||
    order?.fulfillment?.tracking_number ||
    order?.fulfillments?.[0]?.trackingNumber ||
    order?.fulfillments?.[0]?.tracking_number ||
    order?.fulfillments?.[0]?.trackingInfo?.[0]?.number ||
    ''
  );
}

function getTrackingUrl(order: any) {
  return (
    order?.trackingUrl ||
    order?.tracking_url ||
    order?.fulfillment?.trackingUrl ||
    order?.fulfillment?.tracking_url ||
    order?.fulfillments?.[0]?.trackingUrl ||
    order?.fulfillments?.[0]?.tracking_url ||
    order?.fulfillments?.[0]?.trackingInfo?.[0]?.url ||
    ''
  );
}

function getCarrier(order: any) {
  return (
    order?.carrier ||
    order?.trackingCompany ||
    order?.tracking_company ||
    order?.fulfillment?.trackingCompany ||
    order?.fulfillments?.[0]?.trackingCompany ||
    order?.fulfillments?.[0]?.trackingInfo?.[0]?.company ||
    ''
  );
}

function getFulfillmentStatus(order: any) {
  return (
    order?.fulfillmentStatus ||
    order?.fulfillment_status ||
    order?.fulfillment?.status ||
    order?.fulfillments?.[0]?.status ||
    (getTrackingNumber(order) ? 'Shipped' : 'Preparing shipment')
  );
}

function build17TrackUrl(trackingNumber: string) {
  return `https://t.17track.net/en#nums=${encodeURIComponent(trackingNumber.trim())}`;
}

export default function OrdersScreen() {
  const router = useRouter();
  const { addHistoryEvent } = useHistoryEvents();
  const {
    orders = [],
    refundToBalance,
    markOrderRefunded,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = useCart();
  const [trackingNumber, setTrackingNumber] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);

  const sortedOrders = useMemo(
    () =>
      (Array.isArray(orders) ? orders : []).slice().sort((a: any, b: any) => {
        const aTime = new Date(a?.date || 0).getTime();
        const bTime = new Date(b?.date || 0).getTime();
        return bTime - aTime;
      }),
    [orders]
  );

  const showMessage = (title: string, message: string) => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(`${title}\n\n${message}`);
      return;
    }

    Alert.alert(title, message);
  };

  const openTracking = async (number: string, order?: any) => {
    const cleanNumber = String(number || '').trim();

    if (!cleanNumber) {
      showMessage('Tracking number needed', 'Please enter a tracking number.');
      return;
    }

    const url = order ? getTrackingUrl(order) || build17TrackUrl(cleanNumber) : build17TrackUrl(cleanNumber);

    void addHistoryEvent({
      type: 'order',
      title: 'Tracking viewed',
      description: order ? `Tracking opened for order #${order.id}.` : `Tracking opened for ${cleanNumber}.`,
      status: 'tracking',
      relatedId: order ? String(order.id) : cleanNumber,
      metadata: {
        trackingNumber: cleanNumber,
        trackingUrl: url,
      },
    });

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(url, '_blank');
      return;
    }

    await Linking.openURL(url);
  };

  const handleManualTracking = () => {
    void openTracking(trackingNumber);
  };

  const handleRefund = (order: any) => {
    if (order.refunded || order.status === 'Refunded') {
      Alert.alert('Already refunded', `Order #${order.id} has already been refunded.`);
      return;
    }

    Alert.alert('Refund Order', `Choose how to refund order #${order.id}`, [
      {
        text: 'Refund to NOOD Balance',
        onPress: () => {
          refundToBalance(Number(order.total || 0), String(order.id), `Refund for order #${order.id}`);
          Alert.alert('Refund complete', 'Refund added to NOOD Balance.');
        },
      },
      {
        text: 'Refund to Original Payment',
        onPress: () => {
          markOrderRefunded(String(order.id), 'Original Payment');
          Alert.alert('Refund recorded', 'Refund marked as sent to original payment method.');
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const getStatusColor = (status: string) => {
    const normalized = String(status || '').toLowerCase();
    if (normalized.includes('delivered')) return '#5c31ff';
    if (normalized.includes('shipped')) return '#2563eb';
    if (normalized.includes('processing')) return '#ff6a00';
    if (normalized.includes('paid')) return '#5c31ff';
    if (normalized.includes('cancel')) return '#ff3b30';
    if (normalized.includes('refund')) return '#7b7268';
    return '#ff6a00';
  };

  const formatDate = (value: string) => {
    if (!value) return 'Recent';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString();
  };

  const displayTotal = (order: any) =>
    formatMoney(
      convertPrice(Number(order?.total || 0), order?.currency || selectedCurrency, selectedCurrency),
      selectedCurrency
    );

  const orderProducts = (order: any) => (Array.isArray(order?.items) ? order.items : []);

  const renderProductThumbs = (order: any) => {
    const products = orderProducts(order);
    const first = products[0] || {};
    const extraCount = Math.max(products.length - 1, 0);
    const image = first?.image || first?.featuredImage || first?.thumbnail || PLACEHOLDER_IMAGE;

    return (
      <View style={styles.thumbWrap}>
        <Image source={{ uri: image }} style={styles.thumbImage} resizeMode="cover" />
        {extraCount > 0 ? (
          <View style={styles.extraBadge}>
            <Text style={styles.extraBadgeText}>+{extraCount}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  const renderProductsText = (order: any) => {
    const products = orderProducts(order);
    if (!products.length) return 'Products will appear here when Shopify order items are connected.';
    return products
      .slice(0, 3)
      .map((item: any) => `${item?.title || 'Product'} x${Number(item?.quantity || 1)}`)
      .join(', ');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Orders</Text>

        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.trackingCard}>
          <View style={styles.trackingIcon}>
            <Ionicons name="navigate-outline" size={22} color="#fff" />
          </View>
          <Text style={styles.trackingTitle}>Track your order</Text>
          <Text style={styles.trackingCopy}>Enter your tracking number to check your delivery status.</Text>
          <View style={styles.trackingInputRow}>
            <TextInput
              style={styles.trackingInput}
              value={trackingNumber}
              onChangeText={setTrackingNumber}
              placeholder="Tracking number"
              placeholderTextColor="#9b8c82"
              autoCapitalize="characters"
            />
            <TouchableOpacity style={styles.trackButton} activeOpacity={0.9} onPress={handleManualTracking}>
              <Text style={styles.trackButtonText}>Track</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.big}>Order center</Text>
          <Text style={styles.text}>
            Local checkout orders appear here now. Shopify customer orders and fulfillment tracking can plug into this same layout when the API is ready.
          </Text>

          {sortedOrders.length === 0 ? (
            <View style={styles.statusBox}>
              <Ionicons name="cube-outline" size={36} color="#ff6a00" />
              <Text style={styles.statusTitle}>No recent orders</Text>
              <Text style={styles.statusText}>Your placed orders will show here.</Text>
            </View>
          ) : (
            sortedOrders.map((order: any) => {
              const isRefunded = order.refunded || order.status === 'Refunded';
              const status = isRefunded ? 'Refunded' : order.status || 'Processing';
              const statusColor = getStatusColor(status);
              const tracking = getTrackingNumber(order);
              const carrier = getCarrier(order);
              const fulfillmentStatus = getFulfillmentStatus(order);

              return (
                <View key={String(order.id)} style={styles.orderCard}>
                  <View style={styles.orderMainRow}>
                    {renderProductThumbs(order)}
                    <View style={styles.orderMainText}>
                      <View style={styles.orderTopRow}>
                        <View style={styles.orderTitleWrap}>
                          <Text style={styles.orderId}>Order #{order.id}</Text>
                          <Text style={styles.orderDate}>{formatDate(order.date)}</Text>
                        </View>

                        <View style={[styles.statusBadge, { backgroundColor: `${statusColor}18` }]}>
                          <Text style={[styles.statusBadgeText, { color: statusColor }]}>{status}</Text>
                        </View>
                      </View>

                      <Text style={styles.productLine} numberOfLines={2}>
                        {renderProductsText(order)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.infoGrid}>
                    <View style={styles.infoPill}>
                      <Ionicons name="card-outline" size={15} color="#ff6a00" />
                      <Text style={styles.infoPillText}>{order.paymentMethod || 'Wallet'}</Text>
                    </View>
                    <View style={styles.infoPill}>
                      <Ionicons name="cube-outline" size={15} color="#5c31ff" />
                      <Text style={styles.infoPillText}>{fulfillmentStatus}</Text>
                    </View>
                  </View>

                  <View style={styles.orderInfoRow}>
                    <Text style={styles.orderLabel}>Total</Text>
                    <Text style={styles.orderValue}>{displayTotal(order)}</Text>
                  </View>

                  {tracking ? (
                    <View style={styles.trackingLine}>
                      <Ionicons name="trail-sign-outline" size={16} color="#5c31ff" />
                      <Text style={styles.trackingLineText}>
                        {carrier ? `${carrier}: ` : ''}{tracking}
                      </Text>
                    </View>
                  ) : null}

                  <View style={styles.actionsRow}>
                    <TouchableOpacity
                      style={styles.secondaryButton}
                      activeOpacity={0.9}
                      onPress={() => setSelectedOrder(order)}
                    >
                      <Text style={styles.secondaryButtonText}>View details</Text>
                    </TouchableOpacity>

                    {tracking ? (
                      <TouchableOpacity
                        style={styles.trackOrderButton}
                        activeOpacity={0.9}
                        onPress={() => void openTracking(tracking, order)}
                      >
                        <Text style={styles.trackOrderButtonText}>Track</Text>
                      </TouchableOpacity>
                    ) : null}

                    <TouchableOpacity
                      style={[styles.refundButton, isRefunded && styles.refundButtonDisabled]}
                      activeOpacity={0.9}
                      onPress={() => handleRefund(order)}
                      disabled={isRefunded}
                    >
                      <Text style={styles.refundButtonText}>{isRefunded ? 'Refunded' : 'Request Refund'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      <Modal visible={!!selectedOrder} transparent animationType="slide" onRequestClose={() => setSelectedOrder(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Order details</Text>
              <TouchableOpacity style={styles.modalClose} onPress={() => setSelectedOrder(null)}>
                <Ionicons name="close" size={20} color="#555" />
              </TouchableOpacity>
            </View>

            {selectedOrder ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={styles.detailOrderId}>Order #{selectedOrder.id}</Text>
                <Text style={styles.detailMeta}>{formatDate(selectedOrder.date)}</Text>
                <Text style={styles.detailMeta}>Status: {selectedOrder.status || 'Processing'}</Text>
                <Text style={styles.detailMeta}>Payment: {selectedOrder.paymentMethod || 'Wallet'}</Text>
                <Text style={styles.detailTotal}>{displayTotal(selectedOrder)}</Text>

                <Text style={styles.detailSectionTitle}>Products ordered</Text>
                {orderProducts(selectedOrder).length ? (
                  orderProducts(selectedOrder).map((item: any, index: number) => (
                    <View key={`${item?.id || item?.title || index}-${index}`} style={styles.detailProductRow}>
                      <Image source={{ uri: item?.image || PLACEHOLDER_IMAGE }} style={styles.detailProductImage} />
                      <View style={styles.detailProductText}>
                        <Text style={styles.detailProductTitle}>{item?.title || 'Product'}</Text>
                        <Text style={styles.detailProductMeta}>Qty: {Number(item?.quantity || 1)}</Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.detailMeta}>Product details are not available for this order yet.</Text>
                )}
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
    padding: 16,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 22,
    marginTop: 8,
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
  trackingCard: {
    backgroundColor: '#111',
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    overflow: 'hidden',
  },
  trackingIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  trackingTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
  },
  trackingCopy: {
    marginTop: 6,
    color: '#d9d2cc',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
  trackingInputRow: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 8,
  },
  trackingInput: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    color: '#111',
    fontSize: 15,
    fontWeight: '800',
  },
  trackButton: {
    minWidth: 86,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  trackButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  big: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  text: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
    marginBottom: 18,
  },
  statusBox: {
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
  },
  statusTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#ff6a00',
    marginTop: 8,
    marginBottom: 6,
  },
  statusText: {
    fontSize: 14,
    color: '#555',
    textAlign: 'center',
  },
  orderCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginBottom: 12,
  },
  orderMainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  thumbWrap: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: '#fff',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginRight: 12,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  extraBadge: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    backgroundColor: '#111',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  extraBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
  },
  orderMainText: {
    flex: 1,
  },
  orderTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  orderTitleWrap: {
    flex: 1,
    paddingRight: 8,
  },
  orderId: {
    fontSize: 16,
    fontWeight: '900',
    color: '#111',
  },
  orderDate: {
    marginTop: 4,
    fontSize: 11,
    color: '#777',
    fontWeight: '700',
  },
  statusBadge: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '900',
  },
  productLine: {
    color: '#5f544e',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  infoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  infoPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  infoPillText: {
    marginLeft: 5,
    color: '#4f443e',
    fontSize: 12,
    fontWeight: '900',
  },
  orderInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  orderLabel: {
    fontSize: 13,
    color: '#666',
    fontWeight: '800',
  },
  orderValue: {
    fontSize: 18,
    color: '#111',
    fontWeight: '900',
  },
  trackingLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    backgroundColor: '#f1ecff',
    borderRadius: 14,
    padding: 10,
  },
  trackingLineText: {
    flex: 1,
    marginLeft: 7,
    color: '#4d33b8',
    fontSize: 12,
    fontWeight: '900',
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  secondaryButton: {
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: '#6b5549',
    fontSize: 12,
    fontWeight: '900',
  },
  trackOrderButton: {
    borderRadius: 999,
    backgroundColor: '#111',
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  trackOrderButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  refundButton: {
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  refundButtonDisabled: {
    backgroundColor: '#cfcfcf',
  },
  refundButtonText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    maxHeight: '82%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 22,
    color: '#111',
    fontWeight: '900',
  },
  modalClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff7f2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailOrderId: {
    fontSize: 20,
    color: '#111',
    fontWeight: '900',
  },
  detailMeta: {
    marginTop: 6,
    color: '#666',
    fontSize: 13,
    fontWeight: '700',
  },
  detailTotal: {
    marginTop: 12,
    color: '#ff6a00',
    fontSize: 26,
    fontWeight: '900',
  },
  detailSectionTitle: {
    marginTop: 18,
    marginBottom: 10,
    fontSize: 16,
    color: '#111',
    fontWeight: '900',
  },
  detailProductRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    backgroundColor: '#fff7f2',
    padding: 10,
    marginBottom: 10,
  },
  detailProductImage: {
    width: 54,
    height: 54,
    borderRadius: 14,
    backgroundColor: '#fff',
  },
  detailProductText: {
    flex: 1,
    marginLeft: 10,
  },
  detailProductTitle: {
    color: '#111',
    fontSize: 14,
    fontWeight: '900',
  },
  detailProductMeta: {
    marginTop: 4,
    color: '#777',
    fontSize: 12,
    fontWeight: '700',
  },
});
