import { loadAccountRecommendations } from './account-recommendations';
import type { CatalogListProduct } from './catalog-product-mapper';
import { loadRecommendationSignals } from './recommendation-signals';

export type WishlistRecommendationResult = {
  products: CatalogListProduct[];
  sectionTitle: string;
  status: 'ready' | 'cached' | 'error' | 'empty';
};

type WishlistRecommendationContext = {
  profileId?: string;
  email?: string;
  isSignedIn?: boolean;
  cartItems?: any[];
  orders?: any[];
};

function resolveSectionTitle(viewedCount: number, hasProducts: boolean) {
  if (viewedCount >= 2) {
    return 'Recommended for you';
  }

  if (viewedCount > 0) {
    return 'Recently viewed';
  }

  if (hasProducts) {
    return 'Popular right now';
  }

  return 'Recommended for you';
}

export async function loadWishlistRecommendations(
  context: WishlistRecommendationContext
): Promise<WishlistRecommendationResult> {
  const scope = {
    profileId: context.profileId || 'guest',
    email: context.email || '',
    isSignedIn: Boolean(context.isSignedIn),
  };

  try {
    const [result, signals] = await Promise.all([
      loadAccountRecommendations({
        profileId: scope.profileId,
        email: scope.email,
        isSignedIn: scope.isSignedIn,
        cartItems: context.cartItems || [],
        orders: context.orders || [],
      }),
      loadRecommendationSignals(scope),
    ]);

    const products = Array.isArray(result.products) ? result.products.slice(0, 8) : [];
    const sectionTitle = resolveSectionTitle(signals.viewed.length, products.length > 0);

    if (!products.length) {
      return {
        products: [],
        sectionTitle,
        status: 'empty',
      };
    }

    return {
      products,
      sectionTitle,
      status: result.status,
    };
  } catch (error) {
    console.log('Wishlist recommendations error:', error);
    return {
      products: [],
      sectionTitle: 'Recommended for you',
      status: 'error',
    };
  }
}