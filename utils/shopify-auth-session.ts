import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import {
  buildCustomerDisplayName,
  mapShopifyCustomerToProfile,
  saveCustomerProfile,
  type CustomerProfile,
} from './customer-profile';
import { fetchShopifyCustomerAccountProfile } from './shopify-customer-account-api';
import {
  getCustomerIdFromClaims,
  getDisplayNameFromClaims,
  getEmailFromClaims,
  getShopifyOAuthRedirectUri,
  isShopifyAuthCallbackUrl,
  parseJwtPayload,
  SHOPIFY_AUTH_STORAGE_KEY,
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC,
  SHOPIFY_SHOP_ID,
  SHOPIFY_TOKEN_ENDPOINT,
  validateIdTokenNonce,
} from './shopify-auth';
import {
  saveShopifyAuthTokens,
  type ShopifyTokenExchangeResponse,
} from './shopify-auth-tokens';
import { logAuthFlowDebug } from './auth-flow-debug';
import { logAuthRestartCheck } from './auth-restart-debug';
import { isAppBootstrapComplete } from './app-bootstrap';

export type ShopifyCallbackParams = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
};

export type ShopifyAuthProcessResult = {
  handled: boolean;
  signedIn: boolean;
  errorMessage?: string;
};

let lastProcessedAuthUrl = '';

export function parseShopifyCallbackParams(url: string): ShopifyCallbackParams | null {
  try {
    const parsed = new URL(url);
    return {
      code: parsed.searchParams.get('code') || undefined,
      state: parsed.searchParams.get('state') || undefined,
      error: parsed.searchParams.get('error') || undefined,
      error_description: parsed.searchParams.get('error_description') || undefined,
    };
  } catch {
    return null;
  }
}

export function shouldProcessShopifyAuthUrl(url: string) {
  if (!url) {
    return false;
  }

  if (!isShopifyAuthCallbackUrl(url)) {
    return false;
  }

  const params = parseShopifyCallbackParams(url);
  if (!params) {
    return false;
  }

  if (params.error) {
    return true;
  }

  return Boolean(String(params.code || '').trim());
}

type ProcessShopifyAuthOptions = {
  sourceUrl: string;
  markSignedIn: (displayName?: string) => Promise<void>;
  redirectToAccount: () => void;
  addHistoryEvent?: (event: {
    type: 'account';
    title: string;
    description: string;
    status: string;
  }) => Promise<void>;
};

async function resolveCustomerProfileAfterLogin(
  accessToken: string,
  fallback: {
    displayName: string;
    email: string;
    shopifyCustomerId: string;
  }
): Promise<CustomerProfile> {
  const shopifyCustomer = await fetchShopifyCustomerAccountProfile(accessToken);

  if (shopifyCustomer) {
    console.log('[AUTH] Customer Account API profile loaded', {
      email: shopifyCustomer.email || '(empty)',
      orderCount: shopifyCustomer.orderCount,
      addressCount: shopifyCustomer.addressCount,
    });

    return mapShopifyCustomerToProfile(shopifyCustomer, {
      displayName: fallback.displayName,
      email: fallback.email,
      shopifyCustomerId: fallback.shopifyCustomerId,
      signedInAt: new Date().toISOString(),
    });
  }

  console.log('[AUTH] Customer Account API profile unavailable — using id_token claims');

  return {
    displayName: fallback.displayName || buildCustomerDisplayName({ email: fallback.email }),
    email: fallback.email,
    shopifyCustomerId: fallback.shopifyCustomerId || undefined,
    signedInAt: new Date().toISOString(),
  };
}

async function completeVerifiedSignIn(
  profile: CustomerProfile,
  markSignedIn: (displayName?: string) => Promise<void>,
  redirectToAccount: () => void,
  addHistoryEvent?: ProcessShopifyAuthOptions['addHistoryEvent']
) {
  const displayName = buildCustomerDisplayName(profile) || profile.displayName;

  logAuthFlowDebug('complete-sign-in-start', {
    signedIn: false,
    detail: { displayName: displayName || '(empty)' },
  });

  await saveCustomerProfile(profile);
  await markSignedIn(displayName || undefined);
  await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
  console.log('[AUTH] saved signed-in state');

  logAuthFlowDebug('complete-sign-in-done', {
    signedIn: true,
    detail: { displayName: displayName || '(empty)' },
  });

  if (addHistoryEvent) {
    await addHistoryEvent({
      type: 'account',
      title: 'Signed in',
      description: displayName ? `${displayName} signed in to NOOD.` : 'Customer signed in to NOOD.',
      status: 'signed-in',
    });
  }

  logAuthRestartCheck({
    step: 'complete-sign-in-redirect',
    isAppBootstrapping: !isAppBootstrapComplete(),
    isAuthLoading: false,
    signedIn: true,
  });

  redirectToAccount();
  console.log('[AUTH] redirected to account tab');
}

