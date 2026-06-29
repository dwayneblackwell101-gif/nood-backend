import {
  getFirstPurchasableVariant,
  getVariantNodes,
  logProductStockState,
} from './product-availability';

export type ProductPreviewPayload = {
  id?: string;
  handle: string;
  title?: string;
  image?: string;
  priceAmount?: number;
  oldPriceAmount?: number | null;
  currencyCode?: string;
  vendor?: string;
  productType?: string;
  description?: string;
  variantId?: string;
  variantTitle?: string;
  variants?: { edges?: any[] };
  images?: { edges?: any[] };
  media?: { edges?: any[] };
  availableForSale?: boolean;
  collectionHandles?: string[];
};

function compactPreview(preview: ProductPreviewPayload) {
  return Object.fromEntries(
    Object.entries(preview).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false;
      if (Array.isArray(value) && !value.length) return false;
      return true;
    })
  ) as ProductPreviewPayload;
}

export function productPreviewFromGridItem(item: any): ProductPreviewPayload | null {
  const handle = String(item?.handle || '').trim();
  if (!handle) return null;

  const image =
    String(item?.image || item?.featuredImage?.url || '').trim() || undefined;
  const priceAmount = Number(
    item?.priceAmount ?? item?.priceRange?.minVariantPrice?.amount ?? 0
  );
  const oldPriceAmount = item?.oldPriceAmount
    ? Number(item.oldPriceAmount)
    : item?.compareAtPriceRange?.maxVariantPrice?.amount
      ? Number(item.compareAtPriceRange.maxVariantPrice.amount)
      : null;

  return compactPreview({
    id: item?.id ? String(item.id) : undefined,
    handle,
    title: item?.title ? String(item.title) : undefined,
    image,
    priceAmount: Number.isFinite(priceAmount) ? priceAmount : undefined,
    oldPriceAmount: Number.isFinite(Number(oldPriceAmount)) ? Number(oldPriceAmount) : null,
    currencyCode:
      item?.currencyCode || item?.priceRange?.minVariantPrice?.currencyCode || undefined,
    vendor: item?.vendor ? String(item.vendor) : undefined,
    productType: item?.productType ? String(item.productType) : undefined,
    description: item?.description ? String(item.description) : undefined,
    variantId: item?.variantId ? String(item.variantId) : undefined,
    variantTitle: item?.variantTitle ? String(item.variantTitle) : undefined,
    variants: item?.variants?.edges?.length ? item.variants : undefined,
    images: item?.images?.edges?.length ? item.images : undefined,
    media: item?.media?.edges?.length ? item.media : undefined,
    availableForSale: item?.availableForSale !== false,
    collectionHandles: Array.isArray(item?.collectionHandles)
      ? item.collectionHandles.filter(Boolean)
      : undefined,
  });
}

export function productHasRenderableVariants(productData: any) {
  return (productData?.variants?.edges || []).some((edge: any) =>
    (edge?.node?.selectedOptions || []).some(
      (option: any) => String(option?.name || '').trim() && String(option?.value || '').trim()
    )
  );
}

export function buildProductRouteParams(
  item: any,
  extra: Record<string, string> = {}
): Record<string, string> {
  const preview = productPreviewFromGridItem(item);
  const handle = preview?.handle || String(item?.handle || '').trim();
  if (handle) {
    void import('./product-data').then((mod) => {
      mod.prefetchProductDetailOnPress(handle);
    });
    console.log('[NOOD product] card pressed', {
      handle,
      id: preview?.id || item?.id || null,
      from: extra.from || null,
      hasPreview: Boolean(preview),
    });
  }

  if (!preview) {
    return {
      ...extra,
      handle,
    };
  }

  return {
    ...extra,
    handle: preview.handle,
    preview: JSON.stringify(preview),
  };
}

export function parseProductPreviewFromParams(
  params: Record<string, string | string[] | undefined>
): ProductPreviewPayload | null {
  const rawPreview = params.preview;
  const previewText = Array.isArray(rawPreview) ? rawPreview[0] : rawPreview;
  if (!previewText) return null;

  try {
    const parsed = JSON.parse(String(previewText));
    const handle = String(parsed?.handle || params.handle || '').trim();
    if (!handle) return null;
    return compactPreview({
      ...parsed,
      handle,
    });
  } catch {
    return null;
  }
}

export function buildProductDetailFromPreview(preview: ProductPreviewPayload) {
  const imageUrl = String(preview.image || '').trim();
  const currencyCode = preview.currencyCode || 'USD';
  const priceAmount = Number(preview.priceAmount || 0);
  const collectionHandles = Array.isArray(preview.collectionHandles)
    ? preview.collectionHandles
    : [];

  return {
    id: preview.id || '',
    title: preview.title || 'Product',
    handle: preview.handle,
    descriptionHtml: preview.description ? `<p>${preview.description}</p>` : '',
    vendor: preview.vendor || '',
    productType: preview.productType || '',
    tags: [],
    availableForSale: preview.availableForSale !== false,
    featuredImage: imageUrl ? { url: imageUrl } : null,
    images: preview.images || (imageUrl
      ? { edges: [{ node: { url: imageUrl, altText: null } }] }
      : { edges: [] }),
    media: preview.media || { edges: [] },
    priceRange: {
      minVariantPrice: {
        amount: String(priceAmount),
        currencyCode,
      },
    },
    compareAtPriceRange: preview.oldPriceAmount
      ? {
          maxVariantPrice: {
            amount: String(preview.oldPriceAmount),
            currencyCode,
          },
        }
      : { maxVariantPrice: null },
    collections: {
      edges: collectionHandles.map((collectionHandle, index) => ({
        node: {
          id: `${preview.id || preview.handle}_${index}`,
          handle: collectionHandle,
          title: collectionHandle,
        },
      })),
    },
    variants: preview.variants?.edges?.length
      ? preview.variants
      : preview.variantId
      ? {
          edges: [
            {
              node: {
                id: preview.variantId,
                title: preview.variantTitle || 'Default Title',
                availableForSale: preview.availableForSale !== false,
                price: {
                  amount: String(priceAmount),
                  currencyCode,
                },
                selectedOptions: [],
              },
            },
          ],
        }
      : { edges: [] },
  };
}

export function applyProductVariantState(
  productData: any,
  setSelectedVariant: (variant: any) => void,
  setSelectedOptionsMap: (options: Record<string, string>) => void,
  source: 'detail' | 'preview' | 'cache' = 'detail'
) {
  const variantNodes = getVariantNodes(productData);

  if (variantNodes.length) {
    const initialVariant = getFirstPurchasableVariant(variantNodes);
    setSelectedVariant(initialVariant);
    setSelectedOptionsMap(
      Object.fromEntries(
        (initialVariant?.selectedOptions || []).map((option: any) => [
          option.name,
          option.value,
        ])
      )
    );
    logProductStockState(productData, source, { selectedVariant: initialVariant });
    return;
  }

  setSelectedVariant(null);
  setSelectedOptionsMap({});
  logProductStockState(productData, source);
}
