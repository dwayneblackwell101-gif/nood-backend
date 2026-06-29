import { BASE_CURRENCY, normalizeCatalogCurrencyCode } from './currency';
import { getHomeListImageUrl } from './list-product';
import {
  getFirstPurchasableVariant,
  getVariantNodes,
  resolveListProductAvailableForSale,
} from './product-availability';

export type CatalogListProduct = {
  id: string;
  title: string;
  handle: string;
  image: string;
  priceAmount: number;
  oldPriceAmount?: number | null;
  currencyCode: string;
  brand?: string;
  productType?: string;
  tags?: string[];
  collectionHandles?: string[];
  collectionHandle?: string;
  variantId?: string;
  variantTitle?: string;
  availableForSale?: boolean;
};

export function mapCatalogEdgesToProducts(edges: any[]): CatalogListProduct[] {
  const products: CatalogListProduct[] = [];

  (edges || []).forEach((edge) => {
    const node = edge?.node;
    if (!node?.handle) return;

    const priceAmount = Number(node.priceRange?.minVariantPrice?.amount || 0);
    const oldPriceAmount = node.compareAtPriceRange?.maxVariantPrice?.amount
      ? Number(node.compareAtPriceRange.maxVariantPrice.amount)
      : null;
    const currencyCode = normalizeCatalogCurrencyCode(
      node.priceRange?.minVariantPrice?.currencyCode ||
        node.compareAtPriceRange?.maxVariantPrice?.currencyCode
    );
    const collectionHandles =
      node.collections?.edges?.map((entry: any) => entry?.node?.handle).filter(Boolean) || [];
    const firstVariant = getFirstPurchasableVariant(getVariantNodes(node));

    const mapped = {
      id: String(node.id || node.handle),
      title: String(node.title || 'Product'),
      handle: String(node.handle),
      image: getHomeListImageUrl(node.featuredImage?.url),
      priceAmount,
      oldPriceAmount,
      currencyCode,
      brand: String(node.vendor || ''),
      productType: String(node.productType || ''),
      tags: Array.isArray(node.tags) ? node.tags.map(String) : [],
      collectionHandles,
      collectionHandle: collectionHandles[0] || 'all',
      variantId: firstVariant?.id ? String(firstVariant.id) : undefined,
      variantTitle: firstVariant?.title ? String(firstVariant.title) : undefined,
      availableForSale: Boolean(node.availableForSale ?? firstVariant?.availableForSale ?? true),
    };
    mapped.availableForSale = resolveListProductAvailableForSale(mapped);
    products.push(mapped);
  });

  return products;
}
