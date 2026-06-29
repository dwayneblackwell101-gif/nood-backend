import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchProductDetailFromBackend } from './catalog';
import { shopifyStorefrontGraphql } from './shopify';
import {
  buildProductDetailFromPreview,
  productHasRenderableVariants,
  type ProductPreviewPayload,
} from './product-navigation';
import {
  mergeVariantImagesIntoProduct,
  productNeedsVariantImageEnrichment,
} from './product-variant-images';
import { logProductStockState } from './product-availability';
import { emergencyPruneCatalogStorage, isStorageFullError } from './catalog-cache';

export const PRODUCT_DETAIL_CACHE_PREFIX = 'NOOD_PRODUCT_DETAIL_CACHE_V1';
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

function logProductLoadSpeed(message: string) {
  console.log(`[PRODUCT LOAD SPEED] ${message}`);
}

function getProductVariantNodes(product: any) {
  return (product?.variants?.edges || []).map((edge: any) => edge?.node).filter(Boolean);
}

export function productVariantCount(product: any) {
  return getProductVariantNodes(product).length;
}

export function productVariantImagesReady(product: any) {
  const variants = getProductVariantNodes(product);
  if (!variants.length) return false;
  return variants.some((variant: any) => String(variant?.image?.url || '').trim());
}

function getProductCacheAgeMs(product: any) {
  const value = Number(product?.__detailCacheSavedAt || 0);
  return Number.isFinite(value) && value > 0 ? Date.now() - value : Number.POSITIVE_INFINITY;
}