export async function processShopifyAuthCallback(
  options: ProcessShopifyAuthOptions
): Promise<ShopifyAuthProcessResult> {
  const { sourceUrl, markSignedIn, redirectToAccount, addHistoryEvent } = options;

  if (!shouldProcessShopifyAuthUrl(sourceUrl)) {
    console.log('[AUTH] callback ignored — not a verified OAuth callback URL', sourceUrl);
    return { handled: false, signedIn: false };
  }

  if (lastProcessedAuthUrl === sourceUrl) {
    return { handled: true, signedIn: true };
  }
  lastProcessedAuthUrl = sourceUrl;

  console.log('[AUTH] callback received:', sourceUrl);

  const params = parseShopifyCallbackParams(sourceUrl);
  if (!params) {
    return { handled: false, signedIn: false, errorMessage: 'NOOD could not read the sign-in callback.' };
  }

  console.log('[AUTH] callback params', {
    code: params.code ? '[present]' : '',
    state: params.state ? '[present]' : '',
    error: params.error || '',
    error_description: params.error_description || '',
  });

  try {
    WebBrowser.dismissAuthSession();
  } catch {
    // ignore
  }

  if (params.error) {
    console.log('[AUTH] callback error', params.error, params.error_description || '');
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    return {
      handled: true,
      signedIn: false,
      errorMessage: params.error_description || 'Shopify sign-in did not complete.',
    };
  }

  if (!params.code) {
    console.log('[AUTH] missing code');
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    return {
      handled: false,
      signedIn: false,
      errorMessage: 'NOOD did not receive a sign-in code. Please try again.',
    };
  }

  console.log('[AUTH] code present');

  const savedPayload = await AsyncStorage.getItem(SHOPIFY_AUTH_STORAGE_KEY);
  const pending = savedPayload ? JSON.parse(savedPayload) : null;

  if (!params.state || !pending?.state || params.state !== pending.state) {
    console.log('[AUTH] state mismatch');
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    return {
      handled: true,
      signedIn: false,
      errorMessage: 'Sign-in state did not match. Please try again.',
    };
  }

  console.log('[AUTH] state match');

  const tokenPayload = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC,
    redirect_uri: pending.redirectUri || getShopifyOAuthRedirectUri(),
    code: params.code,
  });

  if (pending.codeVerifier) {
    tokenPayload.set('code_verifier', pending.codeVerifier);
  }

  const tokenResponse = await fetch(SHOPIFY_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: tokenPayload.toString(),
  });

  if (!tokenResponse.ok) {
    const tokenErrorBody = await tokenResponse.text().catch(() => '');
    console.log('[AUTH] token exchange failed', tokenResponse.status, tokenErrorBody);
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    return {
      handled: true,
      signedIn: false,
      errorMessage: 'Shopify could not finish sign-in. Please try again.',
    };
  }

  console.log('[AUTH] token exchange success');

  const tokenJson = (await tokenResponse.json()) as ShopifyTokenExchangeResponse;
  if (!tokenJson.access_token || !tokenJson.id_token) {
    console.log('[AUTH] token exchange failed — missing access_token or id_token');
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    return {
      handled: true,
      signedIn: false,
      errorMessage: 'Shopify returned an incomplete sign-in response. Please try again.',
    };
  }

  const nonceValidation = validateIdTokenNonce(tokenJson.id_token, pending.nonce);
  if (!nonceValidation.valid) {
    console.log('[AUTH] nonce mismatch');
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    return {
      handled: true,
      signedIn: false,
      errorMessage: nonceValidation.message,
    };
  }

  console.log('[AUTH] nonce match');

  const savedTokens = await saveShopifyAuthTokens(tokenJson);
  if (!savedTokens) {
    await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
    return {
      handled: true,
      signedIn: false,
      errorMessage: 'NOOD could not save your secure sign-in session. Please try again.',
    };
  }

  console.log('[AUTH] token bundle saved');

  const claims = parseJwtPayload(tokenJson.id_token);
  const fallbackDisplayName = getDisplayNameFromClaims(claims);
  const fallbackEmail = getEmailFromClaims(claims);
  const fallbackCustomerId = getCustomerIdFromClaims(claims);

  const profile = await resolveCustomerProfileAfterLogin(tokenJson.access_token, {
    displayName: fallbackDisplayName,
    email: fallbackEmail,
    shopifyCustomerId: fallbackCustomerId,
  });

  console.log('[AUTH] verified sign in', {
    displayName: buildCustomerDisplayName(profile) || '(empty)',
    email: profile.email || '(empty)',
    shopifyCustomerId: profile.shopifyCustomerId || '(empty)',
  });

  await completeVerifiedSignIn(profile, markSignedIn, redirectToAccount, addHistoryEvent);
  return { handled: true, signedIn: true };
}

export async function processShopifyAuthCallbackFromParams(
  params: ShopifyCallbackParams,
  options: Omit<ProcessShopifyAuthOptions, 'sourceUrl'>
): Promise<ShopifyAuthProcessResult> {
  const query = new URLSearchParams();
  if (params.code) query.set('code', params.code);
  if (params.state) query.set('state', params.state);
  if (params.error) query.set('error', params.error);
  if (params.error_description) query.set('error_description', params.error_description);

  const suffix = query.toString() ? `?${query.toString()}` : '';
  return processShopifyAuthCallback({
    sourceUrl: `shop.${SHOPIFY_SHOP_ID}.nood://auth/callback${suffix}`,
    ...options,
  });
}