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
export const SHOPIFY_ACCOUNT_CALLBACK_URL = `https://shopify.com/${SHOPIFY_SHOP_ID}/account/callback`;
export const SHOPIFY_OAUTH_AUTHORIZE_ENDPOINT = `https://shopify.com/authentication/${SHOPIFY_SHOP_ID}/oauth/authorize`;
export const SHOPIFY_OAUTH_SCOPE = 'openid email customer-account-api:full';
export const SHOPIFY_AUTH_LOCALE = String(process.env.EXPO_PUBLIC_SHOPIFY_LOCALE || 'en-TT').trim();
export const SHOPIFY_AUTH_REGION_COUNTRY = String(process.env.EXPO_PUBLIC_SHOPIFY_REGION_COUNTRY || 'TT').trim();
export const SHOPIFY_TOKEN_ENDPOINT = `https://shopify.com/authentication/${SHOPIFY_SHOP_ID}/oauth/token`;
export const SHOPIFY_LOGOUT_ENDPOINT = `https://shopify.com/authentication/${SHOPIFY_SHOP_ID}/logout`;
export const SHOPIFY_MOBILE_OAUTH_REDIRECT_URI = `shop.${SHOPIFY_SHOP_ID}.nood://auth/callback`;

function resolveMobileOAuthRedirectUri(...candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    const trimmed = String(candidate || '').trim();
    if (trimmed && !trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return trimmed;
    }
  }

  return SHOPIFY_MOBILE_OAUTH_REDIRECT_URI;
}

export const SHOPIFY_APP_DEEP_LINK_URI = resolveMobileOAuthRedirectUri(
  process.env.EXPO_PUBLIC_SHOPIFY_APP_REDIRECT_URI,
  SHOPIFY_MOBILE_OAUTH_REDIRECT_URI
);

/** @deprecated Use SHOPIFY_APP_DEEP_LINK_URI */
export const SHOPIFY_APP_REDIRECT_URI = SHOPIFY_APP_DEEP_LINK_URI;

/** OAuth redirect_uri for Headless mobile client — must match Shopify Admin callback exactly. */
export const SHOPIFY_OAUTH_REDIRECT_URI = resolveMobileOAuthRedirectUri(
  process.env.EXPO_PUBLIC_SHOPIFY_OAUTH_REDIRECT_URI,
  process.env.EXPO_PUBLIC_SHOPIFY_REDIRECT_URI,
  process.env.EXPO_PUBLIC_SHOPIFY_APP_REDIRECT_URI,
  SHOPIFY_APP_DEEP_LINK_URI
);

/** Optional HTTPS bridge fallback only — not registered as Shopify mobile redirect_uri. */
export const SHOPIFY_AUTH_HTTPS_CALLBACK_URL = String(
  process.env.EXPO_PUBLIC_SHOPIFY_HTTPS_REDIRECT_URI || 'https://noodcaribbean.com/auth/callback'
).trim();

export const SHOPIFY_HTTPS_REDIRECT_URI = SHOPIFY_AUTH_HTTPS_CALLBACK_URL;
export const SHOPIFY_REDIRECT_URI = SHOPIFY_OAUTH_REDIRECT_URI;

/** Redirect URI sent to Shopify OAuth authorize + token exchange. */
export function getShopifyOAuthRedirectUri() {
  return SHOPIFY_OAUTH_REDIRECT_URI;
}

/** URL prefix WebBrowser.openAuthSessionAsync watches after OAuth authorize completes. */
export function getShopifyAuthSessionRedirectUri() {
  return SHOPIFY_OAUTH_REDIRECT_URI;
}

export function isShopifyHttpsAuthCallbackUrl(url: string) {
  try {
    const parsed = new URL(url);
    const expected = new URL(SHOPIFY_AUTH_HTTPS_CALLBACK_URL);
    return (
      parsed.protocol === 'https:' &&
      parsed.pathname === '/auth/callback' &&
      parsed.host === expected.host
    );
  } catch {
    return false;
  }
}

export function isShopifyAuthCallbackUrl(url: string) {
  if (!url) {
    return false;
  }

  if (url.startsWith(SHOPIFY_APP_DEEP_LINK_URI) || url.startsWith(getShopifyOAuthRedirectUri())) {
    return true;
  }

  if (isShopifyHttpsAuthCallbackUrl(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const isAppScheme =
      parsed.protocol === `shop.${SHOPIFY_SHOP_ID}.nood:` &&
      parsed.hostname === 'auth' &&
      parsed.pathname === '/callback';
    const isAccountCallback =
      parsed.origin === 'https://shopify.com' &&
      parsed.pathname === `/${SHOPIFY_SHOP_ID}/account/callback`;

    return isAppScheme || isAccountCallback;
  } catch {
    return false;
  }
}
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

export function getNonceFromClaims(claims: Record<string, unknown> | null) {
  if (!claims) {
    return '';
  }

  const nonce = typeof claims.nonce === 'string' ? claims.nonce.trim() : '';
  return nonce;
}

export function validateIdTokenNonce(
  idToken: string,
  expectedNonce: string
): { valid: boolean; message: string } {
  const normalizedExpectedNonce = String(expectedNonce || '').trim();
  if (!normalizedExpectedNonce) {
    return {
      valid: false,
      message: 'Sign-in security check failed. Please try again.',
    };
  }

  const claims = parseJwtPayload(idToken);
  const tokenNonce = getNonceFromClaims(claims);

  if (!tokenNonce || tokenNonce !== normalizedExpectedNonce) {
    return {
      valid: false,
      message: 'Sign-in security check failed. Please try again.',
    };
  }

  return { valid: true, message: '' };
}

export function getCustomerIdFromClaims(claims: Record<string, unknown> | null) {
  if (!claims) {
    return '';
  }

  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!sub) {
    return '';
  }

  if (sub.startsWith('gid://shopify/Customer/')) {
    return sub;
  }

  if (/^\d+$/.test(sub)) {
    return `gid://shopify/Customer/${sub}`;
  }

  return sub;
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

export function buildShopifyOAuthAuthorizeUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri?: string;
  clientId?: string;
  locale?: string;
  regionCountry?: string;
}) {
  const redirectUri = params.redirectUri || getShopifyOAuthRedirectUri();
  const clientId = params.clientId || SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC;

  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SHOPIFY_OAUTH_SCOPE,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });

  const locale = params.locale || SHOPIFY_AUTH_LOCALE;
  const regionCountry = params.regionCountry || SHOPIFY_AUTH_REGION_COUNTRY;

  if (locale) {
    query.set('locale', locale);
  }

  if (regionCountry) {
    query.set('region_country', regionCountry);
  }

  const authorizeUrl = `${SHOPIFY_OAUTH_AUTHORIZE_ENDPOINT}?${query.toString()}`;

  if (BLOCKED_DEV_STORE_MARKERS.some((marker) => authorizeUrl.includes(marker))) {
    throw new Error('Blocked old dev store auth URL. Remove im3dst-x9 from Shopify Customer Account login config.');
  }

  return authorizeUrl;
}

