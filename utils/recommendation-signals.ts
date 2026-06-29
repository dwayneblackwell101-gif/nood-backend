import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getRecentlyViewedStorageKey,
  getRecommendationSignalsStorageKey,
} from './customer-storage';

export type RecommendationSignalProduct = {
  handle: string;
  id?: string;
  title?: string;
  tags?: string[];
  productType?: string;
  collectionHandles?: string[];
  vendor?: string;
  savedAt?: string;
};

export type RecommendationSignals = {
  viewed: RecommendationSignalProduct[];
  cart: RecommendationSignalProduct[];
  wishlist: RecommendationSignalProduct[];
  purchased: RecommendationSignalProduct[];
  categories: string[];
  updatedAt: string;
};

const EMPTY_SIGNALS: RecommendationSignals = {
  viewed: [],
  cart: [],
  wishlist: [],
  purchased: [],
  categories: [],
  updatedAt: '',
};

const MAX_VIEWED = 24;
const MAX_SIGNAL_ITEMS = 20;
const MAX_CATEGORIES = 16;

type CustomerScope = {
  profileId: string;
  email?: string;
  isSignedIn?: boolean;
};

function normalizeSignalProduct(product: RecommendationSignalProduct): RecommendationSignalProduct | null {
  const handle = String(product?.handle || '').trim();
  if (!handle) return null;

  return {
    handle,
    id: product.id ? String(product.id) : undefined,
    title: product.title ? String(product.title) : undefined,
    tags: Array.isArray(product.tags) ? product.tags.map(String) : [],
    productType: product.productType ? String(product.productType) : undefined,
    collectionHandles: Array.isArray(product.collectionHandles)
      ? product.collectionHandles.map(String)
      : [],
    vendor: product.vendor ? String(product.vendor) : undefined,
    savedAt: product.savedAt || new Date().toISOString(),
  };
}

function upsertSignalItem(
  list: RecommendationSignalProduct[],
  item: RecommendationSignalProduct,
  limit: number
) {
  const normalized = normalizeSignalProduct(item);
  if (!normalized) return list;

  const next = [normalized, ...list.filter((entry) => entry.handle !== normalized.handle)];
  return next.slice(0, limit);
}

async function persistSignals(scope: CustomerScope, signals: RecommendationSignals) {
  const storageKey = getRecommendationSignalsStorageKey(
    scope.profileId,
    scope.email,
    scope.isSignedIn
  );
  await AsyncStorage.setItem(storageKey, JSON.stringify(signals));
}

export async function loadRecommendationSignals(
  scope: CustomerScope
): Promise<RecommendationSignals> {
  try {
    const storageKey = getRecommendationSignalsStorageKey(
      scope.profileId,
      scope.email,
      scope.isSignedIn
    );
    const saved = await AsyncStorage.getItem(storageKey);
    if (!saved) return { ...EMPTY_SIGNALS };

    const parsed = JSON.parse(saved) as Partial<RecommendationSignals>;
    return {
      viewed: Array.isArray(parsed.viewed) ? parsed.viewed : [],
      cart: Array.isArray(parsed.cart) ? parsed.cart : [],
      wishlist: Array.isArray(parsed.wishlist) ? parsed.wishlist : [],
      purchased: Array.isArray(parsed.purchased) ? parsed.purchased : [],
      categories: Array.isArray(parsed.categories) ? parsed.categories.map(String) : [],
      updatedAt: String(parsed.updatedAt || ''),
    };
  } catch (error) {
    console.log('Recommendation signals load error:', error);
    return { ...EMPTY_SIGNALS };
  }
}

export async function recordProductView(
  scope: CustomerScope,
  product: RecommendationSignalProduct
) {
  const normalized = normalizeSignalProduct(product);
  if (!normalized) return;

  const [signals, recentlyViewedKey] = await Promise.all([
    loadRecommendationSignals(scope),
    Promise.resolve(
      getRecentlyViewedStorageKey(scope.profileId, scope.email, scope.isSignedIn)
    ),
  ]);

  const nextSignals: RecommendationSignals = {
    ...signals,
    viewed: upsertSignalItem(signals.viewed, normalized, MAX_VIEWED),
    updatedAt: new Date().toISOString(),
  };

  await Promise.all([
    persistSignals(scope, nextSignals),
    AsyncStorage.setItem(recentlyViewedKey, JSON.stringify(nextSignals.viewed)),
  ]);
}

export async function recordCartProduct(
  scope: CustomerScope,
  product: RecommendationSignalProduct
) {
  const normalized = normalizeSignalProduct(product);
  if (!normalized) return;

  const signals = await loadRecommendationSignals(scope);
  const nextSignals: RecommendationSignals = {
    ...signals,
    cart: upsertSignalItem(signals.cart, normalized, MAX_SIGNAL_ITEMS),
    updatedAt: new Date().toISOString(),
  };

  await persistSignals(scope, nextSignals);
}

export async function recordWishlistProduct(
  scope: CustomerScope,
  product: RecommendationSignalProduct
) {
  const normalized = normalizeSignalProduct(product);
  if (!normalized) return;

  const signals = await loadRecommendationSignals(scope);
  const nextSignals: RecommendationSignals = {
    ...signals,
    wishlist: upsertSignalItem(signals.wishlist, normalized, MAX_SIGNAL_ITEMS),
    updatedAt: new Date().toISOString(),
  };

  await persistSignals(scope, nextSignals);
}

export async function recordPurchasedProducts(
  scope: CustomerScope,
  products: RecommendationSignalProduct[]
) {
  const normalizedProducts = products
    .map((product) => normalizeSignalProduct(product))
    .filter((product): product is RecommendationSignalProduct => Boolean(product));

  if (!normalizedProducts.length) return;

  const signals = await loadRecommendationSignals(scope);
  let purchased = [...signals.purchased];

  normalizedProducts.forEach((product) => {
    purchased = upsertSignalItem(purchased, product, MAX_SIGNAL_ITEMS);
  });

  const nextSignals: RecommendationSignals = {
    ...signals,
    purchased,
    updatedAt: new Date().toISOString(),
  };

  await persistSignals(scope, nextSignals);
}

export async function recordCategoryBrowse(
  scope: CustomerScope,
  collectionHandle: string,
  title?: string
) {
  const handle = String(collectionHandle || '').trim();
  if (!handle) return;

  const signals = await loadRecommendationSignals(scope);
  const categories = [handle, ...signals.categories.filter((entry) => entry !== handle)].slice(
    0,
    MAX_CATEGORIES
  );

  const nextSignals: RecommendationSignals = {
    ...signals,
    categories,
    updatedAt: new Date().toISOString(),
  };

  if (title) {
    void title;
  }

  await persistSignals(scope, nextSignals);
}