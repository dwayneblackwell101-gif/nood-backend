const axios = require('axios');
const { safeString } = require('./transform');

const DEFAULT_MAX_GRAPHQL_ATTEMPTS = 15;
const INTER_PAGE_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottledGraphqlPayload(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  return errors.some((entry) => String(entry?.message || '').toLowerCase().includes('throttl'));
}

function getRequestedQueryCost(payload, fallback = 50) {
  const cost = Number(payload?.extensions?.cost?.requestedQueryCost);
  return Number.isFinite(cost) && cost > 0 ? cost : fallback;
}

function getThrottleWaitMs(throttleStatus, requestedQueryCost = 50, attempt = 1) {
  const jitter = 2000 + Math.floor(Math.random() * 3001);

  if (!throttleStatus) {
    return Math.min(jitter * Math.pow(2, Math.max(0, attempt - 1)), 60000);
  }

  const available = Number(throttleStatus.currentlyAvailable ?? 0);
  const restoreRate = Number(throttleStatus.restoreRate ?? 50) || 50;
  const cost = Math.max(1, Number(requestedQueryCost ?? 50));

  if (available >= cost) {
    return Math.min(jitter * Math.pow(2, Math.max(0, attempt - 1)), 60000);
  }

  const deficit = Math.max(0, cost - available);
  const restoreMs = Math.ceil((deficit / restoreRate) * 1000) + 250;
  return Math.min(Math.max(restoreMs, jitter) * Math.pow(2, Math.max(0, attempt - 1)), 60000);
}

function getLowBucketWaitMs(throttleStatus, requestedQueryCost = 50) {
  if (!throttleStatus) return 0;

  const available = Number(throttleStatus.currentlyAvailable ?? 0);
  const restoreRate = Number(throttleStatus.restoreRate ?? 50) || 50;
  const cost = Math.max(1, Number(requestedQueryCost ?? 50));

  if (available >= cost * 2) {
    return 0;
  }

  const target = cost * 2;
  const deficit = Math.max(0, target - available);
  return Math.ceil((deficit / restoreRate) * 1000) + 150;
}

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

