import React, { useCallback } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import RequireSignIn from '../../components/RequireSignIn';
import { noodAlert } from '../../utils/nood-alert';

type RowIconName = React.ComponentProps<typeof Ionicons>['name'];

function PaymentOptionRow({
  icon,
  iconColor,
  title,
  subtitle,
  onPress,
}: {
  icon: RowIconName;
  iconColor: string;
  title: string;
  subtitle: string;
  onPress?: () => void;
}) {
  const content = (
    <View style={styles.methodRow}>
      <View style={styles.methodIconWrap}>
        <Ionicons name={icon} size={22} color={iconColor} />
      </View>
      <View style={styles.methodTextWrap}>
        <Text style={styles.methodTitle}>{title}</Text>
        <Text style={styles.methodSubtitle}>{subtitle}</Text>
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={18} color="#c4b5aa" /> : null}
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress}>
      {content}
    </TouchableOpacity>
  );
}

function PaymentMethodsContent() {
  const router = useRouter();

  const showPaymentInfo = useCallback((title: string, message: string) => {
    noodAlert(title, message, [{ text: 'OK', style: 'default' }]);
  }, []);

  const openWallet = useCallback(() => {
    router.push('/account/wallet' as any);
  }, [router]);

  const learnSecurePayments = useCallback(() => {
    showPaymentInfo(
      'Secure payments',
      'NOOD uses WiPay, PayPal, Shopify checkout, and NOOD Wallet. Your full card number, CVV, and raw payment details are never stored in the app.'
    );
  }, [showPaymentInfo]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Payment methods</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.heading}>Payment options</Text>
          <Text style={styles.description}>
            Choose how you want to pay at checkout. Card details are securely handled by our payment
            providers and are never stored in the NOOD app.
          </Text>

          <PaymentOptionRow
            icon="wallet-outline"
            iconColor="#ff6a00"
            title="NOOD Wallet"
            subtitle="Use wallet balance, refunds, and rewards"
            onPress={openWallet}
          />

          <View style={styles.divider} />

          <PaymentOptionRow
            icon="logo-paypal"
            iconColor="#0070ba"
            title="PayPal"
            subtitle="Available at checkout and wallet top-up"
            onPress={() =>
              showPaymentInfo(
                'PayPal',
                'PayPal is available during checkout and for NOOD Wallet top-ups. Pay securely without storing card details in the app.'
              )
            }
          />

          <View style={styles.divider} />

          <PaymentOptionRow
            icon="card-outline"
            iconColor="#ff6a00"
            title="WiPay cards"
            subtitle="Visa, Mastercard, and debit cards"
            onPress={() =>
              showPaymentInfo(
                'WiPay cards',
                'Card payments are securely processed by WiPay at checkout. Card numbers are not collected on this screen.'
              )
            }
          />

          <View style={styles.divider} />

          <PaymentOptionRow
            icon="bag-handle-outline"
            iconColor="#5433EB"
            title="Shopify checkout"
            subtitle="Secure hosted checkout and Shop Pay"
            onPress={() =>
              showPaymentInfo(
                'Shopify checkout',
                'Shopify checkout is used for secure customer payment options, including hosted checkout and Shop Pay.'
              )
            }
          />
        </View>

        <View style={styles.savedCard}>
          <Text style={styles.savedTitle}>Saved payment methods</Text>

          <View style={styles.emptyState}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="card-outline" size={28} color="#ff6a00" />
            </View>
            <Text style={styles.emptyTitle}>No saved payment methods</Text>
            <Text style={styles.emptySubtitle}>
              Saved cards will appear here when secure provider tokenization is enabled. For now, you
              can pay safely at checkout with WiPay, PayPal, Shopify checkout, or NOOD Wallet.
            </Text>
            <TouchableOpacity
              style={styles.learnBtn}
              activeOpacity={0.9}
              onPress={learnSecurePayments}
            >
              <Ionicons name="shield-checkmark-outline" size={16} color="#ff6a00" />
              <Text style={styles.learnBtnText}>Learn about secure payments</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.securityCard}>
          <Ionicons name="lock-closed-outline" size={18} color="#5c31ff" />
          <Text style={styles.securityText}>
            NOOD never stores your full card number, CVV, or raw payment details.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function PaymentMethodsScreen() {
  return (
    <RequireSignIn feature="payment methods">
      <PaymentMethodsContent />
    </RequireSignIn>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
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
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 8,
    marginBottom: 14,
    shadowColor: '#ff6a00',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  heading: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
  },
  description: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    marginBottom: 6,
  },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  methodIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodTextWrap: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  methodTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
  },
  methodSubtitle: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 18,
    color: '#666',
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: '#f3ebe4',
  },
  savedCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 18,
    marginBottom: 14,
  },
  savedTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginBottom: 12,
  },
  emptyState: {
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 18,
    alignItems: 'center',
  },
  emptyIconWrap: {
    width: 56,
    height: 56,
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
    marginTop: 8,
    fontSize: 13,
    lineHeight: 20,
    color: '#666',
    textAlign: 'center',
    fontWeight: '600',
  },
  learnBtn: {
    marginTop: 16,
    minHeight: 46,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffd9c6',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  learnBtnText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '900',
  },
  securityCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#f8f5ff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e4dcff',
    padding: 14,
  },
  securityText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: '#4d33b8',
    fontWeight: '700',
  },
});