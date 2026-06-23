import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as WebBrowser from 'expo-web-browser';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';
import NoodSpinner from '../../components/NoodSpinner';
import {
  buildShopifyAccountLoginUrl,
  createPendingAuthPayload,
  createPkcePair,
  createRandomString,
  isShopifyAccountPageUrl,
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_REDIRECT_URI,
  SHOPIFY_APP_REDIRECT_URI,
  SHOPIFY_AUTH_STORAGE_KEY,
  validateShopifyAccountLoginUrl,
} from '../../utils/shopify-auth';

WebBrowser.maybeCompleteAuthSession();

const SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY = 'NOOD_SHOPIFY_CUSTOMER_PROFILE';

function getRuntimeShopifyRedirectUri() {
  return SHOPIFY_REDIRECT_URI || SHOPIFY_APP_REDIRECT_URI;
}

export default function AccountAuthScreen() {
  const router = useRouter();
  const { markSignedIn } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const insets = useSafeAreaInsets();
  const { provider } = useLocalSearchParams<{ provider?: string }>();
  const [loading, setLoading] = useState(true);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [authAttempt, setAuthAttempt] = useState(0);
  const openedAttemptRef = useRef(0);

  const completeHostedAccountLogin = useCallback(async (sourceUrl: string) => {
    console.log('SHOPIFY_ACCOUNT_PAGE_REACHED', sourceUrl);

    try {
      WebBrowser.dismissAuthSession();
      console.log('SHOPIFY_BROWSER_DISMISSED');
    } catch (dismissError) {
      console.log('SHOPIFY_BROWSER_DISMISSED', dismissError);
    }

    await markSignedIn();
    await AsyncStorage.setItem(
      SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY,
      JSON.stringify({
        displayName: '',
        email: '',
        source: 'shopify-hosted-account',
        signedInAt: new Date().toISOString(),
      })
    );
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    void addHistoryEvent({
      type: 'account',
      title: 'Signed in',
      description: 'Customer signed in to NOOD with Shopify.',
      status: 'signed-in',
    });

    console.log('SHOPIFY_LOGIN_SUCCESS', {
      source: 'hosted-account-page',
      url: sourceUrl,
    });
    router.replace('/account');
  }, [addHistoryEvent, markSignedIn, router]);

  const handleRedirect = useCallback((url: string) => {
    if (!url) {
      return false;
    }

    const expectedRuntimeRedirectUri = getRuntimeShopifyRedirectUri();
    console.log('SHOPIFY_CALLBACK_URL_RECEIVED', url);

    if (isShopifyAccountPageUrl(url)) {
      void completeHostedAccountLogin(url);
      return true;
    }

    if (
      !url.startsWith(SHOPIFY_REDIRECT_URI) &&
      !url.startsWith(SHOPIFY_APP_REDIRECT_URI) &&
      !url.startsWith(expectedRuntimeRedirectUri)
    ) {
      return false;
    }

    try {
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code') || undefined;
      const state = parsed.searchParams.get('state') || undefined;
      const error = parsed.searchParams.get('error') || undefined;
      const errorDescription = parsed.searchParams.get('error_description') || undefined;

      router.replace({
        pathname: '/auth/callback',
        params: {
          ...(code ? { code } : {}),
          ...(state ? { state } : {}),
          ...(error ? { error } : {}),
          ...(errorDescription ? { error_description: errorDescription } : {}),
        },
      });
    } catch (redirectError) {
      console.log('Customer auth redirect parse error:', redirectError);
      Alert.alert('Error', 'Could not finish Shopify sign-in.');
      router.replace('/sign-in');
    }

    return true;
  }, [completeHostedAccountLogin, router]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleRedirect(url);
    });

    void Linking.getInitialURL().then((url) => {
      if (url) {
        handleRedirect(url);
      }
    });

    return () => subscription.remove();
  }, [handleRedirect]);

  useEffect(() => {
    const startAuth = async () => {
      try {
        if (Platform.OS === 'web') {
          setErrorMessage(
            'Shopify mobile sign-in must be tested in the NOOD app build, not in the web preview.'
          );
          return;
        }

        setLoading(true);
        setErrorMessage('');

        const state = createRandomString(32);
        const nonce = createRandomString(32);
        const { codeVerifier, codeChallenge } = await createPkcePair();
        const redirectUri = getRuntimeShopifyRedirectUri();
        const accountLoginUrl = buildShopifyAccountLoginUrl({
          state,
          nonce,
          codeChallenge,
          redirectUri,
        });
        const validation = validateShopifyAccountLoginUrl(accountLoginUrl, redirectUri);

        console.log('SHOPIFY_STORE_DOMAIN', SHOPIFY_STORE_DOMAIN);
        console.log('SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID', SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC);
        console.log('SHOPIFY_REDIRECT_URI', redirectUri);
        console.log('SHOPIFY_ACCOUNT_LOGIN_URL', accountLoginUrl);

        if (!validation.valid) {
          setErrorMessage(validation.message);
          setAuthUrl('');
          return;
        }

        await AsyncStorage.setItem(
          SHOPIFY_AUTH_STORAGE_KEY,
          JSON.stringify(createPendingAuthPayload(provider || 'email', state, nonce, codeVerifier, redirectUri))
        );
        console.log('SHOPIFY_STORED_REDIRECT_URI', redirectUri);

        setAuthUrl(accountLoginUrl);
      } catch (error) {
        console.log('Customer auth start error:', error);
        setErrorMessage('Could not start Shopify sign-in. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    void startAuth();
  }, [authAttempt, handleRedirect, provider]);

  const openSecureAuthBrowser = useCallback(async () => {
    if (!authUrl || openingBrowser) return;

    setOpeningBrowser(true);
    setErrorMessage('');

    const openFallbackBrowser = async () => {
      const fallbackResult = await WebBrowser.openBrowserAsync(authUrl, {
        toolbarColor: '#ff6a00',
        controlsColor: '#ff6a00',
        showTitle: true,
      });

      console.log('SHOPIFY_BROWSER_FALLBACK_RESULT', fallbackResult);
      setErrorMessage('Complete Shopify sign-in in the browser. NOOD will reopen after login.');
    };

    try {
      if (authUrl.includes('im3dst-x9')) {
        throw new Error('Blocked old dev store auth URL. Remove im3dst-x9 from Shopify Customer Account login config.');
      }

      const redirectUri = getRuntimeShopifyRedirectUri();
      console.log('SHOPIFY_REDIRECT_URI', redirectUri);
      console.log('SHOPIFY_APP_REDIRECT_URI', SHOPIFY_APP_REDIRECT_URI);
      console.log('SHOPIFY_STORED_REDIRECT_URI', redirectUri);
      console.log('SHOPIFY_ACCOUNT_LOGIN_URL', authUrl);

      if (Platform.OS === 'android') {
        await WebBrowser.warmUpAsync().catch(() => null);
        await WebBrowser.mayInitWithUrlAsync(authUrl).catch(() => null);
      }

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri, {
        toolbarColor: '#ff6a00',
        controlsColor: '#ff6a00',
        showTitle: true,
        preferEphemeralSession: false,
      });

      console.log('SHOPIFY_AUTH_SESSION_RESULT', result);

      if (result.type === 'success' && result.url) {
        if (isShopifyAccountPageUrl(result.url)) {
          await completeHostedAccountLogin(result.url);
          return;
        }

        handleRedirect(result.url);
        return;
      }

      if (result.type === 'opened') {
        setErrorMessage('');
        return;
      }

      await openFallbackBrowser();
    } catch (error) {
      console.log('Secure Shopify auth session error:', error);
      console.log('SHOPIFY_LOGIN_ERROR', error);
      try {
        await openFallbackBrowser();
      } catch (fallbackError) {
        console.log('Shopify browser fallback error:', fallbackError);
        const detail = fallbackError instanceof Error ? ` ${fallbackError.message}` : '';
        setErrorMessage(`The secure sign-in session could not open. Tap Try again.${detail}`);
      }
    } finally {
      setOpeningBrowser(false);
      if (Platform.OS === 'android') {
        await WebBrowser.coolDownAsync().catch(() => null);
      }
    }
  }, [authUrl, completeHostedAccountLogin, handleRedirect, openingBrowser]);

  useEffect(() => {
    if (loading || !authUrl || openingBrowser || openedAttemptRef.current === authAttempt + 1) {
      return;
    }

    openedAttemptRef.current = authAttempt + 1;
    void openSecureAuthBrowser();
  }, [authAttempt, authUrl, loading, openSecureAuthBrowser, openingBrowser]);

  const title = useMemo(() => {
    if (provider === 'google') {
      return 'Continue with Google';
    }

    if (provider === 'phone') {
      return 'Continue with phone number';
    }

    return 'Continue with Email';
  }, [provider]);

  const subtitle = useMemo(() => {
    if (provider === 'google') {
      return 'Choose Google on the Shopify sign-in page to continue.';
    }

    if (provider === 'phone') {
      return 'Choose phone number on the Shopify sign-in page to continue.';
    }

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
            setLoading(true);
            setErrorMessage('');
            setAuthAttempt((current) => current + 1);
          }}
          activeOpacity={0.8}
        >
          <Ionicons name="refresh" size={20} color="#111" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View pointerEvents="none" style={[styles.loadingOverlay, { top: Math.max(insets.top, 8) + 78 }]}>
          <NoodSpinner size={28} />
          <Text style={styles.loadingText}>Preparing Shopify sign-in...</Text>
        </View>
      ) : null}

      <View style={styles.webviewWrap}>
          <View style={styles.webRedirectCard}>
            <Ionicons name="shield-checkmark-outline" size={28} color="#ff6a00" />
            <Text style={styles.webRedirectTitle}>Secure Shopify sign-in</Text>
            <Text style={styles.webRedirectText}>
              {openingBrowser
                ? 'Opening Shopify sign-in...'
                : 'Shopify sign-in should open automatically.'}
            </Text>

            {openingBrowser || (!errorMessage && authUrl) ? (
              <NoodSpinner size={28} style={styles.authSpinner} />
            ) : null}

            {errorMessage ? (
              <TouchableOpacity
                style={styles.webRedirectButton}
                activeOpacity={0.9}
                onPress={() => {
                  openedAttemptRef.current = 0;
                  setLoading(true);
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
  loadingOverlay: {
    position: 'absolute',
    top: 88,
    left: 0,
    right: 0,
    zIndex: 5,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  loadingText: {
    marginTop: 8,
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
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
  returnButton: {
    marginTop: 12,
    minWidth: 200,
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e7dfd6',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  returnButtonText: {
    color: '#111',
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
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
});
