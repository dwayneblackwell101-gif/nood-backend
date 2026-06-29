import { navigateAfterAuthSignIn } from './auth-navigation';
import { processShopifyAuthCallback } from './shopify-auth-session';

type ShopifyAuthHandlerOptions = {
  markSignedIn: (displayName?: string) => Promise<void>;
  addHistoryEvent?: (event: {
    type: 'account';
    title: string;
    description: string;
    status: string;
  }) => Promise<void>;
};

export async function handleShopifyAuthRedirectUrl(
  url: string,
  options: ShopifyAuthHandlerOptions
) {
  return processShopifyAuthCallback({
    sourceUrl: url,
    markSignedIn: options.markSignedIn,
    addHistoryEvent: options.addHistoryEvent,
    redirectToAccount: () => {
      navigateAfterAuthSignIn();
    },
  });
}