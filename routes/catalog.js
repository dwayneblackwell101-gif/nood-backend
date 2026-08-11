/**
 * Catalog routes — backend proxy for Shopify Storefront API queries.
 *
 * The NOOD app is designed around these routes (see utils/catalog.ts
 * resolveCatalogPath / parseProductPath):
 *
 *   GET /api/catalog/products?limit=&first=&after=&sort=
 *       → products(first:, after:, sortKey:)
 *   GET /api/catalog/products/:handle
 *       → productByHandle(handle:)
 *   GET /api/catalog/products/recommendations?productId=
 *       → productRecommendations(productId:)  (returns [] when unavailable)
 *   GET /api/catalog/collections/:handle/products?limit=&first=&after=
 *       → collectionByHandle(handle:) { products(first:, after:) }
 *   GET /api/catalog/collections?limit=&first=&after=
 *       → collections(first:, after:)
 *   GET /api/catalog/search?q=&limit=&first=
 *       → products(first:, query:)
 *   GET /api/catalog/menus/:handle
 *       → menu(handle:)
 *   GET /api/catalog/version
 *       → { catalogVersion, catalogUpdatedAt, lastSyncAt }
 *
 * All routes call Shopify Storefront GraphQL directly (works on every plan).
 */

const express = require('express');
const axios = require('axios');

const router = express.Router();

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

const SHOPIFY_STOREFRONT_ENDPOINT =
  `https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;

// ─── Shared product fragments (must match the app's expectations) ──────

const PRODUCT_LIST_FRAGMENT = `
  id
  title
  handle
  vendor
  productType
  description
  tags
  availableForSale
  featuredImage { url width height altText }
  priceRange { minVariantPrice { amount currencyCode } }
  compareAtPriceRange { maxVariantPrice { amount currencyCode } }
  collections(first: 3) { edges { node { id handle title } } }
  variants(first: 10) {
    edges {
      node {
        id
        title
        availableForSale
        quantityAvailable
        price { amount currencyCode }
        selectedOptions { name value }
        image { url altText }
      }
    }
  }
`;

const PRODUCT_DETAIL_FRAGMENT = `
  id
  title
  handle
  descriptionHtml
  vendor
  productType
  tags
  featuredImage { url width height altText }
  images(first: 30) { edges { node { url altText } } }
  media(first: 30) {
    edges {
      node {
        ... on MediaImage {
          __typename
          id
          image { url altText }
        }
      }
    }
  }
  priceRange { minVariantPrice { amount currencyCode } }
  compareAtPriceRange { maxVariantPrice { amount currencyCode } }
  variants(first: 250) {
    edges {
      node {
        id
        title
        availableForSale
        quantityAvailable
        price { amount currencyCode }
        selectedOptions { name value }
        image { url altText }
      }
    }
  }
