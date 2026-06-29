import AsyncStorage from '@react-native-async-storage/async-storage';
import { catalogFetch, fetchCatalogPath } from './catalog';
import { mapCatalogEdgesToProducts, type CatalogListProduct } from './catalog-product-mapper';

const MIN_RECOMMENDATIONS = 6;
const MAX_RECOMMENDATIONS = 12;
const HOME_PRODUCTS_CACHE_KEY = 'NOOD_HOME_PRODUCTS_CACHE_V2';

const FALLBACK_COLLECTION_HANDLES = [
  'clothing',
  'women',
  'kids',
  'shoes',
  'electronics',
  'accessories',
  'beauty',
  'bags',
  'home',
  'kitchen',
];

const COLLECTION_PRODUCTS_QUERY = `
  query ProductPageCollectionProducts($handle: String!, $first: Int!) {
    collectionByHandle(handle: $handle) {
      products(first: $first, sortKey: BEST_SELLING) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            tags
            availableForSale
            featuredImage {
              url
            }
            priceRange {
              minVariantPrice {
                amount
                currencyCode
              }
            }
            compareAtPriceRange {
              maxVariantPrice {
                amount
                currencyCode
              }
            }
            collections(first: 10) {
              edges {
                node {
                  handle
                  title
                }
              }
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  title
                  availableForSale
                }
              }
            }
          }
        }
      }
    }
  }
`;

const CATALOG_PRODUCTS_QUERY = `
  query ProductPagePopularProducts($first: Int!) {
    products(first: $first, sortKey: BEST_SELLING, reverse: false) {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          tags
          availableForSale
          featuredImage {
            url
          }
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          compareAtPriceRange {
            maxVariantPrice {
              amount
              currencyCode
            }
          }
          collections(first: 10) {
            edges {
              node {
                handle
                title
              }
            }
          }
          variants(first: 1) {
            edges {
              node {
                id
                title
                availableForSale
              }
            }
          }
        }
      }
    }
  }
`;

export type ProductPageRecommendationContext = {
  productId: string;
  handle: string;
  title?: string;
  tags?: string[];
  productType?: string;
  collectionHandles?: string[];
  vendor?: string;
};

export type ProductPageRecommendationResult = {
  products: CatalogListProduct[];
  source: string;
};

