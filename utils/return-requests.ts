import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveCustomerStorageKey } from './customer-storage';

export type ReturnRequestStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'refunded_to_wallet'
  | 'refunded_to_original'
  | 'partially_refunded'
  | 'manual_refund_required'
  | 'failed'
  | 'cancelled';

export type RefundMethod = 'original_payment' | 'wallet';

export type ReturnRequestItem = {
  id: string;
  title: string;
  quantity: number;
  image?: string;
};

export type ReturnRequest = {
  id: string;
  orderId: string;
  orderNumber: string;
  reason: string;
  notes?: string;
  items: ReturnRequestItem[];
  refundMethod: RefundMethod;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentProvider?: string;
  paymentTransactionId?: string;
  shopifyOrderId?: string;
  backendRequestId?: string;
  backendRegistered?: boolean;
  refundDestinationLabel?: string;
  status: ReturnRequestStatus;
  createdAt: string;
  updatedAt: string;
};

export type SaveReturnRequestInput = {
  orderId: string;
  orderNumber: string;
  reason: string;
  notes?: string;
  items: ReturnRequestItem[];
  refundMethod: RefundMethod;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentProvider?: string;
  paymentTransactionId?: string;
  shopifyOrderId?: string;
};

const returnsKey = (customerKey: string) => `returns:${customerKey}`;
const refundRequestsKey = (customerKey: string) => `refundRequests:${customerKey}`;

export function getCustomerStorageKey(profileId: string, email = '', isSignedIn = false): string {
  return resolveCustomerStorageKey(profileId, email, isSignedIn);
}

function normalizeStatus(status: unknown): ReturnRequestStatus {
  const value = String(status || '').trim().toLowerCase();

  if (value === 'pending' || value === 'pending review') {
    return 'pending_review';
  }
  if (value === 'refunded') {
    return 'refunded_to_wallet';
  }
  if (
    value === 'pending_review' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'refunded_to_wallet' ||
    value === 'refunded_to_original' ||
    value === 'partially_refunded' ||
    value === 'manual_refund_required' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value as ReturnRequestStatus;
  }

  return 'pending_review';
}

function normalizeRequest(raw: Partial<ReturnRequest>): ReturnRequest {
  const now = new Date().toISOString();

  return {
    id: String(raw.id || Date.now()),
    orderId: String(raw.orderId || '').trim(),
    orderNumber: String(raw.orderNumber || raw.orderId || '').trim(),
    reason: String(raw.reason || '').trim(),
    notes: String(raw.notes || '').trim(),
    items: Array.isArray(raw.items) ? raw.items : [],
    refundMethod: raw.refundMethod === 'wallet' ? 'wallet' : 'original_payment',
    amount: Number(raw.amount || 0),
    currency: String(raw.currency || 'TTD').trim(),
    paymentMethod: String(raw.paymentMethod || '').trim(),
    paymentProvider: raw.paymentProvider ? String(raw.paymentProvider) : undefined,
    paymentTransactionId: raw.paymentTransactionId ? String(raw.paymentTransactionId) : undefined,
    shopifyOrderId: raw.shopifyOrderId ? String(raw.shopifyOrderId) : undefined,
    backendRequestId: raw.backendRequestId ? String(raw.backendRequestId) : undefined,
    backendRegistered: raw.backendRegistered === true,
    refundDestinationLabel: raw.refundDestinationLabel
      ? String(raw.refundDestinationLabel)
      : undefined,
    status: normalizeStatus(raw.status),
    createdAt: String(raw.createdAt || now),
    updatedAt: String(raw.updatedAt || now),
  };
}

async function readRequests(customerKey: string): Promise<ReturnRequest[]> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return [];
  }

  try {
    const [returnsRaw, refundRequestsRaw] = await Promise.all([
      AsyncStorage.getItem(returnsKey(normalizedKey)),
      AsyncStorage.getItem(refundRequestsKey(normalizedKey)),
    ]);

    const source = returnsRaw || refundRequestsRaw;
    if (!source) {
      return [];
    }

    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((entry) => normalizeRequest(entry));
  } catch (error) {
    console.log('Failed to load return requests:', error);
    return [];
  }
}

async function writeRequests(customerKey: string, requests: ReturnRequest[]): Promise<void> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    throw new Error('Missing customer storage key');
  }

  const payload = JSON.stringify(requests);
  await Promise.all([
    AsyncStorage.setItem(returnsKey(normalizedKey), payload),
    AsyncStorage.setItem(refundRequestsKey(normalizedKey), payload),
  ]);
}

export async function getReturnRequests(customerKey: string): Promise<ReturnRequest[]> {
  return readRequests(customerKey);
}

export async function deleteReturnRequest(
  customerKey: string,
  requestId: string
): Promise<boolean> {
  const normalizedKey = String(customerKey || '').trim();
  const normalizedId = String(requestId || '').trim();
  if (!normalizedKey || !normalizedId) {
    return false;
  }

  const existing = await readRequests(normalizedKey);
  const nextRequests = existing.filter(
    (request) => request.id !== normalizedId && request.backendRequestId !== normalizedId
  );

  if (nextRequests.length === existing.length) {
    return false;
  }

  await writeRequests(normalizedKey, nextRequests);
  return true;
}

export async function clearUnconfirmedReturnRequests(customerKey: string): Promise<{
  kept: ReturnRequest[];
  removedCount: number;
}> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return { kept: [], removedCount: 0 };
  }

  const existing = await readRequests(normalizedKey);
  const kept = existing.filter((request) => request.backendRegistered === true);
  const removedCount = existing.length - kept.length;

  if (removedCount > 0) {
    await writeRequests(normalizedKey, kept);
    console.log('[NOOD refund] stale local pending ignored/removed', {
      customerKey: normalizedKey,
      removedCount,
      keptCount: kept.length,
      scope: 'unconfirmed_only',
    });
  }

  return { kept, removedCount };
}

