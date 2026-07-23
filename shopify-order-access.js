const axios = require('axios');

const REQUIRED_ORDER_SCOPES = ['write_orders'];

let resolvedOrderAccess = null;

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function getPrimaryOrderAccessToken() {
  return safeString(process.env.SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN);
}

function getFallbackAdminAccessToken() {
  return safeString(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN);
}

function getShopifyOrderAccessToken() {
  if (resolvedOrderAccess?.accessToken) {
    return resolvedOrderAccess.accessToken;
  }

  const primary = getPrimaryOrderAccessToken();
  if (primary) {
    return primary;
  }

  return getFallbackAdminAccessToken();
}

function hasShopifyOrderAdminAccessToken() {
  return Boolean(getPrimaryOrderAccessToken() || getFallbackAdminAccessToken());
}

function getShopifyOrderTokenSource() {
  if (resolvedOrderAccess?.tokenSource) {
    return resolvedOrderAccess.tokenSource;
  }

  if (getPrimaryOrderAccessToken()) {
    return 'SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN';
  }

  if (getFallbackAdminAccessToken()) {
    return 'SHOPIFY_ADMIN_ACCESS_TOKEN';
  }

  return '';
}

function getShopifyOrderTokenFingerprint(accessToken = getShopifyOrderAccessToken()) {
  const token = safeString(accessToken);
  if (!token) {
    return '';
  }

  if (token.startsWith('shpat_') && token.length > 10) {
    return `shpat_...${token.slice(-4)}`;
  }

  if (token.length < 10) {
    return `${token.slice(0, 2)}...`;
  }

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function getMissingOrderScopes(grantedScopes = []) {
  const granted = new Set(
    (Array.isArray(grantedScopes) ? grantedScopes : []).map((scope) => safeString(scope)).filter(Boolean)
  );

  return REQUIRED_ORDER_SCOPES.filter((scope) => !granted.has(scope));
}

async function fetchShopifyAdminScopes(accessToken) {
  const storeDomain = safeString(process.env.SHOPIFY_STORE_DOMAIN);
  const token = safeString(accessToken);

  if (!storeDomain || !token) {
    return [];
  }

  try {
    const response = await axios.get(`https://${storeDomain}/admin/oauth/access_scopes.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
      },
      timeout: 15000,
    });

    const scopes = Array.isArray(response.data?.access_scopes) ? response.data.access_scopes : [];
    return scopes.map((entry) => safeString(entry?.handle)).filter(Boolean);
  } catch (error) {
    const status = error?.response?.status || null;
    const body = error?.response?.data || error?.message || 'unknown error';
    console.error('[ORDER CREATE FAILED] could not read Shopify access scopes', {
      status,
      body,
      tokenFingerprint: getShopifyOrderTokenFingerprint(token),
    });
    return [];
  }
}

async function resolveShopifyOrderAccessToken() {
  const primaryToken = getPrimaryOrderAccessToken();

  if (primaryToken) {
    const scopes = await fetchShopifyAdminScopes(primaryToken);
    const missingOrderScopes = getMissingOrderScopes(scopes);

    return {
      accessToken: primaryToken,
      tokenSource: 'SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN',
      scopes,
      missingOrderScopes,
      hasShopifyOrderAdminAccessToken: true,
    };
  }

  const fallbackToken = getFallbackAdminAccessToken();
  if (!fallbackToken) {
    return {
      accessToken: '',
      tokenSource: '',
      scopes: [],
      missingOrderScopes: REQUIRED_ORDER_SCOPES,
      hasShopifyOrderAdminAccessToken: false,
    };
  }

  const scopes = await fetchShopifyAdminScopes(fallbackToken);
  const missingOrderScopes = getMissingOrderScopes(scopes);

  if (!missingOrderScopes.length) {
    return {
      accessToken: fallbackToken,
      tokenSource: 'SHOPIFY_ADMIN_ACCESS_TOKEN',
      scopes,
      missingOrderScopes: [],
      hasShopifyOrderAdminAccessToken: true,
    };
  }

  return {
    accessToken: '',
    tokenSource: 'SHOPIFY_ADMIN_ACCESS_TOKEN',
    scopes,
    missingOrderScopes,
    hasShopifyOrderAdminAccessToken: true,
  };
}

async function validateShopifyOrderCreateAccess() {
  const storeDomain = safeString(process.env.SHOPIFY_STORE_DOMAIN);
  const resolved = await resolveShopifyOrderAccessToken();
  const accessToken = resolved.accessToken;
  const tokenSource = resolved.tokenSource || getShopifyOrderTokenSource();
  const tokenFingerprint = getShopifyOrderTokenFingerprint(accessToken);

  resolvedOrderAccess = resolved.accessToken
    ? {
        accessToken: resolved.accessToken,
        tokenSource: resolved.tokenSource,
      }
    : null;

  if (!storeDomain) {
    const message = 'Missing SHOPIFY_STORE_DOMAIN for order creation.';
    console.error('[ORDER CREATE FAILED] startup validation', {
      message,
      tokenSource: tokenSource || null,
      tokenFingerprint: tokenFingerprint || null,
      scopes: resolved.scopes,
    });
    return {
      ok: false,
      message,
      scopes: resolved.scopes,
      tokenSource,
      tokenFingerprint,
      missingOrderScopes: REQUIRED_ORDER_SCOPES,
      hasShopifyOrderAdminAccessToken: resolved.hasShopifyOrderAdminAccessToken,
    };
  }

  if (!accessToken) {
    const message = resolved.tokenSource
      ? `Shopify order creation requires ${resolved.missingOrderScopes.join(', ')} on ${resolved.tokenSource}.`
      : 'Missing SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN. Set a dedicated Shopify Admin API token with write_orders scope for paid checkout order creation.';
    console.error('[ORDER CREATE FAILED] startup validation', {
      message,
      tokenSource: tokenSource || null,
      tokenFingerprint: null,
      scopes: resolved.scopes,
      storeDomain,
      missingOrderScopes: resolved.missingOrderScopes,
    });
    return {
      ok: false,
      message,
      scopes: resolved.scopes,
      tokenSource,
      tokenFingerprint,
      missingOrderScopes: resolved.missingOrderScopes,
      hasShopifyOrderAdminAccessToken: resolved.hasShopifyOrderAdminAccessToken,
    };
  }

  if (resolved.missingOrderScopes.length) {
    const message =
      `Shopify order creation requires ${resolved.missingOrderScopes.join(', ')} on ${tokenSource}. ` +
      'In Shopify Admin, open your custom app API credentials, enable write_orders, reinstall the app if prompted, regenerate the Admin API access token, then update the order token env var.';
    console.error('[ORDER CREATE FAILED] startup validation', {
      message,
      tokenSource,
      tokenFingerprint,
      scopes: resolved.scopes,
      missingOrderScopes: resolved.missingOrderScopes,
      storeDomain,
    });
    return {
      ok: false,
      message,
      scopes: resolved.scopes,
      tokenSource,
      tokenFingerprint,
      missingOrderScopes: resolved.missingOrderScopes,
      hasShopifyOrderAdminAccessToken: true,
    };
  }

  console.log('[NOOD backend] Shopify order creation ready', {
    tokenSource,
    tokenFingerprint,
    scopes: resolved.scopes,
    storeDomain,
  });

  return {
    ok: true,
    message: 'Shopify order creation ready.',
    scopes: resolved.scopes,
    tokenSource,
    tokenFingerprint,
    missingOrderScopes: [],
    hasShopifyOrderAdminAccessToken: true,
  };
}

function assertShopifyOrderCreateAccess(orderAccessState) {
  if (orderAccessState?.ok) {
    return;
  }

  const error = new Error(
    orderAccessState?.message ||
      'Shopify order creation is not configured. Set SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN with write_orders scope.'
  );
  error.code = 'SHOPIFY_ORDER_ACCESS_DENIED';
  error.shopifyDetails = {
    missingOrderScopes: orderAccessState?.missingOrderScopes || REQUIRED_ORDER_SCOPES,
    tokenSource: orderAccessState?.tokenSource || getShopifyOrderTokenSource(),
    scopes: orderAccessState?.scopes || [],
    hasShopifyOrderAdminAccessToken: Boolean(orderAccessState?.hasShopifyOrderAdminAccessToken),
  };
  throw error;
}

module.exports = {
  REQUIRED_ORDER_SCOPES,
  getShopifyOrderAccessToken,
  hasShopifyOrderAdminAccessToken,
  getShopifyOrderTokenSource,
  getShopifyOrderTokenFingerprint,
  getMissingOrderScopes,
  fetchShopifyAdminScopes,
  resolveShopifyOrderAccessToken,
  validateShopifyOrderCreateAccess,
  assertShopifyOrderCreateAccess,
};