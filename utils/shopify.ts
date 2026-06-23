export const SHOPIFY_API_VERSION = String(
  process.env.EXPO_PUBLIC_SHOPIFY_API_VERSION || '2026-04'
).trim();

export const SHOPIFY_STORE_DOMAIN = String(
  process.env.EXPO_PUBLIC_SHOPIFY_STORE_DOMAIN || 'noodcaribbean.myshopify.com'
).trim();

export const SHOPIFY_CUSTOMER_ACCOUNT_DOMAIN = String(
  process.env.EXPO_PUBLIC_SHOPIFY_CUSTOMER_ACCOUNT_DOMAIN || 'noodcaribbean.account.myshopify.com'
).trim();

export const SHOPIFY_STOREFRONT_TOKEN = String(
  process.env.EXPO_PUBLIC_SHOPIFY_STOREFRONT_TOKEN || '6d021813e286f637f88a52f9434102ef'
).trim();

export const SHOPIFY_STOREFRONT_ENDPOINT =
  `https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;

export function getShopifyStorefrontHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
  };
}

export async function fetchShopifyStorefront(
  query: string,
  variables?: Record<string, unknown>
) {
  return fetch(SHOPIFY_STOREFRONT_ENDPOINT, {
    method: 'POST',
    headers: getShopifyStorefrontHeaders(),
    body: JSON.stringify({ query, variables }),
  });
}

export async function shopifyStorefrontGraphql(
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await fetchShopifyStorefront(query, variables);
  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Shopify storefront failed with ${response.status}.`);
  }

  if (json?.errors?.length) {
    console.log('[NOOD product] Shopify storefront GraphQL errors');
  }

  return json;
}
