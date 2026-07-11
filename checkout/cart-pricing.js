const crypto = require('crypto');
const { centsToUsd, normalizeCurrency, requirePositiveCents, usdToCents } = require('../lib/money');

const SHOPIFY_VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const SNAPSHOT_HASH_ALGORITHM = 'sha256';

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errorWithStatus(message, statusCode = 400, code = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function normalizeVariantGid(value) {
  const raw = safeString(value);
  if (!raw) return '';
  if (SHOPIFY_VARIANT_GID_RE.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  const match = raw.match(/ProductVariant\/(\d+)/i);
  return match?.[1] ? `gid://shopify/ProductVariant/${match[1]}` : '';
}

function getCheckoutConfig(env = process.env) {
  return {
    maxQuantityPerLine: Number(env.CHECKOUT_MAX_QUANTITY_PER_LINE || 10),
    maxTotalQuantity: Number(env.CHECKOUT_MAX_TOTAL_QUANTITY || 50),
    maxLineItems: Number(env.CHECKOUT_MAX_LINE_ITEMS || 50),
    pricingMaxAgeSeconds: Number(env.CHECKOUT_PRICING_MAX_AGE_SECONDS || 900),
    shippingMode: safeString(env.CHECKOUT_SHIPPING_MODE, 'fixed').toLowerCase(),
    fixedShippingCents: Number(env.CHECKOUT_FIXED_SHIPPING_CENTS || 0),
    pricingSchemaVersion: Number(env.CHECKOUT_PRICING_SCHEMA_VERSION || 1),
    currency: normalizeCurrency(env.SHOPIFY_CURRENCY || env.PAYMENT_CURRENCY || 'USD'),
    paymentCurrency: normalizeCurrency(env.PAYMENT_CURRENCY || env.SHOPIFY_CURRENCY || 'USD'),
  };
}

function validateCheckoutConfig(config = getCheckoutConfig()) {
  if (!Number.isSafeInteger(config.maxQuantityPerLine) || config.maxQuantityPerLine <= 0) {
    throw errorWithStatus('CHECKOUT_MAX_QUANTITY_PER_LINE must be a positive integer.', 500, 'checkout_config_invalid');
  }
  if (!Number.isSafeInteger(config.maxTotalQuantity) || config.maxTotalQuantity <= 0) {
    throw errorWithStatus('CHECKOUT_MAX_TOTAL_QUANTITY must be a positive integer.', 500, 'checkout_config_invalid');
  }
  if (!Number.isSafeInteger(config.maxLineItems) || config.maxLineItems <= 0) {
    throw errorWithStatus('CHECKOUT_MAX_LINE_ITEMS must be a positive integer.', 500, 'checkout_config_invalid');
  }
  if (!Number.isSafeInteger(config.pricingMaxAgeSeconds) || config.pricingMaxAgeSeconds <= 0) {
    throw errorWithStatus('CHECKOUT_PRICING_MAX_AGE_SECONDS must be a positive integer.', 500, 'checkout_config_invalid');
  }
  if (config.shippingMode !== 'fixed') {
    throw errorWithStatus('CHECKOUT_SHIPPING_MODE must be fixed until trusted live rates are implemented.', 500, 'checkout_config_invalid');
  }
  if (!Number.isSafeInteger(config.fixedShippingCents) || config.fixedShippingCents < 0) {
    throw errorWithStatus('CHECKOUT_FIXED_SHIPPING_CENTS must be a non-negative integer.', 500, 'checkout_config_invalid');
  }
  if (!Number.isSafeInteger(config.pricingSchemaVersion) || config.pricingSchemaVersion <= 0) {
    throw errorWithStatus('CHECKOUT_PRICING_SCHEMA_VERSION must be a positive integer.', 500, 'checkout_config_invalid');
  }
  if (config.currency !== config.paymentCurrency) {
    throw errorWithStatus('SHOPIFY_CURRENCY and PAYMENT_CURRENCY must match for checkout.', 500, 'checkout_currency_mismatch');
  }
  return config;
}

function assertNoClientFinancialOverrides(body = {}) {
  const forbidden = [
    'discount',
    'discountAmount',
    'discount_amount',
    'discountCode',
    'discount_code',
    'shipping',
    'shippingAmount',
    'shipping_amount',
    'shippingPrice',
    'tax',
    'taxAmount',
    'tax_amount',
  ];
  const used = forbidden.filter((key) => body[key] !== undefined && body[key] !== null && body[key] !== '');
  if (used.length) {
    throw errorWithStatus('Checkout discounts, shipping, and tax must be calculated by the server.', 400, 'client_financial_override');
  }
}

function assertClientTotalIfPresent(body = {}, trustedTotalCents) {
  const stated = body.total ?? body.amount ?? body.paypalTotalUsd ?? body.totalUsd;
  if (stated === undefined || stated === null || stated === '') return;
  const statedCents = usdToCents(stated);
  if (statedCents !== trustedTotalCents) {
    throw errorWithStatus('Client checkout total does not match trusted server total.', 400, 'client_total_mismatch');
  }
}

function extractCartLines(body = {}) {
  const lines = Array.isArray(body.cartItems)
    ? body.cartItems
    : Array.isArray(body.cart)
      ? body.cart
      : Array.isArray(body.items)
        ? body.items
        : null;
  if (!Array.isArray(lines)) throw errorWithStatus('Cart items must be an array.', 400, 'malformed_cart');
  if (!lines.length) throw errorWithStatus('Cart is empty.', 400, 'empty_cart');
  return lines;
}

function normalizeCartIntent(body = {}, config = validateCheckoutConfig()) {
  assertNoClientFinancialOverrides(body);
  const lines = extractCartLines(body);
  if (lines.length > config.maxLineItems) {
    throw errorWithStatus('Cart has too many line items.', 400, 'too_many_lines');
  }

  const merged = new Map();
  for (const line of lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      throw errorWithStatus('Cart line is malformed.', 400, 'malformed_cart_line');
    }
    const variantId = normalizeVariantGid(line.variantId || line.id);
    if (!variantId || !SHOPIFY_VARIANT_GID_RE.test(variantId)) {
      throw errorWithStatus('Cart line has malformed Shopify variant ID.', 400, 'malformed_variant_id');
    }
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw errorWithStatus('Cart quantity must be a positive integer.', 400, 'invalid_quantity');
    }
    if (quantity > config.maxQuantityPerLine) {
      throw errorWithStatus('Cart line quantity exceeds the allowed maximum.', 400, 'quantity_exceeds_limit');
    }
    merged.set(variantId, (merged.get(variantId) || 0) + quantity);
  }

  const normalized = Array.from(merged.entries())
    .map(([variantId, quantity]) => ({ variantId, quantity }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
  const totalQuantity = normalized.reduce((sum, line) => sum + line.quantity, 0);
  if (totalQuantity > config.maxTotalQuantity) {
    throw errorWithStatus('Cart total quantity exceeds the allowed maximum.', 400, 'total_quantity_exceeds_limit');
  }
  return normalized;
}

function findVariantInCatalog(products = [], variantId = '') {
  for (const product of products) {
    const variants = product?.variants?.edges || [];
    for (const edge of variants) {
      const variant = edge?.node;
      if (safeString(variant?.id) === variantId) {
        return { product, variant };
      }
    }
  }
  return null;
}

function isProductActive(product = {}) {
  const status = safeString(product.status, 'ACTIVE').toUpperCase();
  return status === 'ACTIVE' && product.availableForSale !== false;
}

function assertVariantPurchasable(product, variant, quantity) {
  if (!product || !variant) throw errorWithStatus('Cart variant was not found.', 400, 'variant_missing');
  if (!isProductActive(product)) throw errorWithStatus('Cart product is not available.', 400, 'product_unavailable');
  if (variant.availableForSale === false) throw errorWithStatus('Cart variant is not available.', 400, 'variant_unavailable');
  const policy = safeString(variant.inventoryPolicy).toUpperCase();
  const available = Number(variant.quantityAvailable ?? variant.inventoryQuantity ?? 0);
  if (policy !== 'CONTINUE' && Number.isFinite(available) && available >= 0 && quantity > available) {
    throw errorWithStatus('Requested quantity is not available.', 400, 'inventory_insufficient');
  }
}

function parseTrustedUnitPriceCents(price = {}, expectedCurrency = 'USD') {
  const currency = normalizeCurrency(price.currencyCode);
  if (!currency) throw errorWithStatus('Trusted variant currency is missing.', 400, 'missing_currency');
  if (currency !== expectedCurrency) throw errorWithStatus('Trusted variant currency is unsupported.', 400, 'unsupported_currency');
  const cents = usdToCents(price.amount);
  requirePositiveCents(cents, 'trusted unit price');
  return cents;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(snapshot) {
  const withoutHash = { ...snapshot };
  delete withoutHash.snapshotHash;
  return crypto.createHash(SNAPSHOT_HASH_ALGORITHM).update(canonicalize(withoutHash)).digest('hex');
}

function verifySnapshotHash(snapshot = {}) {
  const expected = safeString(snapshot.snapshotHash);
  if (!expected || hashSnapshot(snapshot) !== expected) {
    throw errorWithStatus('Trusted cart snapshot hash is invalid.', 409, 'snapshot_hash_invalid');
  }
  return true;
}

async function assertActiveCatalog(cache) {
  const activeVersionId = typeof cache.getActiveVersionId === 'function' ? await cache.getActiveVersionId() : '';
  if (typeof cache.getActiveVersionId === 'function') {
    const meta = activeVersionId && typeof cache.getCatalogVersionMeta === 'function'
      ? await cache.getCatalogVersionMeta(activeVersionId)
      : null;
    if (!activeVersionId || !meta || meta.status !== 'active') {
      throw errorWithStatus('Active validated catalog is required for checkout.', 503, 'catalog_unavailable');
    }
  }
  return activeVersionId || 'json-catalog';
}

async function priceCart({ cache, body = {}, customerId = '', now = new Date() } = {}) {
  const config = validateCheckoutConfig();
  const activeCatalogVersionId = await assertActiveCatalog(cache);
  const intent = normalizeCartIntent(body, config);
  const products = typeof cache.getAllProducts === 'function' ? await cache.getAllProducts() : [];
  const lines = [];
  let subtotalCents = 0;

  for (const line of intent) {
    const resolved = findVariantInCatalog(products, line.variantId);
    assertVariantPurchasable(resolved?.product, resolved?.variant, line.quantity);
    const unitPriceCents = parseTrustedUnitPriceCents(resolved.variant.price, config.currency);
    const lineTotalCents = unitPriceCents * line.quantity;
    if (!Number.isSafeInteger(lineTotalCents)) throw errorWithStatus('Cart line total overflow.', 400, 'money_overflow');
    subtotalCents += lineTotalCents;
    if (!Number.isSafeInteger(subtotalCents)) throw errorWithStatus('Cart subtotal overflow.', 400, 'money_overflow');
    lines.push({
      variantId: line.variantId,
      productId: safeString(resolved.product.id),
      productHandle: safeString(resolved.product.handle),
      productTitle: safeString(resolved.product.title, 'Product'),
      variantTitle: safeString(resolved.variant.title, 'Default Title'),
      sku: safeString(resolved.variant.sku),
      quantity: line.quantity,
      unitPriceCents,
      unitPrice: centsToUsd(unitPriceCents),
      lineTotalCents,
      lineTotal: centsToUsd(lineTotalCents),
      currency: config.currency,
    });
  }

  const discountCents = 0;
  const shippingCents = config.fixedShippingCents;
  const taxCents = 0;
  const totalCents = subtotalCents - discountCents + shippingCents + taxCents;
  requirePositiveCents(totalCents, 'checkout total');
  assertClientTotalIfPresent(body, totalCents);

  const snapshot = {
    pricingSchemaVersion: config.pricingSchemaVersion,
    customerId: safeString(customerId),
    lines,
    subtotalCents,
    subtotal: centsToUsd(subtotalCents),
    discounts: [],
    discountCents,
    shipping: {
      methodId: 'fixed',
      label: shippingCents > 0 ? 'Fixed shipping' : 'No additional shipping charge',
      amountCents: shippingCents,
      amount: centsToUsd(shippingCents),
    },
    tax: {
      policy: 'no_additional_tax',
      amountCents: taxCents,
      amount: centsToUsd(taxCents),
    },
    totalCents,
    total: centsToUsd(totalCents),
    currency: config.currency,
    activeCatalogVersionId,
    pricedAt: now.toISOString(),
    source: 'active_catalog',
  };
  snapshot.cartFingerprint = hashSnapshot({ lines: snapshot.lines, currency: snapshot.currency });
  snapshot.snapshotHash = hashSnapshot(snapshot);
  return snapshot;
}

function snapshotToCartItems(snapshot = {}) {
  verifySnapshotHash(snapshot);
  return (snapshot.lines || []).map((line) => ({
    variantId: line.variantId,
    quantity: line.quantity,
    price: line.unitPrice,
    title: line.productTitle,
    variantTitle: line.variantTitle,
    currency: snapshot.currency,
    trusted: true,
  }));
}

async function revalidateSnapshot({ cache, snapshot, now = new Date() } = {}) {
  verifySnapshotHash(snapshot);
  const config = validateCheckoutConfig();
  const pricedAt = Date.parse(snapshot.pricedAt || '');
  if (!Number.isFinite(pricedAt) || now.getTime() - pricedAt > config.pricingMaxAgeSeconds * 1000) {
    throw errorWithStatus('Trusted cart pricing expired before order creation.', 409, 'pricing_snapshot_expired');
  }
  const activeCatalogVersionId = await assertActiveCatalog(cache);
  if (snapshot.activeCatalogVersionId !== activeCatalogVersionId) {
    return { ok: true, activeCatalogChanged: true };
  }
  const products = await cache.getAllProducts();
  for (const line of snapshot.lines || []) {
    const resolved = findVariantInCatalog(products, line.variantId);
    assertVariantPurchasable(resolved?.product, resolved?.variant, line.quantity);
    const currentUnitPriceCents = parseTrustedUnitPriceCents(resolved.variant.price, snapshot.currency);
    if (currentUnitPriceCents !== Number(line.unitPriceCents)) {
      throw errorWithStatus('Trusted variant price changed before order creation.', 409, 'trusted_price_changed');
    }
  }
  return { ok: true, activeCatalogChanged: false };
}

function assertTrustedPricingSelfTest() {
  if (usdToCents('10.50') !== 1050) throw new Error('Money parser self-test failed.');
  const config = validateCheckoutConfig();
  if (config.currency !== 'USD') throw new Error('Checkout is currently configured for USD only.');
  const sample = { pricingSchemaVersion: 1, lines: [], totalCents: 100, currency: 'USD', pricedAt: '2026-01-01T00:00:00.000Z' };
  const hash = hashSnapshot(sample);
  if (!hash || hash !== hashSnapshot(sample)) throw new Error('Snapshot hashing self-test failed.');
  return true;
}

module.exports = {
  assertTrustedPricingSelfTest,
  getCheckoutConfig,
  hashSnapshot,
  normalizeCartIntent,
  normalizeVariantGid,
  priceCart,
  revalidateSnapshot,
  snapshotToCartItems,
  validateCheckoutConfig,
  verifySnapshotHash,
};
