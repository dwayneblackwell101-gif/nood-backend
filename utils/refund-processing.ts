import { getBackendJson, postBackendJson } from './backend';
import {
  clearUnconfirmedReturnRequests,
  deleteReturnRequest,
  getReturnRequests,
  replaceReturnRequests,
  ReturnRequest,
  ReturnRequestStatus,
  SaveReturnRequestInput,
  updateReturnRequest,
  upsertReturnRequest,
} from './return-requests';
import { requestMatchesOrder } from './order-refund-eligibility';
import type { CustomerOrder } from './customer-orders';

export type PaymentProvider = 'paypal' | 'wipay' | 'shopify' | 'wallet' | 'unknown';

export type RefundRequestsFetchResult = {
  requests: ReturnRequest[];
  httpStatus: number;
  backendAvailable: boolean;
  source: 'backend' | 'local_cache' | 'local_cache_cleared';
};

export function detectPaymentProvider(paymentMethod: string): PaymentProvider {
  const normalized = String(paymentMethod || '').toLowerCase();

  if (normalized.includes('paypal')) {
    return 'paypal';
  }
  if (normalized.includes('wipay') || normalized.includes('visa') || normalized.includes('mastercard')) {
    return 'wipay';
  }
  if (normalized.includes('shopify') || normalized.includes('shop pay') || normalized.includes('shopify checkout')) {
    return 'shopify';
  }
  if (normalized.includes('wallet') || normalized.includes('nood balance')) {
    return 'wallet';
  }

  return 'unknown';
}

type BackendRefundResponse = {
  ok?: boolean;
  success?: boolean;
  status?: string;
  message?: string;
  refund_id?: string;
  provider_refund_id?: string;
  request_id?: string;
  shopify_synced?: boolean;
  request?: Record<string, unknown>;
};

type BackendRefundListResponse = {
  ok?: boolean;
  success?: boolean;
  requests?: Array<Record<string, unknown>>;
};

function parseBackendHttpStatus(error: unknown): number {
  const message = String((error as any)?.message || error || '');
  const match = message.match(/failed with (\d{3})/i);
  return match ? Number(match[1]) : 0;
}

function isBackendSuccess(data: BackendRefundResponse | null | undefined): boolean {
  if (!data) {
    return false;
  }

  if (data.ok === false || data.success === false) {
    return false;
  }

  const status = String(data.status || data.request?.status || '').toLowerCase();
  if (status.includes('fail') || status.includes('reject')) {
    return false;
  }

  return data.ok === true || data.success === true || Boolean(data.request_id);
}

function mapBackendStatus(value: unknown): ReturnRequestStatus | null {
  const status = String(value || '').trim().toLowerCase();
  if (!status) {
    return null;
  }

  if (status === 'pending' || status === 'pending review') {
    return 'pending_review';
  }

  const allowed: ReturnRequestStatus[] = [
    'pending_review',
    'approved',
    'rejected',
    'refunded_to_wallet',
    'refunded_to_original',
    'partially_refunded',
    'manual_refund_required',
    'failed',
    'cancelled',
  ];

  return allowed.includes(status as ReturnRequestStatus) ? (status as ReturnRequestStatus) : null;
}

