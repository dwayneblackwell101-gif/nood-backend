import type { ShippingAddress } from '../context/AddressContext';
import { isValidCheckoutEmail, resolveCheckoutEmail } from './customer';
import { PAYMENT_TESTING_MODE } from './payment-testing';

export function getCartItemsMissingVariantIds(cartItems: any[] = []) {
  return cartItems.filter((item) => !String(item?.variantId || '').trim());
}

export function getCartItemsWithInvalidQuantityOrPrice(cartItems: any[] = []) {
  return cartItems.filter((item) => {
    const quantity = Number(item?.quantity);
    const price = Number(item?.price);
    return (
      !Number.isFinite(quantity) ||
      quantity < 1 ||
      !Number.isFinite(price) ||
      price <= 0
    );
  });
}

export function hasCompleteShippingAddress(address?: ShippingAddress | null) {
  if (!address) return false;

  return Boolean(
    String(address.fullName || '').trim() &&
      String(address.phone || '').trim() &&
      String(address.address1 || '').trim() &&
      String(address.city || '').trim() &&
      String(address.region || '').trim()
  );
}

export function resolveCheckoutCustomerEmail(
  defaultAddress?: ShippingAddress | null,
  profileEmail?: string
) {
  return resolveCheckoutEmail(profileEmail, (defaultAddress as any)?.email);
}

export type CheckoutValidationResult = {
  ok: boolean;
  title?: string;
  message?: string;
  actionLabel?: string;
  actionRoute?: string;
};

export function validateCheckoutPrerequisites(options: {
  cartItems: any[];
  defaultAddress?: ShippingAddress | null;
  profileEmail?: string;
  loadingAddresses?: boolean;
  requireEmail?: boolean;
}): CheckoutValidationResult {
  const {
    cartItems = [],
    defaultAddress,
    profileEmail,
    loadingAddresses = false,
    requireEmail = !PAYMENT_TESTING_MODE,
  } = options;

  if (!cartItems.length) {
    return { ok: false, title: 'Cart is empty', message: 'Add items before checking out.' };
  }

  if (getCartItemsMissingVariantIds(cartItems).length) {
    return {
      ok: false,
      title: 'Product needs to be re-added',
      message:
        'One or more cart items is missing its Shopify variant ID. Please remove it and add it again before checkout.',
    };
  }

  if (getCartItemsWithInvalidQuantityOrPrice(cartItems).length) {
    return {
      ok: false,
      title: 'Product needs to be re-added',
      message:
        'One or more cart items has an invalid quantity or price. Please remove it and add it again before checkout.',
    };
  }

  if (loadingAddresses) {
    return {
      ok: false,
      title: 'Address loading',
      message: 'Please wait while your saved address is loading.',
    };
  }

  if (!hasCompleteShippingAddress(defaultAddress)) {
    return {
      ok: false,
      title: 'Shipping address required',
      message: 'Please add your shipping address before checkout.',
      actionLabel: 'Add address',
      actionRoute: '/account/address',
    };
  }

  if (requireEmail) {
    const email = resolveCheckoutCustomerEmail(defaultAddress, profileEmail);
    if (!isValidCheckoutEmail(email)) {
      return {
        ok: false,
        title: 'Email required',
        message:
          'Sign in with your Shopify account so we can use your profile email for checkout and order updates.',
        actionLabel: 'Sign in',
        actionRoute: '/account/auth',
      };
    }
  }

  return { ok: true };
}

export const PAYMENT_REVIEW_MESSAGE =
  'Payment received, but your order needs review. Please contact NOOD support with this transaction ID.';