const crypto = require('crypto');
const axios = require('axios');

function configuration({ sandboxTest = false } = {}) {
  const environment = sandboxTest ? 'sandbox' : process.env.WIPAY_ENVIRONMENT || 'sandbox';
  if (!['live', 'sandbox'].includes(environment)) throw new Error('Invalid WIPAY_ENVIRONMENT');
  // Public sandbox keys must never authorize production fulfillment.
  if (environment !== 'live' && process.env.NODE_ENV === 'production' && !sandboxTest) throw new Error('Production WiPay requires live credentials');
  if (process.env.NODE_ENV === 'production' && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error('Production WiPay requires durable Supabase payment state');
  const account = environment === 'sandbox' ? '1234567890' : process.env.WIPAY_ACCOUNT_NUMBER;
  const key = environment === 'sandbox' ? '123' : process.env.WIPAY_API_KEY;
  if (!account || !key || (environment === 'live' && key === '123')) throw new Error('Configure WIPAY_ACCOUNT_NUMBER and WIPAY_API_KEY');
  // WiPay selects sandbox from the environment form field; requests use the
  // documented country endpoint in both modes.
  return { environment, account, key, endpoint: 'https://tt.wipayfinancial.com/plugins/payments/request' };
}

function verifyResponse(query, session, key) {
  const transaction = typeof query.transaction_id === 'string' ? query.transaction_id : '';
  const hash = typeof query.hash === 'string' ? query.hash : '';
  // The documented transaction reference embeds the original order ID. Bind the
  // proof to that order so a valid same-price receipt cannot pay another cart.
  if (query.status !== 'success' || !transaction.includes(`-${session.provider_order_id}-`) ||
      query.currency !== session.currency || !/^[a-f0-9]{32}$/i.test(hash)) return false;
  const expected = crypto.createHash('md5').update(transaction + session.amount + key).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'));
}

async function requestPayment(session, responseUrl) {
  const config = configuration({ sandboxTest: session.provider === 'wipay_test' });
  const cents = require('./catalog-pricing').moneyToCents(session.amount);
  if (!['TTD', 'USD'].includes(session.currency) || !cents || cents < (session.currency === 'TTD' ? 500 : 100)) {
    throw Object.assign(new Error('WiPay minimum is TTD 5.00 or USD 1.00'), { statusCode: 400 });
  }
  const payload = new URLSearchParams({ account_number: config.account, country_code: 'TT',
    currency: session.currency, environment: config.environment, fee_structure: 'customer_pay',
    method: 'credit_card', order_id: session.provider_order_id, origin: 'nood_app',
    response_url: responseUrl, total: session.amount,
    name: session.customer.name, email: session.customer.email, phone: session.customer.phone });
  const { data } = await axios.post(config.endpoint, payload.toString(), {
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
  const url = data?.url || data?.payment_url;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['tt.wipayfinancial.com', 'ttsb.wipayfinancial.com'].includes(parsed.hostname)) {
    throw new Error('WiPay returned an invalid checkout URL');
  }
  return url;
}
module.exports = { configuration, verifyResponse, requestPayment };

