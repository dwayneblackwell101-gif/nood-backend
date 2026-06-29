import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import RequireSignIn, { ACCOUNT_SIGN_IN_GATE_DISABLED } from '../../components/RequireSignIn';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';
import { getCustomerProfile } from '../../utils/customer-profile';
import { noodAlert } from '../../utils/nood-alert';

type RowIconName = React.ComponentProps<typeof Ionicons>['name'];

const SECURITY_ACTIONS = [
  {
    id: 'manage-sign-in',
    icon: 'key-outline' as const,
    title: 'Manage sign-in',
    subtitle: 'Open Shopify secure account sign-in',
  },
  {
    id: 'privacy',
    icon: 'eye-off-outline' as const,
    title: 'Privacy settings',
    subtitle: 'Manage account privacy and data',
  },
  {
    id: 'delete-account',
    icon: 'trash-outline' as const,
    title: 'Delete account request',
    subtitle: 'Contact support to request account deletion',
  },
] as const;

const PROTECTION_BADGES = [
  { icon: 'shield-checkmark-outline' as const, label: 'Secure Shopify sign-in' },
  { icon: 'lock-closed-outline' as const, label: 'Protected checkout' },
  { icon: 'checkmark-circle-outline' as const, label: 'NOOD never stores your password' },
] as const;

function StatusBadge({ label }: { label: string }) {
  return (
    <View style={styles.statusBadge}>
      <Text style={styles.statusBadgeText}>{label}</Text>
    </View>
  );
}

function ProtectionBadge({
  icon,
  label,
}: {
  icon: RowIconName;
  label: string;
}) {
  return (
    <View style={styles.protectionBadge}>
      <View style={styles.protectionIconWrap}>
        <Ionicons name={icon} size={16} color="#ff6a00" />
      </View>
      <Text style={styles.protectionBadgeText}>{label}</Text>
    </View>
  );
}

function AccountInfoRow({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, muted && styles.infoValueMuted]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function SecurityActionRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: RowIconName;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.actionRow} activeOpacity={0.88} onPress={onPress}>
      <View style={styles.actionIconWrap}>
        <Ionicons name={icon} size={20} color="#ff6a00" />
      </View>
      <View style={styles.actionTextWrap}>
        <Text style={styles.actionTitle}>{title}</Text>
        <Text style={styles.actionSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#c4b5aa" />
    </TouchableOpacity>
  );
}

