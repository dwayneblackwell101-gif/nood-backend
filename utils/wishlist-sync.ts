import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveCustomerStorageKey } from './customer-storage';
import {
  getWishlistItemKey,
  getWishlistItems,
  saveWishlistItems,
  type WishlistItem,
} from './wishlist-storage';

const GUEST_PROFILE_ID_KEY = 'USER_GUEST_PROFILE_ID';

function dedupeWishlistItems(items: WishlistItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getWishlistItemKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveGuestCustomerKey(): Promise<string> {
  const guestProfileId = String((await AsyncStorage.getItem(GUEST_PROFILE_ID_KEY)) || '').trim();
  return resolveCustomerStorageKey(guestProfileId || 'guest', '', false);
}

export async function mergeGuestWishlistIntoMember(
  memberCustomerKey: string
): Promise<WishlistItem[]> {
  const normalizedMemberKey = String(memberCustomerKey || '').trim();
  if (!normalizedMemberKey) {
    return [];
  }

  const guestCustomerKey = await resolveGuestCustomerKey();
  if (!guestCustomerKey || guestCustomerKey === normalizedMemberKey) {
    return getWishlistItems(normalizedMemberKey);
  }

  const [guestItems, memberItems] = await Promise.all([
    getWishlistItems(guestCustomerKey),
    getWishlistItems(normalizedMemberKey),
  ]);

  if (!guestItems.length) {
    return memberItems;
  }

  const memberKeys = new Set(memberItems.map((item) => getWishlistItemKey(item)).filter(Boolean));
  const incoming = guestItems.filter((item) => {
    const key = getWishlistItemKey(item);
    return key && !memberKeys.has(key);
  });

  const merged = dedupeWishlistItems([...memberItems, ...incoming]);
  await saveWishlistItems(normalizedMemberKey, merged);
  await saveWishlistItems(guestCustomerKey, []);
  return merged;
}

export type WishlistRemoteSyncResult = {
  synced: boolean;
  reason?: string;
  itemCount?: number;
};

export async function syncWishlistToCustomerAccount(params: {
  memberCustomerKey: string;
  accessToken?: string;
  customerId?: string;
}): Promise<WishlistRemoteSyncResult> {
  const memberCustomerKey = String(params.memberCustomerKey || '').trim();
  if (!memberCustomerKey) {
    return { synced: false, reason: 'missing-member-key' };
  }

  const items = await getWishlistItems(memberCustomerKey);

  if (!params.accessToken || !params.customerId) {
    return {
      synced: false,
      reason: 'remote-sync-not-configured',
      itemCount: items.length,
    };
  }

  // Prepared hook for Shopify Customer Account metafields / saved-items API.
  return {
    synced: false,
    reason: 'remote-sync-not-implemented',
    itemCount: items.length,
  };
}