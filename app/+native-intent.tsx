import { isAppBootstrapComplete } from '../utils/app-bootstrap';
import { isShopifyHttpsAuthCallbackUrl } from '../utils/shopify-auth';

function toShopifyCallbackRoute(path: string) {
  try {
    const parsed = new URL(path);
    const isShopifyScheme = parsed.protocol === 'shop.66320990292.nood:';
    const isAuthCallback = parsed.hostname === 'auth' && parsed.pathname === '/callback';
    const isHttpsBridge = isShopifyHttpsAuthCallbackUrl(path);

    if ((isShopifyScheme && isAuthCallback) || isHttpsBridge) {
      return `/auth/callback${parsed.search}`;
    }
  } catch {
    const normalized = path.startsWith('/') ? path : `/${path}`;

    if (normalized.startsWith('/auth/callback')) {
      return normalized;
    }
  }

  return path;
}

export function redirectSystemPath({ path, initial }: { path: string | null; initial: boolean }) {
  if (!path) {
    console.log('[AUTH] native intent path = (null)');
    return '/';
  }

  const redirectedPath = toShopifyCallbackRoute(path);
  const suppressCallbackRoute =
    !initial &&
    isAppBootstrapComplete() &&
    redirectedPath.startsWith('/auth/callback');
  const resolvedPath = suppressCallbackRoute ? '/(tabs)/account' : redirectedPath;

  console.log('[AUTH] native intent path =', path);
  console.log('[AUTH] native intent initial =', initial);
  console.log('[AUTH] native intent redirected =', redirectedPath);
  console.log('[AUTH] native intent resolved =', resolvedPath);
  console.log('SHOPIFY_NATIVE_INTENT_PATH', path);
  console.log('SHOPIFY_NATIVE_INTENT_REDIRECTED_PATH', redirectedPath);

  if (suppressCallbackRoute) {
    console.log('[AUTH] native intent kept tabs mounted; deep-link listener will finish sign-in');
  }

  return resolvedPath;
}
