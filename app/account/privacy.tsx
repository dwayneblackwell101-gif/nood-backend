import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import RequireSignIn from '../../components/RequireSignIn';

type PrivacyRowProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  subtitle: string;
};

function PrivacyRow({ icon, title, subtitle }: PrivacyRowProps) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIconWrap}>
        <Ionicons name={icon} size={20} color="#ff6a00" />
      </View>
      <View style={styles.rowTextWrap}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowSubtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

function PrivacyContent() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Privacy settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.heroCard}>
          <View style={styles.heroIconWrap}>
            <Ionicons name="shield-checkmark-outline" size={34} color="#ff6a00" />
          </View>
          <Text style={styles.heroTitle}>Your data stays protected</Text>
          <Text style={styles.heroCopy}>
            NOOD keeps account checkout and sign-in data protected through Shopify customer accounts.
            Sensitive details are not shown to guests and are cleared from the app when you sign out.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What Shopify manages</Text>
          <PrivacyRow
            icon="person-circle-outline"
            title="Customer account sign-in"
            subtitle="Email, name, and secure authentication through Shopify."
          />
          <View style={styles.divider} />
          <PrivacyRow
            icon="card-outline"
            title="Checkout and payments"
            subtitle="Payment processing and order records tied to your customer account."
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What stays on this device</Text>
          <PrivacyRow
            icon="heart-outline"
            title="Saved items and cart"
            subtitle="Scoped to your signed-in account or guest session on this device."
          />
          <View style={styles.divider} />
          <PrivacyRow
            icon="star-outline"
            title="Draft reviews"
            subtitle="Saved on device until publishing is connected."
          />
          <View style={styles.divider} />
          <PrivacyRow
            icon="time-outline"
            title="Activity history"
            subtitle="Visible only while you are signed in to your NOOD account."
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Coming next</Text>
          <Text style={styles.sectionSubtitle}>
            Marketing preferences, data export requests, and additional privacy controls will appear
            here in a future NOOD update.
          </Text>
          <View style={styles.comingSoonPill}>
            <Ionicons name="construct-outline" size={14} color="#8d5a2b" />
            <Text style={styles.comingSoonText}>Privacy controls in setup</Text>
          </View>
        </View>

        <View style={styles.actionsCard}>
          <TouchableOpacity
            style={styles.primaryBtn}
            activeOpacity={0.9}
            onPress={() => router.push('/account/security' as any)}
          >
            <Ionicons name="lock-closed-outline" size={18} color="#fff" />
            <Text style={styles.primaryBtnText}>Open Security</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryBtn}
            activeOpacity={0.9}
            onPress={() => router.push('/account/settings' as any)}
          >
            <Ionicons name="notifications-outline" size={18} color="#6f5a4e" />
            <Text style={styles.secondaryBtnText}>Notification preferences</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryBtn}
            activeOpacity={0.9}
            onPress={() => router.push('/account/support' as any)}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={18} color="#6f5a4e" />
            <Text style={styles.secondaryBtnText}>Contact support</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function PrivacyScreen() {
  return (
    <RequireSignIn
      feature="privacy settings"
      title="Sign in to manage privacy"
      subtitle="Privacy settings and account data controls are available after you sign in."
      icon="eye-off-outline"
    >
      <PrivacyContent />
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
  heroCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    marginBottom: 14,
  },
  heroIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
    marginBottom: 8,
  },
  heroCopy: {
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    textAlign: 'center',
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginBottom: 6,
  },
  sectionSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: '#666',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 4,
  },
  rowIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTextWrap: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
  },
  rowSubtitle: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 19,
    color: '#666',
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: '#ffe4d6',
    marginVertical: 12,
  },
  comingSoonPill: {
    marginTop: 14,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  comingSoonText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#8d5a2b',
  },
  actionsCard: {
    gap: 10,
  },
  primaryBtn: {
    minHeight: 50,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  secondaryBtn: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryBtnText: {
    color: '#6f5a4e',
    fontSize: 14,
    fontWeight: '900',
  },
});