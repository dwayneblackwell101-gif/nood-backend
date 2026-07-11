const axios = require('axios');

const PAYPAL_SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
const PAYPAL_LIVE_API_BASE = 'https://api-m.paypal.com';

function getPayPalConfig() {
  const env = String(
    process.env.PAYPAL_ENV || process.env.PAYPAL_ENVIRONMENT || 'sandbox'
  )
    .trim()
    .toLowerCase();

  return {
    clientId: String(process.env.PAYPAL_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.PAYPAL_CLIENT_SECRET || '').trim(),
    env: env === 'live' ? 'live' : 'sandbox',
    apiBase: env === 'live' ? PAYPAL_LIVE_API_BASE : PAYPAL_SANDBOX_API_BASE,
  };
}

function hasPayPalCredentials() {
  const { clientId, clientSecret } = getPayPalConfig();
  return Boolean(clientId && clientSecret);
}

function assertPayPalCredentials() {
  if (!hasPayPalCredentials()) {
    const error = new Error(
      'Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in backend .env'
    );
    error.statusCode = 500;
    throw error;
  }
}

async function getPayPalAccessToken() {
  const { clientId, clientSecret, apiBase } = getPayPalConfig();
  assertPayPalCredentials();

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    'base64'
  );

  const response = await axios.post(
    `${apiBase}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    }
  );

  if (!response.data?.access_token) {
    throw new Error('PayPal did not return an access token');
  }

  return response.data.access_token;
}

async function createPayPalOrder({ total, currency = 'USD', referenceId, description }) {
  const { apiBase } = getPayPalConfig();
  const accessToken = await getPayPalAccessToken();

  const response = await axios.post(
    `${apiBase}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: referenceId,
          description: description || 'NOOD order',
          amount: {
            currency_code: currency,
            value: total,
          },
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      timeout: 30000,
    }
  );

  return response.data;
}

async function capturePayPalOrder(orderId) {
  const { apiBase } = getPayPalConfig();
  const accessToken = await getPayPalAccessToken();

  const response = await axios.post(
    `${apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      timeout: 30000,
    }
  );

  return response.data;
}

async function getPayPalOrder(orderId) {
  const { apiBase } = getPayPalConfig();
  const accessToken = await getPayPalAccessToken();

  const response = await axios.get(
    `${apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return response.data;
}

module.exports = {
  getPayPalConfig,
  hasPayPalCredentials,
  getPayPalAccessToken,
  createPayPalOrder,
  capturePayPalOrder,
  getPayPalOrder,
};
