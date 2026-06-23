import type { ShippingAddress } from '../context/AddressContext';

type CustomerProfileInput = {
  defaultAddress?: ShippingAddress | null;
  displayName?: string;
  isSignedIn?: boolean;
};

export function getCheckoutCustomer({
  defaultAddress,
  displayName,
  isSignedIn,
}: CustomerProfileInput) {
  const addressEmail = String((defaultAddress as any)?.email || '').trim();
  const nameFromAddress = String(defaultAddress?.fullName || '').trim();
  const nameFromProfile = isSignedIn ? String(displayName || '').trim() : '';

  return {
    name: nameFromAddress || nameFromProfile || 'NOOD Customer',
    email: addressEmail,
    phone: String(defaultAddress?.phone || '').trim(),
  };
}

export function getPaymentTestingEmail(email?: string) {
  const normalizedEmail = String(email || '').trim();
  return normalizedEmail || 'guest@nood-testing.local';
}