export async function replaceReturnRequests(
  customerKey: string,
  requests: ReturnRequest[]
): Promise<ReturnRequest[]> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return [];
  }

  const normalized = requests.map((entry) => normalizeRequest(entry));
  await writeRequests(normalizedKey, normalized);
  return normalized;
}

export async function resetLocalRefundCache(customerKey: string): Promise<void> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return;
  }

  await writeRequests(normalizedKey, []);
  console.log('[REFUND STALE LOCAL CLEARED]', {
    customerKey: normalizedKey,
    removedCount: 'all',
    action: 'manual_reset',
  });
}

export async function saveReturnRequest(
  customerKey: string,
  request: SaveReturnRequestInput
): Promise<ReturnRequest> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    throw new Error('Missing customer storage key');
  }

  const existing = await readRequests(normalizedKey);
  const now = new Date().toISOString();
  const nextRequest = normalizeRequest({
    id: `${Date.now()}`,
    ...request,
    status: 'pending_review',
    createdAt: now,
    updatedAt: now,
  });

  await writeRequests(normalizedKey, [nextRequest, ...existing]);
  console.log('[RETURN REQUEST SAVED]', {
    requestId: nextRequest.id,
    orderId: nextRequest.orderId,
    scope: 'local',
    status: nextRequest.status,
  });
  return nextRequest;
}

export async function upsertReturnRequest(
  customerKey: string,
  request: ReturnRequest
): Promise<ReturnRequest> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    throw new Error('Missing customer storage key');
  }

  const existing = await readRequests(normalizedKey);
  const matchIndex = existing.findIndex(
    (entry) =>
      entry.id === request.id ||
      (request.backendRequestId && entry.backendRequestId === request.backendRequestId) ||
      (request.backendRequestId && entry.id === request.backendRequestId)
  );

  const nextRequest = normalizeRequest({
    ...(matchIndex >= 0 ? existing[matchIndex] : {}),
    ...request,
    updatedAt: request.updatedAt || new Date().toISOString(),
  });

  const nextRequests =
    matchIndex >= 0
      ? existing.map((entry, index) => (index === matchIndex ? nextRequest : entry))
      : [nextRequest, ...existing];

  await writeRequests(normalizedKey, nextRequests);
  return nextRequest;
}

export async function updateReturnRequest(
  customerKey: string,
  requestId: string,
  updates: Partial<ReturnRequest>
): Promise<ReturnRequest | null> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return null;
  }

  const existing = await readRequests(normalizedKey);
  let updatedRequest: ReturnRequest | null = null;

  const nextRequests = existing.map((request) => {
    if (request.id !== requestId) {
      return request;
    }

    updatedRequest = normalizeRequest({
      ...request,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    return updatedRequest;
  });

  if (!updatedRequest) {
    return null;
  }

  await writeRequests(normalizedKey, nextRequests);
  return updatedRequest;
}

export async function processApprovedWalletRefund(
  customerKey: string,
  requestId: string,
  creditWallet: (amount: number, orderId: string, note: string) => void
): Promise<ReturnRequest | null> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return null;
  }

  const existing = await readRequests(normalizedKey);
  const target = existing.find((request) => request.id === requestId);
  if (!target) {
    return null;
  }

  if (target.refundMethod !== 'wallet') {
    return null;
  }

  if (target.status === 'refunded_to_wallet') {
    return target;
  }

  if (target.status !== 'approved') {
    return null;
  }

  const amount = Number(target.amount || 0);
  if (amount <= 0) {
    return null;
  }

  creditWallet(
    amount,
    target.orderId,
    `Refund for order #${target.orderNumber || target.orderId}`
  );

  return updateReturnRequest(normalizedKey, requestId, {
    status: 'refunded_to_wallet',
  });
}

export function getReturnStatusLabel(status: ReturnRequestStatus): string {
  switch (status) {
    case 'pending_review':
      return 'Pending review';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'refunded_to_wallet':
      return 'Refunded to NOOD Wallet';
    case 'refunded_to_original':
      return 'Refunded to original payment';
    case 'partially_refunded':
      return 'Partially refunded';
    case 'manual_refund_required':
      return 'Manual refund required';
    case 'failed':
      return 'Refund failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending review';
  }
}

export function getReturnStatusColor(status: ReturnRequestStatus): string {
  if (
    status === 'approved' ||
    status === 'refunded_to_wallet' ||
    status === 'refunded_to_original' ||
    status === 'partially_refunded'
  ) {
    return '#22a06b';
  }
  if (status === 'manual_refund_required') {
    return '#5c31ff';
  }
  if (status === 'rejected' || status === 'cancelled' || status === 'failed') {
    return '#d64545';
  }
  return '#ff6a00';
}

export function getRefundMethodLabel(method: RefundMethod): string {
  return method === 'wallet' ? 'NOOD Wallet' : 'Original payment method';
}

export function getRefundDestinationLabel(
  method: RefundMethod,
  explicitLabel?: string
): string {
  const normalized = String(explicitLabel || '').trim();
  if (normalized) {
    return normalized;
  }

  return getRefundMethodLabel(method);
}

export function getRefundRequestHeadline(request: ReturnRequest): string {
  const destination = getRefundDestinationLabel(
    request.refundMethod,
    request.refundDestinationLabel
  );

  if (request.status === 'pending_review') {
    return `Refund requested to ${destination}`;
  }

  return getReturnStatusLabel(request.status);
}