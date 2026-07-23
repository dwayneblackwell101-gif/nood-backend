/**
 * Shopify Customer Account API token verification.
 * Complements Storefront customerAccessToken verification for headless mobile OAuth tokens.
 */

const axios = require('axios');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

const PROFILE_QUERY = `
  query NoodBackendCustomerProfile {
    customer {
      id
      firstName
      lastName
      emailAddress {
        emailAddress
      }
      phoneNumber {
        phoneNumber
      }
    }
  }
`;

let cachedGraphqlEndpoint = '';

function getStoreDomain() {
  return safeString(process.env.SHOPIFY_STORE_DOMAIN).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function getShopId() {
  return safeString(process.env.SHOPIFY_SHOP_ID || process.env.SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID);
}

async function discoverCustomerAccountGraphqlEndpoint() {
  if (cachedGraphqlEndpoint) return cachedGraphqlEndpoint;

  const storeDomain = getStoreDomain();
  if (!storeDomain) {
    throw new Error('SHOPIFY_STORE_DOMAIN is required for Customer Account API auth.');
  }

  const discoveryUrl = `https://${storeDomain}/.well-known/customer-account-api`;
  const response = await axios.get(discoveryUrl, {
    timeout: 10000,
    headers: { Accept: 'application/json' },
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`Customer Account API discovery failed (${response.status}).`);
  }

  const endpoint = safeString(response.data?.graphql_api);
  if (!endpoint) {
    // Fallback for known shop id layout
    const shopId = getShopId();
    if (shopId) {
      cachedGraphqlEndpoint = `https://shopify.com/${shopId}/account/customer/api/2025-04/graphql`;
      return cachedGraphqlEndpoint;
    }
    throw new Error('Customer Account API discovery missing graphql_api.');
  }

  cachedGraphqlEndpoint = endpoint;
  return endpoint;
}

/**
 * Verify a Customer Account API access token and return a normalized customer.
 */
async function verifyCustomerAccountAccessToken(token) {
  const accessToken = safeString(token);
  if (!accessToken || accessToken.length < 10) {
    const error = new Error('Invalid customer token.');
    error.statusCode = 401;
    throw error;
  }

  const endpoint = await discoverCustomerAccountGraphqlEndpoint();
  const response = await axios.post(
    endpoint,
    { query: PROFILE_QUERY },
    {
      timeout: 12000,
      headers: {
        'Content-Type': 'application/json',
        // Customer Account API expects raw access token (not always Bearer)
        Authorization: accessToken,
      },
      validateStatus: () => true,
    }
  );

  if (response.status === 401 || response.status === 403) {
    const error = new Error('Customer authentication failed.');
    error.statusCode = 401;
    error.safeReason = `customer_account_http_${response.status}`;
    throw error;
  }

  if (response.status >= 400) {
    const error = new Error('Customer authentication failed.');
    error.statusCode = 401;
    error.safeReason = `customer_account_http_${response.status}`;
    throw error;
  }

  if (Array.isArray(response.data?.errors) && response.data.errors.length) {
    const error = new Error('Customer authentication failed.');
    error.statusCode = 401;
    error.safeReason = response.data.errors[0]?.message || 'customer_account_graphql_error';
    throw error;
  }

  const customer = response.data?.data?.customer;
  if (!customer?.id) {
    const error = new Error('Customer authentication failed.');
    error.statusCode = 401;
    error.safeReason = 'customer_account_empty_customer';
    throw error;
  }

  return {
    id: safeString(customer.id),
    email: safeString(customer.emailAddress?.emailAddress).toLowerCase(),
    phone: safeString(customer.phoneNumber?.phoneNumber),
    firstName: safeString(customer.firstName),
    lastName: safeString(customer.lastName),
    source: 'customer_account_api',
  };
}

function resetCustomerAccountEndpointCache() {
  cachedGraphqlEndpoint = '';
}

module.exports = {
  verifyCustomerAccountAccessToken,
  discoverCustomerAccountGraphqlEndpoint,
  resetCustomerAccountEndpointCache,
};