function getEnrichmentSkipReason(product: any, force = false) {
  if (force) return '';
  if (!product?.handle) return 'missing-handle';
  const variants = getProductVariantNodes(product);
  if (!variants.length) return '';
  if (!productNeedsVariantImageEnrichment(product)) return 'variant-images-ready';
  return '';
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

export function readProductDetailMemoryCacheSync(handle: string) {
  const key = normalizeHandle(handle);
  if (!key) return null;
  return productDetailMemoryCache.get(key)?.product || null;
}

export function mergeStrongerProductDetail(previewProduct: any, cachedProduct: any) {
  if (!previewProduct && !cachedProduct) return null;
  if (!cachedProduct) return previewProduct;
  if (!previewProduct) return cachedProduct;

  const previewHasVariants = productHasRenderableVariants(previewProduct);
  const cachedHasVariants = productHasRenderableVariants(cachedProduct);

  if (cachedHasVariants && !previewHasVariants) {
    return {
      ...cachedProduct,
      featuredImage: previewProduct.featuredImage?.url
        ? previewProduct.featuredImage
        : cachedProduct.featuredImage,
      images:
        (previewProduct.images?.edges?.length || 0) > (cachedProduct.images?.edges?.length || 0)
          ? previewProduct.images
          : cachedProduct.images,
    };
  }

  if (previewHasVariants) {
    return previewProduct;
  }

  return cachedHasVariants ? cachedProduct : previewProduct;
}

export function resolveInstantProductDetail(
  handle: string,
  preview?: ProductPreviewPayload | null
) {
  const productHandle = normalizeHandle(handle);
  if (!productHandle) return null;

  const previewProduct = preview?.handle ? buildProductDetailFromPreview(preview) : null;
  const cachedProduct = readProductDetailMemoryCacheSync(productHandle);
  return mergeStrongerProductDetail(previewProduct, cachedProduct);
}

const prefetchDetailHandles = new Set<string>();

export function prefetchProductDetailOnPress(handle: string) {
  const productHandle = normalizeHandle(handle);
  if (!productHandle || prefetchDetailHandles.has(productHandle)) return;

  const cached = readProductDetailMemoryCacheSync(productHandle);
  if (cached && productHasRenderableVariants(cached)) return;

  prefetchDetailHandles.add(productHandle);
  void refreshProductDetailFromBackend(productHandle)
    .catch(() => null)
    .finally(() => {
      prefetchDetailHandles.delete(productHandle);
    });
}

export async function readProductDetailCache(handle: string) {
  const key = normalizeHandle(handle);
  if (!key) return null;

  const memory = productDetailMemoryCache.get(key);
  if (memory) {
    return memory.product;
  }

  try {
    const raw = await AsyncStorage.getItem(getDetailCacheKey(key));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { product?: any; savedAt?: string };
    if (!parsed?.product?.handle) return null;

    const savedAt = parsed.savedAt ? Date.parse(parsed.savedAt) : Date.now();
    const productWithCacheMeta = {
      ...parsed.product,
      __detailCacheSavedAt: savedAt,
    };
    productDetailMemoryCache.set(key, { product: productWithCacheMeta, savedAt });
    return productWithCacheMeta;
  } catch {
    return null;
  }
}

async function writeLocalProductDetailCache(handle: string, product: any) {
  const key = normalizeHandle(handle);
  if (!key || !product) return;

  const savedAt = Date.now();
  const productWithCacheMeta = {
    ...product,
    __detailCacheSavedAt: savedAt,
  };
  productDetailMemoryCache.set(key, { product: productWithCacheMeta, savedAt });

  const payload = JSON.stringify({
    product: productWithCacheMeta,
    savedAt: new Date(savedAt).toISOString(),
  });

  try {
    await AsyncStorage.setItem(getDetailCacheKey(key), payload);
  } catch (error) {
    if (!isStorageFullError(error)) {
      console.log('[NOOD data] product detail cache write failed', String(error));
      return;
    }

    try {
      await emergencyPruneCatalogStorage({ aggressive: true });
      await AsyncStorage.setItem(getDetailCacheKey(key), payload);
    } catch (retryError) {
      console.log('[NOOD data] product detail cache write failed after cleanup', String(retryError));
    }
  }
}

async function fetchShopifyVariantImages(handle: string) {
  const productHandle = normalizeHandle(handle);
  if (!productHandle) return [];

  const query = `
    query ProductVariantImages($handle: String!, $after: String) {
      productByHandle(handle: $handle) {
        title
        variants(first: 250, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            availableForSale
            selectedOptions {
              name
              value
            }
            image {
              url
              altText
            }
            price {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

  try {
    const variants: any[] = [];
    let after: string | null = null;
    let hasNextPage = true;
    let productTitle = '';

    while (hasNextPage) {
      const json = await shopifyStorefrontGraphql(query, { handle: productHandle, after });
      const product = json?.data?.productByHandle;
      productTitle = product?.title ? String(product.title) : productTitle;
      const connection = product?.variants;
      const nodes = Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : [];

      variants.push(...nodes);

      hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
      after = connection?.pageInfo?.endCursor || null;

      if (!after && hasNextPage) {
        break;
      }
    }

    if (__DEV__ && productTitle.toLowerCase().includes('new balance')) {
      variants.forEach((variant) => {
        console.log('[PRODUCT VARIANT IMAGE RAW]', {
          id: variant?.id || '',
          selectedOptions: variant?.selectedOptions || [],
          image: variant?.image || null,
        });
      });
    }

    return variants;
  } catch (error) {
    console.log('[NOOD data] variant image enrichment failed', String(error));
    return [];
  }
}

async function enrichProductVariantImages(product: any, force = false) {
  if (!product?.handle || !product?.variants?.edges?.length) {
    logProductLoadSpeed('enrichment skipped reason=missing-product-or-variants');
    return product;
  }

  const skipReason = getEnrichmentSkipReason(product, force);
  if (skipReason) {
    logProductLoadSpeed(`enrichment skipped reason=${skipReason}`);
    return product;
  }

  const startedAt = Date.now();
  logProductLoadSpeed('enrichment started');

  const storefrontVariants = await fetchShopifyVariantImages(product.handle);
  const merged = mergeVariantImagesIntoProduct(product, storefrontVariants);

  if (force || merged !== product) {
    await writeLocalProductDetailCache(product.handle, merged);
  }

  logProductLoadSpeed(`enrichment completed ms=${Date.now() - startedAt}`);
  return merged;
}

export async function refreshProductVariantImages(product: any, force = false) {
  return enrichProductVariantImages(product, force);
}

export async function refreshProductDetailFromBackend(productHandle: string, currentProduct?: any) {
  const fetchStartedAt = Date.now();
  console.log('[NOOD product] backend fetch start', { handle: productHandle });
  try {
    const backendPayload = await fetchProductDetailFromBackend(productHandle);
    const backendProduct =
      backendPayload?.data?.product || backendPayload?.data?.productByHandle || null;

    if (!backendProduct?.handle) {
      return currentProduct || null;
    }

    logProductSource('backend-cache', productHandle);
    logProductLoadSpeed('source=backend-cache');
    const nextProduct =
      currentProduct &&
      productVariantImagesReady(currentProduct) &&
      !productVariantImagesReady(backendProduct)
        ? mergeVariantImagesIntoProduct(backendProduct, getProductVariantNodes(currentProduct))
        : backendProduct;

    logProductLoadSpeed(`variantImagesReady ${productVariantImagesReady(nextProduct)}`);
    await writeLocalProductDetailCache(productHandle, nextProduct);
    console.log('[NOOD product] backend fetch end', {
      handle: productHandle,
      durationMs: Date.now() - fetchStartedAt,
      source: 'backend-cache',
    });
    return nextProduct;
  } catch (backendError: any) {
    console.log('[NOOD product] backend fetch end', {
      handle: productHandle,
      durationMs: Date.now() - fetchStartedAt,
      failed: true,
      error: String(backendError?.message || backendError),
    });
    const message = String(backendError?.message || backendError || '');
    if (!message.includes('404')) {
      console.log('[NOOD data] backend detail failed', message);
    }
    return currentProduct || null;
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
        variants(first: 250) {
          nodes {
            id
            title
            availableForSale
            selectedOptions {
              name
              value
            }
            image {
              url
              altText
            }
            price {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

  try {
    const json = await shopifyStorefrontGraphql(query, { handle: productHandle });
    const product = json?.data?.productByHandle ?? null;
    if (product?.variants?.nodes) {
      product.variants = {
        ...product.variants,
        edges: product.variants.nodes.map((node: any) => ({ node })),
      };
    }
    return product;
  } catch (error) {
    console.log('[NOOD data] Shopify fallback failed', String(error));
    return null;
  }
}

export async function clearProductDetailCache(handle?: string) {
  const productHandle = normalizeHandle(handle || '');
  if (productHandle) {
    productDetailMemoryCache.delete(productHandle);
    try {
      await AsyncStorage.removeItem(getDetailCacheKey(productHandle));
    } catch {
      // ignore
    }
    return;
  }

  productDetailMemoryCache.clear();
  try {
    const keys = await AsyncStorage.getAllKeys();
    const detailKeys = keys.filter((key) => key.startsWith(`${PRODUCT_DETAIL_CACHE_PREFIX}:`));
    if (detailKeys.length) {
      await AsyncStorage.multiRemove(detailKeys);
    }
  } catch {
    // ignore
  }
}

export async function getProductFast(
  handle: string,
  preview?: ProductPreviewPayload | null
) {
  const productHandle = normalizeHandle(handle);
  if (!productHandle) return null;

  const previewProduct = preview?.handle ? buildProductDetailFromPreview(preview) : null;
  const previewHasVariants = productHasRenderableVariants(previewProduct);
  const cached = await readProductDetailCache(productHandle);

  if (previewProduct) {
    if (!previewHasVariants && cached && productHasRenderableVariants(cached)) {
      logProductSource('detail-cache', productHandle);
      logProductStockState(cached, 'cache');
      void (async () => {
        const backendProduct = await refreshProductDetailFromBackend(productHandle, cached);
        if (backendProduct && hasFullProductDetail(backendProduct)) {
          await writeLocalProductDetailCache(productHandle, backendProduct);
          logProductStockState(backendProduct, 'backend');
        }
      })();
      return cached;
    }

    logProductSource('route-preview', productHandle);
    logProductLoadSpeed('source=route-preview');
    logProductStockState(previewProduct, 'preview');
    console.log('[NOOD product] cached product used', {
      handle: productHandle,
      source: 'route-preview',
      hasVariants: previewHasVariants,
    });

    if (!previewHasVariants) {
      void (async () => {
        const backendProduct = await refreshProductDetailFromBackend(productHandle, previewProduct);
        if (backendProduct && hasFullProductDetail(backendProduct)) {
          await writeLocalProductDetailCache(productHandle, backendProduct);
          logProductStockState(backendProduct, 'backend');
        }
      })();
    }

    return previewProduct;
  }

  if (cached) {
    logProductSource('local-cache', productHandle);
    logProductLoadSpeed('source=local-cache');
    console.log('[NOOD product] cached product used', {
      handle: productHandle,
      source: 'detail-cache',
    });
    logProductLoadSpeed(`variantImagesReady ${productVariantImagesReady(cached)}`);
    const cacheStale = getProductCacheAgeMs(cached) > PRODUCT_DETAIL_CACHE_TTL_MS;
    logProductStockState(cached, 'cache', { staleCache: cacheStale });

    void (async () => {
      const needsRepair = productNeedsVariantImageEnrichment(cached);
      const backendProduct = await refreshProductDetailFromBackend(productHandle, cached);

      if (backendProduct && hasFullProductDetail(backendProduct)) {
        await writeLocalProductDetailCache(productHandle, backendProduct);
        logProductStockState(backendProduct, 'backend', { staleCache: cacheStale });
      }

      if (!cacheStale && !needsRepair) {
        logProductLoadSpeed('enrichment skipped reason=local-cache-ready');
        return;
      }

      if (!backendProduct) {
        return;
      }
      const backendNeedsRepair = productNeedsVariantImageEnrichment(backendProduct);

      if (!backendNeedsRepair) {
        logProductLoadSpeed('enrichment skipped reason=backend-cache-ready');
        return;
      }

      logProductLoadSpeed('source=shopify-enrich');
      await enrichProductVariantImages(backendProduct, true);
    })();

    return cached;
  }

  let product: any = await refreshProductDetailFromBackend(productHandle);

  if (!hasFullProductDetail(product) && previewProduct) {
    logProductSource('route-preview', productHandle);
    logProductLoadSpeed('source=local-cache');
    product = previewProduct;
  }

  if (!hasFullProductDetail(product)) {
    console.log(`[NOOD data] Shopify fallback used handle=${productHandle}`);
    logProductLoadSpeed('source=shopify-enrich');
    const fallback = await fetchShopifyProductDetailFallback(productHandle);
    if (fallback) {
      product = await enrichProductVariantImages(fallback, true);
      await writeLocalProductDetailCache(productHandle, product);
    }
  } else if (productNeedsVariantImageEnrichment(product)) {
    void (async () => {
      logProductLoadSpeed('source=shopify-enrich');
      await enrichProductVariantImages(product, true);
    })();
  } else {
    logProductLoadSpeed('enrichment skipped reason=backend-cache-ready');
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
