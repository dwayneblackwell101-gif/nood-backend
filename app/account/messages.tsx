import React, { useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

type MessageItem = {
  id: string;
  title: string;
  subtitle: string;
  time: string;
  unread?: boolean;
  action?: 'orders' | 'support';
};

export default function MessagesScreen() {
  const router = useRouter();

  const [messages] = useState<MessageItem[]>([
    {
      id: '1',
      title: 'Order updates',
      subtitle: 'You will see shipping and delivery updates here.',
      time: 'Now',
      unread: true,
      action: 'orders',
    },
    {
      id: '2',
      title: 'Customer support',
      subtitle: 'Open live MooseDesk support and chat with your team.',
      time: 'Today',
      action: 'support',
    },
  ]);

  const handleMessagePress = async (item: MessageItem) => {
    if (item.action === 'support') {
      router.push('/account/support');
      return;
    }

    router.push('/account/orders');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Messages</Text>

        <View style={{ width: 42 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.heroCard}>
          <Text style={styles.big}>Support and updates</Text>
          <Text style={styles.text}>
            Open live MooseDesk support or check order updates from your account.
          </Text>
        </View>

        <View style={styles.listCard}>
          {messages.map((item) => (
            <TouchableOpacity
              key={item.id}
              style={styles.messageRow}
              activeOpacity={0.88}
              onPress={() => {
                void handleMessagePress(item);
              }}
            >
              <View style={styles.messageLeft}>
                <View style={styles.iconWrap}>
                  <Ionicons
                    name={item.unread ? 'mail-unread-outline' : 'chatbubble-ellipses-outline'}
                    size={20}
                    color="#ff6a00"
                  />
                </View>

                <View style={styles.messageTextWrap}>
                  <View style={styles.titleRow}>
                    <Text style={styles.messageTitle}>{item.title}</Text>
                    {item.unread ? <View style={styles.unreadDot} /> : null}
                  </View>

                  <Text style={styles.messageSubtitle}>{item.subtitle}</Text>
                </View>
              </View>

              <Text style={styles.timeText}>{item.time}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.helpCard}>
          <Ionicons name="information-circle-outline" size={18} color="#ff6a00" />
          <Text style={styles.helpText}>
            Customer support now opens inside the app. Order updates can be connected next.
          </Text>
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

  heroCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginBottom: 14,
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
  },

  listCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    overflow: 'hidden',
  },

  messageRow: {
    minHeight: 86,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#f4ece7',
  },

  messageLeft: {
    flexDirection: 'row',
    flex: 1,
    paddingRight: 10,
  },

  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },

  messageTextWrap: {
    flex: 1,
  },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  messageTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
  },

  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ff6a00',
    marginLeft: 8,
  },

  messageSubtitle: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: '#666',
    fontWeight: '600',
  },

  timeText: {
    fontSize: 12,
    color: '#999',
    fontWeight: '700',
    marginTop: 2,
  },

  helpCard: {
    marginTop: 14,
    backgroundColor: '#fff0e7',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ffe1d1',
  },

  helpText: {
    flex: 1,
    marginLeft: 8,
    color: '#c05d00',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
});
