import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as WebBrowser from 'expo-web-browser';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';
import { logAuthRestartCheck } from '../../utils/auth-restart-debug';
import { isAppBootstrapComplete } from '../../utils/app-bootstrap';
import { handleShopifyAuthRedirectUrl } from '../../utils/shopify-auth-handlers';
import { launchShopifyAuthSession } from '../../utils/shopify-auth-launcher';

WebBrowser.maybeCompleteAuthSession();

export default function AccountAuthScreen() {
  const router = useRouter();
  const { markSignedIn, isAuthLoading } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const insets = useSafeAreaInsets();
  const { provider } = useLocalSearchParams<{ provider?: string }>();
  const [statusMessage, setStatusMessage] = useState('Preparing Shopify sign-in...');
  const [errorMessage, setErrorMessage] = useState('');
  const [awaitingReturn, setAwaitingReturn] = useState(false);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [authAttempt, setAuthAttempt] = useState(0);
  const launchedAttemptRef = useRef(0);

  const processRedirect = useCallback(
    async (url: string) => {
      const result = await handleShopifyAuthRedirectUrl(url, {
        markSignedIn,
        addHistoryEvent,
      });

      if (result.errorMessage) {
        setErrorMessage('Sign-in could not be completed. Please try again.');
        setAwaitingReturn(false);
      }
    },
    [addHistoryEvent, markSignedIn]
  );

  const startSecureSignIn = useCallback(async () => {
    if (openingBrowser) return;

    setOpeningBrowser(true);
    setErrorMessage('');
    setAwaitingReturn(false);
    setStatusMessage('Opening Shopify sign-in...');

    logAuthRestartCheck({
      step: 'account-auth-start-browser',
      isAppBootstrapping: !isAppBootstrapComplete(),
      isAuthLoading: true,
    });

    const result = await launchShopifyAuthSession({
      provider: provider || 'email',
      onAuthUrlReady: () => {
        setStatusMessage('Opening Shopify sign-in...');
      },
      onBrowserOpened: () => {
        setStatusMessage(
          Platform.OS === 'android'
            ? 'Complete sign-in in Shopify, then close the browser tab to return to NOOD.'
            : 'Complete sign-in in Shopify, then return to NOOD.'
        );
      },
      onBrowserDismissed: () => {
        setAwaitingReturn(true);
        setStatusMessage('If you finished signing in, NOOD will update your account shortly.');
      },
      onRedirectUrl: processRedirect,
      onError: (message) => {
        setErrorMessage(message);
      },
    });

    setOpeningBrowser(false);

    if (result.resultType === 'opened') {
      setAwaitingReturn(true);
    }
  }, [openingBrowser, processRedirect, provider]);

  useEffect(() => {
    if (openingBrowser || launchedAttemptRef.current === authAttempt + 1) {
      return;
    }

    launchedAttemptRef.current = authAttempt + 1;
    void startSecureSignIn();
  }, [authAttempt, openingBrowser, startSecureSignIn]);

  const title = useMemo(() => {
    if (provider === 'google') return 'Continue with Google';
    if (provider === 'facebook') return 'Continue with Facebook';
    if (provider === 'shop') return 'Continue with Shop';
    if (provider === 'phone') return 'Continue with phone number';
    return 'Continue with Email';
  }, [provider]);

  const subtitle = useMemo(() => {
    if (provider === 'google') return 'Choose Google on the Shopify sign-in page to continue.';
    if (provider === 'facebook') return 'Choose Facebook on the Shopify sign-in page to continue.';
    if (provider === 'shop') return 'Choose Shop on the Shopify sign-in page to continue.';
    if (provider === 'phone') return 'Choose phone number on the Shopify sign-in page to continue.';
    return 'Sign in with your email on the Shopify customer account page.';
  }, [provider]);

  const handleBackPress = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/sign-in');
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      <View style={[styles.header, { paddingTop: Math.max(insets.top, 8) }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={handleBackPress}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {title}
          </Text>
          <Text numberOfLines={2} style={styles.headerSubtitle}>
            {subtitle}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.refreshButton}
          onPress={() => {
            setErrorMessage('');
            setAuthAttempt((current) => current + 1);
          }}
          activeOpacity={0.8}
        >
          <Ionicons name="refresh" size={20} color="#111" />
        </TouchableOpacity>
      </View>

      <View style={styles.webviewWrap}>
        <View style={styles.webRedirectCard}>
          <Ionicons name="shield-checkmark-outline" size={28} color="#ff6a00" />
          <Text style={styles.webRedirectTitle}>Secure Shopify sign-in</Text>
          <Text style={styles.webRedirectText}>{statusMessage}</Text>

          {openingBrowser || isAuthLoading ? (
            <ActivityIndicator size="small" color="#ff6a00" style={styles.authSpinner} />
          ) : null}

          {awaitingReturn ? (
            <TouchableOpacity
              style={styles.webRedirectButton}
              activeOpacity={0.9}
              onPress={() => {
                launchedAttemptRef.current = 0;
                setAwaitingReturn(false);
                void startSecureSignIn();
              }}
            >
              <Text style={styles.webRedirectButtonText}>I finished signing in</Text>
            </TouchableOpacity>
          ) : null}

          {errorMessage ? (
            <TouchableOpacity
              style={styles.webRedirectButton}
              activeOpacity={0.9}
              onPress={() => {
                launchedAttemptRef.current = 0;
                setErrorMessage('');
                setAuthAttempt((current) => current + 1);
              }}
            >
              <Text style={styles.webRedirectButtonText}>Try again</Text>
            </TouchableOpacity>
          ) : null}

          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    minHeight: 72,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#ececec',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  refreshButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
  },
  headerCenter: {
    flex: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111',
  },
  headerSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
    textAlign: 'center',
  },
  webviewWrap: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webRedirectCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#ffffff',
  },
  webRedirectTitle: {
    marginTop: 12,
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
  },
  webRedirectText: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    textAlign: 'center',
    maxWidth: 420,
  },
  authSpinner: {
    marginTop: 16,
  },
  webRedirectButton: {
    marginTop: 18,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 16,
  },
  webRedirectButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  errorText: {
    marginTop: 12,
    color: '#b02a00',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    maxWidth: 320,
  },
});