/** @deprecated Use buildShopifyOAuthAuthorizeUrl for Customer Account API OAuth. */
export function buildShopifyAccountLoginUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri?: string;
}) {
  return buildShopifyOAuthAuthorizeUrl(params);
}

export function isShopifyAccountPageUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === 'https://shopify.com' &&
      parsed.pathname.startsWith(`/${SHOPIFY_SHOP_ID}/account`) &&
      parsed.pathname !== `/${SHOPIFY_SHOP_ID}/account/callback`
    );
  } catch {
    return false;
  }
}

export function isShopifyAccountCallbackUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://shopify.com' && parsed.pathname === `/${SHOPIFY_SHOP_ID}/account/callback`;
  } catch {
    return false;
  }
}

export function getShopifyRedirectTrigger(url: string) {
  if (isShopifyAccountCallbackUrl(url)) {
    return 'account-callback';
  }

  if (isShopifyAccountPageUrl(url)) {
    return 'account-page';
  }

  try {
    const parsed = new URL(url);

    if (parsed.protocol === `shop.${SHOPIFY_SHOP_ID}.nood:`) {
      return 'app-deep-link';
    }

    if (isShopifyHttpsAuthCallbackUrl(url)) {
      return 'https-bridge';
    }
  } catch {
    return 'unknown';
  }

  return 'unknown';
}

export function validateShopifyOAuthAuthorizeUrl(
  authorizeUrl: string,
  expectedRedirectUri = getShopifyOAuthRedirectUri(),
  expectedClientId = SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC
) {
  try {
    const parsed = new URL(authorizeUrl);
    const params = parsed.searchParams;
    const expectedPath = `/authentication/${SHOPIFY_SHOP_ID}/oauth/authorize`;

    if (BLOCKED_DEV_STORE_MARKERS.some((marker) => authorizeUrl.includes(marker))) {
      return {
        valid: false,
        message: 'Blocked old dev store auth URL. Remove im3dst-x9 from Shopify Customer Account login config.',
      };
    }

    if (parsed.origin !== 'https://shopify.com' || parsed.pathname !== expectedPath) {
      return {
        valid: false,
        message: `Shopify OAuth URL must use https://shopify.com${expectedPath}.`,
      };
    }

    if (params.get('client_id') !== expectedClientId) {
      return {
        valid: false,
        message: 'Shopify OAuth URL must include the configured Customer Account client_id.',
      };
    }

    if (params.get('response_type') !== 'code') {
      return {
        valid: false,
        message: 'Shopify OAuth URL must include response_type=code.',
      };
    }

    if (params.get('redirect_uri') !== expectedRedirectUri) {
      return {
        valid: false,
        message: `Shopify OAuth URL must include redirect_uri set to ${expectedRedirectUri}.`,
      };
    }

    if (params.get('scope') !== SHOPIFY_OAUTH_SCOPE) {
      return {
        valid: false,
        message: `Shopify OAuth URL must include scope=${SHOPIFY_OAUTH_SCOPE}.`,
      };
    }

    if (!String(params.get('state') || '').trim()) {
      return {
        valid: false,
        message: 'Shopify OAuth URL must include a state parameter.',
      };
    }

    if (!String(params.get('nonce') || '').trim()) {
      return {
        valid: false,
        message: 'Shopify OAuth URL must include a nonce parameter.',
      };
    }

    if (!String(params.get('code_challenge') || '').trim()) {
      return {
        valid: false,
        message: 'Shopify OAuth URL must include a PKCE code_challenge.',
      };
    }

    if (params.get('code_challenge_method') !== 'S256') {
      return {
        valid: false,
        message: 'Shopify OAuth URL must include code_challenge_method=S256.',
      };
    }

    return { valid: true, message: '' };
  } catch {
    return {
      valid: false,
      message: 'Shopify OAuth authorize URL could not be parsed.',
    };
  }
}

/** @deprecated Use validateShopifyOAuthAuthorizeUrl for Customer Account API OAuth. */
export function validateShopifyAccountLoginUrl(
  authorizeUrl: string,
  expectedRedirectUri = getShopifyOAuthRedirectUri()
) {
  return validateShopifyOAuthAuthorizeUrl(authorizeUrl, expectedRedirectUri);
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
