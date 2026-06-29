import AsyncStorage from '@react-native-async-storage/async-storage';
import { catalogFetch, fetchCatalogPath } from './catalog';
import { mapCatalogEdgesToProducts, type CatalogListProduct } from './catalog-product-mapper';
import {
  loadRecommendationSignals,
  type RecommendationSignalProduct,
  type RecommendationSignals,
} from './recommendation-signals';
import { resolveCustomerStorageKey } from './customer-storage';
import { getWishlistItems, getWishlistItemKey } from './wishlist-storage';

const ACCOUNT_RECOMMENDATIONS_CACHE_KEY = 'NOOD_ACCOUNT_RECOMMENDATIONS_V2';
const HOME_PRODUCTS_CACHE_KEY = 'NOOD_HOME_PRODUCTS_CACHE_V2';
const DISPLAY_LIMIT = 8;
const POOL_TARGET = 48;

const MIX_COLLECTION_HANDLES = [
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

const CATALOG_PRODUCTS_QUERY = `
  query AccountRecommendedProducts($first: Int!) {
    products(first: $first, sortKey: UPDATED_AT, reverse: true) {
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

const COLLECTION_PRODUCTS_QUERY = `
  query AccountCollectionProducts($handle: String!, $first: Int!) {
    collectionByHandle(handle: $handle) {
      products(first: $first, sortKey: MANUAL) {
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

export type AccountRecommendationResult = {
  products: CatalogListProduct[];
  status: 'ready' | 'cached' | 'error';
};

type RecommendationContext = {
  profileId: string;
  email?: string;
  isSignedIn?: boolean;
  cartItems?: any[];
  orders?: any[];
};

let accountPoolSnapshot: CatalogListProduct[] = [];

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
    const key = String(product.handle || product.id || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toSignalProduct(item: any): RecommendationSignalProduct | null {
  const handle = String(item?.handle || '').trim();
  if (!handle) return null;

  return {
    handle,
    id: item?.id ? String(item.id) : undefined,
    title: item?.title ? String(item.title) : undefined,
    tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
    productType: item?.productType ? String(item.productType) : undefined,
    collectionHandles: Array.isArray(item?.collectionHandles)
      ? item.collectionHandles.map(String)
      : item?.collectionHandle
        ? [String(item.collectionHandle)]
        : [],
    vendor: item?.brand || item?.vendor ? String(item.brand || item.vendor) : undefined,
  };
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
    console.log('Account recommendations home cache read error:', error);
  }

  return [];
}

async function readAccountRecommendationsCache(): Promise<CatalogListProduct[]> {
  try {
    const raw = await AsyncStorage.getItem(ACCOUNT_RECOMMENDATIONS_CACHE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as { products?: CatalogListProduct[] };
    if (Array.isArray(parsed?.products)) {
      return dedupeProducts(parsed.products.filter((product) => product?.handle));
    }
  } catch (error) {
    console.log('Account recommendations cache read error:', error);
  }

  return [];
}

async function persistAccountRecommendationsCache(products: CatalogListProduct[]) {
  try {
    await AsyncStorage.setItem(
      ACCOUNT_RECOMMENDATIONS_CACHE_KEY,
      JSON.stringify({
        products: products.slice(0, POOL_TARGET),
        savedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    console.log('Account recommendations cache write error:', error);
  }
}

async function fetchCatalogProductPool(mixKey: number): Promise<CatalogListProduct[]> {
  const json = await catalogFetch(CATALOG_PRODUCTS_QUERY, { first: POOL_TARGET }, { mixKey });
  return mapCatalogEdgesToProducts((json?.data as any)?.products?.edges || []);
}

async function fetchCollectionSamples(handles: string[]): Promise<CatalogListProduct[]> {
  const results = await Promise.all(
    handles.map(async (handle) => {
      try {
        const json = await catalogFetch(COLLECTION_PRODUCTS_QUERY, {
          handle,
          first: 6,
        });
        return mapCatalogEdgesToProducts(
          (json?.data as any)?.collectionByHandle?.products?.edges || []
        );
      } catch (error) {
        console.log(`Account recommendations collection fetch error (${handle}):`, error);
        return [];
      }
    })
  );

  return dedupeProducts(results.flat());
}

async function fetchSimilarProducts(productId: string): Promise<CatalogListProduct[]> {
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
    console.log('Account recommendations similar products error:', error);
    return [];
  }
}

async function buildProductPool(): Promise<CatalogListProduct[]> {
  if (accountPoolSnapshot.length >= DISPLAY_LIMIT) {
    return accountPoolSnapshot;
  }

  const [homeCache, accountCache] = await Promise.all([
    readHomeProductsCache(),
    readAccountRecommendationsCache(),
  ]);

  let pool = dedupeProducts([...homeCache, ...accountCache]);
  if (pool.length >= DISPLAY_LIMIT) {
    accountPoolSnapshot = pool;
    return pool;
  }

  const mixKey = Math.floor(Date.now() / (1000 * 60 * 15));
  try {
    const catalogProducts = await fetchCatalogProductPool(mixKey);
    pool = dedupeProducts([...pool, ...catalogProducts]);
  } catch (error) {
    console.log('Account recommendations catalog fetch error:', error);
  }

  if (pool.length < DISPLAY_LIMIT) {
    const collectionProducts = await fetchCollectionSamples(
      shuffleArray(MIX_COLLECTION_HANDLES).slice(0, 5)
    );
    pool = dedupeProducts([...pool, ...collectionProducts]);
  }

  if (pool.length) {
    accountPoolSnapshot = pool;
    void persistAccountRecommendationsCache(pool);
  }

  return pool;
}

function buildExcludedHandles(
  _signals: RecommendationSignals,
  cartItems: any[] = [],
  wishlistItems: any[] = []
) {
  const excluded = new Set<string>();

  cartItems.forEach((item) => {
    const handle = String(item?.handle || '').trim();
    if (handle) excluded.add(handle);
  });

  wishlistItems.forEach((item) => {
    const handle = getWishlistItemKey(item);
    if (handle) excluded.add(handle);
  });

  return excluded;
}

function buildInterestWeights(signals: RecommendationSignals) {
  const tags = new Map<string, number>();
  const productTypes = new Map<string, number>();
  const collections = new Map<string, number>();
  const vendors = new Map<string, number>();

  const applyProduct = (product: RecommendationSignalProduct, weight: number) => {
    (product.tags || []).forEach((tag) => {
      const key = String(tag || '').trim().toLowerCase();
      if (!key) return;
      tags.set(key, (tags.get(key) || 0) + weight);
    });

    const productType = String(product.productType || '').trim().toLowerCase();
    if (productType) {
      productTypes.set(productType, (productTypes.get(productType) || 0) + weight);
    }

    const vendor = String(product.vendor || '').trim().toLowerCase();
    if (vendor) {
      vendors.set(vendor, (vendors.get(vendor) || 0) + weight);
    }

    (product.collectionHandles || []).forEach((handle) => {
      const key = String(handle || '').trim().toLowerCase();
      if (!key) return;
      collections.set(key, (collections.get(key) || 0) + weight);
    });
  };

  signals.viewed.forEach((product, index) => applyProduct(product, 4 - Math.min(index, 3)));
  signals.wishlist.forEach((product) => applyProduct(product, 5));
  signals.cart.forEach((product) => applyProduct(product, 4));
  signals.purchased.forEach((product) => applyProduct(product, 6));
  signals.categories.forEach((handle) => {
    const key = String(handle || '').trim().toLowerCase();
    if (!key) return;
    collections.set(key, (collections.get(key) || 0) + 3);
  });

  return { tags, productTypes, collections, vendors };
}

function scoreProduct(
  product: CatalogListProduct,
  weights: ReturnType<typeof buildInterestWeights>
) {
  let score = 0;

  (product.tags || []).forEach((tag) => {
    score += weights.tags.get(String(tag).toLowerCase()) || 0;
  });

  const productType = String(product.productType || '').toLowerCase();
  if (productType) {
    score += weights.productTypes.get(productType) || 0;
  }

  const vendor = String(product.brand || '').toLowerCase();
  if (vendor) {
    score += weights.vendors.get(vendor) || 0;
  }

  (product.collectionHandles || []).forEach((handle) => {
    score += weights.collections.get(String(handle).toLowerCase()) || 0;
  });

  if (product.collectionHandle) {
    score += weights.collections.get(String(product.collectionHandle).toLowerCase()) || 0;
  }

  return score;
}

function pickDiverseFallback(pool: CatalogListProduct[], limit: number, excluded: Set<string>) {
  const available = pool.filter((product) => product.handle && !excluded.has(product.handle));
  const buckets = new Map<string, CatalogListProduct[]>();

  available.forEach((product) => {
    const bucketKey = String(product.collectionHandle || product.productType || 'mixed').toLowerCase();
    const bucket = buckets.get(bucketKey) || [];
    bucket.push(product);
    buckets.set(bucketKey, bucket);
  });

  const bucketKeys = shuffleArray(Array.from(buckets.keys()));
  const picks: CatalogListProduct[] = [];
  let guard = 0;

  while (picks.length < limit && guard < limit * bucketKeys.length * 2) {
    guard += 1;
    const bucketKey = bucketKeys[guard % bucketKeys.length];
    const bucket = buckets.get(bucketKey) || [];
    const candidate = bucket.shift();
    if (!candidate) continue;
    if (picks.some((item) => item.handle === candidate.handle)) continue;
    picks.push(candidate);
  }

  if (picks.length < limit) {
    shuffleArray(available).forEach((product) => {
      if (picks.length >= limit) return;
      if (picks.some((item) => item.handle === product.handle)) return;
      picks.push(product);
    });
  }

  return picks.slice(0, limit);
}

function personalizeProducts(
  pool: CatalogListProduct[],
  signals: RecommendationSignals,
  excluded: Set<string>,
  limit = DISPLAY_LIMIT
) {
  const available = pool.filter((product) => product.handle && !excluded.has(product.handle));
  if (!available.length) return [];

  const weights = buildInterestWeights(signals);
  const hasInterest =
    weights.tags.size > 0 ||
    weights.productTypes.size > 0 ||
    weights.collections.size > 0 ||
    weights.vendors.size > 0;

  if (!hasInterest) {
    return pickDiverseFallback(pool, limit, excluded);
  }

  const scored = available
    .map((product) => ({
      product,
      score: scoreProduct(product, weights) + Math.random() * 0.35,
    }))
    .sort((left, right) => right.score - left.score);

  const picks: CatalogListProduct[] = [];
  const usedCollections = new Set<string>();

  scored.forEach(({ product }) => {
    if (picks.length >= limit) return;
    if (picks.some((item) => item.handle === product.handle)) return;

    const collectionKey = String(product.collectionHandle || 'mixed').toLowerCase();
    if (usedCollections.has(collectionKey) && picks.length < limit - 2) {
      return;
    }

    picks.push(product);
    usedCollections.add(collectionKey);
  });

  if (picks.length < limit) {
    pickDiverseFallback(pool, limit, new Set([...excluded, ...picks.map((item) => item.handle)]))
      .forEach((product) => {
        if (picks.length >= limit) return;
        if (picks.some((item) => item.handle === product.handle)) return;
        picks.push(product);
      });
  }

  return picks.slice(0, limit);
}

function resolveWishlistCustomerKey(context: RecommendationContext): string {
  return resolveCustomerStorageKey(
    context.profileId || '',
    context.email || '',
    Boolean(context.isSignedIn)
  );
}

async function mergeRuntimeSignals(
  context: RecommendationContext,
  signals: RecommendationSignals
): Promise<RecommendationSignals> {
  const customerKey = resolveWishlistCustomerKey(context);
  const [wishlistItems] = await Promise.all([
    customerKey ? getWishlistItems(customerKey) : Promise.resolve([]),
  ]);

  const cartSignals = (context.cartItems || [])
    .map((item) => toSignalProduct(item))
    .filter((item): item is RecommendationSignalProduct => Boolean(item));

  const wishlistSignals = wishlistItems
    .map((item) => toSignalProduct(item))
    .filter((item): item is RecommendationSignalProduct => Boolean(item));

  const purchasedSignals = (context.orders || [])
    .flatMap((order) => (Array.isArray(order?.items) ? order.items : []))
    .map((item) => toSignalProduct(item))
    .filter((item): item is RecommendationSignalProduct => Boolean(item));

  return {
    ...signals,
    cart: dedupeSignalList([...cartSignals, ...signals.cart]),
    wishlist: dedupeSignalList([...wishlistSignals, ...signals.wishlist]),
    purchased: dedupeSignalList([...purchasedSignals, ...signals.purchased]),
  };
}

function dedupeSignalList(items: RecommendationSignalProduct[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.handle || seen.has(item.handle)) return false;
    seen.add(item.handle);
    return true;
  });
}

export async function loadAccountRecommendations(
  context: RecommendationContext
): Promise<AccountRecommendationResult> {
  const scope = {
    profileId: context.profileId || 'guest',
    email: context.email || '',
    isSignedIn: Boolean(context.isSignedIn),
  };

  try {
    const [signals, pool] = await Promise.all([
      loadRecommendationSignals(scope),
      buildProductPool(),
    ]);

    const mergedSignals = await mergeRuntimeSignals(context, signals);
    const wishlistCustomerKey = resolveWishlistCustomerKey(context);
    const excluded = buildExcludedHandles(
      mergedSignals,
      context.cartItems || [],
      wishlistCustomerKey ? await getWishlistItems(wishlistCustomerKey) : []
    );

    let personalized = personalizeProducts(pool, mergedSignals, excluded, DISPLAY_LIMIT);

    const seedProduct = mergedSignals.viewed[0] || mergedSignals.purchased[0] || mergedSignals.wishlist[0];
    if (seedProduct?.id && personalized.length < DISPLAY_LIMIT) {
      const similar = await fetchSimilarProducts(String(seedProduct.id));
      const boosted = dedupeProducts([
        ...personalizeProducts(
          similar,
          mergedSignals,
          excluded,
          DISPLAY_LIMIT
        ),
        ...personalized,
      ]).slice(0, DISPLAY_LIMIT);
      if (boosted.length) {
        personalized = boosted;
      }
    }

    if (!personalized.length && pool.length) {
      personalized = pickDiverseFallback(pool, DISPLAY_LIMIT, excluded);
    }

    if (!personalized.length) {
      const cachedFallback = dedupeProducts([
        ...(await readAccountRecommendationsCache()),
        ...(await readHomeProductsCache()),
        ...accountPoolSnapshot,
      ]);

      if (cachedFallback.length) {
        personalized = pickDiverseFallback(cachedFallback, DISPLAY_LIMIT, new Set());
      }
    }

    if (!personalized.length) {
      return { products: [], status: 'error' };
    }

    void persistAccountRecommendationsCache(personalized);

    return {
      products: personalized,
      status: pool.length ? 'ready' : 'cached',
    };
  } catch (error) {
    console.log('Account recommendations error:', error);

    const fallback = dedupeProducts([
      ...(await readAccountRecommendationsCache()),
      ...(await readHomeProductsCache()),
      ...accountPoolSnapshot,
    ]).slice(0, DISPLAY_LIMIT);

    if (fallback.length) {
      return { products: fallback, status: 'cached' };
    }

    return { products: [], status: 'error' };
  }
}