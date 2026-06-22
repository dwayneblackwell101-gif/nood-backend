const axios = require('axios');
const { safeString } = require('./transform');

function getShopifyConfig() {
  return {
    storeDomain: safeString(process.env.SHOPIFY_STORE_DOMAIN),
    adminToken: safeString(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN),
    adminApiVersion: safeString(process.env.SHOPIFY_ADMIN_API_VERSION, '2025-10'),
    storefrontToken: safeString(process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN),
    storefrontApiVersion: safeString(
      process.env.SHOPIFY_STOREFRONT_API_VERSION,
      process.env.SHOPIFY_ADMIN_API_VERSION || '2025-10'
    ),
    currencyCode: safeString(process.env.SHOPIFY_CURRENCY, 'TTD'),
  };
}

async function adminGraphql(query, variables = {}) {
  const config = getShopifyConfig();
  if (!config.storeDomain || !config.adminToken) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN.');
  }

  const response = await axios.post(
    `https://${config.storeDomain}/admin/api/${config.adminApiVersion}/graphql.json`,
    { query, variables },
    {
      headers: {
        'X-Shopify-Access-Token': config.adminToken,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  if (response.data?.errors?.length) {
    const error = new Error(response.data.errors[0]?.message || 'Shopify Admin GraphQL error');
    error.shopifyErrors = response.data.errors;
    throw error;
  }

  return response.data;
}

async function storefrontGraphql(query, variables = {}) {
  const config = getShopifyConfig();
  if (!config.storeDomain || !config.storefrontToken) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_STOREFRONT_ACCESS_TOKEN.');
  }

  const response = await axios.post(
    `https://${config.storeDomain}/api/${config.storefrontApiVersion}/graphql.json`,
    { query, variables },
    {
      headers: {
        'X-Shopify-Storefront-Access-Token': config.storefrontToken,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  if (response.data?.errors?.length) {
    const error = new Error(response.data.errors[0]?.message || 'Shopify Storefront GraphQL error');
    error.shopifyErrors = response.data.errors;
    throw error;
  }

  return response.data;
}

const ADMIN_PRODUCTS_PAGE_QUERY = `
  query CatalogProductsPage($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          vendor
          productType
          tags
          status
          updatedAt
          featuredImage {
            url
            altText
            width
            height
          }
          images(first: 30) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                inventoryQuantity
                inventoryPolicy
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          collections(first: 20) {
            edges {
              node {
                id
                handle
                title
              }
            }
          }
        }
      }
    }
  }
`;

const ADMIN_PRODUCT_BY_ID_QUERY = `
  query CatalogProductById($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      vendor
      productType
      tags
      status
      updatedAt
      featuredImage {
        url
        altText
        width
        height
      }
      images(first: 30) {
        edges {
          node {
            url
            altText
          }
        }
      }
      variants(first: 100) {
        edges {
          node {
            id
            title
            price
            compareAtPrice
            inventoryQuantity
            inventoryPolicy
            selectedOptions {
              name
              value
            }
          }
        }
      }
      collections(first: 20) {
        edges {
          node {
            id
            handle
            title
          }
        }
      }
    }
  }
`;

const ADMIN_COLLECTIONS_PAGE_QUERY = `
  query CatalogCollectionsPage($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          image {
            url
          }
          products(first: 250) {
            edges {
              node {
                handle
              }
            }
          }
        }
      }
    }
  }
`;

const STOREFRONT_MENU_QUERY = `
  query CatalogMenu($handle: String!) {
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
            image {
              url
              altText
            }
            products(first: 24) {
              nodes {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
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
              image {
                url
                altText
              }
              products(first: 24) {
                nodes {
                  id
                  title
                  handle
                  featuredImage {
                    url
                    altText
                  }
                  priceRange {
                    minVariantPrice {
                      amount
                      currencyCode
                    }
                  }
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
                image {
                  url
                  altText
                }
                products(first: 24) {
                  nodes {
                    id
                    title
                    handle
                    featuredImage {
                      url
                      altText
                    }
                    priceRange {
                      minVariantPrice {
                        amount
                        currencyCode
                      }
                    }
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

const STOREFRONT_COLLECTIONS_BROWSER_QUERY = `
  query CatalogCollectionsBrowser($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          image {
            url
          }
          products(first: 24) {
            edges {
              node {
                id
                handle
                title
                featuredImage {
                  url
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
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

const STOREFRONT_PRODUCT_DETAIL_QUERY = `
  query CatalogProductDetail($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      handle
      descriptionHtml
      vendor
      productType
      featuredImage {
        url
      }
      images(first: 30) {
        edges {
          node {
            url
            altText
          }
        }
      }
      media(first: 30) {
        edges {
          node {
            __typename
            ... on MediaImage {
              id
              image {
                url
                altText
              }
            }
            ... on Video {
              id
              previewImage {
                url
              }
              sources {
                url
                mimeType
              }
            }
          }
        }
      }
      priceRange {
        minVariantPrice {
          amount
          currencyCode
        }
      }
      variants(first: 100) {
        edges {
          node {
            id
            title
            availableForSale
            price {
              amount
              currencyCode
            }
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

const STOREFRONT_RECOMMENDATIONS_QUERY = `
  query CatalogRecommendations($productId: ID!) {
    productRecommendations(productId: $productId) {
      id
      title
      handle
      featuredImage {
        url
      }
      priceRange {
        minVariantPrice {
          amount
          currencyCode
        }
      }
    }
  }
`;

async function fetchAllAdminProducts() {
  const products = [];
  let after = null;
  let hasMore = true;
  let guard = 0;

  while (hasMore && guard < 200) {
    const payload = await adminGraphql(ADMIN_PRODUCTS_PAGE_QUERY, {
      first: 50,
      after,
    });
    const connection = payload?.data?.products;
    const edges = connection?.edges || [];
    products.push(...edges.map((edge) => edge.node).filter(Boolean));
    after = connection?.pageInfo?.endCursor || null;
    hasMore = Boolean(connection?.pageInfo?.hasNextPage && after);
    guard += 1;
  }

  return products;
}

async function fetchAdminProductById(id) {
  const payload = await adminGraphql(ADMIN_PRODUCT_BY_ID_QUERY, { id });
  return payload?.data?.product || null;
}

async function fetchAllAdminCollections() {
  const collections = [];
  let after = null;
  let hasMore = true;
  let guard = 0;

  while (hasMore && guard < 100) {
    const payload = await adminGraphql(ADMIN_COLLECTIONS_PAGE_QUERY, {
      first: 50,
      after,
    });
    const connection = payload?.data?.collections;
    const edges = connection?.edges || [];
    collections.push(...edges.map((edge) => edge.node).filter(Boolean));
    after = connection?.pageInfo?.endCursor || null;
    hasMore = Boolean(connection?.pageInfo?.hasNextPage && after);
    guard += 1;
  }

  return collections;
}

module.exports = {
  getShopifyConfig,
  adminGraphql,
  storefrontGraphql,
  fetchAllAdminProducts,
  fetchAdminProductById,
  fetchAllAdminCollections,
  STOREFRONT_MENU_QUERY,
  STOREFRONT_COLLECTIONS_BROWSER_QUERY,
  STOREFRONT_PRODUCT_DETAIL_QUERY,
  STOREFRONT_RECOMMENDATIONS_QUERY,
};