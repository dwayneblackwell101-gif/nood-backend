import React, { useEffect, useState } from 'react';
import {
  Image,
  InteractionManager,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Font from 'expo-font';
import { Stack, usePathname, useRouter } from 'expo-router';
import { UserProvider, useUser } from '../context/UserContext';
import { CartProvider } from '../context/CartContext';
import { AddressProvider } from '../context/AddressContext';
import { HistoryProvider } from '../context/HistoryContext';
import { UpdatesProvider } from '../context/UpdatesContext';
import { logBackendStartup } from '../utils/backend';

const webShadow = (value: string) => (Platform.OS === 'web' ? { boxShadow: value } : {});
const platformShadow = (webValue: string, nativeValue: object) =>
  Platform.OS === 'web' ? webShadow(webValue) : nativeValue;
const GOOGLE_LOGO_URL =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/2a5758d6-4edb-4047-87bb-e6b94dbbbab0-cover.png?v=1781936734';

export default function RootLayout() {
  return (
    <UserProvider>
      <HistoryProvider>
        <UpdatesProvider>
          <AddressProvider>
            <CartProvider>
              <RootLayoutInner />
            </CartProvider>
          </AddressProvider>
        </UpdatesProvider>
      </HistoryProvider>
    </UserProvider>
  );
}

function RootLayoutInner() {
  const [iconsReady, setIconsReady] = useState(Platform.OS === 'web');

  useEffect(() => {
    logBackendStartup();
  }, []);

  useEffect(() => {
    const previousUnhandledRejection = (globalThis as any).onunhandledrejection;

    (globalThis as any).onunhandledrejection = (event: any) => {
      const message = String(event?.reason?.message || event?.reason || '');

      if (message.includes('Unable to activate keep awake')) {
        event?.preventDefault?.();
        return;
      }

      if (typeof previousUnhandledRejection === 'function') {
        previousUnhandledRejection(event);
      }
    };

    return () => {
      (globalThis as any).onunhandledrejection = previousUnhandledRejection;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    Font.loadAsync(Ionicons.font)
      .catch(() => {
        // Keep the app usable if the icon font is slow or unavailable on web.
      })
      .finally(() => {
        if (isMounted && Platform.OS !== 'web') {
          setIconsReady(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <View style={styles.rootShell}>
      <Stack screenOptions={{ headerShown: false }} />
      {iconsReady ? <WelcomeModalHost /> : <LaunchSplash overlay />}
    </View>
  );
}

function WelcomeModalHost() {
  const router = useRouter();
  const pathname = usePathname();
  const { isReady, isSignedIn } = useUser();
  const [dismissedForSession, setDismissedForSession] = useState(false);

  const isAuthRoute = pathname === '/sign-in' || pathname === '/account/auth';
  const showWelcomeModal =
    isReady && !isSignedIn && !dismissedForSession && !isAuthRoute;
  const shouldBlockTouches = !isReady;

  const closeModal = () => {
    setDismissedForSession(true);
  };

  const openProvider = (provider: 'google' | 'email' | 'phone' | 'facebook') => {
    closeModal();

    InteractionManager.runAfterInteractions(() => {
      if (provider === 'email' || provider === 'google' || provider === 'phone') {
        router.push({
          pathname: '/account/auth',
          params: { provider },
        });
        return;
      }

      router.push('/sign-in');
    });
  };

  return (
    <>
      {shouldBlockTouches ? <View style={styles.touchBlocker} pointerEvents="box-only" /> : null}

      {showWelcomeModal ? (
        <View style={styles.overlay}>
          <SafeAreaView style={styles.modalShell}>
            <Pressable style={styles.backdrop} onPress={closeModal} />

            <View style={styles.card}>
              <View style={styles.topRow}>
                <View style={styles.securePill}>
                  <Ionicons name="shield-checkmark" size={14} color="#5c31ff" />
                  <Text style={styles.secureText}>Secure account access</Text>
                </View>

                <TouchableOpacity
                  style={styles.closeButton}
                  activeOpacity={0.85}
                  onPress={closeModal}
                >
                  <Ionicons name="close" size={18} color="#666" />
                </TouchableOpacity>
              </View>

              <Image
                source={require('../assets/images/nood-brand-logo.png')}
                style={styles.logo}
                resizeMode="contain"
              />

              <Text style={styles.title}>Sign in to join NOOD</Text>
              <Text style={styles.subtitle}>
                Access saved items, rewards, order updates, and a faster checkout in one place.
              </Text>

              <View style={styles.featureRow}>
                <View style={styles.featureChip}>
                  <Ionicons name="gift-outline" size={16} color="#ff6a00" />
                  <Text style={styles.featureText}>Rewards</Text>
                </View>
                <View style={styles.featureChip}>
                  <Ionicons name="pricetag-outline" size={16} color="#ff6a00" />
                  <Text style={styles.featureText}>Offers</Text>
                </View>
                <View style={styles.featureChip}>
                  <Ionicons name="wallet-outline" size={16} color="#ff6a00" />
                  <Text style={styles.featureText}>Wallet</Text>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.authButton, styles.googleButton]}
                activeOpacity={0.92}
                onPress={() => openProvider('google')}
              >
                <View style={styles.googleBadge}>
                  <Image source={{ uri: GOOGLE_LOGO_URL }} style={styles.googleBadgeLogo} resizeMode="contain" />
                </View>
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.authButton}
                activeOpacity={0.92}
                onPress={() => openProvider('email')}
              >
                <Ionicons name="mail-outline" size={20} color="#111" />
                <Text style={styles.authButtonText}>Continue with Email</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.authButton}
                activeOpacity={0.92}
                onPress={() => openProvider('phone')}
              >
                <Ionicons name="phone-portrait-outline" size={20} color="#111" />
                <Text style={styles.authButtonText}>Continue with phone number</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.skipButton}
                activeOpacity={0.85}
                onPress={closeModal}
              >
                <Text style={styles.skipText}>Maybe later</Text>
              </TouchableOpacity>

              <Text style={styles.footerText}>
                By continuing, you agree to secure sign-in and account protection.
              </Text>
            </View>
          </SafeAreaView>
        </View>
      ) : null}
    </>
  );
}

function LaunchSplash({ overlay = false }: { overlay?: boolean }) {
  return (
    <View style={[styles.launchSplash, overlay && styles.launchSplashOverlay]}>
      <View style={styles.launchSplashContent}>
        <Image
          source={require('../assets/images/nood-brand-splash.png')}
          resizeMode="contain"
          style={styles.launchSplashLogo}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rootShell: {
    flex: 1,
    backgroundColor: '#fff',
  },
  launchSplash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  launchSplashOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10000,
    ...(Platform.OS === 'web' ? {} : { elevation: 10000 }),
  },
  launchSplashLogo: {
    width: 260,
    height: 180,
  },
  launchSplashContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  touchBlocker: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
    zIndex: 9998,
    ...(Platform.OS === 'web' ? {} : { elevation: 9998 }),
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 17, 17, 0.42)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    zIndex: 9999,
    ...(Platform.OS === 'web' ? {} : { elevation: 9999 }),
  },
  modalShell: {
    flex: 1,
    justifyContent: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 420,
    borderRadius: 28,
    backgroundColor: '#fff8f1',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: '#ffe1cc',
    ...platformShadow('0 8px 18px rgba(0,0,0,0.16)', {
        shadowColor: '#000',
        shadowOpacity: 0.16,
        shadowRadius: 18,
        elevation: 8,
    }),
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  securePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1ecff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  secureText: {
    marginLeft: 6,
    color: '#5c31ff',
    fontSize: 12,
    fontWeight: '700',
  },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#f2ddcf',
  },
  logo: {
    width: 120,
    height: 42,
    alignSelf: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 30,
    lineHeight: 34,
    fontWeight: '900',
    color: '#4e260d',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
    color: '#6f5a4e',
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  featureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 18,
    marginBottom: 18,
  },
  featureChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffe1cc',
    paddingVertical: 12,
  },
  featureText: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: '700',
    color: '#8a5a37',
  },
  authButton: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e9d8c9',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  googleButton: {
    backgroundColor: '#1f73e8',
    borderColor: '#1f73e8',
  },
  googleBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    marginRight: 10,
  },
  googleBadgeLogo: {
    width: 20,
    height: 20,
  },
  googleButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
  },
  authButtonText: {
    marginLeft: 10,
    color: '#111',
    fontSize: 16,
    fontWeight: '700',
  },
  skipButton: {
    alignSelf: 'center',
    marginTop: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  skipText: {
    color: '#8d7a6f',
    fontSize: 14,
    fontWeight: '600',
  },
  footerText: {
    marginTop: 4,
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 18,
    color: '#8d7a6f',
  },
});
