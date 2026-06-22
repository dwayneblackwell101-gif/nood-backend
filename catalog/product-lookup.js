const { safeString } = require('./transform');

function decodeProductReference(rawValue) {
  let value = safeString(rawValue);
  if (!value) return '';

  try {
    value = decodeURIComponent(value);
  } catch {
    // keep raw value
  }

  try {
    value = decodeURIComponent(value);
  } catch {
    // keep single-decoded value
  }

  return value.trim();
}

function normalizeProductGid(value) {
  const raw = safeString(value);
  if (!raw) return '';

  if (raw.startsWith('gid://shopify/Product/')) {
    return raw;
  }

  if (/^\d+$/.test(raw)) {
    return `gid://shopify/Product/${raw}`;
  }

  const productMatch = raw.match(/Product\/(\d+)/i);
  if (productMatch?.[1]) {
    return `gid://shopify/Product/${productMatch[1]}`;
  }

  return '';
}

function normalizeVariantGid(value) {
  const raw = safeString(value);
  if (!raw) return '';

  if (raw.startsWith('gid://shopify/ProductVariant/')) {
    return raw;
  }

  if (/^\d+$/.test(raw)) {
    return `gid://shopify/ProductVariant/${raw}`;
  }

  const variantMatch = raw.match(/ProductVariant\/(\d+)/i);
  if (variantMatch?.[1]) {
    return `gid://shopify/ProductVariant/${variantMatch[1]}`;
  }

  return '';
}

function variantBelongsToProduct(product, variantGid) {
  if (!product || !variantGid) return false;
  const variants = product?.variants?.edges || [];
  return variants.some((edge) => safeString(edge?.node?.id) === variantGid);
}

async function findProductByVariantId(cache, variantGid) {
  if (!variantGid) return null;

  const allProducts = await cache.getAllProducts();
  return (
    allProducts.find((product) => variantBelongsToProduct(product, variantGid)) || null
  );
}

async function resolveProductFromReference(cache, rawReference) {
  const reference = decodeProductReference(rawReference);
  if (!reference) return null;

  const productGid = normalizeProductGid(reference);
  if (productGid) {
    const byId = await cache.getProductById(productGid);
    if (byId) return byId;
  }

  const variantGid = normalizeVariantGid(reference);
  if (variantGid) {
    const byVariant = await findProductByVariantId(cache, variantGid);
    if (byVariant) return byVariant;
  }

  const byHandle = await cache.getProduct(reference);
  if (byHandle) return byHandle;

  if (/^\d+$/.test(reference)) {
    const numericGid = `gid://shopify/Product/${reference}`;
    const byNumeric = await cache.getProductById(numericGid);
    if (byNumeric) return byNumeric;
  }

  return null;
}

module.exports = {
  decodeProductReference,
  resolveProductFromReference,
};