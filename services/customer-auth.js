const axios = require('axios');
const crypto = require('crypto');

let endpoint = '';
const cache = new Map();

async function graphqlEndpoint() {
  if (endpoint) return endpoint;
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim();
  if (!domain) throw new Error('Shopify customer authentication is not configured');
  const response = await axios.get(`https://${domain}/.well-known/customer-account-api`, {
    headers: { Accept: 'application/json' }, timeout: 10000,
  });
  endpoint = String(response.data?.graphql_api || '').trim();
  if (!endpoint) throw new Error('Shopify Customer Account discovery failed');
  return endpoint;
}

function bearerToken(req) {
  const value = String(req.headers?.authorization || '').trim();
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : value;
}

function authenticateDevelopmentTestSession(req) {
  if (process.env.NODE_ENV === 'production') return null;
  const configured = String(process.env.NOOD_AI_DEV_TEST_TOKEN || '');
  const supplied = String(req.headers?.['x-nood-ai-dev-test-token'] || '');
  if (configured.length < 32 || supplied.length !== configured.length) return null;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return { userId: 'nood-development-ai-test-session', email: '', firstName: 'NOOD', lastName: 'Development Test', developmentTestSession: true };
}

async function authenticateCustomer(req) {
  const developmentTest = authenticateDevelopmentTestSession(req);
  if (developmentTest) return developmentTest; // fixed non-customer identity; never production
  const token = bearerToken(req);
  if (!token) return null;
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;
  try {
    const response = await axios.post(await graphqlEndpoint(), {
      query: `query NoodAuthenticatedCustomer { customer { id firstName lastName emailAddress { emailAddress } } }`,
    }, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      timeout: 12000,
      maxContentLength: 512 * 1024,
    });
    const customer = response.data?.data?.customer;
    if (!customer?.id || response.data?.errors?.length) return null;
    const identity = {
      userId: String(customer.id),
      email: String(customer.emailAddress?.emailAddress || '').trim().toLowerCase(),
      firstName: String(customer.firstName || '').trim(),
      lastName: String(customer.lastName || '').trim(),
    };
    cache.set(key, { identity, expiresAt: Date.now() + 5 * 60 * 1000 });
    if (cache.size > 1000) cache.clear();
    return identity;
  } catch (error) {
    if (error.response?.status !== 401) console.error('[CUSTOMER AUTH] validation failed:', error.message);
    return null;
  }
}

module.exports = { authenticateCustomer, bearerToken };
