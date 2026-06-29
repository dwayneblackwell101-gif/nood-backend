import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCustomerStorageKey } from './return-requests';

export type CustomerReviewStatus = 'pending_upload' | 'published';

export type CustomerReview = {
  id: string;
  profileId: string;
  orderId: string;
  orderItemId: string;
  productId?: string;
  title: string;
  reviewTitle?: string;
  image?: string;
  handle: string;
  variantTitle?: string;
  rating: number;
  comment: string;
  photoUri?: string;
  status: CustomerReviewStatus;
  submittedAt: string;
};

export type ReviewableOrderItem = {
  id: string;
  orderItemId: string;
  orderId: string;
  title: string;
  image?: string;
  handle: string;
  variantTitle?: string;
  orderDate: string;
  orderStatus: string;
};

const LEGACY_REVIEWS_PREFIX = 'NOOD_CUSTOMER_REVIEWS';

const reviewsKey = (customerKey: string) => `reviews:${customerKey}`;
const pendingReviewsKey = (customerKey: string) => `pendingReviews:${customerKey}`;

function normalizeReview(raw: Partial<CustomerReview>, profileId: string): CustomerReview | null {
  const orderId = String(raw?.orderId || '').trim();
  const orderItemId = String(raw?.orderItemId || '').trim();
  const handle = String(raw?.handle || '').trim();

  if (!orderId || !orderItemId || !handle) {
    return null;
  }

  const status = raw?.status === 'published' ? 'published' : 'pending_upload';

  return {
    id: String(raw?.id || `${profileId}:${orderId}:${orderItemId}`),
    profileId: String(raw?.profileId || profileId),
    orderId,
    orderItemId,
    productId: raw?.productId ? String(raw.productId) : undefined,
    title: String(raw?.title || 'Purchased item'),
    reviewTitle: raw?.reviewTitle ? String(raw.reviewTitle).trim() : undefined,
    image: raw?.image ? String(raw.image) : undefined,
    handle,
    variantTitle: raw?.variantTitle ? String(raw.variantTitle) : undefined,
    rating: Math.min(5, Math.max(1, Number(raw?.rating || 5))),
    comment: String(raw?.comment || '').trim(),
    photoUri: raw?.photoUri ? String(raw.photoUri) : undefined,
    status,
    submittedAt: String(raw?.submittedAt || new Date().toISOString()),
  };
}

async function syncPendingReviewsIndex(customerKey: string, reviews: CustomerReview[]) {
  const pending = reviews.filter((review) => review.status === 'pending_upload');
  await AsyncStorage.setItem(pendingReviewsKey(customerKey), JSON.stringify(pending));
}

async function loadLegacyReviews(profileId: string): Promise<CustomerReview[]> {
  try {
    const saved = await AsyncStorage.getItem(`${LEGACY_REVIEWS_PREFIX}:${profileId}`);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) =>
        normalizeReview(
          {
            ...entry,
            status: 'pending_upload',
          },
          profileId
        )
      )
      .filter(Boolean) as CustomerReview[];
  } catch {
    return [];
  }
}

export function getOrderItemReviewId(orderId: string, item: any, index: number) {
  const rawItemId = String(
    item?.reviewItemId ||
      item?.lineItemId ||
      item?.id ||
      item?.variantId ||
      item?.productId ||
      `item-${index}`
  );

  return `${orderId}:${rawItemId}:${index}`;
}

export function isReviewEligibleOrder(order: any) {
  if (order?.refunded) {
    return false;
  }

  const status = String(order?.status || order?.fulfillmentStatus || '').toLowerCase();
  if (status.includes('cancel') || status.includes('refund') || status.includes('failed')) {
    return false;
  }

  return (
    status.includes('delivered') ||
    status.includes('complete') ||
    status.includes('fulfilled') ||
    status.includes('shipped') ||
    status.includes('paid') ||
    status.includes('processing')
  );
}

