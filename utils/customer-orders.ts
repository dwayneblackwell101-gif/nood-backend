import AsyncStorage from '@react-native-async-storage/async-storage';
import { getOrdersStorageKey } from './customer-storage';

const LEGACY_ORDERS_KEY = 'NOOD_ORDERS';

export type CustomerOrder = {
  id: string;
  date: string;
  createdAt?: string;
  total: number;
  currency: string;
  status: string;
  paymentMethod: string;
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  paymentTransactionId?: string;
  checkoutOrderId?: string;
  refunded?: boolean;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  shippingAddress?: any;
  items?: any[];
  financialStatus?: string;
  fulfillmentStatus?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  cancelledAt?: string;
  cancelReason?: string;
  refundedAmount?: number;
  displayFinancialStatus?: string;
  refundRecords?: Array<{
    createdAt?: string;
    amount?: number;
    currency?: string;
  }>;
  shopifyRefundRequest?: {
    refund_status?: string;
    refund_request_id?: string;
    refund_method?: string;
    refund_destination_label?: string;
    refund_amount?: string;
    updated_at?: string;
  };
  refundProcessedAt?: string;
  refundMethodLabel?: string;
  fulfillments?: any[];
  source?: 'local' | 'shopify' | 'merged';
};

const legacyProfileOrdersKey = (profileId: string) => `${LEGACY_ORDERS_KEY}:${profileId}`;

function normalizeOrder(raw: Partial<CustomerOrder>): CustomerOrder | null {
  const id = String(raw?.id || '').trim();
  if (!id) {
    return null;
  }

  const createdAt = String(raw?.createdAt || raw?.date || new Date().toISOString());

  return {
    id,
    date: createdAt,
    createdAt,
    total: Number(raw?.total || 0),
    currency: String(raw?.currency || 'TTD'),
    status: String(raw?.status || 'Processing'),
    paymentMethod: String(raw?.paymentMethod || 'Checkout'),
    shopifyOrderId: raw?.shopifyOrderId ? String(raw.shopifyOrderId) : undefined,
    shopifyOrderName: raw?.shopifyOrderName ? String(raw.shopifyOrderName) : undefined,
    paymentTransactionId: raw?.paymentTransactionId
      ? String(raw.paymentTransactionId)
      : undefined,
    checkoutOrderId: raw?.checkoutOrderId ? String(raw.checkoutOrderId) : undefined,
    refunded: Boolean(raw?.refunded),
    customer: raw?.customer,
    shippingAddress: raw?.shippingAddress,
    items: Array.isArray(raw?.items) ? raw.items : [],
    financialStatus: raw?.financialStatus ? String(raw.financialStatus) : undefined,
    fulfillmentStatus: raw?.fulfillmentStatus ? String(raw.fulfillmentStatus) : undefined,
    trackingNumber: raw?.trackingNumber ? String(raw.trackingNumber) : undefined,
    trackingUrl: raw?.trackingUrl ? String(raw.trackingUrl) : undefined,
    carrier: raw?.carrier ? String(raw.carrier) : undefined,
    cancelledAt: raw?.cancelledAt ? String(raw.cancelledAt) : undefined,
    cancelReason: raw?.cancelReason ? String(raw.cancelReason) : undefined,
    refundedAmount:
      raw?.refundedAmount !== undefined ? Number(raw.refundedAmount) : undefined,
    displayFinancialStatus: raw?.displayFinancialStatus
      ? String(raw.displayFinancialStatus)
      : raw?.financialStatus
        ? String(raw.financialStatus)
        : undefined,
    refundRecords: Array.isArray(raw?.refundRecords) ? raw.refundRecords : undefined,
    shopifyRefundRequest:
      raw?.shopifyRefundRequest && typeof raw.shopifyRefundRequest === 'object'
        ? raw.shopifyRefundRequest
        : undefined,
    refundProcessedAt: raw?.refundProcessedAt ? String(raw.refundProcessedAt) : undefined,
    refundMethodLabel: raw?.refundMethodLabel ? String(raw.refundMethodLabel) : undefined,
    fulfillments: Array.isArray(raw?.fulfillments) ? raw.fulfillments : undefined,
    source: raw?.source as CustomerOrder['source'],
  };
}

