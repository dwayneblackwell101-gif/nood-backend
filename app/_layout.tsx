import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useUpdates } from '../context/UpdatesContext';
import { PAYMENT_TESTING_MODE } from '../utils/payment-testing';
import { CartProvider } from '../context/CartContext';
import { WishlistProvider } from '../context/WishlistContext';
import { AddressProvider } from '../context/AddressContext';
import { HistoryProvider } from '../context/HistoryContext';
import { UpdatesProvider } from '../context/UpdatesContext';
import { NoodAlertProvider } from '../context/NoodAlertContext';
import { logBackendStartup } from '../utils/backend';
import {
  canUseRemotePushNotifications,
  ensurePushTokenRegistered,
  evaluateNotificationPromptState,
  markNotificationPromptShown,
} from '../utils/push-notifications';
import ShopifyAuthDeepLinkListener from '../components/ShopifyAuthDeepLinkListener';

const webShadow = (value: string) => (Platform.OS === 'web' ? { boxShadow: value } : {});
const platformShadow = (webValue: string, nativeValue: object) =>
  Platform.OS === 'web' ? webShadow(webValue) : nativeValue;
const GOOGLE_LOGO_URL =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/2a5758d6-4edb-4047-87bb-e6b94dbbbab0-cover.png?v=1781936734';

type WelcomeAuthProvider = 'google' | 'facebook' | 'shop';

function FacebookProviderIcon() {
  return (
    <View style={styles.facebookIconBadge}>
      <Text style={styles.facebookIconText}>f</Text>
    </View>
  );
}

function ShopProviderIcon() {
  return (
    <View style={styles.shopIconBadge}>
      <Ionicons name="bag-handle" size={18} color="#fff" />
    </View>
  );
}

export default function RootLayout() {
  return (
    <UserProvider>
      <NoodAlertProvider>
        <HistoryProvider>
          <UpdatesProvider>
            <AddressProvider>
              <CartProvider>
                <WishlistProvider>
                  <RootLayoutInner />
                </WishlistProvider>
              </CartProvider>
            </AddressProvider>
          </UpdatesProvider>
        </HistoryProvider>
      </NoodAlertProvider>
    </UserProvider>
  );
}

function RootLayoutInner() {
  const [iconsReady, setIconsReady] = useState(Platform.OS === 'web');
  const [welcomeDismissedForSession, setWelcomeDismissedForSession] = useState(false);
  const [notificationFlowFinished, setNotificationFlowFinished] = useState(false);
  const handleNotificationFlowFinished = useCallback(() => {
    setNotificationFlowFinished(true);
  }, []);

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
      <ShopifyAuthDeepLinkListener />
      <Stack screenOptions={{ headerShown: false }} />
      {iconsReady ? (
        <>
          <NotificationPermissionPromptHost onFlowFinished={handleNotificationFlowFinished} />
          <WelcomeModalHost
            dismissedForSession={welcomeDismissedForSession}
            onDismiss={() => setWelcomeDismissedForSession(true)}
            canShowAfterStartup={notificationFlowFinished}
          />
        </>
      ) : (
        <LaunchSplash overlay />
      )}
    </View>
  );
}

