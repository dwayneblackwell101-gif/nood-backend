import React, { useCallback, useMemo } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import AccountGuestState from '../../components/AccountGuestState';
import { ACCOUNT_SIGN_IN_GATE_DISABLED } from '../../components/RequireSignIn';
import NoodSpinner from '../../components/NoodSpinner';
import { useCart } from '../../context/CartContext';
import { useUser } from '../../context/UserContext';
import { HistoryEvent, HistoryEventType, useHistoryEvents } from '../../context/HistoryContext';
import { BASE_CURRENCY } from '../../utils/currency';
import { noodAlert } from '../../utils/nood-alert';

type TimelineItem = {
  id: string;
  type: HistoryEventType;
  title: string;
  description: string;
  date: string;
  amount?: number;
  currency?: string;
  status?: string;
  relatedId?: string;
  metadata?: Record<string, any>;
};

const TYPE_ICON: Record<HistoryEventType, React.ComponentProps<typeof Ionicons>['name']> = {
  order: 'receipt-outline',
  wallet: 'wallet-outline',
  reward: 'gift-outline',
  address: 'location-outline',
  wishlist: 'heart-outline',
  checkout: 'card-outline',
  account: 'person-circle-outline',
  review: 'star-outline',
};

const ACTIVITY_COLOR = '#ff6a00';
const ORDER_COLOR = '#0070ba';
const WALLET_CREDIT_COLOR = '#1f9d55';
const WALLET_DEBIT_COLOR = '#e53935';

function getItemColor(item: TimelineItem): string {
  if (item.type === 'order' || item.type === 'checkout') {
    return ORDER_COLOR;
  }

  if (item.type === 'wallet') {
    return typeof item.amount === 'number' && item.amount < 0
      ? WALLET_DEBIT_COLOR
      : WALLET_CREDIT_COLOR;
  }

  return ACTIVITY_COLOR;
}