const guestOrdersKey = (profileId: string) => `orders:guest:${String(profileId || 'guest').trim()}`;

export async function getGuestSessionOrders(profileId: string): Promise<CustomerOrder[]> {
  try {
    const saved = await AsyncStorage.getItem(guestOrdersKey(profileId));
    return parseOrdersPayload(saved);
  } catch (error) {
    console.log('Failed to load guest session orders:', error);
    return [];
  }
}

export async function saveGuestSessionOrders(
  profileId: string,
  orders: CustomerOrder[]
): Promise<void> {
  const normalizedProfileId = String(profileId || 'guest').trim();
  const normalized = orders.map((entry) => normalizeOrder(entry)).filter(Boolean) as CustomerOrder[];
  await AsyncStorage.setItem(guestOrdersKey(normalizedProfileId), JSON.stringify(normalized));
}

function parseOrdersPayload(savedOrders: string | null): CustomerOrder[] {
  if (!savedOrders) {
    return [];
  }

  try {
    const parsed = JSON.parse(savedOrders);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((entry) => normalizeOrder(entry)).filter(Boolean) as CustomerOrder[];
  } catch {
    return [];
  }
}

async function readLegacyOrderLists(profileId: string): Promise<CustomerOrder[][]> {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return [];
  }

  const [legacyProfileOrders, legacyGlobalOrders] = await Promise.all([
    AsyncStorage.getItem(legacyProfileOrdersKey(normalizedProfileId)),
    AsyncStorage.getItem(LEGACY_ORDERS_KEY),
  ]);

  return [
    parseOrdersPayload(legacyProfileOrders),
    parseOrdersPayload(legacyGlobalOrders),
  ].filter((list) => list.length > 0);
}

async function clearLegacyOrderKeys(profileId: string): Promise<void> {
  const normalizedProfileId = String(profileId || '').trim();
  const keys = [LEGACY_ORDERS_KEY];

  if (normalizedProfileId) {
    keys.push(legacyProfileOrdersKey(normalizedProfileId));
  }

  await AsyncStorage.multiRemove(keys);
}

export async function saveCustomerOrders(
  profileId: string,
  orders: CustomerOrder[],
  email = '',
  isSignedIn = true
): Promise<void> {
  if (!isSignedIn) {
    return;
  }

  const normalizedProfileId = String(profileId || '').trim();
  const storageKey = getOrdersStorageKey(normalizedProfileId, email, true);
  if (!storageKey) {
    return;
  }

  const normalized = orders
    .map((entry) => normalizeOrder(entry))
    .filter(Boolean) as CustomerOrder[];

  await AsyncStorage.setItem(storageKey, JSON.stringify(normalized));
  await clearLegacyOrderKeys(normalizedProfileId);
}

export async function getCustomerOrders(
  profileId: string,
  email = '',
  isSignedIn = true
): Promise<CustomerOrder[]> {
  if (!isSignedIn) {
    return [];
  }

  const normalizedProfileId = String(profileId || '').trim();
  const storageKey = getOrdersStorageKey(normalizedProfileId, email, true);
  if (!storageKey) {
    return [];
  }

  try {
    const savedOrders = await AsyncStorage.getItem(storageKey);
    const canonicalOrders = parseOrdersPayload(savedOrders);
    const legacyLists = await readLegacyOrderLists(normalizedProfileId);
    const merged = mergeCustomerOrders(canonicalOrders, ...legacyLists);

    if (merged.length && (legacyLists.length > 0 || canonicalOrders.length !== merged.length)) {
      await saveCustomerOrders(normalizedProfileId, merged, email, true);
    }

    return merged;
  } catch (error) {
    console.log('Failed to load customer orders:', error);
    return [];
  }
}

export async function resolveOrderProfileId(isSignedIn: boolean, profileId: string): Promise<string> {
  if (!isSignedIn || !profileId) {
    return '';
  }

  return String(profileId).trim();
}

