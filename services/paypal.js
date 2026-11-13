const axios = require('axios');

function paypalBaseUrl() {
  return String(process.env.PAYPAL_ENVIRONMENT || 'sandbox').toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function credentials() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const secret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  if (!clientId || !secret) throw Object.assign(new Error('PayPal server credentials are not configured'), { statusCode: 503 });
  return { clientId, secret };
}

async function accessToken() {
  const { clientId, secret } = credentials();
  const response = await axios.post(
    `${paypalBaseUrl()}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: clientId, password: secret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      timeout: 15000,
    }
  );
  if (!response.data?.access_token) throw new Error('PayPal authentication failed');
  return response.data.access_token;
}

async function paypalRequest(method, path, data, requestId) {
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (requestId) headers['PayPal-Request-Id'] = String(requestId).slice(0, 108);
  const response = await axios({ method, url: `${paypalBaseUrl()}${path}`, data, headers, timeout: 30000 });
  return response.data;
}

function createOrder({ amount, currency, reference }) {
  return paypalRequest('post', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: reference, amount: { currency_code: currency, value: amount } }],
  }, `create-${reference}`);
}

function captureOrder(orderId) {
  return paypalRequest('post', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`);
}

function refundCapture(captureId, { amount, currency, requestId }) {
  return paypalRequest(
    'post',
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { amount: { value: Number(amount).toFixed(2), currency_code: String(currency).toUpperCase() } },
    requestId || `refund-${captureId}`
  );
}

module.exports = { createOrder, captureOrder, refundCapture };
