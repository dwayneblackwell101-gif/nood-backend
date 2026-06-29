import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC,
  SHOPIFY_LOGOUT_ENDPOINT,
  SHOPIFY_TOKEN_ENDPOINT,
} from './shopify-auth';

export const SHOPIFY_AUTH_TOKENS_STORAGE_KEY = 'NOOD_SHOPIFY_AUTH_TOKENS';

export type ShopifyAuthTokens = {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_at: number;
};

export type ShopifyTokenExchangeResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
};

export type ShopifySessionStatus = 'valid' | 'missing' | 'expired';

const TOKEN_EXPIRY_BUFFER_MS = 60_000;

async function canUseSecureStore(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function readTokenPayload(): Promise<string | null> {
  if (await canUseSecureStore()) {
    return SecureStore.getItemAsync(SHOPIFY_AUTH_TOKENS_STORAGE_KEY);
  }

  return AsyncStorage.getItem(SHOPIFY_AUTH_TOKENS_STORAGE_KEY);
}

async function writeTokenPayload(payload: string): Promise<void> {
  if (await canUseSecureStore()) {
    await SecureStore.setItemAsync(SHOPIFY_AUTH_TOKENS_STORAGE_KEY, payload);
    return;
  }

  await AsyncStorage.setItem(SHOPIFY_AUTH_TOKENS_STORAGE_KEY, payload);
}

async function deleteTokenPayload(): Promise<void> {
  if (await canUseSecureStore()) {
    await SecureStore.deleteItemAsync(SHOPIFY_AUTH_TOKENS_STORAGE_KEY);
  }

  await AsyncStorage.removeItem(SHOPIFY_AUTH_TOKENS_STORAGE_KEY);
}

export function isAccessTokenExpired(
  tokens: ShopifyAuthTokens,
  bufferMs = TOKEN_EXPIRY_BUFFER_MS
): boolean {
  return Date.now() >= tokens.expires_at - bufferMs;
}

export async function saveShopifyAuthTokens(bundle: ShopifyTokenExchangeResponse): Promise<ShopifyAuthTokens | null> {
  const accessToken = String(bundle.access_token || '').trim();
  const idToken = String(bundle.id_token || '').trim();

  if (!accessToken || !idToken) {
    return null;
  }

  const existing = await loadShopifyAuthTokens();
  const expiresInSeconds = Number(bundle.expires_in || 3600);
  const tokens: ShopifyAuthTokens = {
    access_token: accessToken,
    refresh_token: String(bundle.refresh_token || existing?.refresh_token || '').trim(),
    id_token: idToken,
    expires_at: Date.now() + expiresInSeconds * 1000,
  };

  await writeTokenPayload(JSON.stringify(tokens));
  console.log('[AUTH] token bundle saved to secure storage');
  return tokens;
}

export async function loadShopifyAuthTokens(): Promise<ShopifyAuthTokens | null> {
  try {
    const saved = await readTokenPayload();
    if (!saved) {
      return null;
    }

    const parsed = JSON.parse(saved) as Partial<ShopifyAuthTokens>;
    const accessToken = String(parsed.access_token || '').trim();
    const idToken = String(parsed.id_token || '').trim();

    if (!accessToken || !idToken || !parsed.expires_at) {
      return null;
    }

    return {
      access_token: accessToken,
      refresh_token: String(parsed.refresh_token || '').trim(),
      id_token: idToken,
      expires_at: Number(parsed.expires_at),
    };
  } catch (error) {
    console.log('[AUTH] failed to load token bundle', error);
    return null;
  }
}

export async function clearShopifyAuthTokens(): Promise<void> {
  try {
    await deleteTokenPayload();
    console.log('[AUTH] token bundle cleared');
  } catch (error) {
    console.log('[AUTH] failed to clear token bundle', error);
  }
}

export async function refreshShopifyAuthTokens(refreshToken: string): Promise<ShopifyAuthTokens | null> {
  const normalizedRefreshToken = String(refreshToken || '').trim();
  if (!normalizedRefreshToken) {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC,
    refresh_token: normalizedRefreshToken,
  });

  const response = await fetch(SHOPIFY_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    console.log('[AUTH] token refresh failed', response.status, errorBody);
    return null;
  }

  const tokenJson = (await response.json()) as ShopifyTokenExchangeResponse;
  if (!tokenJson.access_token) {
    console.log('[AUTH] token refresh failed — missing access_token');
    return null;
  }

  console.log('[AUTH] token refresh success');
  return saveShopifyAuthTokens({
    ...tokenJson,
    refresh_token: tokenJson.refresh_token || normalizedRefreshToken,
    id_token: tokenJson.id_token || (await loadShopifyAuthTokens())?.id_token,
  });
}

export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await loadShopifyAuthTokens();
  if (!tokens?.access_token) {
    return null;
  }

  if (!isAccessTokenExpired(tokens)) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    return null;
  }

  const refreshed = await refreshShopifyAuthTokens(tokens.refresh_token);
  return refreshed?.access_token || null;
}

export async function ensureValidShopifySession(): Promise<ShopifySessionStatus> {
  const tokens = await loadShopifyAuthTokens();
  if (!tokens?.access_token) {
    return 'missing';
  }

  if (!isAccessTokenExpired(tokens)) {
    return 'valid';
  }

  if (!tokens.refresh_token) {
    return 'expired';
  }

  const refreshed = await refreshShopifyAuthTokens(tokens.refresh_token);
  return refreshed?.access_token ? 'valid' : 'expired';
}

export async function shopifyCustomerLogout(): Promise<void> {
  const tokens = await loadShopifyAuthTokens();
  const idTokenHint = String(tokens?.id_token || '').trim();

  if (!idTokenHint) {
    return;
  }

  try {
    const body = new URLSearchParams({
      id_token_hint: idTokenHint,
    });

    const response = await fetch(SHOPIFY_LOGOUT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    console.log('[AUTH] Shopify logout response', response.status);
  } catch (error) {
    console.log('[AUTH] Shopify logout request failed', error);
  }
}