export function resolveCustomerStorageKey(
  profileId: string,
  email = '',
  isSignedIn = false
): string {
  const normalizedProfileId = String(profileId || '').trim();
  const normalizedEmail = String(email || '').trim();

  if (isSignedIn) {
    return normalizedProfileId || normalizedEmail || 'member';
  }

  return normalizedProfileId || 'guest';
}

export function getHistoryStorageKey(profileId: string, email = '', isSignedIn = false) {
  return `history:${resolveCustomerStorageKey(profileId, email, isSignedIn)}`;
}

export function getAddressesStorageKey(profileId: string, email = '', isSignedIn = false) {
  return `addresses:${resolveCustomerStorageKey(profileId, email, isSignedIn)}`;
}

export function getRecentlyViewedStorageKey(profileId: string, email = '', isSignedIn = false) {
  return `recentlyViewed:${resolveCustomerStorageKey(profileId, email, isSignedIn)}`;
}

export function getRecommendationSignalsStorageKey(
  profileId: string,
  email = '',
  isSignedIn = false
) {
  return `recommendationSignals:${resolveCustomerStorageKey(profileId, email, isSignedIn)}`;
}

export function getOrdersStorageKey(profileId: string, email = '', isSignedIn = false) {
  if (!isSignedIn) {
    return '';
  }

  return `orders:${resolveCustomerStorageKey(profileId, email, isSignedIn)}`;
}

export function getCartStorageKey(profileId: string, email = '', isSignedIn = false) {
  return `NOOD_CART:${resolveCustomerStorageKey(profileId, email, isSignedIn)}`;
}

export function getWishlistStorageKey(customerKey: string) {
  return `NOOD_WISHLIST:${String(customerKey || '').trim()}`;
}

export function getLuckySpinStorageKey(customerKey: string) {
  return `NOOD_LUCKY_SPIN_DAILY_LIMIT_V1:${String(customerKey || '').trim()}`;
}