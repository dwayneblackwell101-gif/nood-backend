function toShopifyCallbackRoute(path: string) {
  try {
    const parsed = new URL(path);
    const isShopifyScheme = parsed.protocol === 'shop.66320990292.nood:';
    const isAuthCallback = parsed.hostname === 'auth' && parsed.pathname === '/callback';

    if (isShopifyScheme && isAuthCallback) {
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

export function redirectSystemPath({ path }: { path: string | null; initial: boolean }) {
  if (!path) {
    return '/';
  }

  const redirectedPath = toShopifyCallbackRoute(path);
  console.log('SHOPIFY_NATIVE_INTENT_PATH', path);
  console.log('SHOPIFY_NATIVE_INTENT_REDIRECTED_PATH', redirectedPath);

  return redirectedPath;
}
