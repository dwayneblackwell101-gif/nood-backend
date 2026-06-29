import AsyncStorage from '@react-native-async-storage/async-storage';
import { getWishlistStorageKey } from './customer-storage';

export const LEGACY_WISHLIST_STORAGE_KEY = 'NOOD_WISHLIST';

export type WishlistItem = {
  id?: string;
  handle?: string;
  title?: string;
  image?: string;
  price?: number;
  baseCurrency?: string;
  size?: string;
  color?: string;
  variantId?: string;
  variantTitle?: string;
  quantity?: number;
  savedAt?: string;
  [key: string]: unknown;
};

export function getWishlistItemKey(item: WishlistItem): string {
  return String(item?.handle || item?.id || '').trim();
}

async function migrateLegacyWishlistForGuest(customerKey: string): Promise<WishlistItem[] | null> {
  if (!customerKey.includes('guest')) {
    return null;
  }

  try {
    const scopedKey = getWishlistStorageKey(customerKey);
    const [scopedRaw, legacyRaw] = await Promise.all([
      AsyncStorage.getItem(scopedKey),
      AsyncStorage.getItem(LEGACY_WISHLIST_STORAGE_KEY),
    ]);

    if (scopedRaw || !legacyRaw) {
      return null;
    }

    const parsed = JSON.parse(legacyRaw);
    const items = Array.isArray(parsed) ? parsed : [];
    await AsyncStorage.setItem(scopedKey, JSON.stringify(items));
    await AsyncStorage.removeItem(LEGACY_WISHLIST_STORAGE_KEY);
    return items;
  } catch (error) {
    console.log('Wishlist legacy migration error:', error);
    return null;
  }
}

export async function getWishlistItems(customerKey: string): Promise<WishlistItem[]> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return [];
  }

  try {
    const storageKey = getWishlistStorageKey(normalizedKey);
    let saved = await AsyncStorage.getItem(storageKey);

    if (!saved) {
      const migrated = await migrateLegacyWishlistForGuest(normalizedKey);
      if (migrated) {
        return migrated;
      }
    }

    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.log('Wishlist load error:', error);
    return [];
  }
}

export async function saveWishlistItems(customerKey: string, items: WishlistItem[]): Promise<void> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return;
  }

  await AsyncStorage.setItem(getWishlistStorageKey(normalizedKey), JSON.stringify(items));
}

export async function removeWishlistItem(
  customerKey: string,
  itemKey: string
): Promise<WishlistItem[]> {
  const items = await getWishlistItems(customerKey);
  const next = items.filter((item) => getWishlistItemKey(item) !== itemKey);
  await saveWishlistItems(customerKey, next);
  return next;
}

export async function addWishlistItem(
  customerKey: string,
  item: WishlistItem
): Promise<{ items: WishlistItem[]; alreadySaved: boolean }> {
  const normalizedKey = String(customerKey || '').trim();
  if (!normalizedKey) {
    return { items: [], alreadySaved: false };
  }

  const items = await getWishlistItems(normalizedKey);
  const itemKey = getWishlistItemKey(item);
  const alreadySaved = items.some((entry) => getWishlistItemKey(entry) === itemKey);

  if (alreadySaved) {
    return { items, alreadySaved: true };
  }

  const next = [
    {
      ...item,
      quantity: 1,
      savedAt: new Date().toISOString(),
    },
    ...items,
  ];

  await saveWishlistItems(normalizedKey, next);
  return { items: next, alreadySaved: false };
}