import { BASE_CURRENCY } from './currency';

export const SHOPIFY_CHECKOUT_CURRENCY = 'USD';
/** WiPay charges in TTD; convert only inside the WiPay payment flow on the backend. */
export const WIPAY_CHECKOUT_CURRENCY = 'TTD';
export const CHECKOUT_SHIPPING = 0;
export const CHECKOUT_DISCOUNT = 0;

export type CheckoutCartLine = {
  title: string;
  productId: string;
  quantity: number;
  price: number;
  currency: string;
  variantId: string;
  image: string;
  handle: string;
  variantTitle: string;
  size?: string;
  color?: string;
};

export type CheckoutTotals = {
  currency: string;
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  cartLines: CheckoutCartLine[];
};

export function roundMoney(amount: number) {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

export function calculateLineUnitPrice(
  item: any,
  convertPrice: (amount: number, from: string, to: string) => number,
  currency = SHOPIFY_CHECKOUT_CURRENCY
) {
  const unitPrice = convertPrice(
    Number(item?.price || 0),
    item?.baseCurrency || BASE_CURRENCY,
    currency
  );
  return roundMoney(unitPrice);
}

export function buildCheckoutCartLines(
  cartItems: any[] = [],
  convertPrice: (amount: number, from: string, to: string) => number,
  currency = SHOPIFY_CHECKOUT_CURRENCY
): CheckoutCartLine[] {
  return (cartItems || []).map((item) => ({
    title: String(item?.title || 'Product'),
    productId: item?.productId ? String(item.productId) : String(item?.id || ''),
    quantity: Number(item?.quantity || 1),
    price: calculateLineUnitPrice(item, convertPrice, currency),
    currency,
    variantId: item?.variantId ? String(item.variantId) : '',
    image: String(item?.image || ''),
    handle: String(item?.handle || ''),
    variantTitle: String(item?.variantTitle || ''),
    size: item?.size ? String(item.size) : undefined,
    color: item?.color ? String(item.color) : undefined,
  }));
}

export function calculateCheckoutSubtotal(
  cartItems: any[] = [],
  convertPrice: (amount: number, from: string, to: string) => number,
  currency = SHOPIFY_CHECKOUT_CURRENCY
) {
  const lines = buildCheckoutCartLines(cartItems, convertPrice, currency);
  return roundMoney(
    lines.reduce((sum, line) => sum + Number(line.price || 0) * Number(line.quantity || 0), 0)
  );
}

export function buildCheckoutTotals(
  cartItems: any[] = [],
  convertPrice: (amount: number, from: string, to: string) => number,
  currency = SHOPIFY_CHECKOUT_CURRENCY
): CheckoutTotals {
  const cartLines = buildCheckoutCartLines(cartItems, convertPrice, currency);
  const subtotal = roundMoney(
    cartLines.reduce((sum, line) => sum + Number(line.price || 0) * Number(line.quantity || 0), 0)
  );

  return {
    currency,
    subtotal,
    shipping: CHECKOUT_SHIPPING,
    discount: CHECKOUT_DISCOUNT,
    total: subtotal,
    cartLines,
  };
}