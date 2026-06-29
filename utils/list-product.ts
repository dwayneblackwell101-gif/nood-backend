import { trimProductsForMemory } from './catalog-cache';

export const HOME_LIST_IMAGE_WIDTH = 360;

export type HomeListProduct = {
  id: string;
  title: string;
  handle: string;
  brand?: string;
  category?: string;
  tags?: string[];
  image: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  price?: string;
  oldPrice?: string | null;
  priceAmount: number;
  oldPriceAmount?: number | null;
  currencyCode: string;
  collectionHandle?: string;
  collectionTitle?: string;
  collectionHandles?: string[];
  collectionTitles?: string[];
  availableForSale?: boolean;
  variantId?: string;
  variantTitle?: string;
};

export function getHomeListImageUrl(url?: string | null, width = HOME_LIST_IMAGE_WIDTH) {
  const trimmed = String(url || '').trim();
  if (!trimmed) {
    return 'https://via.placeholder.com/600x700.png?text=No+Image';
  }

  try {
    const parsed = new URL(trimmed);
    parsed.searchParams.set('width', String(width));
    return parsed.toString();
  } catch {
    if (trimmed.includes('width=')) {
      return trimmed.replace(/width=\d+/i, `width=${width}`);
    }

    const joiner = trimmed.includes('?') ? '&' : '?';
    return `${trimmed}${joiner}width=${width}`;
  }
}

export function slimHomeListProduct<T extends Record<string, any>>(product: T): HomeListProduct {
  const id = String(product?.id || product?.handle || '').trim();
  const handle = String(product?.handle || '').trim();
  const title = String(product?.title || 'Product');
  const priceAmount = Number.isFinite(Number(product?.priceAmount))
    ? Number(product.priceAmount)
    : Number(String(product?.price || '').replace(/[^0-9.]/g, '')) || 0;

  const slim: HomeListProduct = {
    id,
    title,
    handle,
    image: getHomeListImageUrl(product?.image),
    priceAmount,
    currencyCode: String(product?.currencyCode || 'USD'),
    availableForSale: product?.availableForSale,
    variantId: product?.variantId ? String(product.variantId) : undefined,
    variantTitle: product?.variantTitle ? String(product.variantTitle) : undefined,
  };

  if (product?.brand) slim.brand = String(product.brand);
  if (product?.category) slim.category = String(product.category);
  if (Array.isArray(product?.tags) && product.tags.length) {
    slim.tags = product.tags.map(String);
  }
  if (product?.price) slim.price = String(product.price);
  if (product?.oldPrice) slim.oldPrice = String(product.oldPrice);
  if (Number.isFinite(Number(product?.oldPriceAmount))) {
    slim.oldPriceAmount = Number(product.oldPriceAmount);
  }
  if (product?.collectionHandle) slim.collectionHandle = String(product.collectionHandle);
  if (product?.collectionTitle) slim.collectionTitle = String(product.collectionTitle);
  if (Array.isArray(product?.collectionHandles) && product.collectionHandles.length) {
    slim.collectionHandles = product.collectionHandles.map(String);
  }
  if (Array.isArray(product?.collectionTitles) && product.collectionTitles.length) {
    slim.collectionTitles = product.collectionTitles.map(String);
  }
  if (product?.imageWidth != null) slim.imageWidth = product.imageWidth;
  if (product?.imageHeight != null) slim.imageHeight = product.imageHeight;

  return slim;
}

export function slimHomeListProducts<T extends Record<string, any>>(products: T[]): HomeListProduct[] {
  return products.map((product) => slimHomeListProduct(product));
}

export function prepareInMemoryHomeProducts<T extends Record<string, any>>(products: T[]) {
  const slimmed = slimHomeListProducts(products);
  return trimProductsForMemory(slimmed);
}