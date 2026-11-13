const axios = require('axios');

function toVariantGid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('gid://shopify/ProductVariant/')) return raw;
  const numeric = raw.match(/(\d+)$/)?.[1];
  return numeric ? `gid://shopify/ProductVariant/${numeric}` : '';
}

function moneyToCents(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

async function fetchVariants(ids, includeQuantity = true) {
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim();
  const token = String(process.env.SHOPIFY_STOREFRONT_TOKEN || '').trim();
  const version = String(process.env.SHOPIFY_STOREFRONT_API_VERSION || process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04');
  if (!domain || !token) throw new Error('Shopify Storefront pricing is not configured');

  const quantityField = includeQuantity ? 'quantityAvailable' : '';
  const query = `query TrustedCheckout($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id title availableForSale ${quantityField}
        price { amount currencyCode }
        product { id title handle }
      }
    }
  }`;
  const response = await axios.post(
    `https://${domain}/api/${version}/graphql.json`,
    { query, variables: { ids } },
    {
      headers: { 'X-Shopify-Storefront-Access-Token': token, 'Content-Type': 'application/json' },
      timeout: 20000,
      maxContentLength: 2 * 1024 * 1024,
    }
  );
  if (response.data?.errors?.length) {
    const message = response.data.errors.map((e) => e.message).join('; ');
    if (includeQuantity && /quantityAvailable|inventory/i.test(message)) {
      return fetchVariants(ids, false);
    }
    throw new Error(`Shopify pricing error: ${message}`);
  }
  return response.data?.data?.nodes || [];
}

async function priceCart(cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0 || cartItems.length > 100) {
    throw Object.assign(new Error('Cart must contain 1 to 100 items'), { statusCode: 400 });
  }

  const requested = cartItems.map((item) => {
    const variantId = toVariantGid(item?.variantId || item?.id);
    const quantity = Number(item?.quantity);
    if (!variantId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw Object.assign(new Error('Every cart line needs a valid variant and quantity from 1 to 20'), { statusCode: 400 });
    }
    return { variantId, quantity };
  });

  const uniqueIds = [...new Set(requested.map((line) => line.variantId))];
  const nodes = await fetchVariants(uniqueIds);
  const byId = new Map(nodes.filter(Boolean).map((node) => [node.id, node]));
  let currency = '';
  let subtotalCents = 0;
  const lines = requested.map((line) => {
    const variant = byId.get(line.variantId);
    if (!variant) throw Object.assign(new Error('A cart variant no longer exists'), { statusCode: 409 });
    if (!variant.availableForSale) throw Object.assign(new Error(`${variant.product?.title || 'An item'} is sold out`), { statusCode: 409 });
    if (Number.isFinite(variant.quantityAvailable) && variant.quantityAvailable < line.quantity) {
      throw Object.assign(new Error(`Only ${variant.quantityAvailable} of ${variant.product?.title || 'an item'} remain`), { statusCode: 409 });
    }
    const unitCents = moneyToCents(variant.price?.amount);
    const lineCurrency = String(variant.price?.currencyCode || '').toUpperCase();
    if (unitCents == null || !lineCurrency) throw new Error('Shopify returned an invalid price');
    if (currency && lineCurrency !== currency) throw new Error('Cart contains mixed currencies');
    currency = lineCurrency;
    subtotalCents += unitCents * line.quantity;
    return {
      variantId: variant.id,
      quantity: line.quantity,
      unitPrice: (unitCents / 100).toFixed(2),
      title: variant.product?.title || variant.title || 'Product',
      variantTitle: variant.title || '',
      handle: variant.product?.handle || '',
    };
  });

  return { lines, currency, subtotalCents, subtotal: (subtotalCents / 100).toFixed(2) };
}

module.exports = { priceCart, moneyToCents, toVariantGid };
