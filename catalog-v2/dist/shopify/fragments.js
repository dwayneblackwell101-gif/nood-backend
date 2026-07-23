"use strict";
/**
 * Storefront GraphQL Fragments and Queries for Catalog v2
 * These are used for real-time product detail hydration
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COLLECTION_PREVIEW_FRAGMENT = exports.PRODUCT_DETAIL_FRAGMENT = exports.STOREFRONT_RECOMMENDATIONS_QUERY = exports.STOREFRONT_MENU_QUERY = exports.STOREFRONT_COLLECTIONS_QUERY = exports.STOREFRONT_COLLECTION_BY_HANDLE_QUERY = exports.STOREFRONT_PRODUCT_BY_HANDLE_QUERY = void 0;
exports.STOREFRONT_PRODUCT_BY_HANDLE_QUERY = `
  query CatalogProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      handle
      descriptionHtml
      description
      vendor
      productType
      availableForSale
      featuredImage {
        url
        altText
        width
        height
      }
      images(first: 250) {
        edges {
          node {
            url
            altText
            width
            height
          }
        }
      }
      media(first: 250) {
        edges {
          node {
            __typename
            ... on MediaImage {
              id
              image {
                url
                altText
                width
                height
              }
            }
            ... on Video {
              id
              previewImage {
                url
                altText
              }
              sources {
                url
                mimeType
                format
                height
                width
              }
            }
            ... on ExternalVideo {
              id
              embedUrl
              originUrl
              previewImage {
                url
                altText
              }
            }
            ... on Model3d {
              id
              previewImage {
                url
                altText
              }
              sources {
                url
                mimeType
                format
                filesize
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
      variants(first: 250) {
        edges {
          node {
            id
            title
            availableForSale
            quantityAvailable
            currentlyNotInStock
            price {
              amount
              currencyCode
            }
            compareAtPrice {
              amount
              currencyCode
            }
            selectedOptions {
              name
              value
            }
            image {
              url
              altText
              width
              height
            }
          }
        }
      }
      seo {
        title
        description
      }
    }
  }
`;
exports.STOREFRONT_COLLECTION_BY_HANDLE_QUERY = `
  query CatalogCollectionByHandle($handle: String!, $first: Int!, $after: String) {
    collectionByHandle(handle: $handle) {
      id
      title
      handle
      descriptionHtml
      description
      image {
        url
        altText
        width
        height
      }
      products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          cursor
          node {
            id
            title
            handle
            featuredImage {
              url
              altText
              width
              height
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
      seo {
        title
        description
      }
    }
  }
`;
exports.STOREFRONT_COLLECTIONS_QUERY = `
  query CatalogCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      edges {
        cursor
        node {
          id
          title
          handle
          descriptionHtml
          description
          image {
            url
            altText
            width
            height
          }
          products(first: 24) {
            edges {
              node {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                  width
                  height
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
          seo {
            title
            description
          }
        }
      }
    }
  }
`;
exports.STOREFRONT_MENU_QUERY = `
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
exports.STOREFRONT_RECOMMENDATIONS_QUERY = `
  query CatalogRecommendations($productId: ID!) {
    productRecommendations(productId: $productId) {
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
`;
// Common fragments for reuse
exports.PRODUCT_DETAIL_FRAGMENT = `
  fragment ProductDetail on Product {
    id
    title
    handle
    descriptionHtml
    description
    vendor
    productType
    availableForSale
    featuredImage {
      url
      altText
      width
      height
    }
    images(first: 250) {
      edges {
        node {
          url
          altText
          width
          height
        }
      }
    }
    media(first: 250) {
      edges {
        node {
          __typename
          ... on MediaImage {
            id
            image {
              url
              altText
              width
              height
            }
          }
          ... on Video {
            id
            previewImage {
              url
              altText
            }
            sources {
              url
              mimeType
              format
              height
              width
            }
          }
          ... on ExternalVideo {
            id
            embedUrl
            originUrl
            previewImage {
              url
              altText
            }
          }
          ... on Model3d {
            id
            previewImage {
              url
              altText
            }
            sources {
              url
              mimeType
              format
              filesize
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
    variants(first: 250) {
      edges {
        node {
          id
          title
          availableForSale
          quantityAvailable
          currentlyNotInStock
          price {
            amount
            currencyCode
          }
          compareAtPrice {
            amount
            currencyCode
          }
          selectedOptions {
            name
            value
          }
          image {
            url
            altText
            width
            height
          }
        }
      }
    }
    seo {
      title
      description
    }
  }
`;
exports.COLLECTION_PREVIEW_FRAGMENT = `
  fragment CollectionPreview on Collection {
    id
    title
    handle
    descriptionHtml
    description
    image {
      url
      altText
      width
      height
    }
    seo {
      title
      description
    }
  }
`;
//# sourceMappingURL=fragments.js.map