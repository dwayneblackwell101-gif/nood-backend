export type StockLogSource =
  | 'backend'
  | 'cache'
  | 'detail'
  | 'search'
  | 'category'
  | 'collection'
  | 'home'
  | 'trending'
  | 'preview'
  | 'unknown';

export function getVariantNodes(product: any): any[] {
  if (!product) return [];

  if (Array.isArray(product?.variants?.edges)) {
    return product.variants.edges.map((edge: any) => edge?.node).filter(Boolean);
  }

  if (Array.isArray(product?.variants?.nodes)) {
    return product.variants.nodes.filter(Boolean);
  }

  return [];
}

function isInventoryTracked(variant: any): boolean {
  if (typeof variant?.inventoryItem?.tracked === 'boolean') {
    return variant.inventoryItem.tracked;
  }
  if (typeof variant?.tracked === 'boolean') {
    return variant.tracked;
  }
  return false;
}

function hasNumericInventory(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  const num = Number(value);
  return Number.isFinite(num);
}

function getVariantInventoryPolicy(variant: any): string {
  return String(variant?.inventoryPolicy || '').trim().toUpperCase();
}

export function isVariantPurchasable(variant: any): boolean {
  if (!variant) return false;

  if (variant.availableForSale === true) return true;

  const policy = getVariantInventoryPolicy(variant);
  if (policy === 'CONTINUE') return true;

  if (!isInventoryTracked(variant)) return true;

  if (variant.availableForSale === false) return false;

  const rawQuantity = variant?.quantityAvailable ?? variant?.inventoryQuantity;
  if (!hasNumericInventory(rawQuantity)) return true;

  return Number(rawQuantity) > 0;
}

export function countAvailableVariants(product: any): number {
  return getVariantNodes(product).filter(isVariantPurchasable).length;
}

export function computeProductSoldOut(product: any): boolean {
  const variants = getVariantNodes(product);

  if (!variants.length) {
    if (product?.availableForSale === true) return false;
    if (product?.availableForSale === false) return true;
    return false;
  }

  return !variants.some(isVariantPurchasable);
}

export function resolveProductAvailableForSale(product: any): boolean {
  return !computeProductSoldOut(product);
}

export function getFirstPurchasableVariant(variants: any[]): any | null {
  if (!Array.isArray(variants) || !variants.length) return null;
  return variants.find(isVariantPurchasable) || variants[0] || null;
}

export function getProductAvailabilityLabel(product: any): 'Available now' | 'Sold out' {
  return computeProductSoldOut(product) ? 'Sold out' : 'Available now';
}

export function logSoldOutDebug(product: any, source: StockLogSource = 'unknown') {
  if (!computeProductSoldOut(product)) return;

  const firstVariant = getVariantNodes(product)[0] || null;

  console.log('[SOLD_OUT_DEBUG]', {
    handle: product?.handle || '',
    title: product?.title || '',
    productAvailableForSale: product?.availableForSale,
    firstVariantAvailableForSale: firstVariant?.availableForSale,
    quantityAvailable: firstVariant?.quantityAvailable ?? firstVariant?.inventoryQuantity ?? null,
    source,
  });
}

/** List/card items often only include one variant — recompute from variant + product flags. */
export function resolveListProductSoldOut(item: any): boolean {
  return computeProductSoldOut(item);
}

export function resolveListProductAvailableForSale(item: any): boolean {
  return !resolveListProductSoldOut(item);
}

function resolveStockReason(product: any, soldOut: boolean): string {
  const variants = getVariantNodes(product);
  const availableCount = countAvailableVariants(product);

  if (!variants.length) {
    if (product?.availableForSale === false) return 'product-flag-false-no-variants';
    if (product?.availableForSale === true) return 'product-flag-true-no-variants';
    return soldOut ? 'unknown-no-variants' : 'default-available-no-variants';
  }

  if (availableCount > 0) {
    return 'has-purchasable-variant';
  }

  const firstVariant = variants[0];
  const policy = getVariantInventoryPolicy(firstVariant);
  if (policy === 'CONTINUE') return 'continue-policy';
  if (!isInventoryTracked(firstVariant)) return 'untracked-inventory';

  if (variants.every((variant) => variant?.availableForSale === false)) {
    return 'all-variants-explicitly-unavailable';
  }

  return 'no-purchasable-variant';
}

export function logProductStockState(
  product: any,
  source: StockLogSource,
  options: {
    selectedVariant?: any | null;
    staleCache?: boolean;
  } = {}
) {
  const variants = getVariantNodes(product);
  const availableCount = countAvailableVariants(product);
  const firstVariant = variants[0] || null;
  const soldOut = computeProductSoldOut(product);
  const reason = resolveStockReason(product, soldOut);

  console.log('[NOOD stock] product handle/title', product?.handle || '', product?.title || '');
  console.log('[NOOD stock] backend availableForSale', product?.availableForSale);
  console.log('[NOOD stock] variants count', variants.length);
  console.log('[NOOD stock] available variants count', availableCount);
  console.log('[NOOD stock] inventory policy', getVariantInventoryPolicy(firstVariant));
  console.log(
    '[NOOD stock] first variant available',
    firstVariant ? isVariantPurchasable(firstVariant) : null
  );

  if (options.selectedVariant) {
    console.log(
      '[NOOD stock] selected variant id/title',
      options.selectedVariant?.id || '',
      options.selectedVariant?.title || ''
    );
    console.log(
      '[NOOD stock] selected variant available',
      isVariantPurchasable(options.selectedVariant)
    );
  }

  console.log('[NOOD stock] computed soldOut', soldOut);
  console.log('[NOOD stock] reason', reason);
  console.log('[NOOD stock] source', source);

  if (options.staleCache) {
    console.log('[NOOD stock] stale cache detected', true);
  }
}

export function logCardProductStockState(product: any, source: StockLogSource = 'home') {
  if (!__DEV__) return;

  const productLoadDebugEnabled =
    process.env.EXPO_PUBLIC_PRODUCT_LOAD_DEBUG === 'true' ||
    process.env.EXPO_PUBLIC_PRODUCT_LOAD_DEBUG === '1';
  if (!productLoadDebugEnabled) return;

  logProductStockState(product, source);
}