function normalizeOrderMatchKeys(order: Partial<CustomerOrder>): string[] {
  const keys = [
    order?.shopifyOrderName,
    order?.shopifyOrderId,
    order?.id,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return Array.from(new Set(keys));
}

function sortOrdersNewestFirst(orders: CustomerOrder[]): CustomerOrder[] {
  return orders.slice().sort((a, b) => {
    const aTime = new Date(a.date || 0).getTime();
    const bTime = new Date(b.date || 0).getTime();
    return bTime - aTime;
  });
}

function mergeOrderPair(localOrder: CustomerOrder, shopifyOrder: CustomerOrder): CustomerOrder {
  const shopifyItems = Array.isArray(shopifyOrder.items) ? shopifyOrder.items : [];
  const localItems = Array.isArray(localOrder.items) ? localOrder.items : [];

  return {
    ...localOrder,
    ...shopifyOrder,
    id: shopifyOrder.shopifyOrderName || shopifyOrder.id || localOrder.id,
    shopifyOrderId: shopifyOrder.shopifyOrderId || localOrder.shopifyOrderId,
    shopifyOrderName: shopifyOrder.shopifyOrderName || localOrder.shopifyOrderName,
    paymentMethod: localOrder.paymentMethod || shopifyOrder.paymentMethod,
    paymentTransactionId: localOrder.paymentTransactionId || shopifyOrder.paymentTransactionId,
    checkoutOrderId: localOrder.checkoutOrderId || shopifyOrder.checkoutOrderId,
    customer: localOrder.customer || shopifyOrder.customer,
    shippingAddress: localOrder.shippingAddress || shopifyOrder.shippingAddress,
    createdAt: localOrder.createdAt || shopifyOrder.createdAt || localOrder.date,
    date:
      shopifyOrder.date ||
      shopifyOrder.createdAt ||
      localOrder.date ||
      localOrder.createdAt ||
      new Date().toISOString(),
    items: shopifyItems.length ? shopifyItems : localItems,
    status: shopifyOrder.status || localOrder.status,
    refunded: Boolean(shopifyOrder.refunded || localOrder.refunded),
    financialStatus: shopifyOrder.financialStatus || localOrder.financialStatus,
    displayFinancialStatus:
      shopifyOrder.displayFinancialStatus ||
      shopifyOrder.financialStatus ||
      localOrder.displayFinancialStatus ||
      localOrder.financialStatus,
    refundedAmount:
      shopifyOrder.refundedAmount !== undefined
        ? shopifyOrder.refundedAmount
        : localOrder.refundedAmount,
    refundRecords: shopifyOrder.refundRecords?.length
      ? shopifyOrder.refundRecords
      : localOrder.refundRecords,
    shopifyRefundRequest: shopifyOrder.shopifyRefundRequest || localOrder.shopifyRefundRequest,
    refundProcessedAt: shopifyOrder.refundProcessedAt || localOrder.refundProcessedAt,
    refundMethodLabel: shopifyOrder.refundMethodLabel || localOrder.refundMethodLabel,
    source: 'merged',
  };
}

export function mergeCustomerOrders(...lists: CustomerOrder[][]): CustomerOrder[] {
  const merged = new Map<string, CustomerOrder>();

  lists.flat().forEach((order) => {
    if (order?.id) {
      merged.set(String(order.id), order);
    }
  });

  return sortOrdersNewestFirst(Array.from(merged.values()));
}

export function mergeLocalAndShopifyOrders(
  localOrders: CustomerOrder[] = [],
  shopifyOrders: CustomerOrder[] = []
): CustomerOrder[] {
  const merged = new Map<string, CustomerOrder>();

  const registerOrder = (order: CustomerOrder, preferShopify = false) => {
    const keys = normalizeOrderMatchKeys(order);
    const primaryKey = keys[0];
    if (!primaryKey) {
      return;
    }

    const existing = merged.get(primaryKey);
    const nextOrder =
      existing && preferShopify ? mergeOrderPair(existing, order) : existing || order;

    keys.forEach((key) => merged.set(key, nextOrder));
    merged.set(primaryKey, nextOrder);
  };

  localOrders.forEach((order) => registerOrder({ ...order, source: order.source || 'local' }));
  shopifyOrders.forEach((order) => registerOrder({ ...order, source: 'shopify' }, true));

  const uniqueOrders = Array.from(
    new Map(
      Array.from(merged.values()).map((order) => [normalizeOrderMatchKeys(order)[0] || order.id, order])
    ).values()
  );

  return sortOrdersNewestFirst(uniqueOrders);
}