function SecurityContent() {
  const router = useRouter();
  const { displayName, isSignedIn, signOut } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerNameFromProfile, setCustomerNameFromProfile] = useState('');

  const loadProfile = useCallback(async () => {
    if (!isSignedIn) {
      setCustomerEmail('');
      setCustomerNameFromProfile('');
      return;
    }

    const profile = await getCustomerProfile();
    setCustomerEmail(profile?.email || '');
    setCustomerNameFromProfile(profile?.displayName || '');
  }, [isSignedIn]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useFocusEffect(
    useCallback(() => {
      void loadProfile();
    }, [loadProfile])
  );

  const signedInAs = useMemo(() => {
    if (!isSignedIn) {
      return 'Guest';
    }

    const normalizedName = String(customerNameFromProfile || displayName || '').trim();
    if (normalizedName && normalizedName !== 'NOOD Shopper') {
      return normalizedName;
    }

    const email = customerEmail.trim();
    if (email) {
      return email;
    }

    return 'NOOD Member';
  }, [customerEmail, customerNameFromProfile, displayName, isSignedIn]);

  const emailValue = isSignedIn
    ? customerEmail.trim() || 'Email not available yet'
    : 'Sign in to view email';

  const goToSignIn = useCallback(() => {
    router.replace('/(tabs)/account' as any);
  }, [router]);

  const showSetupAlert = useCallback(() => {
    noodAlert(
      'This feature is being set up',
      'NOOD is finishing this account tool. Check back soon.'
    );
  }, []);

  const handleSecurityAction = useCallback(
    (actionId: string) => {
      if (actionId === 'manage-sign-in') {
        router.push('/account/auth' as any);
        return;
      }

      if (actionId === 'privacy') {
        router.push('/account/privacy' as any);
        return;
      }

      if (actionId === 'delete-account') {
        router.push('/account/support' as any);
        return;
      }

      showSetupAlert();
    },
    [router, showSetupAlert]
  );

  const handleSignOut = async () => {
    await addHistoryEvent({
      type: 'account',
      title: 'Signed out',
      description: 'Customer signed out of NOOD on this device.',
      status: 'signed-out',
    });
    await signOut();
    router.replace('/(tabs)/account');
  };

  const confirmSignOut = () => {
    noodAlert('Sign out', 'Sign out of your NOOD customer account on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void handleSignOut() },
    ]);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Security</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.cardHeadingRow}>
            <View style={styles.cardHeadingIcon}>
              <Ionicons name="shield-checkmark" size={20} color="#ff6a00" />
            </View>
            <Text style={styles.heading}>Account protection</Text>
          </View>

          <Text style={styles.description}>
            Your NOOD account sign-in is securely managed through Shopify customer accounts.
          </Text>

          <View style={styles.protectionList}>
            {PROTECTION_BADGES.map((badge) => (
              <ProtectionBadge key={badge.label} icon={badge.icon} label={badge.label} />
            ))}
          </View>

          <View style={styles.divider} />

          <AccountInfoRow label="Signed in as" value={signedInAs} muted={!isSignedIn} />
          <View style={styles.divider} />
          <AccountInfoRow
            label="Email"
            value={emailValue}
            muted={!isSignedIn || !customerEmail.trim()}
          />

          {!isSignedIn && !ACCOUNT_SIGN_IN_GATE_DISABLED ? (
            <View style={styles.guestPanel}>
              <Text style={styles.guestPanelText}>
                Sign in to view your connected sign-in methods and account protection settings.
              </Text>
              <TouchableOpacity style={styles.signInBtn} activeOpacity={0.9} onPress={goToSignIn}>
                <Ionicons name="person-circle-outline" size={18} color="#fff" />
                <Text style={styles.signInBtnText}>Sign in to manage security</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        {isSignedIn || ACCOUNT_SIGN_IN_GATE_DISABLED ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Sign-in</Text>
            <Text style={styles.sectionSubtitle}>
              Your NOOD account sign-in is managed securely by Shopify customer accounts.
            </Text>

            <View style={styles.methodRow}>
              <View style={styles.methodIconWrap}>
                <Ionicons name="shield-checkmark-outline" size={22} color="#ff6a00" />
              </View>
              <View style={styles.methodTextWrap}>
                <Text style={styles.methodTitle}>Managed by Shopify</Text>
                <Text style={styles.methodSubtitle}>
                  Use the same sign-in provider you chose when creating your customer account. NOOD
                  does not store your password.
                </Text>
              </View>
              <StatusBadge label="Active" />
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Security actions</Text>
          <Text style={styles.sectionSubtitle}>
            Manage sign-in, privacy, and account requests through secure NOOD account tools.
          </Text>

          {SECURITY_ACTIONS.map((action, index) => (
            <React.Fragment key={action.id}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <SecurityActionRow
                icon={action.icon}
                title={action.title}
                subtitle={action.subtitle}
                onPress={() => handleSecurityAction(action.id)}
              />
            </React.Fragment>
          ))}
        </View>

        {isSignedIn ? (
          <TouchableOpacity style={styles.signOutBtn} activeOpacity={0.9} onPress={confirmSignOut}>
            <Ionicons name="log-out-outline" size={18} color="#d64545" />
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.footerNote}>
          <Ionicons name="information-circle-outline" size={16} color="#8d7a6f" />
          <Text style={styles.footerNoteText}>
            NOOD does not store your password. Sign-in and account security are managed by Shopify
            customer accounts.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function SecurityScreen() {
  return (
    <RequireSignIn feature="security settings">
      <SecurityContent />
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
    paddingBottom: 32,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 16,
    marginBottom: 14,
    shadowColor: '#ff6a00',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  cardHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  cardHeadingIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
    flex: 1,
  },
  description: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    fontWeight: '600',
  },
  protectionList: {
    marginTop: 14,
    gap: 8,
  },
  protectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff7f2',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  protectionIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  protectionBadgeText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    color: '#4e260d',
  },
  divider: {
    height: 1,
    backgroundColor: '#f3ebe4',
    marginVertical: 2,
  },
  infoRow: {
    paddingVertical: 12,
  },
  infoLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8d7a6f',
    marginBottom: 4,
    letterSpacing: 0.2,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
  },
  infoValueMuted: {
    color: '#8d7a6f',
    fontWeight: '700',
  },
  guestPanel: {
    marginTop: 14,
    backgroundColor: '#fff7f2',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 16,
  },
  guestPanelText: {
    fontSize: 13,
    lineHeight: 20,
    color: '#666',
    fontWeight: '600',
    textAlign: 'center',
  },
  signInBtn: {
    marginTop: 14,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  signInBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginBottom: 6,
  },
  sectionSubtitle: {
    fontSize: 13,
    lineHeight: 20,
    color: '#666',
    fontWeight: '600',
    marginBottom: 4,
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
  statusBadge: {
    maxWidth: 118,
    backgroundColor: '#fff7f2',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ffd9c6',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusBadgeText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    color: '#b35a12',
    textAlign: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  actionIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionTextWrap: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  actionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
  },
  actionSubtitle: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    color: '#666',
    fontWeight: '600',
  },
  signOutBtn: {
    marginTop: 2,
    minHeight: 52,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: '#ffb4a8',
    backgroundColor: '#fff9f7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  signOutText: {
    color: '#d64545',
    fontSize: 16,
    fontWeight: '800',
  },
  footerNote: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 4,
  },
  footerNoteText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    color: '#8d7a6f',
    fontWeight: '600',
  },
});