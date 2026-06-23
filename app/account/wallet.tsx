import React, { useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Modal,
  Platform,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as WebBrowser from 'expo-web-browser';
import { useCart } from '../../context/CartContext';
import { useAddressBook } from '../../context/AddressContext';
import { useUser } from '../../context/UserContext';
import { postBackendJson } from '../../utils/backend';
import { BASE_CURRENCY } from '../../utils/currency';
import { getCheckoutCustomer, getPaymentTestingEmail } from '../../utils/customer';

const WIPAY_LOGO =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/IMG_2415.jpg?v=1772139039';
const PAYPAL_LOGO =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/paypal-logo-symbol-icon-transparent-png-701751695036660okg9nooua3.png?v=1781243217';

type WalletItem = {
  id: string;
  type: 'credit' | 'debit' | 'refund' | 'spend';
  amount: number;
  note: string;
  createdAt: string;
};

export default function WalletScreen() {
  const router = useRouter();
  const {
    balance = 0,
    walletHistory = [],
    addWalletFunds,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = (useCart() as any) || {};
  const { defaultAddress } = useAddressBook();
  const { profileId, displayName, isSignedIn } = useUser();

  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  const handleBackPress = () => {
    router.back();
  };

  const openPaymentChoices = () => {
    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      Alert.alert('Error', 'Enter a valid amount');
      return;
    }

    setShowPaymentModal(true);
  };

  const openPaymentUrl = async (url: string) => {
    const paymentUrl = String(url || '').trim();

    if (!paymentUrl || !paymentUrl.startsWith('https://')) {
      console.log('[NOOD payment] invalid paymentUrl:', paymentUrl);
      Alert.alert('Payment Error', 'Payment link could not be created. Please try again.');
      return;
    }

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.location.href = paymentUrl;
      return;
    }

    await WebBrowser.openBrowserAsync(paymentUrl);
  };

  const displayMoney = (value: number) =>
    formatMoney(
      convertPrice(Number(value || 0), BASE_CURRENCY, selectedCurrency),
      selectedCurrency
    );

  const getTopUpPayload = (provider: 'wipay' | 'paypal') => {
    const parsedAmount = Number(amount);
    const customer = getCheckoutCustomer({ defaultAddress, displayName, isSignedIn });
    const paypalAmount = convertPrice(parsedAmount, selectedCurrency, BASE_CURRENCY);

    const payload = {
      customerId: profileId,
      amount: provider === 'paypal' ? paypalAmount.toFixed(2) : parsedAmount.toFixed(2),
      name: customer.name,
      email: getPaymentTestingEmail(customer.email),
      phone: customer.phone,
      provider,
      paymentMethod: provider,
    };

    if (provider === 'paypal') {
      return {
        ...payload,
        currency: BASE_CURRENCY,
      };
    }

    return payload;
  };

  const createTopUpSession = async (provider: 'wipay' | 'paypal') => {
    const payload = getTopUpPayload(provider);
    try {
      const data = await postBackendJson('/wallet/topup', payload, { timeoutMs: 45000 });
      console.log('Wallet top-up response:', data);

      const paymentUrl =
        String(data?.payment_url || data?.url || data?.redirect_url || '').trim();
      console.log('[NOOD wallet] payment_url before browser opens', paymentUrl);

      if (data?.success && paymentUrl.startsWith('https://')) {
        return paymentUrl as string;
      }

      console.log('[NOOD payment] invalid paymentUrl:', paymentUrl, data);
      throw new Error(data?.message || 'Payment link could not be created. Please try again.');
    } catch (err) {
      console.log('Wallet top-up error:', err);
      throw err instanceof Error ? err : new Error('Top-up request failed');
    }
  };

  const capturePayPalTopUp = async (orderId: string) => {
    const data = await postBackendJson(
      `/api/wallet/paypal/orders/${encodeURIComponent(orderId)}/capture`,
      {},
      { timeoutMs: 45000 }
    );
    console.log('[NOOD wallet] PayPal wallet capture response:', data);

    if (!data?.success) {
      throw new Error(data?.message || 'PayPal wallet top-up was not completed.');
    }

    const transactionId = String(
      data?.transaction_id ||
        data?.wallet?.transactionId ||
        data?.wallet_transaction_id ||
        orderId
    );
    const walletHistoryId = String(data?.wallet_transaction_id || `paypal_${transactionId}`);
    const alreadyCredited = Array.isArray(walletHistory)
      ? walletHistory.some((entry: any) => String(entry?.id || '') === walletHistoryId)
      : false;

    if (alreadyCredited || data?.idempotent) {
      console.log('[NOOD wallet] PayPal wallet top-up already credited', {
        orderId,
        transactionId,
        walletHistoryId,
      });
      return data;
    }

    const creditedAmount = Number(data?.amount || data?.wallet?.amount || 0);
    const creditedCurrency = String(data?.currency || data?.wallet?.currency || BASE_CURRENCY).toUpperCase();
    const creditedBaseAmount = convertPrice(creditedAmount, creditedCurrency, BASE_CURRENCY);

    if (!Number.isFinite(creditedBaseAmount) || creditedBaseAmount <= 0) {
      throw new Error('PayPal wallet top-up did not return a valid confirmed amount.');
    }

    addWalletFunds?.(creditedBaseAmount, `PayPal wallet top-up (${transactionId})`, {
      id: walletHistoryId,
      provider: 'paypal',
      transactionId,
      orderId,
      status: data?.status || data?.wallet?.status || 'COMPLETED',
      createdAt: data?.wallet?.createdAt || new Date().toISOString(),
      currency: BASE_CURRENCY,
    });

    return data;
  };

  const handleWiPayTopUp = async () => {
    try {
      setLoading(true);
      setShowPaymentModal(false);

      const paymentUrl = await createTopUpSession('wipay');
      await openPaymentUrl(paymentUrl);
    } catch (err) {
      console.log('Wallet WiPay error:', err);
      Alert.alert('Error', err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handlePayPalTopUp = async () => {
    try {
      setLoading(true);
      setShowPaymentModal(false);

      const payload = getTopUpPayload('paypal');
      const data = await postBackendJson('/api/wallet/paypal/orders', payload, { timeoutMs: 45000 });
      console.log('[NOOD wallet] PayPal wallet order response:', data);

      const orderId = String(data?.id || data?.order_id || data?.orderID || '').trim();
      const paymentUrl = String(data?.approval_url || data?.payment_url || data?.url || '').trim();

      if (!data?.success || !orderId || !paymentUrl.startsWith('https://')) {
        throw new Error(data?.message || 'PayPal wallet top-up could not be started.');
      }

      await openPaymentUrl(paymentUrl);
      await capturePayPalTopUp(orderId);
      Alert.alert('Wallet Updated', 'Your PayPal top-up was added to your wallet.');
    } catch (err) {
      console.log('Wallet PayPal error:', err);
      Alert.alert('Error', err instanceof Error ? err.message : 'PayPal top-up is not available yet');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBackPress} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={24} color="#111" />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Wallet</Text>

        <View style={styles.iconBtn} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Available Balance</Text>
          <Text style={styles.balanceAmount}>{displayMoney(balance)}</Text>

          <TextInput
            style={styles.input}
            placeholder="Enter amount"
            placeholderTextColor="#999"
            keyboardType="numeric"
            value={amount}
            onChangeText={setAmount}
          />

          <TouchableOpacity
            style={[styles.topUpBtn, loading && styles.disabledBtn]}
            onPress={openPaymentChoices}
            disabled={loading}
          >
            <Text style={styles.topUpBtnText}>
              {loading ? 'Opening Payment...' : 'Top Up Wallet'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Wallet Activity</Text>

          {!Array.isArray(walletHistory) || walletHistory.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="wallet-outline" size={42} color="#ff6a00" />
              <Text style={styles.emptyTitle}>No wallet activity yet</Text>
              <Text style={styles.emptyText}>
                Top up your wallet to see activity here.
              </Text>
            </View>
          ) : (
            (walletHistory as WalletItem[]).map((item) => {
              const isPositive =
                item.type === 'credit' || item.type === 'refund';

              return (
                <View key={item.id} style={styles.historyCard}>
                  <View style={styles.historyLeft}>
                    <View style={styles.historyIconWrap}>
                      <Ionicons
                        name={isPositive ? 'arrow-down-circle' : 'arrow-up-circle'}
                        size={22}
                        color="#ff6a00"
                      />
                    </View>

                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyTitle}>
                        {item.note || 'Wallet transaction'}
                      </Text>
                      <Text style={styles.historyDate}>
                        {item.createdAt
                          ? new Date(item.createdAt).toLocaleString()
                          : ''}
                      </Text>
                    </View>
                  </View>

                  <Text
                    style={[
                      styles.historyAmount,
                      isPositive ? styles.positiveAmount : styles.negativeAmount,
                    ]}
                  >
                    {isPositive ? '+' : '-'}{displayMoney(Number(item.amount || 0))}
                  </Text>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      <Modal
        visible={showPaymentModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPaymentModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Top Up Wallet</Text>
            <Text style={styles.modalAmount}>
              Top up {displayMoney(Number(amount || 0))}
            </Text>

            <TouchableOpacity
              style={[styles.wipayButton, loading && styles.disabledBtn]}
              activeOpacity={0.92}
              onPress={handleWiPayTopUp}
              disabled={loading}
            >
              <View style={styles.paymentButtonLeft}>
                <View style={styles.logoBadgeLight}>
                  <Image source={{ uri: WIPAY_LOGO }} style={styles.wipayLogo} resizeMode="contain" />
                </View>
                <View style={styles.paymentTextWrap}>
                  <Text style={styles.paymentButtonTitleLight}>Continue with WiPay</Text>
                  <Text style={styles.paymentButtonSubtitleLight}>Pay securely with WiPay</Text>
                  <View style={styles.cardLogoRow}>
                    <View style={styles.cardLogoPill}>
                      <Text style={styles.cardLogoText}>Visa Debit</Text>
                    </View>
                    <View style={styles.cardLogoPill}>
                      <Text style={styles.cardLogoText}>Visa</Text>
                    </View>
                    <View style={styles.cardLogoPill}>
                      <Text style={styles.cardLogoText}>Mastercard</Text>
                    </View>
                  </View>
                </View>
              </View>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.paypalButton, loading && styles.disabledBtn]}
              activeOpacity={0.92}
              onPress={handlePayPalTopUp}
              disabled={loading}
            >
              <View style={styles.paymentButtonLeft}>
                <View style={styles.logoBadgeDark}>
                  <Image source={{ uri: PAYPAL_LOGO }} style={styles.paypalLogo} resizeMode="contain" />
                </View>
                <View style={styles.paymentTextWrap}>
                  <Text style={styles.paymentButtonTitleDark}>Continue with PayPal</Text>
                  <Text style={styles.paymentButtonSubtitleDark}>Express wallet top-up with PayPal</Text>
                </View>
              </View>
              <Ionicons name="arrow-forward" size={18} color="#0070ba" />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => setShowPaymentModal(false)}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff7f2' },

  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },

  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
  },

  content: {
    padding: 16,
    paddingBottom: 40,
  },

  balanceCard: {
    backgroundColor: '#ff6a00',
    borderRadius: 24,
    padding: 22,
    marginBottom: 18,
  },

  balanceLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    opacity: 0.9,
  },

  balanceAmount: {
    color: '#fff',
    fontSize: 38,
    fontWeight: '900',
    marginTop: 8,
  },

  input: {
    marginTop: 18,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    color: '#111',
  },

  topUpBtn: {
    marginTop: 14,
    backgroundColor: '#fff',
    alignSelf: 'flex-start',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
  },

  disabledBtn: {
    opacity: 0.6,
  },

  topUpBtnText: {
    color: '#ff6a00',
    fontWeight: '800',
    fontSize: 14,
  },

  section: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 18,
  },

  sectionTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#111',
    marginBottom: 14,
  },

  emptyCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ffd9c2',
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 220,
  },

  emptyTitle: {
    marginTop: 14,
    fontSize: 20,
    fontWeight: '800',
    color: '#111',
  },

  emptyText: {
    marginTop: 8,
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },

  historyCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffd9c2',
    padding: 14,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  historyLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 10,
  },

  historyIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },

  historyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
  },

  historyDate: {
    marginTop: 4,
    fontSize: 12,
    color: '#777',
  },

  historyAmount: {
    fontSize: 16,
    fontWeight: '900',
  },

  positiveAmount: {
    color: '#5c31ff',
  },

  negativeAmount: {
    color: '#d64545',
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: 24,
  },

  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: '#efdfcc',
  },

  modalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
  },

  modalAmount: {
    marginTop: 8,
    fontSize: 18,
    fontWeight: '700',
    color: '#ff6a00',
    textAlign: 'center',
    marginBottom: 18,
  },

  wipayButton: {
    minHeight: 88,
    borderRadius: 18,
    backgroundColor: '#ff8a00',
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  paypalButton: {
    minHeight: 72,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d7e6f7',
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  paymentButtonLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 12,
  },

  logoBadgeLight: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  logoBadgeDark: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#f3f8fd',
    alignItems: 'center',
    justifyContent: 'center',
  },

  wipayLogo: {
    width: 48,
    height: 48,
  },

  paypalLogo: {
    width: 30,
    height: 30,
  },

  paymentTextWrap: {
    marginLeft: 10,
    flex: 1,
  },

  paymentButtonTitleLight: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '900',
  },

  paymentButtonSubtitleLight: {
    color: '#fff4e8',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },

  cardLogoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    gap: 5,
  },

  cardLogoPill: {
    backgroundColor: '#ffffff',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },

  cardLogoText: {
    color: '#ff7300',
    fontSize: 9,
    fontWeight: '900',
  },

  paymentButtonTitleDark: {
    color: '#0070ba',
    fontSize: 17,
    fontWeight: '900',
  },

  paymentButtonSubtitleDark: {
    color: '#4e6b86',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },

  cancelBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },

  cancelBtnText: {
    color: '#777',
    fontWeight: '700',
  },
});
