import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from './UserContext';
import { useHistoryEvents } from './HistoryContext';
import { getCustomerProfile } from '../utils/customer-profile';
import { getAddressesStorageKey } from '../utils/customer-storage';

const LEGACY_ADDRESS_PREFIX = 'NOOD_ADDRESS_BOOK_V1';

export type ShippingAddress = {
  id: string;
  fullName: string;
  phone: string;
  address1: string;
  address2?: string;
  city: string;
  region: string;
  country: string;
  postalCode?: string;
  notes?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

type AddressInput = Omit<ShippingAddress, 'id' | 'isDefault' | 'createdAt' | 'updatedAt'> & {
  isDefault?: boolean;
};

type AddressContextValue = {
  addresses: ShippingAddress[];
  defaultAddress: ShippingAddress | null;
  loadingAddresses: boolean;
  isDeviceLocal: boolean;
  addAddress: (address: AddressInput) => Promise<void>;
  updateAddress: (id: string, address: AddressInput) => Promise<void>;
  deleteAddress: (id: string) => Promise<void>;
  setDefaultAddress: (id: string) => Promise<void>;
};

const AddressContext = createContext<AddressContextValue | null>(null);

const normalizeAddress = (address: ShippingAddress): ShippingAddress => ({
  ...address,
  fullName: String(address.fullName || '').trim(),
  phone: String(address.phone || '').trim(),
  address1: String(address.address1 || '').trim(),
  address2: String(address.address2 || '').trim(),
  city: String(address.city || '').trim(),
  region: String(address.region || '').trim(),
  country: String(address.country || address.region || '').trim(),
  postalCode: String(address.postalCode || '').trim(),
  notes: String(address.notes || '').trim(),
});

async function loadLegacyAddresses(profileId: string): Promise<ShippingAddress[]> {
  try {
    const saved = await AsyncStorage.getItem(`${LEGACY_ADDRESS_PREFIX}:${profileId || 'guest'}`);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((entry) =>
      normalizeAddress({
        ...entry,
        country: entry?.country || entry?.region || '',
      })
    );
  } catch {
    return [];
  }
}

export function AddressProvider({ children }: { children: React.ReactNode }) {
  const { profileId, isReady, isSignedIn, settings } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const [addresses, setAddresses] = useState<ShippingAddress[]>([]);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [customerEmail, setCustomerEmail] = useState('');

  const storageKey = useMemo(
    () => (profileId ? getAddressesStorageKey(profileId, customerEmail, isSignedIn) : ''),
    [customerEmail, isSignedIn, profileId]
  );

  useEffect(() => {
    if (!isSignedIn) {
      setCustomerEmail('');
      return;
    }

    void getCustomerProfile().then((profile) => {
      setCustomerEmail(profile?.email || '');
    });
  }, [isSignedIn]);

  useEffect(() => {
    let isMounted = true;

    const loadAddresses = async () => {
      if (!isReady || !profileId || !storageKey) {
        return;
      }

      try {
        setLoadingAddresses(true);
        const saved = await AsyncStorage.getItem(storageKey);
        let parsed: ShippingAddress[] = saved ? JSON.parse(saved) : [];

        if (!Array.isArray(parsed) || !parsed.length) {
          const legacy = await loadLegacyAddresses(profileId);
          if (legacy.length) {
            parsed = legacy;
            await AsyncStorage.setItem(storageKey, JSON.stringify(legacy));
          }
        }

        if (isMounted) {
          setAddresses(
            Array.isArray(parsed)
              ? parsed.map((entry) =>
                  normalizeAddress({
                    ...entry,
                    country: entry.country || settings.country || entry.region || '',
                  })
                )
              : []
          );
        }
      } catch (error) {
        console.log('Address load error:', error);
        if (isMounted) {
          setAddresses([]);
        }
      } finally {
        if (isMounted) {
          setLoadingAddresses(false);
        }
      }
    };

    void loadAddresses();

    return () => {
      isMounted = false;
    };
  }, [isReady, isSignedIn, profileId, settings.country, storageKey]);

  const persistAddresses = useCallback(
    async (nextAddresses: ShippingAddress[]) => {
      if (!storageKey) {
        setAddresses([]);
        return;
      }

      setAddresses(nextAddresses);
      await AsyncStorage.setItem(storageKey, JSON.stringify(nextAddresses));
    },
    [storageKey]
  );

  const addAddress = useCallback(
    async (address: AddressInput) => {
      const now = new Date().toISOString();
      const shouldBeDefault = address.isDefault || addresses.length === 0;
      const nextAddress = normalizeAddress({
        ...address,
        id: `${Date.now()}`,
        country: address.country || settings.country || address.region || '',
        isDefault: shouldBeDefault,
        createdAt: now,
        updatedAt: now,
      });

      const nextAddresses = [
        nextAddress,
        ...addresses.map((item) => ({
          ...item,
          isDefault: shouldBeDefault ? false : item.isDefault,
        })),
      ];

      await persistAddresses(nextAddresses);
      void addHistoryEvent({
        type: 'address',
        title: 'Address added',
        description: `${nextAddress.fullName} - ${nextAddress.city}, ${nextAddress.country}`,
        status: nextAddress.isDefault ? 'default' : 'saved',
        relatedId: nextAddress.id,
        date: nextAddress.createdAt,
      });
    },
    [addHistoryEvent, addresses, persistAddresses, settings.country]
  );

  const updateAddress = useCallback(
    async (id: string, address: AddressInput) => {
      const shouldBeDefault = !!address.isDefault;
      let nextAddresses = addresses.map((item) =>
        item.id === id
          ? normalizeAddress({
              ...item,
              ...address,
              country: address.country || item.country || settings.country || '',
              isDefault: shouldBeDefault || item.isDefault,
              updatedAt: new Date().toISOString(),
            })
          : {
              ...item,
              isDefault: shouldBeDefault ? false : item.isDefault,
            }
      );

      if (!nextAddresses.some((item) => item.isDefault) && nextAddresses.length) {
        nextAddresses = nextAddresses.map((item, index) => ({ ...item, isDefault: index === 0 }));
      }

      await persistAddresses(nextAddresses);
      void addHistoryEvent({
        type: 'address',
        title: 'Address updated',
        description: `${address.fullName || 'Shipping address'} was edited.`,
        status: shouldBeDefault ? 'default' : 'updated',
        relatedId: id,
      });
    },
    [addHistoryEvent, addresses, persistAddresses, settings.country]
  );

  const deleteAddress = useCallback(
    async (id: string) => {
      const removedDefault = addresses.find((item) => item.id === id)?.isDefault;
      let nextAddresses = addresses.filter((item) => item.id !== id);

      if (removedDefault && nextAddresses.length) {
        nextAddresses = nextAddresses.map((item, index) => ({ ...item, isDefault: index === 0 }));
      }

      await persistAddresses(nextAddresses);
      void addHistoryEvent({
        type: 'address',
        title: 'Address deleted',
        description: 'A shipping address was removed from the address book.',
        status: 'deleted',
        relatedId: id,
      });
    },
    [addHistoryEvent, addresses, persistAddresses]
  );

  const setDefaultAddress = useCallback(
    async (id: string) => {
      await persistAddresses(addresses.map((item) => ({ ...item, isDefault: item.id === id })));
      const address = addresses.find((item) => item.id === id);
      void addHistoryEvent({
        type: 'address',
        title: 'Default address changed',
        description: address
          ? `${address.fullName} - ${address.city}, ${address.country}`
          : 'Default shipping address was changed.',
        status: 'default',
        relatedId: id,
      });
    },
    [addHistoryEvent, addresses, persistAddresses]
  );

  const defaultAddress = useMemo(
    () => addresses.find((address) => address.isDefault) || addresses[0] || null,
    [addresses]
  );

  const value = useMemo(
    () => ({
      addresses,
      defaultAddress,
      loadingAddresses,
      isDeviceLocal: !isSignedIn,
      addAddress,
      updateAddress,
      deleteAddress,
      setDefaultAddress,
    }),
    [
      addAddress,
      addresses,
      defaultAddress,
      deleteAddress,
      isSignedIn,
      loadingAddresses,
      setDefaultAddress,
      updateAddress,
    ]
  );

  return <AddressContext.Provider value={value}>{children}</AddressContext.Provider>;
}

export function useAddressBook() {
  const context = useContext(AddressContext);

  if (!context) {
    throw new Error('useAddressBook must be used inside AddressProvider');
  }

  return context;
}