function WelcomeModalHost({
  dismissedForSession,
  onDismiss,
  canShowAfterStartup,
}: {
  dismissedForSession: boolean;
  onDismiss: () => void;
  canShowAfterStartup: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { isReady, isSignedIn } = useUser();
  const loginActionsEnabled = !PAYMENT_TESTING_MODE;

  const isAuthRoute =
    pathname === '/sign-in' ||
    pathname === '/account/auth' ||
    pathname === '/auth/callback';
  const showWelcomeModal =
    canShowAfterStartup && isReady && !isSignedIn && !dismissedForSession && !isAuthRoute;
  const shouldBlockTouches = !isReady;

  const closeModal = () => {
    onDismiss();
  };

  const openProvider = (provider: WelcomeAuthProvider) => {
    if (!loginActionsEnabled) return;

    closeModal();

    InteractionManager.runAfterInteractions(() => {
      router.push({
        pathname: '/account/auth',
        params: { provider },
      });
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
              <View style={styles.accentBar} />

              <View style={styles.watermarkWrap} pointerEvents="none">
                <Image
                  source={require('../assets/images/nood-brand-logo.png')}
                  style={styles.watermark}
                  resizeMode="contain"
                />
              </View>

              <View style={styles.cardContent}>
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

              {!loginActionsEnabled ? (
                <Text style={styles.loginPausedText}>
                  Sign-in is paused while checkout testing is in progress. You can keep shopping as a
                  guest.
                </Text>
              ) : null}

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
                style={[
                  styles.authButton,
                  styles.googleButton,
                  !loginActionsEnabled && styles.authButtonDisabled,
                ]}
                activeOpacity={loginActionsEnabled ? 0.92 : 1}
                disabled={!loginActionsEnabled}
                onPress={() => openProvider('google')}
              >
                <View style={styles.googleBadge}>
                  <Image source={{ uri: GOOGLE_LOGO_URL }} style={styles.googleBadgeLogo} resizeMode="contain" />
                </View>
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.authButton, !loginActionsEnabled && styles.authButtonDisabled]}
                activeOpacity={loginActionsEnabled ? 0.92 : 1}
                disabled={!loginActionsEnabled}
                onPress={() => openProvider('facebook')}
              >
                <FacebookProviderIcon />
                <Text style={styles.authButtonText}>Continue with Facebook</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.authButton, !loginActionsEnabled && styles.authButtonDisabled]}
                activeOpacity={loginActionsEnabled ? 0.92 : 1}
                disabled={!loginActionsEnabled}
                onPress={() => openProvider('shop')}
              >
                <ShopProviderIcon />
                <Text style={styles.authButtonText}>Continue with Shop</Text>
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
            </View>
          </SafeAreaView>
        </View>
      ) : null}
    </>
  );
}

