import React from 'react';
import { Image, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { NoodUpdate, UpdateType, useUpdates } from '../../context/UpdatesContext';

const TYPE_META: Record<UpdateType, { label: string; icon: React.ComponentProps<typeof Ionicons>['name']; color: string }> = {
  deal: { label: 'Deal', icon: 'pricetag-outline', color: '#ff6a00' },
  app: { label: 'App Update', icon: 'sparkles-outline', color: '#5c31ff' },
  arrival: { label: 'New Arrival', icon: 'bag-add-outline', color: '#ff8a00' },
  reward: { label: 'Reward', icon: 'gift-outline', color: '#5c31ff' },
  shipping: { label: 'Shipping', icon: 'cube-outline', color: '#0070ba' },
  sale: { label: 'Flash Sale', icon: 'flash-outline', color: '#ff3b30' },
  coupon: { label: 'Coupon', icon: 'ticket-outline', color: '#ff6a00' },
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recent';
  return date.toLocaleString();
}

export default function UpdatesScreen() {
  const router = useRouter();
  const { updates, readUpdateIds, unreadCount, markAllUpdatesRead, openUpdate } = useUpdates();

  const handleOpenUpdate = (update: NoodUpdate) => {
    void openUpdate(update);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Updates</Text>

        <TouchableOpacity style={styles.markReadBtn} onPress={() => void markAllUpdatesRead()}>
          <Ionicons name="checkmark-done-outline" size={20} color="#5c31ff" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.heroCard}>
          <View style={styles.heroIcon}>
            <Ionicons name="notifications-outline" size={26} color="#fff" />
          </View>
          <View style={styles.heroText}>
            <Text style={styles.heroTitle}>NOOD Inbox</Text>
            <Text style={styles.heroCopy}>
              Deals, rewards, shipping notes, app changes, and sales updates live here.
            </Text>
          </View>
          {unreadCount > 0 ? (
            <View style={styles.unreadPill}>
              <Text style={styles.unreadPillText}>{unreadCount} new</Text>
            </View>
          ) : null}
        </View>

        {updates.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No updates yet</Text>
            <Text style={styles.emptyText}>New NOOD announcements will appear here.</Text>
          </View>
        ) : (
          updates.map((update) => {
            const meta = TYPE_META[update.type];
            const unread = !readUpdateIds.includes(update.id);

            return (
              <TouchableOpacity
                key={update.id}
                style={[styles.updateCard, unread && styles.updateCardUnread]}
                activeOpacity={0.9}
                onPress={() => handleOpenUpdate(update)}
              >
                {update.imageUrl ? (
                  <Image source={{ uri: update.imageUrl }} style={styles.updateImage} resizeMode="cover" />
                ) : (
                  <View style={[styles.updateImageFallback, { backgroundColor: `${meta.color}16` }]}>
                    <Ionicons name={meta.icon} size={28} color={meta.color} />
                  </View>
                )}

                <View style={styles.updateBody}>
                  <View style={styles.updateTopRow}>
                    <View style={[styles.typeBadge, { backgroundColor: `${meta.color}15` }]}>
                      <Ionicons name={meta.icon} size={13} color={meta.color} />
                      <Text style={[styles.typeBadgeText, { color: meta.color }]}>{meta.label}</Text>
                    </View>
                    {unread ? <View style={styles.unreadDot} /> : null}
                  </View>

                  <Text style={styles.updateTitle}>{update.title}</Text>
                  <Text style={styles.updateMessage}>{update.message}</Text>
                  <Text style={styles.updateDate}>{formatDate(update.createdAt)}</Text>

                  {update.actionLabel ? (
                    <View style={styles.actionRow}>
                      <Text style={styles.actionText}>{update.actionLabel}</Text>
                      <Ionicons name="arrow-forward" size={15} color="#ff6a00" />
                    </View>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })
        )}
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
  markReadBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f1ecff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingBottom: 24,
  },
  heroCard: {
    backgroundColor: '#111',
    borderRadius: 24,
    padding: 18,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  heroText: {
    flex: 1,
  },
  heroTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
  },
  heroCopy: {
    marginTop: 5,
    color: '#d8d1cc',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  unreadPill: {
    backgroundColor: '#f1ecff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 8,
  },
  unreadPillText: {
    color: '#5c31ff',
    fontSize: 12,
    fontWeight: '900',
  },
  emptyCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  emptyTitle: {
    color: '#ff6a00',
    fontSize: 18,
    fontWeight: '900',
  },
  emptyText: {
    marginTop: 7,
    color: '#666',
    fontSize: 14,
    lineHeight: 20,
  },
  updateCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 12,
    marginBottom: 12,
    flexDirection: 'row',
  },
  updateCardUnread: {
    borderColor: '#ffb15c',
    backgroundColor: '#fffaf5',
  },
  updateImage: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: '#fff7f2',
    marginRight: 12,
  },
  updateImageFallback: {
    width: 72,
    height: 72,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  updateBody: {
    flex: 1,
  },
  updateTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  typeBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
  },
  typeBadgeText: {
    marginLeft: 4,
    fontSize: 11,
    fontWeight: '900',
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ff6a00',
  },
  updateTitle: {
    color: '#111',
    fontSize: 16,
    fontWeight: '900',
  },
  updateMessage: {
    marginTop: 5,
    color: '#5d514b',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  updateDate: {
    marginTop: 7,
    color: '#9a8b80',
    fontSize: 11,
    fontWeight: '700',
  },
  actionRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionText: {
    color: '#ff6a00',
    fontSize: 13,
    fontWeight: '900',
    marginRight: 5,
  },
});
