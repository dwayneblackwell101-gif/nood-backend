import type { ShippingAddress } from '../context/AddressContext';
import { PAYMENT_TEST_CUSTOMER_EMAIL, PAYMENT_TESTING_MODE } from './payment-testing';

type CustomerProfileInput = {
  defaultAddress?: ShippingAddress | null;
  displayName?: string;
  isSignedIn?: boolean;
};

export function resolveCheckoutEmail(
  profileEmail?: string,
  addressEmail?: string,
  preferProfileEmail = false
) {
  const normalizedProfileEmail = String(profileEmail || '').trim();
  const normalizedAddressEmail = String(addressEmail || '').trim();

  if (preferProfileEmail) {
    return normalizedProfileEmail || normalizedAddressEmail;
  }

  return normalizedAddressEmail || normalizedProfileEmail;
}

export function isValidCheckoutEmail(email?: string) {
  const normalized = String(email || '').trim();
  if (!normalized) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function getCheckoutCustomer({
  defaultAddress,
  displayName,
  isSignedIn,
  profileEmail,
}: CustomerProfileInput & { profileEmail?: string }) {
  const nameFromAddress = String(defaultAddress?.fullName || '').trim();
  const nameFromProfile = isSignedIn ? String(displayName || '').trim() : '';

  return {
    name: nameFromAddress || nameFromProfile || 'NOOD Customer',
    email: resolveCheckoutEmail(profileEmail, (defaultAddress as any)?.email, Boolean(isSignedIn)),
    phone: String(defaultAddress?.phone || '').trim(),
  };
}

export function getPaymentCustomerEmail(email?: string) {
  const normalizedEmail = String(email || '').trim();
  if (isValidCheckoutEmail(normalizedEmail)) {
    return normalizedEmail;
  }

  return PAYMENT_TESTING_MODE ? PAYMENT_TEST_CUSTOMER_EMAIL : '';
}