function mapBackendRequest(entry: Record<string, unknown>): ReturnRequest {
  const rawMethod = String(entry.refund_method || '').toLowerCase();

  return {
    id: String(entry.request_id || entry.id || ''),
    orderId: String(entry.order_id || ''),
    orderNumber: String(entry.order_number || entry.order_id || ''),
    reason: String(entry.reason || ''),
    notes: String(entry.notes || ''),
    items: Array.isArray(entry.items) ? (entry.items as ReturnRequest['items']) : [],
    refundMethod:
      rawMethod === 'wallet' || rawMethod === 'nood_wallet' ? 'wallet' : 'original_payment',
    refundDestinationLabel: String(
      entry.refund_destination_label || entry.refundDestinationLabel || ''
    ).trim() || undefined,
    amount: Number(entry.amount || 0),
    currency: String(entry.currency || 'TTD'),
    paymentMethod: String(entry.payment_method || ''),
    paymentProvider: entry.payment_provider ? String(entry.payment_provider) : undefined,
    paymentTransactionId: entry.payment_transaction_id
      ? String(entry.payment_transaction_id)
      : undefined,
    shopifyOrderId: entry.shopify_order_id ? String(entry.shopify_order_id) : undefined,
    backendRequestId: entry.request_id ? String(entry.request_id) : undefined,
    backendRegistered: true,
    status: mapBackendStatus(entry.status) || 'pending_review',
    createdAt: String(entry.created_at || new Date().toISOString()),
    updatedAt: String(entry.updated_at || new Date().toISOString()),
  };
}

export async function fetchReturnRequestsFromBackend(
  customerEmail: string
): Promise<RefundRequestsFetchResult> {
  const email = String(customerEmail || '').trim().toLowerCase();
  const path = `/api/refunds/requests?customerEmail=${encodeURIComponent(email)}`;

  console.log('[REFUND REQUESTS FETCH]', { email, path });

  if (!email) {
    console.log('[REFUND REQUESTS RESPONSE]', { httpStatus: 0, reason: 'missing_email' });
    return {
      requests: [],
      httpStatus: 0,
      backendAvailable: false,
      source: 'local_cache',
    };
  }

  try {
    const data = await getBackendJson<BackendRefundListResponse>(path, { timeoutMs: 10000 });
    const requests = Array.isArray(data?.requests) ? data.requests.map((entry) => mapBackendRequest(entry)) : [];

    console.log('[REFUND REQUESTS RESPONSE]', {
      httpStatus: 200,
      requestCount: requests.length,
      ok: data?.ok ?? data?.success ?? true,
    });
    console.log('[REFUND REQUESTS SOURCE]', { source: 'backend', email });

    return {
      requests,
      httpStatus: 200,
      backendAvailable: true,
      source: 'backend',
    };
  } catch (error) {
    const httpStatus = parseBackendHttpStatus(error);

    console.log('[REFUND REQUESTS RESPONSE]', {
      httpStatus: httpStatus || 'unknown',
      error: String((error as any)?.message || error),
    });
    console.log('[REFUND REQUESTS SOURCE]', {
      source: 'backend_unavailable',
      email,
      httpStatus: httpStatus || 'unknown',
    });

    return {
      requests: [],
      httpStatus: httpStatus || 0,
      backendAvailable: false,
      source: 'local_cache',
    };
  }
}

