import { loadAccountRecommendations } from './account-recommendations';
import type { CatalogListProduct } from './catalog-product-mapper';

export type CartRecommendationResult = {
  products: CatalogListProduct[];
  status: 'ready' | 'cached' | 'error' | 'empty';
};

type CartRecommendationContext = {
  profileId?: string;
  email?: string;
  isSignedIn?: boolean;
  cartItems?: any[];
  orders?: any[];
};

export async function loadCartRecommendations(
  context: CartRecommendationContext
): Promise<CartRecommendationResult> {
  const cartHandles = new Set(
    (context.cartItems || [])
      .map((item) => String(item?.handle || '').trim())
      .filter(Boolean)
  );

  try {
    const result = await loadAccountRecommendations({
      profileId: context.profileId || 'guest',
      email: context.email || '',
      isSignedIn: Boolean(context.isSignedIn),
      cartItems: context.cartItems || [],
      orders: context.orders || [],
    });

    const products = result.products
      .filter((product) => product.handle && !cartHandles.has(product.handle))
      .slice(0, 8);

    if (!products.length) {
      return { products: [], status: 'empty' };
    }

    return {
      products,
      status: result.status,
    };
  } catch (error) {
    console.log('Cart recommendations error:', error);
    return { products: [], status: 'error' };
  }
}