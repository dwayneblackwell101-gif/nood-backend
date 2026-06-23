import {
  SHOPIFY_CUSTOMER_ACCOUNT_DOMAIN,
  SHOPIFY_STORE_DOMAIN,
} from './shopify';

export { SHOPIFY_CUSTOMER_ACCOUNT_DOMAIN, SHOPIFY_STORE_DOMAIN };

export const SHOPIFY_SHOP_ID = '66320990292';
const SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID = String(
  process.env.EXPO_PUBLIC_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID || 'f3c8b30a-f173-4962-9226-15f56a122578'
).trim();
const forge = require('node-forge');

const BLOCKED_DEV_STORE_MARKERS = ['im3dst-x9'];

export const SHOPIFY_ACCOUNT_LOGIN_URL = `https://shopify.com/${SHOPIFY_SHOP_ID}/account`;
export const SHOPIFY_TOKEN_ENDPOINT = `https://shopify.com/authentication/${SHOPIFY_SHOP_ID}/oauth/token`;
export const SHOPIFY_LOGOUT_ENDPOINT = `https://shopify.com/authentication/${SHOPIFY_SHOP_ID}/logout`;
export const SHOPIFY_APP_REDIRECT_URI = String(
  process.env.EXPO_PUBLIC_SHOPIFY_APP_REDIRECT_URI || `shop.${SHOPIFY_SHOP_ID}.nood://auth/callback`
).trim();
export const SHOPIFY_REDIRECT_URI = String(
  process.env.EXPO_PUBLIC_SHOPIFY_REDIRECT_URI || SHOPIFY_APP_REDIRECT_URI
).trim();
export const SHOPIFY_AUTH_STORAGE_KEY = 'NOOD_SHOPIFY_AUTH_PENDING';

type PendingAuthPayload = {
  state: string;
  nonce: string;
  codeVerifier?: string;
  provider: string;
  redirectUri?: string;
  createdAt: string;
};

export const SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC = SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;

export function parseJwtPayload(token?: string | null) {
  if (!token) {
    return null;
  }

  try {
    const payload = token.split('.')[1];

    if (!payload) {
      return null;
    }

    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = forge.util.decode64(normalized + padding);

    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function getDisplayNameFromClaims(claims: Record<string, unknown> | null) {
  if (!claims) {
    return '';
  }

  const directName = typeof claims.name === 'string' ? claims.name.trim() : '';
  if (directName) {
    return directName;
  }

  const givenName = typeof claims.given_name === 'string' ? claims.given_name.trim() : '';
  const familyName = typeof claims.family_name === 'string' ? claims.family_name.trim() : '';
  const combined = `${givenName} ${familyName}`.trim();

  if (combined) {
    return combined;
  }

  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (email.includes('@')) {
    return email.split('@')[0];
  }

  return '';
}

export function getEmailFromClaims(claims: Record<string, unknown> | null) {
  if (!claims) {
    return '';
  }

  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  return email.includes('@') ? email : '';
}

function toBase64UrlFromBytes(bytes: number[]) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return forge.util
    .encode64(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function createRandomString(length = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';

  for (let index = 0; index < length; index += 1) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return result;
}

export async function createPkcePair() {
  const codeVerifier = createRandomString(64);
  const digest = forge.md.sha256.create();
  digest.update(codeVerifier, 'utf8');
  const digestBytes = Array.from(digest.digest().getBytes() as string).map((char: string) =>
    char.charCodeAt(0)
  );
  const codeChallenge = toBase64UrlFromBytes(digestBytes);

  return { codeVerifier, codeChallenge };
}

export function buildShopifyAccountLoginUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}) {
  const query = new URLSearchParams({
    return_url: params.redirectUri,
    redirect_uri: params.redirectUri,
    redirect_url: params.redirectUri,
    return_to: params.redirectUri,
    state: params.state,
  });

  const accountLoginUrl = `${SHOPIFY_ACCOUNT_LOGIN_URL}?${query.toString()}`;

  if (BLOCKED_DEV_STORE_MARKERS.some((marker) => accountLoginUrl.includes(marker))) {
    throw new Error('Blocked old dev store auth URL. Remove im3dst-x9 from Shopify Customer Account login config.');
  }

  return accountLoginUrl;
}

export function isShopifyAccountPageUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://shopify.com' && parsed.pathname.startsWith(`/${SHOPIFY_SHOP_ID}/account`);
  } catch {
    return false;
  }
}

export function validateShopifyAccountLoginUrl(accountLoginUrl: string, expectedRedirectUri = SHOPIFY_REDIRECT_URI) {
  try {
    const parsed = new URL(accountLoginUrl);
    const params = parsed.searchParams;
    const redirectUri = params.get('redirect_uri') || '';
    const returnUrl = params.get('return_url') || '';
    const redirectUrl = params.get('redirect_url') || '';
    const expectedPath = `/${SHOPIFY_SHOP_ID}/account`;

    if (BLOCKED_DEV_STORE_MARKERS.some((marker) => accountLoginUrl.includes(marker))) {
      return {
        valid: false,
        message: 'Blocked old dev store auth URL. Remove im3dst-x9 from Shopify Customer Account login config.',
      };
    }

    if (parsed.origin !== 'https://shopify.com' || parsed.pathname !== expectedPath) {
      return {
        valid: false,
        message: `Shopify account login URL must use https://shopify.com${expectedPath}.`,
      };
    }

    if (accountLoginUrl.includes('/oauth/authorize')) {
      return {
        valid: false,
        message: 'Do not open the raw Shopify OAuth authorize URL from the app UI.',
      };
    }

    if (
      redirectUri !== expectedRedirectUri ||
      returnUrl !== expectedRedirectUri ||
      redirectUrl !== expectedRedirectUri
    ) {
      return {
        valid: false,
        message: `Shopify account login redirect must be ${expectedRedirectUri}.`,
      };
    }

    return { valid: true, message: '' };
  } catch {
    return {
      valid: false,
      message: 'Shopify account login URL could not be parsed.',
    };
  }
}

export function createPendingAuthPayload(
  provider: string,
  state: string,
  nonce: string,
  codeVerifier?: string,
  redirectUri?: string
): PendingAuthPayload {
  return {
    provider,
    state,
    nonce,
    codeVerifier,
    redirectUri,
    createdAt: new Date().toISOString(),
  };
}