export function getReviewableItemsFromOrders(orders: any[]): ReviewableOrderItem[] {
  return (Array.isArray(orders) ? orders : [])
    .filter(isReviewEligibleOrder)
    .flatMap((order) => {
      const orderId = String(order?.id || '').trim();
      const orderItems = Array.isArray(order?.items) ? order.items : [];

      return orderItems
        .map((item: any, index: number) => {
          const handle = String(item?.handle || item?.productHandle || '').trim();
          if (!handle) {
            return null;
          }

          return {
            id: getOrderItemReviewId(orderId, item, index),
            orderItemId: getOrderItemReviewId(orderId, item, index),
            orderId,
            title: String(item?.title || 'Purchased item'),
            image: String(item?.image || item?.featuredImage || item?.thumbnail || '').trim() || undefined,
            handle,
            variantTitle: item?.variantTitle ? String(item.variantTitle) : undefined,
            orderDate: String(order?.deliveredAt || order?.date || ''),
            orderStatus: String(order?.status || 'Processing'),
          };
        })
        .filter(Boolean) as ReviewableOrderItem[];
    });
}

export async function getCustomerReviews(
  profileId: string,
  email = '',
  isSignedIn = false
): Promise<CustomerReview[]> {
  const customerKey = getCustomerStorageKey(profileId, email, isSignedIn);
  if (!customerKey) {
    return [];
  }

  try {
    const saved = await AsyncStorage.getItem(reviewsKey(customerKey));
    let parsed: CustomerReview[] = [];

    if (saved) {
      const raw = JSON.parse(saved);
      if (Array.isArray(raw)) {
        parsed = raw
          .map((entry) => normalizeReview(entry, profileId))
          .filter(Boolean) as CustomerReview[];
      }
    }

    if (!parsed.length) {
      const legacy = await loadLegacyReviews(profileId);
      if (legacy.length) {
        parsed = legacy;
        await saveCustomerReviews(profileId, email, isSignedIn, parsed);
      }
    }

    return parsed.sort(
      (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );
  } catch (error) {
    console.log('Failed to load customer reviews:', error);
    return [];
  }
}

export async function saveCustomerReviews(
  profileId: string,
  email: string,
  isSignedIn: boolean,
  reviews: CustomerReview[]
) {
  const customerKey = getCustomerStorageKey(profileId, email, isSignedIn);
  if (!customerKey) {
    return;
  }

  const normalized = reviews
    .map((entry) => normalizeReview(entry, profileId))
    .filter(Boolean) as CustomerReview[];

  await AsyncStorage.setItem(reviewsKey(customerKey), JSON.stringify(normalized));
  await syncPendingReviewsIndex(customerKey, normalized);
}

export async function submitCustomerReview(input: {
  profileId: string;
  email?: string;
  isSignedIn: boolean;
  orderId: string;
  orderItemId: string;
  productId?: string;
  title: string;
  reviewTitle?: string;
  image?: string;
  handle: string;
  variantTitle?: string;
  rating: number;
  comment: string;
  photoUri?: string;
}): Promise<CustomerReview> {
  const {
    profileId,
    email = '',
    isSignedIn,
    orderId,
    orderItemId,
    productId,
    title,
    reviewTitle,
    image,
    handle,
    variantTitle,
    rating,
    comment,
    photoUri,
  } = input;

  const existing = await getCustomerReviews(profileId, email, isSignedIn);
  const publishedRemotely = await trySubmitReviewToJudgeMe({
    handle,
    rating,
    comment,
    reviewTitle,
    email,
  });

  const nextReview: CustomerReview = {
    id: `${profileId}:${orderId}:${orderItemId}`,
    profileId,
    orderId,
    orderItemId,
    productId,
    title,
    reviewTitle: reviewTitle?.trim() || undefined,
    image,
    handle,
    variantTitle,
    rating: Math.min(5, Math.max(1, rating)),
    comment: comment.trim(),
    photoUri,
    status: publishedRemotely ? 'published' : 'pending_upload',
    submittedAt: new Date().toISOString(),
  };

  const nextReviews = [
    nextReview,
    ...existing.filter((review) => review.orderItemId !== orderItemId),
  ];

  await saveCustomerReviews(profileId, email, isSignedIn, nextReviews);
  return nextReview;
}

async function trySubmitReviewToJudgeMe(_input: {
  handle: string;
  rating: number;
  comment: string;
  reviewTitle?: string;
  email?: string;
}): Promise<boolean> {
  // Judge.me write API is not connected in this app build yet.
  return false;
}

export function getReviewStatusLabel(status: CustomerReviewStatus) {
  return status === 'published' ? 'Published' : 'Saved on device — not published yet';
}

export function getReviewStatusColor(status: CustomerReviewStatus) {
  return status === 'published' ? '#2f9d63' : '#b35a12';
}