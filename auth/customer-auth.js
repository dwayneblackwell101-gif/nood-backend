const crypto = require('crypto');
const { storefrontGraphql } = require('../catalog/shopify');

const CUSTOMER_ACCESS_TOKEN_QUERY = `
  query NoodCustomerFromAccessToken($customerAccessToken: String!) {
    customer(customerAccessToken: $customerAccessToken) {
      id
      email
      firstName
      lastName
      phone
    }
  }
`;

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function redactToken(token) {
  const value = safeString(token);
  if (!value) return '';
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `sha256:${hash}`;
}

function getBearerToken(req) {
  const authHeader = safeString(req.get?.('authorization') || req.headers?.authorization);
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) {
    return safeString(match[1]);
  }

  return safeString(req.body?.customerAccessToken || req.query?.customerAccessToken);
}

function normalizeShopifyCustomerId(value) {
  const raw = safeString(value);
  if (!raw) return '';
  const numeric = raw.match(/Customer\/(\d+)/)?.[1] || raw.match(/(\d+)$/)?.[1] || raw;
  return numeric ? `gid://shopify/Customer/${numeric}` : '';
}

function normalizeCustomer(customer = {}) {
  const id = normalizeShopifyCustomerId(customer.id);
  return {
    id,
    numericId: id.match(/(\d+)$/)?.[1] || '',
    email: safeString(customer.email).toLowerCase(),
    phone: safeString(customer.phone),
    firstName: safeString(customer.firstName),
    lastName: safeString(customer.lastName),
  };
}

async function verifyCustomerAccessToken(token) {
  const customerAccessToken = safeString(token);
  if (!customerAccessToken || customerAccessToken.length < 10) {
    const error = new Error('Invalid customer token.');
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    payload = await storefrontGraphql(CUSTOMER_ACCESS_TOKEN_QUERY, { customerAccessToken });
  } catch (error) {
    const wrapped = new Error('Customer authentication failed.');
    wrapped.statusCode = 401;
    wrapped.safeReason = error.message;
    throw wrapped;
  }

  const customer = normalizeCustomer(payload?.customer);
  if (!customer.id) {
    const error = new Error('Customer authentication failed.');
    error.statusCode = 401;
    throw error;
  }

  return customer;
}

function assertBodyIdentityMatches(req, customer) {
  const body = req.body || {};
  const query = req.query || {};
  const suppliedCustomerId = safeString(
    body.customerId || body.customer_id || query.customerId || query.customer_id
  );
  const suppliedEmail = safeString(body.email || query.email || body.customerEmail || query.customerEmail)
    .toLowerCase();

  if (suppliedCustomerId) {
    const normalizedSupplied = normalizeShopifyCustomerId(suppliedCustomerId);
    if (normalizedSupplied && normalizedSupplied !== customer.id) {
      const error = new Error('Authenticated customer does not match request customer.');
      error.statusCode = 403;
      throw error;
    }
  }

  if (suppliedEmail && customer.email && suppliedEmail !== customer.email) {
    const error = new Error('Authenticated customer does not match request email.');
    error.statusCode = 403;
    throw error;
  }
}

function createCustomerAuthMiddleware({ verifyToken = verifyCustomerAccessToken } = {}) {
  return async function requireCustomerAuth(req, res, next) {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: true,
        message: 'Customer authentication required.',
      });
    }

    try {
      const customer = await verifyToken(token);
      assertBodyIdentityMatches(req, customer);
      req.customer = customer;
      req.customerAuth = {
        tokenFingerprint: redactToken(token),
      };
      return next();
    } catch (error) {
      const statusCode = error.statusCode === 403 ? 403 : 401;
      console.warn('[NOOD auth] customer auth rejected', {
        reason: error.safeReason || error.message || 'invalid_customer_auth',
        token: redactToken(token),
      });
      return res.status(statusCode).json({
        success: false,
        error: true,
        message:
          statusCode === 403
            ? 'Authenticated customer does not match this request.'
            : 'Customer authentication failed.',
      });
    }
  };
}

module.exports = {
  assertBodyIdentityMatches,
  createCustomerAuthMiddleware,
  getBearerToken,
  normalizeShopifyCustomerId,
  verifyCustomerAccessToken,
};
