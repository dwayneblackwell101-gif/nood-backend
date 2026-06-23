import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchProductDetailFromBackend } from './catalog';
import { shopifyStorefrontGraphql } from './shopify';
import {
  buildProductDetailFromPreview,
  type ProductPreviewPayload,
} from './product-navigation';

const PRODUCT_DETAIL_CACHE_PREFIX = 'NOOD_PRODUCT_DETAIL_CACHE_V1';
const PRODUCT_DETAIL_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const PRODUCT_DETAIL_FETCH_CONCURRENCY = 5;

const productDetailMemoryCache = new Map<
  string,
  { product: any; savedAt: number }
>();

function normalizeHandle(handle: string) {
  return String(handle || '').trim();
}

function logProductSource(source: string, handle: string) {
  console.log(`[NOOD data] product source=${source} handle=${handle}`);
}

export function hasFullProductDetail(productData: any) {
  return Boolean(
    productData?.id &&
      productData?.handle &&
      (productData?.variants?.edges?.length || productData?.images?.edges?.length)
  );
}

function getDetailCacheKey(handle: string) {
  return `${PRODUCT_DETAIL_CACHE_PREFIX}:${normalizeHandle(handle)}`;
}

async function readLocalProductDetailCache(handle: string) {
  const key = normalizeHandle(handle);
  if (!key) return null;

  const memory = productDetailMemoryCache.get(key);
  if (memory && Date.now() - memory.savedAt < PRODUCT_DETAIL_CACHE_TTL_MS) {
    return memory.product;
  }

  try {
    const raw = await AsyncStorage.getItem(getDetailCacheKey(key));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { product?: any; savedAt?: string };
    if (!parsed?.product?.handle) return null;

    const savedAt = parsed.savedAt ? Date.parse(parsed.savedAt) : Date.now();
    if (Date.now() - savedAt > PRODUCT_DETAIL_CACHE_TTL_MS) {
      return null;
    }

    productDetailMemoryCache.set(key, { product: parsed.product, savedAt });
    return parsed.product;
  } catch {
    return null;
  }
}

async function writeLocalProductDetailCache(handle: string, product: any) {
  const key = normalizeHandle(handle);
  if (!key || !product) return;

  const savedAt = Date.now();
  productDetailMemoryCache.set(key, { product, savedAt });

  try {
    await AsyncStorage.setItem(
      getDetailCacheKey(key),
      JSON.stringify({
        product,
        savedAt: new Date(savedAt).toISOString(),
      })
    );
  } catch (error) {
    console.log('[NOOD data] product detail cache write failed', String(error));
  }
}

async function fetchShopifyProductDetailFallback(handle: string) {
  const productHandle = normalizeHandle(handle);
  if (!productHandle) return null;

  const query = `
    query ProductByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        featuredImage { url }
        images(first: 30) {
          edges { node { url altText } }
        }
        media(first: 30) {
          edges {
            node {
              __typename
              ... on MediaImage {
                id
                image { url altText }
              }
              ... on Video {
                id
                previewImage { url }
                sources { url mimeType }
              }
            }
          }
        }
        priceRange {
          minVariantPrice { amount currencyCode }
        }
        variants(first: 100) {
          edges {
            node {
              id
              title
              availableForSale
              price { amount currencyCode }
              selectedOptions { name value }
            }
          }
        }
      }
    }
  `;

  try {
    const json = await shopifyStorefrontGraphql(query, { handle: productHandle });
    return json?.data?.productByHandle ?? null;
  } catch (error) {
    console.log('[NOOD data] Shopify fallback failed', String(error));
    return null;
  }
}

export async function getProductFast(
  handle: string,
  preview?: ProductPreviewPayload | null
) {
  const productHandle = normalizeHandle(handle);
  if (!productHandle) return null;

  if (preview?.handle) {
    logProductSource('route-preview', productHandle);
    const previewProduct = buildProductDetailFromPreview(preview);
    void writeLocalProductDetailCache(productHandle, previewProduct);
    return previewProduct;
  }

  const cached = await readLocalProductDetailCache(productHandle);
  if (cached) {
    logProductSource('local-cache', productHandle);
  }

  let product: any = cached;

  try {
    const backendPayload = await fetchProductDetailFromBackend(productHandle);
    const backendProduct =
      backendPayload?.data?.product || backendPayload?.data?.productByHandle || null;

    if (backendProduct?.handle) {
      logProductSource('backend-cache', productHandle);
      product = backendProduct;
      await writeLocalProductDetailCache(productHandle, backendProduct);
    }
  } catch (backendError: any) {
    const message = String(backendError?.message || backendError || '');
    if (!message.includes('404')) {
      console.log('[NOOD data] backend detail failed', message);
    }
  }

  if (!hasFullProductDetail(product)) {
    console.log(`[NOOD data] Shopify fallback used handle=${productHandle}`);
    const fallback = await fetchShopifyProductDetailFallback(productHandle);
    if (fallback) {
      product = fallback;
      await writeLocalProductDetailCache(productHandle, fallback);
    }
  }

  return product;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current]);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function getProductsFastByHandles(
  handles: string[] = [],
  previews: Record<string, ProductPreviewPayload | undefined> = {}
) {
  const uniqueHandles = [...new Set(handles.map(normalizeHandle).filter(Boolean))];
  const productsByHandle = new Map<string, any>();

  if (!uniqueHandles.length) {
    return productsByHandle;
  }

  const fetched = await mapWithConcurrency(
    uniqueHandles,
    PRODUCT_DETAIL_FETCH_CONCURRENCY,
    async (productHandle) => {
      const product = await getProductFast(productHandle, previews[productHandle]);
      return { productHandle, product };
    }
  );

  fetched.forEach((entry) => {
    if (entry?.product) {
      productsByHandle.set(entry.productHandle, entry.product);
    }
  });

  console.log(
    `[NOOD data] products batch backend count=${productsByHandle.size} requested=${uniqueHandles.length}`
  );

  return productsByHandle;
}