export async function registerReturnRequestWithBackend(
  request: ReturnRequest,
  order: CustomerOrder,
  customerEmail = ''
): Promise<{ submitted: boolean; message: string; backendRequestId?: string }> {
  const provider = detectPaymentProvider(request.paymentMethod || order.paymentMethod);

  console.log('[REFUND DESTINATION SELECTED]', {
    requestId: request.id,
    orderId: request.orderId,
    orderNumber: request.orderNumber,
    refundMethod: request.refundMethod,
    refundDestinationLabel:
      request.refundMethod === 'wallet' ? 'NOOD Wallet' : 'Original payment method',
    amount: request.amount,
    currency: request.currency,
  });

  console.log('[RETURN REQUEST CREATE]', {
    requestId: request.id,
    orderId: request.orderId,
    orderNumber: request.orderNumber,
    refundMethod: request.refundMethod,
    amount: request.amount,
    currency: request.currency,
  });

  console.log('[NOOD refund] backend create request start', {
    requestId: request.id,
    orderId: request.orderId,
    orderNumber: request.orderNumber,
    shopifyOrderId: order.shopifyOrderId,
  });

  try {
    const data = await postBackendJson<BackendRefundResponse>(
      '/api/refunds/requests',
      {
        request_id: request.id,
        order_id: request.orderId,
        order_number: request.orderNumber,
        customer_email: customerEmail || order.customer?.email || '',
        amount: request.amount,
        currency: request.currency,
        refund_method: request.refundMethod,
        payment_provider: provider,
        payment_method: request.paymentMethod || order.paymentMethod,
        payment_transaction_id: order.paymentTransactionId || null,
        shopify_order_id: order.shopifyOrderId || null,
        reason: request.reason,
        notes: request.notes || '',
        items: request.items,
      },
      { timeoutMs: 12000 }
    );

    if (isBackendSuccess(data)) {
      console.log('[RETURN REQUEST SAVED]', {
        requestId: request.id,
        backendRequestId: data?.request_id || request.id,
        status: data?.status || data?.request?.status || 'pending_review',
        shopifySynced: Boolean(data?.shopify_synced),
        scope: 'backend',
      });

      return {
        submitted: true,
        message: String(data?.message || 'Refund request registered with NOOD support.'),
        backendRequestId: String(data?.request_id || data?.refund_id || request.id),
      };
    }

    console.log('[RETURN REQUEST FAILED]', {
      requestId: request.id,
      reason: 'backend_rejected',
      message: data?.message,
    });

    return {
      submitted: false,
      message: String(data?.message || 'Refund request could not be registered with support.'),
    };
  } catch (error) {
    const httpStatus = parseBackendHttpStatus(error);
    const errorMessage = String((error as any)?.message || error || '').trim();

    if (httpStatus === 409 || errorMessage.toLowerCase().includes('already have a pending')) {
      console.log('[NOOD refund] existing request source backend', {
        requestId: request.id,
        orderId: request.orderId,
        httpStatus: httpStatus || 409,
      });
    }

    console.log('[RETURN REQUEST FAILED]', {
      requestId: request.id,
      reason: 'backend_unavailable',
      httpStatus: httpStatus || 'unknown',
      error,
    });

    return {
      submitted: false,
      message:
        httpStatus === 409
          ? errorMessage ||
            'You already have a pending return or refund request for this order.'
          : httpStatus === 404
            ? 'Refund service is not available yet. Please try again after the backend update is deployed.'
            : errorMessage || 'Refund request could not reach support right now. Please try again.',
    };
  }
}

