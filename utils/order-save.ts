import type { CustomerOrder } from './customer-orders';
import { SHOPIFY_CHECKOUT_CURRENCY } from './checkout-totals';

export type PaymentOrderSaveInput = {
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  checkoutOrderId?: string;
  transactionId?: string;
  paymentMethod: string;
  total: number;
  currency?: string;
  items?: any[];
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  shippingAddress?: any;
};

function normalizeOrderItems(items: any[] = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    title: String(item?.title || 'Product'),
    quantity: Number(item?.quantity || 1),
    price: Number(item?.price || 0),
    variantId: item?.variantId ? String(item.variantId) : undefined,
    variantTitle: item?.variantTitle ? String(item.variantTitle) : undefined,
    size: item?.size ? String(item.size) : undefined,
    color: item?.color ? String(item.color) : undefined,
    image: item?.image ? String(item.image) : undefined,
    handle: item?.handle ? String(item.handle) : undefined,
    productId: item?.productId ? String(item.productId) : undefined,
  }));
}

export function buildPaymentOrder(input: PaymentOrderSaveInput): CustomerOrder {
  const shopifyOrderName = String(input.shopifyOrderName || '').trim();
  const shopifyOrderId = String(input.shopifyOrderId || '').trim();
  const createdAt = new Date().toISOString();
  const paymentMethodLabel = shopifyOrderName
    ? `${input.paymentMethod} (${shopifyOrderName})`
    : input.paymentMethod;

  return {
    id: shopifyOrderName || shopifyOrderId || `order_${Date.now()}`,
    date: createdAt,
    createdAt,
    total: Number(input.total || 0),
    currency: String(input.currency || SHOPIFY_CHECKOUT_CURRENCY),
    status: 'Paid',
    paymentMethod: paymentMethodLabel,
    shopifyOrderId: shopifyOrderId || undefined,
    shopifyOrderName: shopifyOrderName || undefined,
    paymentTransactionId: input.transactionId ? String(input.transactionId) : undefined,
    checkoutOrderId: input.checkoutOrderId ? String(input.checkoutOrderId) : undefined,
    customer: input.customer,
    shippingAddress: input.shippingAddress,
    items: normalizeOrderItems(input.items),
    source: 'local',
  };
}

export function isDuplicatePaymentOrder(
  existing: CustomerOrder,
  candidate: CustomerOrder
): boolean {
  const existingShopifyId = String(existing.shopifyOrderId || '').trim();
  const candidateShopifyId = String(candidate.shopifyOrderId || '').trim();
  if (existingShopifyId && candidateShopifyId && existingShopifyId === candidateShopifyId) {
    return true;
  }

  const existingShopifyName = String(existing.shopifyOrderName || existing.id || '').trim();
  const candidateShopifyName = String(candidate.shopifyOrderName || candidate.id || '').trim();
  if (existingShopifyName && candidateShopifyName && existingShopifyName === candidateShopifyName) {
    return true;
  }

  const existingTxn = String(existing.paymentTransactionId || '').trim();
  const candidateTxn = String(candidate.paymentTransactionId || '').trim();
  if (existingTxn && candidateTxn && existingTxn === candidateTxn) {
    return true;
  }

  return false;
}