function toDate(value: string) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function dayLabel(value: string) {
  const date = toDate(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return 'Earlier';
}

function formatTime(value: string) {
  const date = toDate(value);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatStatus(status: string) {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function HistoryScreen() {
  const router = useRouter();
  const { isReady, isSignedIn } = useUser();
  const { historyEvents = [] } = useHistoryEvents();
  const {
    orders = [],
    walletHistory = [],
    lockedRewards = [],
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = (useCart() as any) || {};

  const displayMoney = useCallback(
    (amount: number, fromCurrency = BASE_CURRENCY) =>
      formatMoney(
        convertPrice(Number(amount || 0), fromCurrency || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      ),
    [convertPrice, formatMoney, selectedCurrency]
  );

  const timelineItems = useMemo(() => {
    const eventItems: TimelineItem[] = (Array.isArray(historyEvents) ? historyEvents : [])
      .filter((event: HistoryEvent) => !!event?.date && !!event?.title)
      .map((event: HistoryEvent) => ({
        id: `event-${event.id}`,
        type: event.type,
        title: event.title,
        description: event.description,
        date: event.date,
        amount: event.amount,
        currency: event.currency,
        status: event.status,
        relatedId: event.relatedId,
        metadata: event.metadata,
      }));

    const loggedOrderIds = new Set(
      eventItems.filter((event) => event.type === 'order' && event.relatedId).map((event) => event.relatedId)
    );
    const loggedWalletIds = new Set(
      eventItems.filter((event) => event.type === 'wallet' && event.relatedId).map((event) => event.relatedId)
    );
    const loggedRewardKeys = new Set(
      eventItems
        .filter((event) => event.type === 'reward' && event.relatedId)
        .map((event) => `${event.relatedId}:${event.status || ''}`)
    );

    const orderItems: TimelineItem[] = (Array.isArray(orders) ? orders : [])
      .filter(
        (order: any) =>
          order?.id &&
          order?.date &&
          !loggedOrderIds.has(String(order.id))
      )
      .map((order: any) => {
      const products = Array.isArray(order?.items)
        ? order.items
            .slice(0, 3)
            .map((item: any) => item?.title || 'Product')
            .filter(Boolean)
            .join(', ')
        : '';

      return {
        id: `order-${order.id}`,
        type: 'order',
        title: `Order #${order.id}`,
        description: [
          order.status || 'Processing',
          order.paymentMethod || 'Wallet',
          products ? `Products: ${products}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        date: order.date,
        amount: Number(order.total || 0),
        currency: order.currency || selectedCurrency,
        status: order.status || 'Processing',
        relatedId: String(order.id),
        metadata: { items: order.items || [], paymentMethod: order.paymentMethod },
      } as TimelineItem;
    });

    const walletItems: TimelineItem[] = (Array.isArray(walletHistory) ? walletHistory : [])
      .filter(
        (entry: any) =>
          entry?.createdAt &&
          !loggedWalletIds.has(String(entry?.id || ''))
      )
      .map((entry: any, index: number) => {
        const isDebit = entry?.type === 'spend' || entry?.type === 'debit';
        return {
          id: `wallet-${entry?.id || index}`,
          type: 'wallet',
          title: entry?.note || 'Wallet activity',
          description: isDebit ? 'Wallet balance decreased' : 'Wallet balance increased',
          date: entry.createdAt,
          amount: isDebit
            ? -Math.abs(Number(entry?.amount || 0))
            : Math.abs(Number(entry?.amount || 0)),
          currency: entry?.currency || BASE_CURRENCY,
          status: entry?.type || 'completed',
          relatedId: String(entry?.id || index),
        };
      });

    const rewardItems: TimelineItem[] = (Array.isArray(lockedRewards) ? lockedRewards : []).flatMap(
      (reward: any) => {
        if (!reward?.id || !reward?.createdAt) {
          return [];
        }

        const rewardId = String(reward.id);
        const items: TimelineItem[] = [];

        if (!loggedRewardKeys.has(`${rewardId}:${reward?.status || 'locked'}`)) {
          items.push({
            id: `reward-created-${rewardId}`,
            type: 'reward',
            title: 'Locked reward won',
            description: `${reward?.note || 'Reward'} — spend ${displayMoney(
              Number(reward?.unlockRequirement || 0),
              reward?.currency || BASE_CURRENCY
            )} to unlock.`,
            date: reward.createdAt,
            amount: Number(reward?.amount || 0),
            currency: reward?.currency || BASE_CURRENCY,
            status: reward?.status || 'locked',
            relatedId: rewardId,
          });
        }

        if (reward?.status === 'unlocked' && reward?.unlockedAt && !loggedRewardKeys.has(`${rewardId}:unlocked`)) {
          items.push({
            id: `reward-unlocked-${rewardId}`,
            type: 'reward',
            title: 'Reward unlocked',
            description: `${reward?.note || 'Reward'} moved to wallet.`,
            date: reward.unlockedAt,
            amount: Number(reward?.amount || 0),
            currency: reward?.currency || BASE_CURRENCY,
            status: 'unlocked',
            relatedId: rewardId,
          });
        }

        if (reward?.status === 'expired' && reward?.expiresAt && !loggedRewardKeys.has(`${rewardId}:expired`)) {
          items.push({
            id: `reward-expired-${rewardId}`,
            type: 'reward',
            title: 'Reward expired',
            description: `${reward?.note || 'Reward'} expired before it unlocked.`,
            date: reward.expiresAt,
            amount: Number(reward?.amount || 0),
            currency: reward?.currency || BASE_CURRENCY,
            status: 'expired',
            relatedId: rewardId,
          });
        }

        return items;
      }
    );

    const byKey = new Map<string, TimelineItem>();
    [...eventItems, ...orderItems, ...walletItems, ...rewardItems].forEach((item) => {
      const key = `${item.type}:${item.relatedId || item.id}:${item.status || ''}:${item.title}`;
      if (!byKey.has(key)) byKey.set(key, item);
    });

    return Array.from(byKey.values()).sort(
      (a, b) => toDate(b.date).getTime() - toDate(a.date).getTime()
    );
  }, [displayMoney, historyEvents, lockedRewards, orders, selectedCurrency, walletHistory]);

  const groupedItems = useMemo(() => {
    return timelineItems.reduce<Record<string, TimelineItem[]>>((groups, item) => {
      const label = dayLabel(item.date);
      groups[label] = groups[label] || [];
      groups[label].push(item);
      return groups;
    }, {});
  }, [timelineItems]);

  const openTimelineItem = (item: TimelineItem) => {
    if (item.type === 'order') {
      router.push('/account/orders' as any);
      return;
    }

    if (item.type === 'wallet') {
      router.push('/account/wallet' as any);
      return;
    }

    if (item.type === 'reward') {
      router.push('/account/rewards' as any);
      return;
    }

    if (item.type === 'address') {
      router.push('/account/address' as any);
      return;
    }

    if (item.type === 'wishlist') {
      router.replace('/wishlist' as any);
      return;
    }

    if (item.type === 'review') {
      router.push('/account/reviews' as any);
      return;
    }

    if (item.type === 'checkout') {
      router.push('/account/orders' as any);
      return;
    }

    if (item.type === 'account') {
      router.push('/account/security' as any);
      return;
    }

    noodAlert(
      'This feature is being set up',
      'This activity link will open in a future NOOD update.'
    );
  };

  if (!isReady) {
    return (
      <SafeAreaView style={styles.loadingWrap}>
        <NoodSpinner size={48} />
      </SafeAreaView>
    );
  }

  if (!isSignedIn && !ACCOUNT_SIGN_IN_GATE_DISABLED) {
    return (
      <AccountGuestState
        showHeader
        headerTitle="History"
        icon="time-outline"
        title="Sign in to view your activity"
        subtitle="Orders, wallet updates, rewards, saved items, and checkout activity will appear here after you sign in."
      />
    );
  }

  const renderAmount = (item: TimelineItem) => {
    if (typeof item.amount !== 'number' || item.amount === 0) return null;

    const color = getItemColor(item);
    const sign =
      item.type === 'wallet'
        ? item.amount < 0
          ? '−'
          : '+'
        : item.type === 'order' || item.type === 'checkout'
          ? ''
          : '';

    return (
      <Text style={[styles.amount, { color }]}>
        {sign}
        {displayMoney(Math.abs(Number(item.amount || 0)), item.currency || BASE_CURRENCY)}
      </Text>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>History</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.heading}>Activity timeline</Text>
          <Text style={styles.description}>
            Orders, wallet updates, saved items, addresses, and rewards appear here as you shop.
          </Text>

          {timelineItems.length === 0 ? (
            <View style={styles.emptyBox}>
              <View style={styles.emptyIconWrap}>
                <Ionicons name="time-outline" size={36} color="#ff6a00" />
              </View>
              <Text style={styles.emptyTitle}>No activity yet</Text>
              <Text style={styles.emptyText}>
                Orders, wallet updates, saved items, addresses, and rewards will appear here.
              </Text>
              <TouchableOpacity
                style={styles.emptyButton}
                activeOpacity={0.9}
                onPress={() => router.replace('/categories' as any)}
              >
                <Text style={styles.emptyButtonText}>Start shopping</Text>
              </TouchableOpacity>
            </View>
          ) : (
            ['Today', 'Yesterday', 'Earlier'].map((group) =>
              groupedItems[group]?.length ? (
                <View key={group} style={styles.group}>
                  <Text style={styles.groupTitle}>{group}</Text>

                  <View style={styles.timeline}>
                    {groupedItems[group].map((item, index) => {
                      const color = getItemColor(item);
                      const isLast = index === groupedItems[group].length - 1;
                      const amount = renderAmount(item);

                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={styles.timelineRow}
                          activeOpacity={0.86}
                          onPress={() => openTimelineItem(item)}
                        >
                          <View style={styles.timelineRail}>
                            <View style={[styles.timelineDot, { borderColor: color, backgroundColor: `${color}18` }]}>
                              <Ionicons name={TYPE_ICON[item.type]} size={16} color={color} />
                            </View>
                            {!isLast ? <View style={styles.timelineLine} /> : null}
                          </View>

                          <View style={styles.timelineCard}>
                            <View style={styles.timelineCardTop}>
                              <Text style={styles.rowTitle} numberOfLines={1}>
                                {item.title}
                              </Text>
                              <Text style={styles.rowTime}>{formatTime(item.date)}</Text>
                            </View>

                            <Text style={styles.rowSubtitle} numberOfLines={3}>
                              {item.description}
                            </Text>

                            <View style={styles.timelineCardBottom}>
                              {!!item.status ? (
                                <View style={[styles.statusBadge, { backgroundColor: `${color}14` }]}>
                                  <Text style={[styles.statusBadgeText, { color }]}>
                                    {formatStatus(item.status)}
                                  </Text>
                                </View>
                              ) : (
                                <View />
                              )}
                              {amount}
                            </View>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ) : null
            )
          )}
        </View>
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
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
    padding: 16,
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
  spacer: {
    width: 42,
  },
  content: {
    paddingBottom: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  heading: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
    marginBottom: 18,
  },
  emptyBox: {
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    padding: 28,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 18,
  },
  emptyButton: {
    minHeight: 48,
    paddingHorizontal: 24,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  group: {
    marginBottom: 20,
  },
  groupTitle: {
    color: '#6f5a4e',
    fontSize: 12,
    fontWeight: '900',
    marginBottom: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  timeline: {
    gap: 0,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  timelineRail: {
    width: 36,
    alignItems: 'center',
    marginRight: 10,
  },
  timelineDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  timelineLine: {
    flex: 1,
    width: 2,
    minHeight: 24,
    backgroundColor: '#f0e0d4',
    marginTop: 4,
    marginBottom: 4,
    borderRadius: 1,
  },
  timelineCard: {
    flex: 1,
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 14,
    marginBottom: 12,
  },
  timelineCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  rowTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '900',
    color: '#111',
  },
  rowTime: {
    fontSize: 11,
    color: '#9a8b80',
    fontWeight: '700',
  },
  rowSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: '#666',
    fontWeight: '600',
  },
  timelineCardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 8,
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '900',
  },
  amount: {
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'right',
    flexShrink: 0,
  },
});