export async function submitReturnRequest(
  customerKey: string,
  input: SaveReturnRequestInput,
  order: CustomerOrder,
  customerEmail = ''
): Promise<{ saved: ReturnRequest | null; message: string }> {
  const requestId = `${Date.now()}`;
  const draftRequest: ReturnRequest = {
    id: requestId,
    ...input,
    refundDestinationLabel:
      input.refundMethod === 'wallet' ? 'NOOD Wallet' : 'Original payment method',
    backendRegistered: false,
    status: 'pending_review',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  console.log('[NOOD refund] submit started', {
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    shopifyOrderId: input.shopifyOrderId,
    refundMethod: input.refundMethod,
  });

  const backend = await registerReturnRequestWithBackend(draftRequest, order, customerEmail);
  if (!backend.submitted) {
    console.log('[NOOD refund] backend create fail', {
      orderId: input.orderId,
      message: backend.message,
    });
    console.log('[NOOD refund] pending request saved', false);
    return {
      saved: null,
      message: backend.message,
    };
  }

  console.log('[NOOD refund] backend create success', {
    orderId: input.orderId,
    backendRequestId: backend.backendRequestId || requestId,
  });

  const saved = await upsertReturnRequest(customerKey, {
    ...draftRequest,
    backendRegistered: true,
    backendRequestId: backend.backendRequestId || requestId,
    refundDestinationLabel: draftRequest.refundDestinationLabel,
    status: 'pending_review',
  });

  console.log('[NOOD refund] pending request saved', true);
  console.log('[REFUND REQUESTS CACHE]', {
    customerKey,
    requestId: saved.id,
    orderId: saved.orderId,
    action: 'saved_confirmed_request',
  });

  return {
    saved,
    message: backend.message,
  };
}

export async function fetchReturnRequestStatusFromBackend(
  requestId: string
): Promise<ReturnRequest | null> {
  const normalizedId = String(requestId || '').trim();
  if (!normalizedId) {
    return null;
  }

  try {
    const data = await getBackendJson<BackendRefundResponse>(
      `/api/refunds/requests/${encodeURIComponent(normalizedId)}/status`,
      { timeoutMs: 10000 }
    );

    if (!data?.request) {
      return null;
    }

    console.log('[REFUND STATUS SYNC]', {
      requestId: normalizedId,
      status: data.status || data.request?.status,
      source: 'backend_status',
    });

    return mapBackendRequest(data.request);
  } catch (error) {
    console.log('[RETURN REQUEST FAILED]', {
      reason: 'fetch_backend_status',
      requestId: normalizedId,
      httpStatus: parseBackendHttpStatus(error) || 'unknown',
      error,
    });
    return null;
  }
}

function buildRequestSyncKey(request: ReturnRequest): string {
  return String(request.backendRequestId || request.id || '').trim();
}

export async function syncReturnRequestsWithBackend(
  customerKey: string,
  customerEmail: string
): Promise<ReturnRequest[]> {
  const localBefore = await getReturnRequests(customerKey);
  console.log('[REFUND REQUESTS CACHE]', {
    customerKey,
    localCount: localBefore.length,
    confirmedCount: localBefore.filter((request) => request.backendRegistered).length,
    unconfirmedCount: localBefore.filter((request) => !request.backendRegistered).length,
  });

  const { kept: afterUnconfirmedClear, removedCount: unconfirmedRemoved } =
    await clearUnconfirmedReturnRequests(customerKey);
  if (unconfirmedRemoved > 0) {
    console.log('[NOOD refund] stale local pending ignored/removed', {
      customerKey,
      removedCount: unconfirmedRemoved,
      scope: 'unconfirmed_before_sync',
    });
  }

  const fetchResult = await fetchReturnRequestsFromBackend(customerEmail);

  if (!fetchResult.backendAvailable) {
    const shouldClearLocal = fetchResult.httpStatus === 404 || fetchResult.httpStatus === 0;
    if (shouldClearLocal) {
      await replaceReturnRequests(customerKey, []);
      console.log('[REFUND REQUESTS SOURCE]', {
        source: 'local_cache_cleared',
        reason: fetchResult.httpStatus === 404 ? 'backend_404' : 'backend_unavailable',
        removedCount: afterUnconfirmedClear.length,
        keptCount: 0,
      });
      return [];
    }

    console.log('[REFUND REQUESTS SOURCE]', {
      source: 'backend_unavailable_unverified',
      ignoredConfirmedCount: afterUnconfirmedClear.filter((request) => request.backendRegistered)
        .length,
    });
    return [];
  }

  const backendKeys = new Set(
    fetchResult.requests.map((request) => buildRequestSyncKey(request)).filter(Boolean)
  );

  const staleConfirmedKeys: string[] = [];
  for (const localRequest of afterUnconfirmedClear) {
    if (localRequest.backendRegistered !== true) {
      continue;
    }

    const localKey = buildRequestSyncKey(localRequest);
    if (localKey && !backendKeys.has(localKey)) {
      staleConfirmedKeys.push(localKey);
      console.log('[NOOD refund] stale local pending ignored/removed', {
        customerKey,
        requestId: localRequest.id,
        backendRequestId: localRequest.backendRequestId,
        reason: 'not_in_backend',
      });
    }
  }

  const synced: ReturnRequest[] = [];

  for (const remoteRequest of fetchResult.requests) {
    const key = buildRequestSyncKey(remoteRequest);
    const localMatch = afterUnconfirmedClear.find(
      (entry) =>
        entry.id === remoteRequest.id ||
        entry.backendRequestId === key ||
        entry.id === key
    );

    const mergedRequest = normalizeRequestForSync({
      ...localMatch,
      ...remoteRequest,
      id: localMatch?.id || remoteRequest.id,
      backendRequestId: remoteRequest.backendRequestId || remoteRequest.id,
      backendRegistered: true,
    });

    if (!localMatch || localMatch.status !== mergedRequest.status) {
      console.log('[APP REFUND STATUS UPDATED]', {
        requestId: mergedRequest.id,
        fromStatus: localMatch?.status || 'none',
        toStatus: mergedRequest.status,
        source: 'backend_sync',
      });
    }

    synced.push(mergedRequest);
  }

  synced.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  await replaceReturnRequests(customerKey, synced);

  console.log('[REFUND REQUESTS SOURCE]', {
    source: 'backend',
    syncedCount: synced.length,
    staleRemovedCount: staleConfirmedKeys.length,
  });
  console.log('[NOOD refund] existing request source', {
    source: 'backend',
    syncedCount: synced.length,
    staleRemovedCount: staleConfirmedKeys.length,
  });

  return synced;
}

function normalizeRequestForSync(request: ReturnRequest): ReturnRequest {
  return {
    ...request,
    backendRegistered: true,
    updatedAt: request.updatedAt || new Date().toISOString(),
  };
}

function getShopifyRefundState(order: CustomerOrder): {
  isRefunded: boolean;
  isPartiallyRefunded: boolean;
  refundedAmount: number;
  latestRefundDate?: string;
} {
  const financialStatus = String(order.displayFinancialStatus || order.financialStatus || '')
    .trim()
    .toUpperCase();
  const status = String(order.status || '').trim().toLowerCase();
  const refundedAmount = Number(order.refundedAmount || 0);
  const total = Number(order.total || 0);
  const refundRecords = Array.isArray(order.refundRecords) ? order.refundRecords : [];

  const isPartiallyRefunded =
    financialStatus === 'PARTIALLY_REFUNDED' ||
    status === 'partially refunded' ||
    (refundedAmount > 0 && total > 0 && refundedAmount < total);

  const isRefunded =
    financialStatus === 'REFUNDED' ||
    status === 'refunded' ||
    (total > 0 && refundedAmount >= total);

  const latestRefundDate = refundRecords
    .map((entry) => String(entry?.createdAt || ''))
    .filter(Boolean)
    .sort()
    .pop();

  return {
    isRefunded,
    isPartiallyRefunded,
    refundedAmount,
    latestRefundDate,
  };
}

export async function syncReturnRequestsWithShopifyRefunds(
  customerKey: string,
  orders: CustomerOrder[]
): Promise<ReturnRequest[]> {
  const requests = await getReturnRequests(customerKey);
  if (!requests.length || !orders.length) {
    return requests;
  }

  let changed = false;
  const nextRequests = [...requests];

  for (const order of orders) {
    const refundState = getShopifyRefundState(order);
    if (!refundState.isRefunded && !refundState.isPartiallyRefunded) {
      continue;
    }

    console.log('[SHOPIFY REFUND DETECTED]', {
      orderId: order.id,
      shopifyOrderId: order.shopifyOrderId,
      financialStatus: order.displayFinancialStatus || order.financialStatus,
      refundedAmount: refundState.refundedAmount,
      isPartiallyRefunded: refundState.isPartiallyRefunded,
      isRefunded: refundState.isRefunded,
    });

    for (let index = 0; index < nextRequests.length; index += 1) {
      const request = nextRequests[index];
      if (!requestMatchesOrder(order, request)) {
        continue;
      }

      if (request.refundMethod === 'wallet') {
        continue;
      }

      const nextStatus: ReturnRequestStatus | null = refundState.isRefunded
        ? 'refunded_to_original'
        : refundState.isPartiallyRefunded
          ? 'partially_refunded'
          : null;

      if (!nextStatus || request.status === nextStatus) {
        continue;
      }

      if (
        request.status === 'rejected' ||
        request.status === 'cancelled' ||
        request.status === 'refunded_to_wallet'
      ) {
        continue;
      }

      const updated = {
        ...request,
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      };

      nextRequests[index] = updated;
      changed = true;

      console.log('[ORDER REFUND STATUS SYNC]', {
        orderId: order.id,
        requestId: request.id,
        fromStatus: request.status,
        toStatus: nextStatus,
        refundedAmount: refundState.refundedAmount,
        latestRefundDate: refundState.latestRefundDate,
      });

      console.log('[APP REFUND STATUS UPDATED]', {
        requestId: request.id,
        fromStatus: request.status,
        toStatus: nextStatus,
        source: 'shopify_order_refund',
      });
    }
  }

  if (!changed) {
    return requests;
  }

  return replaceReturnRequests(customerKey, nextRequests);
}

export async function processApprovedOriginalPaymentRefund(
  customerKey: string,
  request: ReturnRequest
): Promise<ReturnRequest | null> {
  if (request.refundMethod !== 'original_payment') {
    return null;
  }

  if (request.status === 'refunded_to_original' || request.status === 'manual_refund_required') {
    return request;
  }

  if (request.status !== 'approved') {
    return null;
  }

  return updateReturnRequest(customerKey, request.id, {
    status: 'manual_refund_required',
  });
}

async function processWalletRefundIfNeeded(
  customerKey: string,
  request: ReturnRequest,
  creditWallet: (amount: number, orderId: string, note: string) => void,
  orders: CustomerOrder[]
): Promise<ReturnRequest | null> {
  if (request.refundMethod !== 'wallet' || request.backendRegistered !== true) {
    return null;
  }

  if (request.status !== 'refunded_to_wallet') {
    return null;
  }

  const order = orders.find((entry) => String(entry.id) === String(request.orderId));
  if (!order?.refunded) {
    const amount = Number(request.amount || 0);
    if (amount > 0) {
      creditWallet(
        amount,
        request.orderId,
        `Refund for order #${request.orderNumber || request.orderId}`
      );
    }
  }

  return request;
}

export async function syncApprovedReturnRefunds(
  customerKey: string,
  orders: CustomerOrder[],
  creditWallet: (amount: number, orderId: string, note: string) => void,
  markOrderRefunded?: (orderId: string, method: string) => void
): Promise<void> {
  const requests = (await getReturnRequests(customerKey)).filter(
    (request) => request.backendRegistered === true
  );

  for (const request of requests) {
    if (
      request.status !== 'approved' &&
      request.status !== 'manual_refund_required' &&
      request.status !== 'refunded_to_wallet' &&
      request.status !== 'refunded_to_original'
    ) {
      continue;
    }

    const order = orders.find((entry) => String(entry.id) === String(request.orderId));
    if (!order) {
      continue;
    }

    if (request.refundMethod === 'wallet') {
      await processWalletRefundIfNeeded(customerKey, request, creditWallet, orders);
      continue;
    }

    if (request.refundMethod === 'original_payment' && request.status === 'approved') {
      const updated = await processApprovedOriginalPaymentRefund(customerKey, request);
      if (updated?.status === 'manual_refund_required') {
        markOrderRefunded?.(request.orderId, 'Manual refund required');
      }
      continue;
    }

    if (request.refundMethod === 'original_payment' && request.status === 'refunded_to_original') {
      markOrderRefunded?.(request.orderId, 'Original payment method');
    }
  }
}

export async function purgeStaleLocalReturnRequest(
  customerKey: string,
  requestId: string
): Promise<void> {
  await deleteReturnRequest(customerKey, requestId);
  console.log('[REFUND REQUESTS CACHE]', {
    customerKey,
    requestId,
    action: 'removed_stale_local_request',
  });
}