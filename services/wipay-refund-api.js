const axios = require('axios');
const crypto = require('crypto');

function configuration(environment) {
  if (!['live', 'sandbox'].includes(environment)) throw Error('Invalid WiPay refund environment');
  const key = String(process.env[environment === 'sandbox' ? 'WIPAY_WAPI_SANDBOX_KEY' : 'WIPAY_WAPI_KEY'] || '').trim();
  const prefix = environment === 'sandbox' ? 'test' : 'live';
  if (!new RegExp(`^wapi_${prefix}_[a-f0-9]{18}_[a-f0-9]{64}$`).test(key)) {
    throw Object.assign(Error(`WiPay ${environment} refund access is not configured`), { statusCode: 503 });
  }
  return { baseURL: `https://${environment === 'sandbox' ? 'ttsb' : 'tt'}.wipayfinancial.com/wapi`,
    headers: { 'X-WAPI-Key': key, Accept: 'application/json' }, timeout: 20000, maxRedirects: 0 };
}
function transactionPath(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{3,150}$/.test(id)) throw Error('Invalid WiPay transaction reference');
  return `/transactions/${encodeURIComponent(id)}`;
}
async function retrieve(id, environment) {
  const { data } = await axios.create(configuration(environment)).get(transactionPath(id));
  if (!data?.data || data.data.transaction_id !== id) throw Error('WiPay transaction reference mismatch');
  return data.data;
}
async function request(id, environment) {
  const response = await axios.create(configuration(environment)).post(`${transactionPath(id)}/refund`, '', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  // A 201 only confirms that WiPay accepted a request, not that money returned.
  if (response.status !== 201) throw Error('Unconfirmed WiPay refund request');
}
function verifyWebhook(req, secret, now = Date.now()) {
  const timestamp = String(req.get('X-WiPay-Webhook-Timestamp') || '');
  const signature = String(req.get('X-WiPay-Webhook-Signature') || '');
  if (!secret || typeof req.rawBody !== 'string' || !/^\d{10}$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300 ||
      req.get('X-WiPay-Webhook-Version') !== 'v1' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${req.rawBody}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
module.exports = { configuration, retrieve, request, verifyWebhook };