async function adminGraphql(query, variables = {}, options = {}) {
  const config = getShopifyConfig();
  const adminToken = safeString(options.accessToken) || config.adminToken;
  if (!config.storeDomain || !adminToken) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN or Shopify Admin API access token.');
  }

  const maxAttempts = Number(options.maxAttempts || DEFAULT_MAX_GRAPHQL_ATTEMPTS);
  let lastThrottleStatus = null;
  let throttleAttempt = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.interPageDelayMs && attempt === 1) {
      await sleep(options.interPageDelayMs);
    }

    const preWaitMs = getLowBucketWaitMs(lastThrottleStatus, options.requestedQueryCost || 50);
    if (preWaitMs > 0) {
      console.log(`[NOOD sync] throttled waiting ${preWaitMs} ms`);
      await sleep(preWaitMs);
    }

    let response;
    try {
      response = await axios.post(
        `https://${config.storeDomain}/admin/api/${config.adminApiVersion}/graphql.json`,
        { query, variables },
        {
          headers: {
            'X-Shopify-Access-Token': adminToken,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );
    } catch (error) {
      const retryable =
        error?.code === 'ECONNABORTED' ||
        error?.response?.status === 429 ||
        (error?.response?.status >= 500 && error?.response?.status < 600);

      if (retryable && attempt < maxAttempts) {
        throttleAttempt += 1;
        const waitMs = getThrottleWaitMs(lastThrottleStatus, options.requestedQueryCost || 50, throttleAttempt);
        console.log(`[NOOD sync] throttled waiting ${waitMs} ms`);
        await sleep(waitMs);
        continue;
      }

      throw error;
    }

    const payload = response.data;
    const throttleStatus = payload?.extensions?.cost?.throttleStatus || null;
    const requestedQueryCost = getRequestedQueryCost(payload, options.requestedQueryCost || 50);

    if (throttleStatus) {
      lastThrottleStatus = throttleStatus;
    }

    if (isThrottledGraphqlPayload(payload)) {
      throttleAttempt += 1;
      const waitMs = getThrottleWaitMs(throttleStatus || lastThrottleStatus, requestedQueryCost, throttleAttempt);
      console.log(`[NOOD sync] throttled waiting ${waitMs} ms`);
      await sleep(waitMs);
      continue;
    }

    if (payload?.errors?.length) {
      const error = new Error(payload.errors[0]?.message || 'Shopify Admin GraphQL error');
      error.shopifyErrors = payload.errors;
      throw error;
    }

    const postWaitMs = getLowBucketWaitMs(throttleStatus, requestedQueryCost);
    if (postWaitMs > 0) {
      await sleep(postWaitMs);
    }

    return payload;
  }

  const error = new Error('Throttled');
  error.shopifyErrors = [{ message: 'Throttled' }];
  throw error;
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

const ADMIN_COLLECTION_BY_ID_QUERY = `
  query CatalogCollectionById($id: ID!) {
    collection(id: $id) {
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
`;

const INVENTORY_ITEM_PRODUCT_QUERY = `
  query CatalogInventoryItemProduct($id: ID!) {
    inventoryItem(id: $id) {
      variant {
        product {
          id
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

function resolvePageSize(pageSize, fallback = 25) {
  const size = Number(pageSize);
  if (!Number.isFinite(size) || size < 1) {
    return fallback;
  }
  return Math.min(50, Math.max(1, Math.floor(size)));
}

async function fetchAdminProductsPage(after = null, options = {}) {
  const pageSize = resolvePageSize(options.pageSize, 25);
  const payload = await adminGraphql(
    ADMIN_PRODUCTS_PAGE_QUERY,
    {
      first: pageSize,
      after,
    },
    {
      interPageDelayMs: options.interPageDelayMs || 0,
      requestedQueryCost: 50,
    }
  );
  const connection = payload?.data?.products;
  const edges = connection?.edges || [];

  return {
    items: edges.map((edge) => edge.node).filter(Boolean),
    pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}

async function fetchAdminCollectionsPage(after = null, options = {}) {
  const pageSize = resolvePageSize(options.pageSize, 25);
  const payload = await adminGraphql(
    ADMIN_COLLECTIONS_PAGE_QUERY,
    {
      first: pageSize,
      after,
    },
    {
      interPageDelayMs: options.interPageDelayMs || 0,
      requestedQueryCost: 50,
    }
  );
  const connection = payload?.data?.collections;
  const edges = connection?.edges || [];

  return {
    items: edges.map((edge) => edge.node).filter(Boolean),
    pageInfo: connection?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}

async function fetchAllAdminProducts() {
  const products = [];
  let after = null;
  let hasMore = true;
  let guard = 0;

  while (hasMore && guard < 200) {
    const payload = await adminGraphql(
      ADMIN_PRODUCTS_PAGE_QUERY,
      {
        first: 50,
        after,
      },
      {
        interPageDelayMs: guard > 0 ? INTER_PAGE_DELAY_MS : 0,
        requestedQueryCost: 50,
      }
    );
    const connection = payload?.data?.products;
    const edges = connection?.edges || [];
    products.push(...edges.map((edge) => edge.node).filter(Boolean));
    after = connection?.pageInfo?.endCursor || null;
    hasMore = Boolean(connection?.pageInfo?.hasNextPage && after);
    guard += 1;

    console.log(`[NOOD sync] page synced products=${products.length}`);
  }

  return products;
}

async function fetchAdminProductById(id) {
  const payload = await adminGraphql(ADMIN_PRODUCT_BY_ID_QUERY, { id });
  return payload?.data?.product || null;
}

async function fetchAdminCollectionById(id) {
  const payload = await adminGraphql(ADMIN_COLLECTION_BY_ID_QUERY, { id });
  return payload?.data?.collection || null;
}

async function fetchProductGidByInventoryItemId(inventoryItemId) {
  const raw = safeString(inventoryItemId);
  if (!raw) {
    return '';
  }

  const gid = raw.startsWith('gid://')
    ? raw
    : `gid://shopify/InventoryItem/${raw.replace(/\D/g, '')}`;
  const payload = await adminGraphql(INVENTORY_ITEM_PRODUCT_QUERY, { id: gid });
  return safeString(payload?.data?.inventoryItem?.variant?.product?.id);
}

async function fetchAllAdminCollections() {
  const collections = [];
  let after = null;
  let hasMore = true;
  let guard = 0;

  while (hasMore && guard < 100) {
    const payload = await adminGraphql(
      ADMIN_COLLECTIONS_PAGE_QUERY,
      {
        first: 50,
        after,
      },
      {
        interPageDelayMs: guard > 0 ? INTER_PAGE_DELAY_MS : 0,
        requestedQueryCost: 50,
      }
    );
    const connection = payload?.data?.collections;
    const edges = connection?.edges || [];
    collections.push(...edges.map((edge) => edge.node).filter(Boolean));
    after = connection?.pageInfo?.endCursor || null;
    hasMore = Boolean(connection?.pageInfo?.hasNextPage && after);
    guard += 1;

    console.log(`[NOOD sync] page synced collections=${collections.length}`);
  }

  return collections;
}

module.exports = {
  getShopifyConfig,
  adminGraphql,
  storefrontGraphql,
  fetchAdminProductsPage,
  fetchAdminCollectionsPage,
  fetchAllAdminProducts,
  fetchAdminProductById,
  fetchAdminCollectionById,
  fetchProductGidByInventoryItemId,
  fetchAllAdminCollections,
  STOREFRONT_MENU_QUERY,
  STOREFRONT_COLLECTIONS_BROWSER_QUERY,
  STOREFRONT_PRODUCT_DETAIL_QUERY,
  STOREFRONT_RECOMMENDATIONS_QUERY,
};

module.exports.fetchAdminProductsPage = fetchAdminProductsPage;
module.exports.fetchAdminCollectionsPage = fetchAdminCollectionsPage;