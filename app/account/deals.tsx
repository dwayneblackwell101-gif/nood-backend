import React, { useMemo } from 'react';
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
import { useCart } from '../../context/CartContext';
import { BASE_CURRENCY } from '../../utils/currency';

export default function DealsScreen() {
  const router = useRouter();
  const {
    balance = 0,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = useCart();

  const displayBalance = formatMoney(
    convertPrice(Number(balance || 0), BASE_CURRENCY, selectedCurrency),
    selectedCurrency
  );

  // ✅ DYNAMIC DEALS
  const deals = useMemo(() => {
    return [
      {
        id: '1',
        title: '5% off 3+ items',
        desc: 'Automatically applied at checkout',
        color: '#ff6a00',
      },
      {
        id: '2',
        title: 'Free Shipping',
        desc: 'All items qualify for free delivery',
        color: '#5c31ff',
      },
      {
        id: '3',
        title: 'Use NOOD Balance',
        desc: `You have ${displayBalance} available`,
        color: '#2563eb',
      },
    ];
  }, [displayBalance]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Deals</Text>

        <View style={{ width: 42 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* HERO */}
        <View style={styles.heroCard}>
          <Text style={styles.big}>Coupons & offers</Text>
          <Text style={styles.text}>
            Save more on every order with automatic deals and balance rewards.
          </Text>
        </View>

        {/* DEAL LIST */}
        <View style={styles.listCard}>
          {deals.map((deal) => (
            <View key={deal.id} style={styles.dealRow}>
              <View style={[styles.iconWrap, { backgroundColor: `${deal.color}15` }]}>
                <Ionicons name="pricetag-outline" size={20} color={deal.color} />
              </View>

              <View style={styles.dealTextWrap}>
                <Text style={styles.dealTitle}>{deal.title}</Text>
                <Text style={styles.dealDesc}>{deal.desc}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* ACTION */}
        <TouchableOpacity
          style={styles.actionCard}
          activeOpacity={0.9}
          onPress={() => router.push('/(tabs)/categories')}
        >
          <Ionicons name="flash-outline" size={18} color="#ff6a00" />
          <Text style={styles.actionText}>Shop now and apply deals automatically</Text>
        </TouchableOpacity>
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

  dealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f4ece7',
  },

  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },

  dealTextWrap: {
    flex: 1,
  },

  dealTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
  },

  dealDesc: {
    marginTop: 4,
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
  },

  actionCard: {
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

  actionText: {
    marginLeft: 8,
    color: '#ff6a00',
    fontSize: 13,
    fontWeight: '800',
  },
});
