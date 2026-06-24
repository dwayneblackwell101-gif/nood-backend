const axios = require('axios');

const REQUIRED_ORDER_SCOPES = ['write_orders'];

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function getShopifyOrderAccessToken() {
  return safeString(process.env.SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN);
}

function hasShopifyOrderAdminAccessToken() {
  return Boolean(getShopifyOrderAccessToken());
}

function getShopifyOrderTokenSource() {
  return 'SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN';
}

function getShopifyOrderTokenFingerprint(accessToken = getShopifyOrderAccessToken()) {
  const token = safeString(accessToken);
  if (!token) {
    return '';
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
      tokenSource: getShopifyOrderTokenSource(),
    });
    return [];
  }
}

async function validateShopifyOrderCreateAccess() {
  const storeDomain = safeString(process.env.SHOPIFY_STORE_DOMAIN);
  const accessToken = getShopifyOrderAccessToken();
  const tokenSource = getShopifyOrderTokenSource();
  const tokenFingerprint = getShopifyOrderTokenFingerprint(accessToken);

  if (!storeDomain) {
    const message = 'Missing SHOPIFY_STORE_DOMAIN for order creation.';
    console.error('[ORDER CREATE FAILED] startup validation', {
      message,
      tokenSource,
      tokenFingerprint: tokenFingerprint || null,
      scopes: [],
    });
    return {
      ok: false,
      message,
      scopes: [],
      tokenSource,
      tokenFingerprint,
      missingOrderScopes: REQUIRED_ORDER_SCOPES,
      hasShopifyOrderAdminAccessToken: false,
    };
  }

  if (!accessToken) {
    const message =
      'Missing SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN. Set a dedicated Shopify Admin API token with write_orders scope for paid checkout order creation.';
    console.error('[ORDER CREATE FAILED] startup validation', {
      message,
      tokenSource,
      tokenFingerprint: null,
      scopes: [],
      storeDomain,
    });
    return {
      ok: false,
      message,
      scopes: [],
      tokenSource,
      tokenFingerprint,
      missingOrderScopes: REQUIRED_ORDER_SCOPES,
      hasShopifyOrderAdminAccessToken: false,
    };
  }

  const scopes = await fetchShopifyAdminScopes(accessToken);
  const missingOrderScopes = getMissingOrderScopes(scopes);

  if (missingOrderScopes.length) {
    const message =
      `Shopify order creation requires ${missingOrderScopes.join(', ')} on SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN. ` +
      'In Shopify Admin, open your custom app API credentials, enable write_orders, reinstall the app if prompted, regenerate the Admin API access token, then update SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN on Render.';
    console.error('[ORDER CREATE FAILED] startup validation', {
      message,
      tokenSource,
      tokenFingerprint,
      scopes,
      missingOrderScopes,
      storeDomain,
    });
    return {
      ok: false,
      message,
      scopes,
      tokenSource,
      tokenFingerprint,
      missingOrderScopes,
      hasShopifyOrderAdminAccessToken: true,
    };
  }

  console.log('[ORDER CREATE SUCCESS] startup validation passed', {
    tokenSource,
    tokenFingerprint,
    scopes,
    storeDomain,
  });

  return {
    ok: true,
    message: 'Shopify order creation access is configured.',
    scopes,
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
    tokenSource: getShopifyOrderTokenSource(),
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
  validateShopifyOrderCreateAccess,
  assertShopifyOrderCreateAccess,
};