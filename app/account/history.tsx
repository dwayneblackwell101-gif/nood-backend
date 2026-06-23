import React, { useCallback, useMemo } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCart } from '../../context/CartContext';
import { HistoryEvent, HistoryEventType, useHistoryEvents } from '../../context/HistoryContext';
import { BASE_CURRENCY } from '../../utils/currency';

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
};

const TYPE_COLOR: Record<HistoryEventType, string> = {
  order: '#ff6a00',
  wallet: '#5c31ff',
  reward: '#ff8a00',
  address: '#5c31ff',
  wishlist: '#ff5a8a',
  checkout: '#0070ba',
  account: '#111',
};

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

export default function HistoryScreen() {
  const router = useRouter();
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
    const eventItems: TimelineItem[] = (Array.isArray(historyEvents) ? historyEvents : []).map(
      (event: HistoryEvent) => ({
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
      })
    );

    const orderItems: TimelineItem[] = (Array.isArray(orders) ? orders : []).map((order: any) => {
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
          .join(' - '),
        date: order.date || new Date().toISOString(),
        amount: Number(order.total || 0),
        currency: order.currency || selectedCurrency,
        status: order.status || 'Processing',
        relatedId: String(order.id),
        metadata: { items: order.items || [], paymentMethod: order.paymentMethod },
      } as TimelineItem;
    });

    const walletItems: TimelineItem[] = (Array.isArray(walletHistory) ? walletHistory : []).map(
      (entry: any, index: number) => ({
        id: `wallet-${entry?.id || index}`,
        type: 'wallet',
        title: entry?.note || 'Wallet activity',
        description:
          entry?.type === 'spend' || entry?.type === 'debit'
            ? 'Wallet balance decreased'
            : 'Wallet balance increased',
        date: entry?.createdAt || new Date().toISOString(),
        amount:
          entry?.type === 'spend' || entry?.type === 'debit'
            ? -Math.abs(Number(entry?.amount || 0))
            : Math.abs(Number(entry?.amount || 0)),
        currency: entry?.currency || BASE_CURRENCY,
        status: entry?.type || 'completed',
        relatedId: String(entry?.id || index),
      })
    );

    const rewardItems: TimelineItem[] = (Array.isArray(lockedRewards) ? lockedRewards : []).flatMap(
      (reward: any) => {
        const items: TimelineItem[] = [
          {
            id: `reward-created-${reward?.id}`,
            type: 'reward',
            title: 'Locked reward won',
            description: `${reward?.note || 'Reward'} - spend ${displayMoney(
              Number(reward?.unlockRequirement || 0),
              reward?.currency || BASE_CURRENCY
            )} to unlock.`,
            date: reward?.createdAt || new Date().toISOString(),
            amount: Number(reward?.amount || 0),
            currency: reward?.currency || BASE_CURRENCY,
            status: reward?.status || 'locked',
            relatedId: String(reward?.id || ''),
          },
        ];

        if (reward?.status === 'unlocked') {
          items.push({
            id: `reward-unlocked-${reward?.id}`,
            type: 'reward',
            title: 'Reward unlocked',
            description: `${reward?.note || 'Reward'} moved to wallet.`,
            date: reward?.unlockedAt || reward?.updatedAt || reward?.createdAt || new Date().toISOString(),
            amount: Number(reward?.amount || 0),
            currency: reward?.currency || BASE_CURRENCY,
            status: 'unlocked',
            relatedId: String(reward?.id || ''),
          });
        }

        if (reward?.status === 'expired') {
          items.push({
            id: `reward-expired-${reward?.id}`,
            type: 'reward',
            title: 'Reward expired',
            description: `${reward?.note || 'Reward'} expired before it unlocked.`,
            date: reward?.expiresAt || reward?.createdAt || new Date().toISOString(),
            amount: Number(reward?.amount || 0),
            currency: reward?.currency || BASE_CURRENCY,
            status: 'expired',
            relatedId: String(reward?.id || ''),
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
      router.push('/(tabs)/wishlist' as any);
    }
  };

  const renderAmount = (item: TimelineItem) => {
    if (typeof item.amount !== 'number') return '';

    const sign = item.type === 'wallet' && item.amount < 0 ? '-' : item.amount > 0 && item.type === 'wallet' ? '+' : '';
    return `${sign}${displayMoney(Math.abs(Number(item.amount || 0)), item.currency || BASE_CURRENCY)}`;
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
          <Text style={styles.heading}>Recent activity</Text>
          <Text style={styles.description}>
            Orders, wallet updates, rewards, address changes, and checkout activity are grouped here.
          </Text>

          {timelineItems.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>No history yet</Text>
              <Text style={styles.emptyText}>Place an order or use your wallet to build your timeline.</Text>
            </View>
          ) : (
            ['Today', 'Yesterday', 'Earlier'].map((group) =>
              groupedItems[group]?.length ? (
                <View key={group} style={styles.group}>
                  <Text style={styles.groupTitle}>{group}</Text>
                  {groupedItems[group].map((item) => {
                    const color = TYPE_COLOR[item.type] || '#ff6a00';
                    const amount = renderAmount(item);

                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={styles.row}
                        activeOpacity={0.86}
                        onPress={() => openTimelineItem(item)}
                      >
                        <View style={styles.rowLeft}>
                          <View style={[styles.iconWrap, { borderColor: `${color}22`, backgroundColor: `${color}12` }]}>
                            <Ionicons name={TYPE_ICON[item.type]} size={18} color={color} />
                          </View>
                          <View style={styles.textWrap}>
                            <View style={styles.titleLine}>
                              <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                              {!!item.status ? (
                                <View style={styles.statusBadge}>
                                  <Text style={styles.statusBadgeText}>{item.status}</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text style={styles.rowSubtitle} numberOfLines={3}>{item.description}</Text>
                            <Text style={styles.rowDate}>{toDate(item.date).toLocaleString()}</Text>
                          </View>
                        </View>
                        {!!amount ? <Text style={[styles.amount, { color }]}>{amount}</Text> : null}
                      </TouchableOpacity>
                    );
                  })}
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
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#ff6a00',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
    color: '#555',
  },
  group: {
    marginBottom: 16,
  },
  groupTitle: {
    color: '#6f5a4e',
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f4e1d6',
  },
  rowLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 12,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  textWrap: {
    flex: 1,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowTitle: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
  },
  statusBadge: {
    borderRadius: 999,
    backgroundColor: '#fff1df',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  statusBadgeText: {
    color: '#ff6a00',
    fontSize: 10,
    fontWeight: '900',
  },
  rowSubtitle: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 18,
    color: '#666',
    fontWeight: '600',
  },
  rowDate: {
    marginTop: 3,
    fontSize: 11,
    color: '#9a8b80',
    fontWeight: '700',
  },
  amount: {
    fontSize: 13,
    fontWeight: '900',
    maxWidth: 92,
    textAlign: 'right',
  },
});
