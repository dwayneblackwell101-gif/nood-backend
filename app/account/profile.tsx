import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import RequireSignIn from '../../components/RequireSignIn';
import { SIGN_IN_ENABLED } from '../../utils/payment-testing';
import { useAddressBook } from '../../context/AddressContext';
import { useUser } from '../../context/UserContext';
import {
  buildCustomerDisplayName,
  getCustomerProfile,
  type CustomerProfile,
} from '../../utils/customer-profile';
import { getProfilePictureUri, saveProfilePicture } from '../../utils/profile-avatar';
import { noodAlert } from '../../utils/nood-alert';

const NOOD_LOGO_SOURCE = require('../../assets/images/nood-brand-logo.png');

type RowIconName = React.ComponentProps<typeof Ionicons>['name'];

function getProfileInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    return '';
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function formatAddressSummary(address: {
  address1?: string;
  address2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
} | null | undefined): string {
  if (!address) {
    return '';
  }

  return [address.address1, address.address2, address.city, address.region, address.postalCode]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}

function ProfileInfoRow({
  icon,
  label,
  value,
  onPress,
  showChevron = false,
  muted = false,
}: {
  icon: RowIconName;
  label: string;
  value: string;
  onPress?: () => void;
  showChevron?: boolean;
  muted?: boolean;
}) {
  const content = (
    <View style={styles.infoRow}>
      <View style={styles.infoIconWrap}>
        <Ionicons name={icon} size={18} color="#ff6a00" />
      </View>
      <View style={styles.infoTextWrap}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={[styles.infoValue, muted && styles.infoValueMuted]} numberOfLines={2}>
          {value}
        </Text>
      </View>
      {showChevron ? <Ionicons name="chevron-forward" size={18} color="#c4b5aa" /> : null}
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

function ProfileActionRow({
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

function ProfileContent() {
  const router = useRouter();
  const { displayName, profileId, isSignedIn } = useUser();
  const { defaultAddress } = useAddressBook();
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [profilePictureUri, setProfilePictureUri] = useState<string | null>(null);

  const resolvedSignedInName = useMemo(() => {
    if (!customerProfile) {
      const fallback = String(displayName || '').trim();
      return fallback && fallback !== 'NOOD Shopper' ? fallback : '';
    }

    return buildCustomerDisplayName(customerProfile) || customerProfile.displayName || '';
  }, [customerProfile, displayName]);

  const customerName = isSignedIn ? resolvedSignedInName || 'NOOD Member' : 'Guest';
  const customerEmail = customerProfile?.email || '';

  const profileInitials = useMemo(() => {
    if (!isSignedIn || !resolvedSignedInName) {
      return '';
    }

    return getProfileInitials(resolvedSignedInName);
  }, [isSignedIn, resolvedSignedInName]);

  const emailValue = isSignedIn
    ? customerEmail.trim() || 'Email not available yet'
    : 'Sign in to view email';

  const phoneValue = isSignedIn
    ? defaultAddress?.phone?.trim() || 'Add a phone number in Addresses'
    : 'Add after sign-in';

  const addressValue = isSignedIn
    ? formatAddressSummary(defaultAddress) || 'Add a default shipping address'
    : 'Add after sign-in';

  const loadProfile = useCallback(async () => {
    if (!isSignedIn) {
      setCustomerProfile(null);
      setProfilePictureUri(null);
      return;
    }

    const [savedProfile, savedPhoto] = await Promise.all([
      getCustomerProfile(),
      profileId ? getProfilePictureUri(profileId) : Promise.resolve(null),
    ]);

    setCustomerProfile(savedProfile);
    setProfilePictureUri(savedPhoto);
  }, [isSignedIn, profileId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useFocusEffect(
    useCallback(() => {
      void loadProfile();
    }, [loadProfile])
  );

  const handleEditProfilePicture = useCallback(async () => {
    if (!isSignedIn || !profileId) {
      noodAlert('Profile picture', 'Sign in to add a profile picture.');
      return;
    }

    if (Platform.OS === 'web') {
      noodAlert('Profile picture', 'Choose a profile picture from the NOOD mobile app.');
      return;
    }

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        noodAlert('Photo access needed', 'Allow photo library access to choose a profile picture.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });

      if (result.canceled || !result.assets?.[0]?.uri) {
        return;
      }

      const savedUri = await saveProfilePicture(profileId, result.assets[0].uri);
      setProfilePictureUri(savedUri);
    } catch (error) {
      console.log('Profile picture picker error:', error);
      noodAlert('Profile picture', 'Could not update your profile picture. Please try again.');
    }
  }, [isSignedIn, profileId]);

  const goToSignIn = useCallback(() => {
    router.replace('/(tabs)/account' as any);
  }, [router]);

  const openRoute = useCallback(
    (route: string) => {
      router.push(route as any);
    },
    [router]
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Profile</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.heroCard}>
          <View style={styles.avatarShell}>
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => void handleEditProfilePicture()}
              style={[
                styles.avatarBubble,
                isSignedIn && profilePictureUri ? styles.avatarBubblePhoto : null,
                isSignedIn && !profilePictureUri && profileInitials ? styles.avatarBubbleInitials : null,
              ]}
            >
              {isSignedIn && profilePictureUri ? (
                <Image source={{ uri: profilePictureUri }} style={styles.avatarImage} resizeMode="cover" />
              ) : isSignedIn && profileInitials ? (
                <Text style={styles.avatarInitials}>{profileInitials}</Text>
              ) : (
                <Image source={NOOD_LOGO_SOURCE} style={styles.avatarLogo} resizeMode="contain" />
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.editBtn}
              activeOpacity={0.88}
              onPress={() => void handleEditProfilePicture()}
            >
              <Ionicons name="camera" size={13} color="#fff" />
            </TouchableOpacity>
          </View>

          <Text style={styles.heroName}>{customerName}</Text>
          <Text style={styles.heroSubtitle}>
            {isSignedIn ? 'NOOD customer profile' : 'Browse as guest'}
          </Text>
        </View>

        {SIGN_IN_ENABLED && !isSignedIn ? (
          <View style={styles.guestCard}>
            <Text style={styles.guestCardTitle}>Complete your profile</Text>
            <Text style={styles.guestCardText}>
              Sign in to manage your NOOD profile, saved addresses, orders, wallet, and rewards.
            </Text>
            <TouchableOpacity style={styles.signInBtn} activeOpacity={0.9} onPress={goToSignIn}>
              <Ionicons name="person-circle-outline" size={18} color="#fff" />
              <Text style={styles.signInBtnText}>Sign in to complete profile</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Profile details</Text>

          <ProfileInfoRow
            icon="person-outline"
            label="Name"
            value={customerName}
            muted={!isSignedIn}
          />
          <View style={styles.divider} />
          <ProfileInfoRow
            icon="mail-outline"
            label="Email"
            value={emailValue}
            muted={!isSignedIn || !customerEmail.trim()}
          />
          <View style={styles.divider} />
          <ProfileInfoRow
            icon="call-outline"
            label="Phone"
            value={phoneValue}
            muted={!isSignedIn || !defaultAddress?.phone?.trim()}
            onPress={isSignedIn ? () => openRoute('/account/address') : undefined}
            showChevron={isSignedIn}
          />
          <View style={styles.divider} />
          <ProfileInfoRow
            icon="location-outline"
            label="Default shipping address"
            value={addressValue}
            muted={!isSignedIn || !formatAddressSummary(defaultAddress)}
            onPress={isSignedIn ? () => openRoute('/account/address') : undefined}
            showChevron={isSignedIn}
          />
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Profile actions</Text>

          <ProfileActionRow
            icon="camera-outline"
            title="Edit profile picture"
            subtitle={isSignedIn ? 'Choose a photo from your gallery' : 'Sign in to add a profile picture'}
            onPress={() => void handleEditProfilePicture()}
          />
          <View style={styles.divider} />
          <ProfileActionRow
            icon="location-outline"
            title="Manage addresses"
            subtitle="Shipping and default delivery addresses"
            onPress={() => openRoute('/account/address')}
          />
          <View style={styles.divider} />
          <ProfileActionRow
            icon="card-outline"
            title="Payment methods"
            subtitle="Wallet, PayPal, WiPay, and secure checkout"
            onPress={() => openRoute('/account/payment-methods')}
          />
          <View style={styles.divider} />
          <ProfileActionRow
            icon="shield-checkmark-outline"
            title="Security"
            subtitle="Sign-in methods and account protection"
            onPress={() => openRoute('/account/security')}
          />
        </View>

        {isSignedIn ? (
          <Text style={styles.footerNote}>
            Name and email come from your Shopify customer account. Phone and address use your saved shipping details.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

export default function ProfileScreen() {
  return (
    <RequireSignIn feature="your profile">
      <ProfileContent />
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
    borderRadius: 26,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingVertical: 24,
    paddingHorizontal: 18,
    alignItems: 'center',
    marginBottom: 14,
    shadowColor: '#ff6a00',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  avatarShell: {
    position: 'relative',
    marginBottom: 14,
  },
  avatarBubble: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarBubblePhoto: {
    borderColor: '#ffd2b8',
  },
  avatarBubbleInitials: {
    backgroundColor: '#ff6a00',
    borderColor: '#ff6a00',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarLogo: {
    width: 62,
    height: 42,
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '900',
  },
  editBtn: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#ff6a00',
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  heroName: {
    fontSize: 24,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
  },
  heroSubtitle: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '700',
    color: '#ff6a00',
    textAlign: 'center',
  },
  guestCard: {
    backgroundColor: '#fff',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 18,
    marginBottom: 14,
  },
  guestCardTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  guestCardText: {
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    marginBottom: 16,
  },
  signInBtn: {
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: '#ff6a00',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  signInBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  sectionCard: {
    backgroundColor: '#fff',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  infoIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  infoLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8d7a6f',
    marginBottom: 3,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
    lineHeight: 20,
  },
  infoValueMuted: {
    color: '#8d7a6f',
    fontWeight: '700',
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
    borderRadius: 14,
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
    color: '#7a6a5f',
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: '#f3ebe4',
  },
  footerNote: {
    fontSize: 12,
    lineHeight: 18,
    color: '#8d7a6f',
    textAlign: 'center',
    paddingHorizontal: 8,
    marginTop: 2,
  },
});