`;

const PRODUCTS_LIST_QUERY = `
  query NoodCatalogProducts($first: Int!, $after: String, $sortKey: ProductSortKeys, $query: String) {
    products(first: $first, after: $after, sortKey: $sortKey, reverse: true, query: $query) {
      edges { node { ${PRODUCT_LIST_FRAGMENT} } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCT_DETAIL_QUERY = `
  query NoodCatalogProductDetail($handle: String!) {
    productByHandle(handle: $handle) {
      ${PRODUCT_DETAIL_FRAGMENT}
    }
  }
`;

const RECOMMENDATIONS_QUERY = `
  query NoodCatalogRecommendations($productId: ID!) {
    productRecommendations(productId: $productId) {
      ${PRODUCT_LIST_FRAGMENT}
    }
  }
`;

const COLLECTION_PRODUCTS_QUERY = `
  query NoodCatalogCollectionProducts($handle: String!, $first: Int!, $after: String) {
    collectionByHandle(handle: $handle) {
      title
      handle
      products(first: $first, after: $after) {
        edges { node { ${PRODUCT_LIST_FRAGMENT} } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const COLLECTIONS_LIST_QUERY = `
  query NoodCatalogCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          image { url altText }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SEARCH_QUERY = `
  query NoodCatalogSearch($first: Int!, $query: String!) {
    products(first: $first, query: $query) {
      edges { node { ${PRODUCT_LIST_FRAGMENT} } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ─── Helpers ────────────────────────────────────────────────────────────

function storefrontConfigured() {
  return Boolean(
    SHOPIFY_STORE_DOMAIN &&
      !SHOPIFY_STORE_DOMAIN.includes('your-store') &&
      SHOPIFY_STOREFRONT_TOKEN
  );
}

async function storefrontGraphql(query, variables) {
  const response = await axios.post(
    SHOPIFY_STOREFRONT_ENDPOINT,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
      },
      timeout: 12000,
    }
  );
  const json = response?.data || {};
  if (json?.errors?.length) {
    const err = new Error(json.errors[0]?.message || 'Shopify Storefront error');
    err.status = 400;
    throw err;
  }
  return json;
}

function storefrontUnavailable(res) {
  return res
    .status(503)
    .json({ errors: [{ message: 'Shopify Storefront not configured' }] });
}

function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 250);
}

// ─── Product list ───────────────────────────────────────────────────────

/**
 * GET /api/catalog/products?limit=&first=&after=&sort=&mixKey=
 */
router.get('/api/catalog/products', async (req, res) => {
  if (!storefrontConfigured()) return storefrontUnavailable(res);

  const first = clampLimit(req.query.first || req.query.limit, 50);
  const after = req.query.after ? String(req.query.after) : undefined;
  const sortRaw = String(req.query.sort || 'updated').replace(/[\s_-]/g, '').toLowerCase();
  const sortMap = {
    updated: 'UPDATED_AT',
    updatedat: 'UPDATED_AT',
    created: 'CREATED_AT',
    createdat: 'CREATED_AT',
    title: 'TITLE',
    best: 'BEST_SELLING',
    bestselling: 'BEST_SELLING',
    price: 'PRICE',
    manual: 'MANUAL',
  };
  const sortKey = sortMap[sortRaw] || 'UPDATED_AT';

  try {
    const json = await storefrontGraphql(PRODUCTS_LIST_QUERY, { first, after, sortKey });
    return res.json({ success: true, data: json.data, source: 'shopify' });
  } catch (error) {
    console.error('[CATALOG] products error:', error.message);
    return res.status(error?.status || 500).json({
      errors: [{ message: error.message }],
    });
  }
});

// ─── Product detail ─────────────────────────────────────────────────────

// ─── Recommendations (MUST be registered BEFORE /products/:handle) ──────

/**
 * GET /api/catalog/products/recommendations?productId=
 * Returns [] gracefully when Shopify has no recommendations.
 */
router.get('/api/catalog/products/recommendations', async (req, res) => {
  const productId = String(req.query.productId || '').trim();
  if (!productId) {
    return res.json({ success: true, data: { productRecommendations: [] }, source: 'shopify' });
  }

  if (!storefrontConfigured()) return storefrontUnavailable(res);

  try {
    const json = await storefrontGraphql(RECOMMENDATIONS_QUERY, { productId });
    const recommendations = json?.data?.productRecommendations || [];
    return res.json({
      success: true,
      data: { productRecommendations: recommendations },
      source: 'shopify',
    });
  } catch (error) {
    console.error('[CATALOG] recommendations error:', error.message);
    return res.json({
      success: true,
      data: { productRecommendations: [] },
      source: 'shopify',
    });
  }
});

/**
 * GET /api/catalog/products/:handle
 */
router.get('/api/catalog/products/:handle', async (req, res) => {
  if (!storefrontConfigured()) return storefrontUnavailable(res);

  const handle = String(req.params.handle || '').trim();
  if (!handle) {
    return res.status(400).json({ errors: [{ message: 'handle required' }] });
  }

  try {
    const json = await storefrontGraphql(PRODUCT_DETAIL_QUERY, { handle });
    return res.json({ success: true, data: json.data, source: 'shopify' });
  } catch (error) {
    console.error('[CATALOG] product detail error:', error.message);
    return res.status(error?.status || 500).json({
      errors: [{ message: error.message }],
    });
  }
});

// ─── Collection products ────────────────────────────────────────────────

/**
 * GET /api/catalog/collections/:handle/products?limit=&first=&after=
 */
router.get('/api/catalog/collections/:handle/products', async (req, res) => {
  if (!storefrontConfigured()) return storefrontUnavailable(res);

  const handle = String(req.params.handle || '').trim();
  if (!handle) {
    return res.status(400).json({ errors: [{ message: 'handle required' }] });
  }

  const first = clampLimit(req.query.first || req.query.limit, 60);
  const after = req.query.after ? String(req.query.after) : undefined;

  try {
    const json = await storefrontGraphql(COLLECTION_PRODUCTS_QUERY, { handle, first, after });
    return res.json({ success: true, data: json.data, source: 'shopify' });
  } catch (error) {
    console.error('[CATALOG] collection products error:', error.message);
    return res.status(error?.status || 500).json({
      errors: [{ message: error.message }],
    });
  }
});

// ─── Collections list ───────────────────────────────────────────────────

/**
 * GET /api/catalog/collections?limit=&first=&after=
 */
router.get('/api/catalog/collections', async (req, res) => {
  if (!storefrontConfigured()) return storefrontUnavailable(res);

  const first = clampLimit(req.query.first || req.query.limit, 250);
  const after = req.query.after ? String(req.query.after) : undefined;

  try {
    const json = await storefrontGraphql(COLLECTIONS_LIST_QUERY, { first, after });
    return res.json({ success: true, data: json.data, source: 'shopify' });
  } catch (error) {
    console.error('[CATALOG] collections error:', error.message);
    return res.status(error?.status || 500).json({
      errors: [{ message: error.message }],
    });
  }
});

// ─── Search ─────────────────────────────────────────────────────────────

/**
 * GET /api/catalog/search?q=&limit=&first=
 */
router.get('/api/catalog/search', async (req, res) => {
  if (!storefrontConfigured()) return storefrontUnavailable(res);

  const q = String(req.query.q || '').trim();
  const first = clampLimit(req.query.first || req.query.limit, 50);
  const query = q ? `title:*${q}* OR tag:*${q}*` : '';

  try {
    const json = await storefrontGraphql(SEARCH_QUERY, { first, query });
    return res.json({ success: true, data: json.data, source: 'shopify' });
  } catch (error) {
    console.error('[CATALOG] search error:', error.message);
    return res.status(error?.status || 500).json({
      errors: [{ message: error.message }],
    });
  }
});

// ─── Version ────────────────────────────────────────────────────────────

/**
 * GET /api/catalog/version
 * Returns a stable catalog version so the app can invalidate local caches.
 */
router.get('/api/catalog/version', (req, res) => {
  // No external dependency: version is derived from the current deploy time.
  const catalogVersion = Number(process.env.CATALOG_VERSION) || Math.floor(Date.now() / 1000);
  return res.json({
    success: true,
    catalogVersion,
    catalogUpdatedAt: new Date().toISOString(),
    lastSyncAt: new Date().toISOString(),
  });
});

// ─── Menus (existing) ───────────────────────────────────────────────────

/** Fetch a Shopify navigation menu (with nested items + collection resources + preview products). */
const MENU_QUERY = `
  query NoodCategoriesMenu($handle: String!) {
    menu(handle: $handle) {
      title
      items {
        title
        url
        type
        resource {
          ... on Collection {
            id
            handle
            title
            image { url altText }
            products(first: 3) {
              nodes {
                id
                title
                handle
                featuredImage { url altText }
                images(first: 1) { edges { node { url altText } } }
                priceRange { minVariantPrice { amount currencyCode } }
              }
            }
          }
        }
        items {
          title
          url
          type
          resource {
            ... on Collection {
              id
              handle
              title
              image { url altText }
              products(first: 3) {
                nodes {
                  id
                  title
                  handle
                  featuredImage { url altText }
                  images(first: 1) { edges { node { url altText } } }
                  priceRange { minVariantPrice { amount currencyCode } }
                }
              }
            }
          }
          items {
            title
            url
            type
            resource {
              ... on Collection {
                id
                handle
                title
                image { url altText }
                products(first: 3) {
                  nodes {
                    id
                    title
                    handle
                    featuredImage { url altText }
                    images(first: 1) { edges { node { url altText } } }
                    priceRange { minVariantPrice { amount currencyCode } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** GET /api/catalog/menus/:handle — return a Shopify menu as JSON. */
router.get('/api/catalog/menus/:handle', async (req, res) => {
  const handle = String(req.params.handle || '').trim();
  if (!handle) {
    return res.status(400).json({ errors: [{ message: 'menu handle required' }] });
  }

  if (!storefrontConfigured()) {
    return storefrontUnavailable(res);
  }

  try {
    const response = await axios.post(
      SHOPIFY_STOREFRONT_ENDPOINT,
      {
        query: MENU_QUERY,
        variables: { handle },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
        },
        timeout: 12000,
      }
    );

    const json = response?.data || {};

    if (json?.errors?.length) {
      return res.status(400).json(json);
    }

    return res.json(json);
  } catch (error) {
    console.error('[CATALOG] menu fetch error:', error.message);
    return res.status(500).json({
      errors: [{ message: `Failed to fetch menu: ${error.message}` }],
    });
  }
});

module.exports = { router };
