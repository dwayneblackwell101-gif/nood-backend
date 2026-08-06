/**
 * Catalog routes — backend proxy for Shopify Storefront API queries that
 * the app can't do directly (menus, etc.).
 */

const express = require('express');
const axios = require('axios');

const router = express.Router();

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

const SHOPIFY_STOREFRONT_ENDPOINT =
  `https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;

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

  if (!SHOPIFY_STORE_DOMAIN || SHOPIFY_STORE_DOMAIN.includes('your-store')) {
    return res.status(503).json({ errors: [{ message: 'Shopify store not configured' }] });
  }

  if (!SHOPIFY_STOREFRONT_TOKEN) {
    return res.status(503).json({ errors: [{ message: 'Shopify Storefront token not configured' }] });
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