function NotificationPermissionPromptHost({
  onFlowFinished,
}: {
  onFlowFinished: () => void;
}) {
  const { isReady, profileId } = useUser();
  const { updateNotificationSetting } = useUpdates();
  const [visible, setVisible] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  const flowFinishedRef = useRef(false);

  const finishNotificationFlow = useCallback(() => {
    if (flowFinishedRef.current) return;
    flowFinishedRef.current = true;
    onFlowFinished();
  }, [onFlowFinished]);

  useEffect(() => {
    if (!isReady) return;

    let cancelled = false;

    const preparePrompt = async () => {
      try {
        const state = await evaluateNotificationPromptState();

        if (state.permissionStatus === 'granted') {
          await markNotificationPromptShown();
          if (await canUseRemotePushNotifications()) {
            await ensurePushTokenRegistered(profileId);
          }
          if (!cancelled) {
            setPromptReady(false);
            setVisible(false);
            finishNotificationFlow();
          }
          return;
        }

        if (!state.shouldShowPrompt) {
          if (!cancelled) {
            finishNotificationFlow();
          }
          return;
        }

        if (!cancelled) {
          setPromptReady(true);
        }
      } catch (error) {
        if (__DEV__) {
          console.log('[NOTIFICATIONS PROMPT] error', {
            context: 'prepare-prompt',
            message: String((error as any)?.message || error || ''),
          });
        }
        if (!cancelled) {
          finishNotificationFlow();
        }
      }
    };

    void preparePrompt();

    return () => {
      cancelled = true;
    };
  }, [finishNotificationFlow, isReady, profileId]);

  useEffect(() => {
    if (!promptReady || !isReady) {
      setVisible(false);
      return;
    }

    const task = InteractionManager.runAfterInteractions(() => {
      setVisible(true);
    });

    return () => {
      task.cancel?.();
    };
  }, [isReady, promptReady]);

  const closePrompt = () => {
    setVisible(false);
    setPromptReady(false);
    finishNotificationFlow();
  };

  const handleEnable = async () => {
    if (__DEV__) {
      console.log('[NOTIFICATIONS PROMPT] user tapped enable');
    }

    try {
      await updateNotificationSetting('notificationsEnabled', true);
      if (__DEV__) {
        console.log('[NOTIFICATIONS PROMPT] token registered/skipped', {
          registered: true,
        });
      }
    } catch (error) {
      if (__DEV__) {
        console.log('[NOTIFICATIONS PROMPT] error', {
          context: 'enable-notifications',
          message: String((error as any)?.message || error || ''),
        });
      }
    } finally {
      await markNotificationPromptShown();
      closePrompt();
    }
  };

  const handleNotNow = async () => {
    if (__DEV__) {
      console.log('[NOTIFICATIONS PROMPT] user tapped not now');
    }

    await markNotificationPromptShown();
    closePrompt();
  };

  if (!visible) return null;

  return (
    <View style={styles.notificationOverlay}>
      <SafeAreaView style={styles.notificationModalShell}>
        <Pressable style={styles.backdrop} onPress={handleNotNow} />

        <View style={styles.notificationCard}>
          <View style={styles.notificationAccentBar} />

          <View style={styles.notificationIconWrap}>
            <Ionicons name="notifications-outline" size={24} color="#ff6a00" />
          </View>

          <Text style={styles.notificationTitle}>Stay updated with NOOD</Text>
          <Text style={styles.notificationMessage}>
            Enable notifications for order updates, delivery alerts, deals, and rewards.
          </Text>

          <TouchableOpacity
            style={styles.notificationPrimaryButton}
            activeOpacity={0.92}
            onPress={() => void handleEnable()}
          >
            <Text style={styles.notificationPrimaryButtonText}>Enable notifications</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.notificationSecondaryButton}
            activeOpacity={0.85}
            onPress={() => void handleNotNow()}
          >
            <Text style={styles.notificationSecondaryButtonText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
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
    backgroundColor: '#fff9f3',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    overflow: 'hidden',
    ...platformShadow('0 14px 36px rgba(255, 106, 0, 0.14), 0 8px 24px rgba(0, 0, 0, 0.14)', {
      shadowColor: '#ff6a00',
      shadowOpacity: 0.14,
      shadowRadius: 22,
      elevation: 12,
    }),
  },
  accentBar: {
    height: 4,
    backgroundColor: '#ff6a00',
    opacity: 0.92,
  },
  watermarkWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
  },
  watermark: {
    width: 168,
    height: 112,
    opacity: 0.055,
  },
  cardContent: {
    position: 'relative',
    zIndex: 2,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 20,
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
  loginPausedText: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 19,
    color: '#8a5a37',
    textAlign: 'center',
    paddingHorizontal: 10,
    fontWeight: '600',
  },
  authButtonDisabled: {
    opacity: 0.48,
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
  facebookIconBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1877F2',
  },
  facebookIconText: {
    color: '#fff',
    fontSize: 22,
    lineHeight: 24,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif',
    marginTop: Platform.OS === 'ios' ? 1 : 0,
  },
  shopIconBadge: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#5433EB',
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
  notificationOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 17, 17, 0.38)',
    justifyContent: 'center',
    paddingHorizontal: 20,
    zIndex: 9990,
    ...(Platform.OS === 'web' ? {} : { elevation: 9990 }),
  },
  notificationModalShell: {
    flex: 1,
    justifyContent: 'center',
  },
  notificationCard: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 380,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#F1E4D8',
    overflow: 'hidden',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 20,
    ...platformShadow('0 12px 32px rgba(255, 106, 0, 0.12), 0 8px 20px rgba(0, 0, 0, 0.12)', {
      shadowColor: '#ff6a00',
      shadowOpacity: 0.12,
      shadowRadius: 18,
      elevation: 10,
    }),
  },
  notificationAccentBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: '#ff6a00',
  },
  notificationIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF4EA',
    borderWidth: 1,
    borderColor: '#FFE1CC',
    alignSelf: 'center',
    marginBottom: 14,
  },
  notificationTitle: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '900',
    color: '#4E260D',
    textAlign: 'center',
  },
  notificationMessage: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
    color: '#6F5A4E',
    textAlign: 'center',
    paddingHorizontal: 4,
    marginBottom: 18,
  },
  notificationPrimaryButton: {
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: '#FF6A00',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  notificationPrimaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  notificationSecondaryButton: {
    minHeight: 44,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E9D8C9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationSecondaryButtonText: {
    color: '#6F5A4E',
    fontSize: 15,
    fontWeight: '700',
  },
});