function shuffleArray<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function dedupeProducts(products: CatalogListProduct[]) {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = String(product.handle || product.id || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function excludeCurrentProduct(products: CatalogListProduct[], currentHandle: string) {
  const normalized = String(currentHandle || '').trim().toLowerCase();
  return products.filter(
    (product) => String(product.handle || '').trim().toLowerCase() !== normalized
  );
}

function mergeRecommendations(
  current: CatalogListProduct[],
  incoming: CatalogListProduct[],
  currentHandle: string
) {
  return dedupeProducts(excludeCurrentProduct([...current, ...incoming], currentHandle));
}

async function fetchCollectionProducts(
  handle: string,
  first = 24
): Promise<CatalogListProduct[]> {
  const normalizedHandle = String(handle || '').trim();
  if (!normalizedHandle) return [];

  try {
    const json = await catalogFetch(COLLECTION_PRODUCTS_QUERY, {
      handle: normalizedHandle,
      first,
    });
    return mapCatalogEdgesToProducts(
      (json?.data as any)?.collectionByHandle?.products?.edges || []
    );
  } catch (error) {
    console.log(`[RECOMMENDATIONS_DEBUG] collection fetch error (${normalizedHandle})`, error);
    return [];
  }
}

async function fetchBackendRecommendations(productId: string): Promise<CatalogListProduct[]> {
  if (!productId) return [];

  try {
    const path = `/api/catalog/products/recommendations?productId=${encodeURIComponent(productId)}`;
    const json = await fetchCatalogPath(path);
    const recommendations = (json?.data as any)?.productRecommendations || [];
    return mapCatalogEdgesToProducts(
      recommendations.map((node: any) => ({
        node: {
          ...node,
          collections: node.collections || { edges: [] },
          variants: node.variants || { edges: [] },
          tags: node.tags || [],
        },
      }))
    );
  } catch (error) {
    console.log('[RECOMMENDATIONS_DEBUG] backend recommendations error', error);
    return [];
  }
}

async function fetchSearchProducts(query: string, limit = 24): Promise<CatalogListProduct[]> {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];

  try {
    const path = `/api/catalog/search?q=${encodeURIComponent(normalizedQuery)}&limit=${limit}&first=${limit}`;
    const json = await fetchCatalogPath(path);
    const edges =
      (json?.data as any)?.products?.edges ||
      (json as any)?.products?.edges ||
      [];
    return mapCatalogEdgesToProducts(edges);
  } catch (error) {
    console.log(`[RECOMMENDATIONS_DEBUG] search fetch error (${normalizedQuery})`, error);
    return [];
  }
}

async function fetchPopularProducts(limit = 32): Promise<CatalogListProduct[]> {
  try {
    const json = await catalogFetch(CATALOG_PRODUCTS_QUERY, { first: limit });
    return mapCatalogEdgesToProducts((json?.data as any)?.products?.edges || []);
  } catch (error) {
    console.log('[RECOMMENDATIONS_DEBUG] popular products fetch error', error);
    return [];
  }
}

async function readHomeProductsCache(): Promise<CatalogListProduct[]> {
  try {
    const raw = await AsyncStorage.getItem(HOME_PRODUCTS_CACHE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as { products?: CatalogListProduct[] } | CatalogListProduct[];
    if (Array.isArray(parsed)) {
      return dedupeProducts(parsed.filter((product) => product?.handle));
    }

    if (Array.isArray(parsed?.products)) {
      return dedupeProducts(parsed.products.filter((product) => product?.handle));
    }
  } catch (error) {
    console.log('[RECOMMENDATIONS_DEBUG] home cache read error', error);
  }

  return [];
}

function buildSearchQueries(context: ProductPageRecommendationContext) {
  const queries: string[] = [];
  const productType = String(context.productType || '').trim();
  const vendor = String(context.vendor || '').trim();
  const title = String(context.title || '').trim();

  if (productType) queries.push(productType);
  if (vendor) queries.push(vendor);

  (context.tags || []).forEach((tag) => {
    const normalized = String(tag || '').trim();
    if (normalized.length >= 3) queries.push(normalized);
  });

  if (title) {
    const titleTokens = title
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
      .slice(0, 2);
    queries.push(...titleTokens);
  }

  return [...new Set(queries)].slice(0, 5);
}

export async function loadProductPageRecommendations(
  context: ProductPageRecommendationContext
): Promise<ProductPageRecommendationResult> {
  const currentHandle = String(context.handle || '').trim();
  if (!currentHandle) {
    return { products: [], source: 'none' };
  }

  let merged: CatalogListProduct[] = [];
  const sources: string[] = [];

  const collectionHandles = [
    ...new Set((context.collectionHandles || []).map((handle) => String(handle || '').trim()).filter(Boolean)),
  ];

  for (const collectionHandle of collectionHandles) {
    const fromCollection = await fetchCollectionProducts(collectionHandle, 24);
    if (fromCollection.length) {
      sources.push(`collection:${collectionHandle}`);
      merged = mergeRecommendations(merged, fromCollection, currentHandle);
    }
    if (merged.length >= MIN_RECOMMENDATIONS) {
      return {
        products: merged.slice(0, MAX_RECOMMENDATIONS),
        source: sources.join('+'),
      };
    }
  }

  const backendRecommendations = await fetchBackendRecommendations(context.productId);
  if (backendRecommendations.length) {
    sources.push('backend-similar');
    merged = mergeRecommendations(merged, backendRecommendations, currentHandle);
  }
  if (merged.length >= MIN_RECOMMENDATIONS) {
    return {
      products: merged.slice(0, MAX_RECOMMENDATIONS),
      source: sources.join('+'),
    };
  }

  for (const query of buildSearchQueries(context)) {
    const fromSearch = await fetchSearchProducts(query, 20);
    if (fromSearch.length) {
      sources.push(`search:${query}`);
      merged = mergeRecommendations(merged, fromSearch, currentHandle);
    }
    if (merged.length >= MIN_RECOMMENDATIONS) break;
  }

  if (merged.length >= MIN_RECOMMENDATIONS) {
    return {
      products: merged.slice(0, MAX_RECOMMENDATIONS),
      source: sources.join('+'),
    };
  }

  const parentCollections = shuffleArray(
    FALLBACK_COLLECTION_HANDLES.filter((handle) => !collectionHandles.includes(handle))
  );

  for (const collectionHandle of parentCollections) {
    const fromCollection = await fetchCollectionProducts(collectionHandle, 16);
    if (fromCollection.length) {
      sources.push(`fallback-collection:${collectionHandle}`);
      merged = mergeRecommendations(merged, fromCollection, currentHandle);
    }
    if (merged.length >= MIN_RECOMMENDATIONS) break;
  }

  if (merged.length < MIN_RECOMMENDATIONS) {
    const cachedHome = await readHomeProductsCache();
    if (cachedHome.length) {
      sources.push('home-cache');
      merged = mergeRecommendations(merged, cachedHome, currentHandle);
    }
  }

  if (merged.length < MIN_RECOMMENDATIONS) {
    const popular = await fetchPopularProducts(32);
    if (popular.length) {
      sources.push('popular-catalog');
      merged = mergeRecommendations(merged, popular, currentHandle);
    }
  }

  return {
    products: merged.slice(0, MAX_RECOMMENDATIONS),
    source: sources.length ? sources.join('+') : 'none',
  };
}