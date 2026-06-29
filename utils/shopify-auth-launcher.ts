import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import {
  buildShopifyOAuthAuthorizeUrl,
  createPendingAuthPayload,
  createPkcePair,
  createRandomString,
  getShopifyAuthSessionRedirectUri,
  getShopifyOAuthRedirectUri,
  getShopifyRedirectTrigger,
  SHOPIFY_AUTH_STORAGE_KEY,
  validateShopifyOAuthAuthorizeUrl,
} from './shopify-auth';
import { logAuthRestartCheck } from './auth-restart-debug';
import { isAppBootstrapComplete } from './app-bootstrap';

export type LaunchShopifyAuthOptions = {
  provider?: string;
  onAuthUrlReady?: (authUrl: string) => void;
  onBrowserOpened?: () => void;
  onBrowserDismissed?: () => void;
  onRedirectUrl?: (url: string) => void | Promise<void>;
  onError?: (message: string) => void;
};

export async function launchShopifyAuthSession(options: LaunchShopifyAuthOptions = {}) {
  const provider = options.provider || 'email';

  logAuthRestartCheck({
    step: 'launch-shopify-auth-start',
    isAppBootstrapping: !isAppBootstrapComplete(),
    isAuthLoading: true,
    detail: { provider },
  });

  if (Platform.OS === 'web') {
    options.onError?.(
      'Shopify mobile sign-in must be tested in the NOOD app build, not in the web preview.'
    );
    return { opened: false, authUrl: '' };
  }

  try {
    const state = createRandomString(32);
    const nonce = createRandomString(32);
    const { codeVerifier, codeChallenge } = await createPkcePair();
    const redirectUri = getShopifyOAuthRedirectUri();
    const oauthAuthorizeUrl = buildShopifyOAuthAuthorizeUrl({
      state,
      nonce,
      codeChallenge,
      redirectUri,
    });
    const validation = validateShopifyOAuthAuthorizeUrl(oauthAuthorizeUrl, redirectUri);

    if (!validation.valid) {
      options.onError?.('Sign-in could not be completed. Please try again.');
      return { opened: false, authUrl: '' };
    }

    await AsyncStorage.setItem(
      SHOPIFY_AUTH_STORAGE_KEY,
      JSON.stringify(createPendingAuthPayload(provider, state, nonce, codeVerifier, redirectUri))
    );

    options.onAuthUrlReady?.(oauthAuthorizeUrl);

    if (Platform.OS === 'android') {
      await WebBrowser.warmUpAsync().catch(() => null);
      await WebBrowser.mayInitWithUrlAsync(oauthAuthorizeUrl).catch(() => null);
    }

    console.log('[AUTH] opening Shopify login URL', oauthAuthorizeUrl);

    const authSessionRedirectUri = getShopifyAuthSessionRedirectUri();
    const result = await WebBrowser.openAuthSessionAsync(oauthAuthorizeUrl, authSessionRedirectUri, {
      toolbarColor: '#ff6a00',
      controlsColor: '#ff6a00',
      showTitle: true,
      preferEphemeralSession: false,
    });

    console.log('[AUTH] AuthSession result type =', result.type);

    if (result.type === 'success' && 'url' in result && result.url) {
      console.log('[AUTH] AuthSession success -> redirect trigger =', getShopifyRedirectTrigger(result.url));
      await options.onRedirectUrl?.(result.url);
      logAuthRestartCheck({
        step: 'launch-shopify-auth-success',
        isAuthLoading: false,
      });
      return { opened: true, authUrl: oauthAuthorizeUrl, resultType: result.type };
    }

    if (result.type === 'opened') {
      options.onBrowserOpened?.();
      logAuthRestartCheck({
        step: 'launch-shopify-auth-browser-opened',
        isAuthLoading: true,
      });
      return { opened: true, authUrl: oauthAuthorizeUrl, resultType: result.type };
    }

    if (result.type === 'cancel' || result.type === 'dismiss') {
      options.onBrowserDismissed?.();
      logAuthRestartCheck({
        step: 'launch-shopify-auth-dismissed',
        isAuthLoading: false,
        detail: { resultType: result.type },
      });
      return { opened: false, authUrl: oauthAuthorizeUrl, resultType: result.type };
    }

    return { opened: false, authUrl: oauthAuthorizeUrl, resultType: result.type };
  } catch (error) {
    console.log('Secure Shopify auth session error:', error);
    const detail = error instanceof Error ? ` ${error.message}` : '';
    console.log('[AUTH] secure sign-in session error detail', detail.trim());
    options.onError?.('Sign-in could not be completed. Please try again.');
    return { opened: false, authUrl: '' };
  } finally {
    if (Platform.OS === 'android') {
      await WebBrowser.coolDownAsync().catch(() => null);
    }
    logAuthRestartCheck({
      step: 'launch-shopify-auth-finished',
      isAuthLoading: false,
    });
  }
}