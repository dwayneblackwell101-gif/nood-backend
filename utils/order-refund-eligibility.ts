import { ReturnRequest, ReturnRequestItem } from './return-requests';

export const RETURN_WINDOW_DAYS = 30;

const PAID_STATUSES = new Set(['paid', 'processing', 'completed', 'delivered', 'shipped']);
const BLOCKED_STATUSES = new Set(['cancelled', 'canceled', 'refunded', 'failed']);

export const OPEN_REFUND_REQUEST_STATUSES = new Set([
  'pending_review',
  'approved',
  'manual_refund_required',
]);

export const CLOSED_REFUND_REQUEST_STATUSES = new Set([
  'rejected',
  'refunded_to_wallet',
  'refunded_to_original',
  'partially_refunded',
  'cancelled',
  'failed',
]);

export type OrderEligibility = {
  eligible: boolean;
  label: string;
  detail: string;
};

export type ShopifyRefundRequestSnapshot = {
  refund_status?: string;
  refund_request_id?: string;
  refund_method?: string;
  refund_destination_label?: string;
};

function normalizeStatus(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeOrderKey(value: unknown): string {
  const raw = normalizeStatus(value);
  if (!raw) {
    return '';
  }

  if (raw.startsWith('gid://shopify/order/')) {
    return raw;
  }

  const gidMatch = raw.match(/gid:\/\/shopify\/order\/(\d+)/i);
  if (gidMatch) {
    return `gid://shopify/order/${gidMatch[1]}`;
  }

  return raw.replace(/^#/, '');
}

export function orderIdentityKeys(order: any): string[] {
  const keys = [order?.id, order?.shopifyOrderName, order?.shopifyOrderId]
    .map((value) => normalizeOrderKey(value))
    .filter(Boolean);

  return Array.from(new Set(keys));
}

export function requestIdentityKeys(request: ReturnRequest): string[] {
  const keys = [request.orderId, request.orderNumber, request.shopifyOrderId]
    .map((value) => normalizeOrderKey(value))
    .filter(Boolean);

  return Array.from(new Set(keys));
}

export function ordersMatchIdentity(left: any, right: any): boolean {
  const leftKeys = orderIdentityKeys(left);
  const rightKeys =
    typeof right === 'string'
      ? [normalizeOrderKey(right)]
      : typeof right === 'object' && right?.orderId
        ? requestIdentityKeys(right as ReturnRequest)
        : orderIdentityKeys(right);

  return leftKeys.some((key) => rightKeys.includes(key));
}

export function requestMatchesOrder(order: any, request: ReturnRequest): boolean {
  const orderKeys = orderIdentityKeys(order);
  const requestKeys = requestIdentityKeys(request);
  return requestKeys.some((key) => orderKeys.includes(key));
}

function normalizeItemKey(item: ReturnRequestItem | any): string {
  return normalizeOrderKey(item?.id || item?.variantId || item?.title || '');
}

export function getOrderItemsFingerprint(order: any): string[] {
  return getOrderItems(order)
    .map((item) => normalizeItemKey(item))
    .filter(Boolean)
    .sort();
}

export function getRequestItemsFingerprint(request: ReturnRequest): string[] {
  return (Array.isArray(request.items) ? request.items : [])
    .map((item) => normalizeItemKey(item))
    .filter(Boolean)
    .sort();
}

export function requestItemsOverlapOrder(
  order: any,
  request: ReturnRequest,
  selectedItemIds?: string[]
): boolean {
  const requestItems = getRequestItemsFingerprint(request);
  if (!requestItems.length) {
    return false;
  }

  const orderItems = getOrderItemsFingerprint(order);
  if (!orderItems.length) {
    return true;
  }

  const selectedKeys = (selectedItemIds || [])
    .map((id) => normalizeItemKey(id))
    .filter(Boolean);

  const targetItems = selectedKeys.length ? selectedKeys : orderItems;
  return targetItems.some((itemKey) => requestItems.includes(itemKey));
}

export function getOrderTimestamp(order: any): number {
  const raw = order?.date || order?.createdAt || 0;
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isWithinReturnWindow(order: any): boolean {
  const orderTime = getOrderTimestamp(order);
  if (!orderTime) {
    return false;
  }

  const windowEnd = orderTime + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() <= windowEnd;
}

function isFullyRefunded(order: any): boolean {
  const status = normalizeStatus(order?.status);
  const financialStatus = String(
    order?.displayFinancialStatus || order?.financialStatus || ''
  )
    .trim()
    .toUpperCase();

  if (financialStatus === 'PARTIALLY_REFUNDED' || status === 'partially refunded') {
    return false;
  }

  if (status === 'refunded' || financialStatus === 'REFUNDED') {
    return true;
  }

  const total = Number(order?.total || 0);
  const refundedAmount = Number(order?.refundedAmount || 0);
  if (total > 0 && refundedAmount >= total) {
    return true;
  }

  return Boolean(order?.refunded) && status === 'refunded';
}

function isPaidOrder(order: any): boolean {
  const status = normalizeStatus(order?.status);
  const financialStatus = normalizeStatus(order?.displayFinancialStatus || order?.financialStatus);

  if (status === 'failed-paid') {
    return true;
  }

  if (PAID_STATUSES.has(status)) {
    return true;
  }

  if (financialStatus.includes('paid') || financialStatus.includes('partially_paid')) {
    return true;
  }

  if (Number(order?.total || 0) > 0 && !BLOCKED_STATUSES.has(status)) {
    return true;
  }

  return false;
}

function getShopifyRefundSnapshot(order: any): ShopifyRefundRequestSnapshot | null {
  const raw = order?.shopifyRefundRequest;
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  return raw as ShopifyRefundRequestSnapshot;
}

function hasShopifyConfirmedOpenRequest(order: any): boolean {
  const snapshot = getShopifyRefundSnapshot(order);
  const status = normalizeStatus(snapshot?.refund_status);
  if (!status || CLOSED_REFUND_REQUEST_STATUSES.has(status)) {
    return false;
  }

  if (!OPEN_REFUND_REQUEST_STATUSES.has(status)) {
    return false;
  }

  console.log('[NOOD refund] existing request source shopify', {
    orderId: order?.id || order?.shopifyOrderName,
    shopifyOrderId: order?.shopifyOrderId,
    requestId: snapshot?.refund_request_id,
    status,
    refundMethod: snapshot?.refund_method,
  });

  return true;
}

function hasConfirmedOpenReturnRequest(
  order: any,
  requests: ReturnRequest[],
  selectedItemIds?: string[]
): ReturnRequest | null {
  for (const request of requests) {
    if (request.backendRegistered !== true) {
      continue;
    }

    if (!OPEN_REFUND_REQUEST_STATUSES.has(request.status)) {
      continue;
    }

    if (!requestMatchesOrder(order, request)) {
      continue;
    }

    if (!requestItemsOverlapOrder(order, request, selectedItemIds)) {
      continue;
    }

    console.log('[NOOD refund] existing request source backend', {
      orderId: order?.id || order?.shopifyOrderName,
      shopifyOrderId: order?.shopifyOrderId,
      requestId: request.id,
      backendRequestId: request.backendRequestId,
      status: request.status,
      itemCount: request.items?.length || 0,
    });

    return request;
  }

  return null;
}

export function getOrderEligibility(
  order: any,
  requests: ReturnRequest[] = [],
  selectedItemIds?: string[]
): OrderEligibility {
  const orderId = String(order?.id || order?.shopifyOrderName || '').trim();
  const status = normalizeStatus(order?.status);
  const validatedRequests = requests.filter((request) => request.backendRegistered === true);

  const eligibilityLog = {
    orderId: orderId || order?.shopifyOrderId,
    orderKeys: orderIdentityKeys(order),
    requestCount: requests.length,
    confirmedRequestCount: validatedRequests.length,
    financialStatus: order?.displayFinancialStatus || order?.financialStatus,
    refundedAmount: order?.refundedAmount,
  };

  if (!orderId && !order?.shopifyOrderId) {
    console.log('[NOOD refund] eligibility result', { ...eligibilityLog, eligible: false, reason: 'incomplete' });
    return {
      eligible: false,
      label: 'Unavailable',
      detail: 'Order details are incomplete.',
    };
  }

  if (isFullyRefunded(order)) {
    console.log('[NOOD refund] eligibility result', { ...eligibilityLog, eligible: false, reason: 'fully_refunded' });
    return {
      eligible: false,
      label: 'Refunded',
      detail: 'This order has already been refunded.',
    };
  }

  if (BLOCKED_STATUSES.has(status) && status !== 'failed-paid') {
    console.log('[NOOD refund] eligibility result', { ...eligibilityLog, eligible: false, reason: 'blocked_status' });
    return {
      eligible: false,
      label: 'Not eligible',
      detail: 'Cancelled or failed orders cannot be refunded here.',
    };
  }

  if (!isPaidOrder(order)) {
    console.log('[NOOD refund] eligibility result', { ...eligibilityLog, eligible: false, reason: 'not_paid' });
    return {
      eligible: false,
      label: 'Not paid',
      detail: 'Only paid orders can be requested for a refund.',
    };
  }

  if (!isWithinReturnWindow(order)) {
    console.log('[NOOD refund] eligibility result', { ...eligibilityLog, eligible: false, reason: 'window_closed' });
    return {
      eligible: false,
      label: 'Window closed',
      detail: `Returns and refunds are available within ${RETURN_WINDOW_DAYS} days of purchase.`,
    };
  }

  const blockingRequest = hasConfirmedOpenReturnRequest(order, validatedRequests, selectedItemIds);
  if (blockingRequest) {
    console.log('[NOOD refund] eligibility result', {
      ...eligibilityLog,
      eligible: false,
      reason: 'open_request',
      blockingRequestId: blockingRequest.id,
      source: 'backend',
    });
    return {
      eligible: false,
      label: 'Request open',
      detail: 'You already have a pending return or refund request for this order.',
    };
  }

  if (hasShopifyConfirmedOpenRequest(order)) {
    console.log('[NOOD refund] eligibility result', {
      ...eligibilityLog,
      eligible: false,
      reason: 'shopify_open_request',
      source: 'shopify',
    });
    return {
      eligible: false,
      label: 'Request open',
      detail: 'You already have a pending return or refund request for this order.',
    };
  }

  console.log('[NOOD refund] eligibility result', { ...eligibilityLog, eligible: true, reason: 'ok' });
  return {
    eligible: true,
    label: 'Eligible',
    detail: 'You can request a return or refund for this order.',
  };
}

export function getEligibleOrders(orders: any[] = [], requests: ReturnRequest[] = []) {
  return (Array.isArray(orders) ? orders : []).filter((order) =>
    getOrderEligibility(order, requests).eligible
  );
}

export function getOrderItems(order: any) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.map((item: any, index: number) => ({
    id: String(item?.variantId || item?.id || `${order?.id || 'order'}-${index}`),
    title: String(item?.title || item?.name || 'Item'),
    quantity: Math.max(Number(item?.quantity || 1), 1),
    image: String(item?.image || item?.featuredImage || item?.thumbnail || ''),
  }));
}