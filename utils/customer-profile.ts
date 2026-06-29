import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ShopifyCustomerAccountProfile } from './shopify-customer-account-api';

export const SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY = 'NOOD_SHOPIFY_CUSTOMER_PROFILE';

export type CustomerProfile = {
  displayName: string;
  firstName?: string;
  lastName?: string;
  email: string;
  shopifyCustomerId?: string;
  signedInAt?: string;
  syncedFromShopifyAt?: string;
  shopifyOrderCount?: number;
  shopifyAddressCount?: number;
};

export function buildCustomerDisplayName(profile: Partial<CustomerProfile>): string {
  const firstName = String(profile.firstName || '').trim();
  const lastName = String(profile.lastName || '').trim();
  const combined = `${firstName} ${lastName}`.trim();

  if (combined) {
    return combined;
  }

  const displayName = String(profile.displayName || '').trim();
  if (displayName) {
    return displayName;
  }

  const email = String(profile.email || '').trim();
  if (email.includes('@')) {
    return email.split('@')[0];
  }

  return '';
}

export function mapShopifyCustomerToProfile(
  shopifyCustomer: ShopifyCustomerAccountProfile,
  existing?: Partial<CustomerProfile>
): CustomerProfile {
  const email = String(shopifyCustomer.email || existing?.email || '').trim();
  const firstName = String(shopifyCustomer.firstName || existing?.firstName || '').trim();
  const lastName = String(shopifyCustomer.lastName || existing?.lastName || '').trim();
  const displayName = buildCustomerDisplayName({
    firstName,
    lastName,
    displayName: shopifyCustomer.displayName || existing?.displayName,
    email,
  });

  return {
    displayName,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    email,
    shopifyCustomerId: String(shopifyCustomer.id || existing?.shopifyCustomerId || '').trim() || undefined,
    signedInAt: existing?.signedInAt || new Date().toISOString(),
    syncedFromShopifyAt: new Date().toISOString(),
    shopifyOrderCount: shopifyCustomer.orderCount,
    shopifyAddressCount: shopifyCustomer.addressCount,
  };
}

export async function saveCustomerProfile(profile: CustomerProfile): Promise<void> {
  const normalized: CustomerProfile = {
    ...profile,
    displayName: buildCustomerDisplayName(profile) || profile.displayName,
    email: String(profile.email || '').trim(),
  };

  await AsyncStorage.setItem(SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
}

export async function clearCustomerProfile(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY);
  } catch (error) {
    console.log('Failed to clear customer profile:', error);
  }
}

export async function getCustomerProfile(): Promise<CustomerProfile | null> {
  try {
    const saved = await AsyncStorage.getItem(SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY);
    if (!saved) {
      return null;
    }

    const parsed = JSON.parse(saved) as Partial<CustomerProfile>;
    const email = String(parsed.email || '').trim();
    const firstName = String(parsed.firstName || '').trim();
    const lastName = String(parsed.lastName || '').trim();
    const displayName = buildCustomerDisplayName({
      displayName: parsed.displayName,
      firstName,
      lastName,
      email,
    });

    if (!displayName && !email) {
      return null;
    }

    const shopifyCustomerId = String(parsed.shopifyCustomerId || '').trim();

    return {
      displayName: displayName || email,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      email,
      shopifyCustomerId: shopifyCustomerId || undefined,
      signedInAt: parsed.signedInAt,
      syncedFromShopifyAt: parsed.syncedFromShopifyAt,
      shopifyOrderCount:
        parsed.shopifyOrderCount !== undefined ? Number(parsed.shopifyOrderCount) : undefined,
      shopifyAddressCount:
        parsed.shopifyAddressCount !== undefined ? Number(parsed.shopifyAddressCount) : undefined,
    };
  } catch (error) {
    console.log('Failed to load customer profile:', error);
    return null;
  }
}