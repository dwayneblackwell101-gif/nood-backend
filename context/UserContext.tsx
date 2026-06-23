import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';

export type UserSettings = {
  country: string;
  currency: string;
  language: string;
  manuallyChangedCountry: boolean;
  manuallyChangedCurrency: boolean;
};

type UserContextType = {
  settings: UserSettings;
  isReady: boolean;
  isSignedIn: boolean;
  profileId: string;
  displayName: string;
  updateCountry: (country: string) => Promise<void>;
  updateCurrency: (currency: string) => Promise<void>;
  updateLanguage: (language: string) => Promise<void>;
  resetCurrencyToCountryDefault: () => Promise<void>;
  detectAndApplyDeviceRegion: () => Promise<void>;
  markSignedIn: (displayName?: string) => Promise<void>;
  setDisplayName: (displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
  availableCountries: { code: string; name: string; currency: string }[];
  availableCurrencies: string[];
  availableLanguages: string[];
};

const STORAGE_KEY = 'USER_SETTINGS';
const SIGNED_IN_KEY = 'USER_SIGNED_IN';
const GUEST_PROFILE_ID_KEY = 'USER_GUEST_PROFILE_ID';
const MEMBER_PROFILE_ID_KEY = 'USER_MEMBER_PROFILE_ID';
const DISPLAY_NAME_KEY = 'USER_DISPLAY_NAME';

const COUNTRY_DATA: { code: string; name: string; currency: string }[] = [
  { code: 'TT', name: 'Trinidad & Tobago', currency: 'TTD' },
  { code: 'US', name: 'United States', currency: 'USD' },
  { code: 'CA', name: 'Canada', currency: 'CAD' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { code: 'IE', name: 'Ireland', currency: 'EUR' },
  { code: 'FR', name: 'France', currency: 'EUR' },
  { code: 'DE', name: 'Germany', currency: 'EUR' },
  { code: 'ES', name: 'Spain', currency: 'EUR' },
  { code: 'IT', name: 'Italy', currency: 'EUR' },
  { code: 'NL', name: 'Netherlands', currency: 'EUR' },
  { code: 'PT', name: 'Portugal', currency: 'EUR' },
  { code: 'BE', name: 'Belgium', currency: 'EUR' },
  { code: 'AT', name: 'Austria', currency: 'EUR' },
  { code: 'FI', name: 'Finland', currency: 'EUR' },
  { code: 'GR', name: 'Greece', currency: 'EUR' },
  { code: 'AU', name: 'Australia', currency: 'AUD' },
  { code: 'NZ', name: 'New Zealand', currency: 'NZD' },
  { code: 'JM', name: 'Jamaica', currency: 'JMD' },
  { code: 'BB', name: 'Barbados', currency: 'BBD' },
  { code: 'GY', name: 'Guyana', currency: 'GYD' },
  { code: 'LC', name: 'Saint Lucia', currency: 'XCD' },
  { code: 'GD', name: 'Grenada', currency: 'XCD' },
  { code: 'VC', name: 'Saint Vincent and the Grenadines', currency: 'XCD' },
  { code: 'AG', name: 'Antigua and Barbuda', currency: 'XCD' },
  { code: 'DM', name: 'Dominica', currency: 'XCD' },
  { code: 'KN', name: 'Saint Kitts and Nevis', currency: 'XCD' },
  { code: 'BS', name: 'Bahamas', currency: 'BSD' },
  { code: 'BZ', name: 'Belize', currency: 'BZD' },
  { code: 'MX', name: 'Mexico', currency: 'MXN' },
  { code: 'BR', name: 'Brazil', currency: 'BRL' },
  { code: 'AR', name: 'Argentina', currency: 'ARS' },
  { code: 'CL', name: 'Chile', currency: 'CLP' },
  { code: 'CO', name: 'Colombia', currency: 'COP' },
  { code: 'PE', name: 'Peru', currency: 'PEN' },
  { code: 'IN', name: 'India', currency: 'INR' },
  { code: 'CN', name: 'China', currency: 'CNY' },
  { code: 'JP', name: 'Japan', currency: 'JPY' },
  { code: 'KR', name: 'South Korea', currency: 'KRW' },
  { code: 'SG', name: 'Singapore', currency: 'SGD' },
  { code: 'MY', name: 'Malaysia', currency: 'MYR' },
  { code: 'TH', name: 'Thailand', currency: 'THB' },
  { code: 'ID', name: 'Indonesia', currency: 'IDR' },
  { code: 'PH', name: 'Philippines', currency: 'PHP' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR' },
  { code: 'NG', name: 'Nigeria', currency: 'NGN' },
  { code: 'KE', name: 'Kenya', currency: 'KES' },
  { code: 'EG', name: 'Egypt', currency: 'EGP' },
  { code: 'CH', name: 'Switzerland', currency: 'CHF' },
  { code: 'SE', name: 'Sweden', currency: 'SEK' },
  { code: 'NO', name: 'Norway', currency: 'NOK' },
  { code: 'DK', name: 'Denmark', currency: 'DKK' },
  { code: 'PL', name: 'Poland', currency: 'PLN' },
  { code: 'CZ', name: 'Czech Republic', currency: 'CZK' },
  { code: 'HU', name: 'Hungary', currency: 'HUF' },
  { code: 'RO', name: 'Romania', currency: 'RON' },
  { code: 'TR', name: 'Turkey', currency: 'TRY' },
  { code: 'RU', name: 'Russia', currency: 'RUB' },
];

const COUNTRY_CURRENCY_MAP: Record<string, string> = COUNTRY_DATA.reduce(
  (acc, item) => {
    acc[item.code] = item.currency;
    return acc;
  },
  {} as Record<string, string>
);

const DEFAULT_SETTINGS: UserSettings = {
  country: 'US',
  currency: 'USD',
  language: 'English',
  manuallyChangedCountry: false,
  manuallyChangedCurrency: false,
};

const UserContext = createContext<UserContextType | null>(null);

function createProfileId(prefix: 'guest' | 'member') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultCountryFromDevice(): string {
  try {
    const locale = Localization.getLocales?.()?.[0];
    const regionCode = locale?.regionCode?.toUpperCase?.();

    if (regionCode && COUNTRY_CURRENCY_MAP[regionCode]) {
      return regionCode;
    }

    return 'US';
  } catch {
    return 'US';
  }
}

function getCurrencyForCountry(country: string): string {
  return COUNTRY_CURRENCY_MAP[country.toUpperCase()] || 'USD';
}

function getLanguageFromDevice(): string {
  try {
    const locale = Localization.getLocales?.()?.[0];
    const languageCode = locale?.languageCode?.toLowerCase?.() || 'en';

    const map: Record<string, string> = {
      en: 'English',
      es: 'Spanish',
      fr: 'French',
      pt: 'Portuguese',
      de: 'German',
      it: 'Italian',
      nl: 'Dutch',
      zh: 'Chinese',
      ja: 'Japanese',
      ko: 'Korean',
      hi: 'Hindi',
      ar: 'Arabic',
    };

    return map[languageCode] || 'English';
  } catch {
    return 'English';
  }
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [isReady, setIsReady] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [displayName, setDisplayNameState] = useState('NOOD Shopper');

  const availableCurrencies = useMemo(() => {
    return Array.from(new Set(COUNTRY_DATA.map((item) => item.currency))).sort();
  }, []);

  const availableLanguages = useMemo(() => {
    return [
      'Arabic',
      'Chinese',
      'Dutch',
      'English',
      'French',
      'German',
      'Hindi',
      'Italian',
      'Japanese',
      'Korean',
      'Portuguese',
      'Spanish',
    ];
  }, []);

  const saveSettings = async (newSettings: UserSettings) => {
    setSettings(newSettings);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
  };

  const initializeSettings = useCallback(async () => {
    try {
      const [saved, savedSignIn, savedGuestProfileId, savedMemberProfileId, savedDisplayName] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        AsyncStorage.getItem(SIGNED_IN_KEY),
        AsyncStorage.getItem(GUEST_PROFILE_ID_KEY),
        AsyncStorage.getItem(MEMBER_PROFILE_ID_KEY),
        AsyncStorage.getItem(DISPLAY_NAME_KEY),
      ]);

      const nextIsSignedIn = savedSignIn === 'true';
      setIsSignedIn(nextIsSignedIn);

      const guestProfileId = savedGuestProfileId || createProfileId('guest');
      const memberProfileId = savedMemberProfileId || createProfileId('member');

      await Promise.all([
        savedGuestProfileId ? Promise.resolve() : AsyncStorage.setItem(GUEST_PROFILE_ID_KEY, guestProfileId),
        savedMemberProfileId ? Promise.resolve() : AsyncStorage.setItem(MEMBER_PROFILE_ID_KEY, memberProfileId),
      ]);

      setProfileId(nextIsSignedIn ? memberProfileId : guestProfileId);
      setDisplayNameState(savedDisplayName || 'NOOD Shopper');

      if (saved) {
        const parsed = JSON.parse(saved) as Partial<UserSettings>;

        const safeSettings: UserSettings = {
          country: (parsed.country || DEFAULT_SETTINGS.country).toUpperCase(),
          currency: (parsed.currency || DEFAULT_SETTINGS.currency).toUpperCase(),
          language: parsed.language || DEFAULT_SETTINGS.language,
          manuallyChangedCountry: !!parsed.manuallyChangedCountry,
          manuallyChangedCurrency: !!parsed.manuallyChangedCurrency,
        };

        const detectedCountry = getDefaultCountryFromDevice();
        const detectedCurrency = getCurrencyForCountry(detectedCountry);

        const hydratedSettings: UserSettings = safeSettings.manuallyChangedCountry
          ? safeSettings
          : {
              ...safeSettings,
              country: detectedCountry,
              currency: safeSettings.manuallyChangedCurrency
                ? safeSettings.currency
                : detectedCurrency,
              language: safeSettings.language || getLanguageFromDevice(),
            };

        setSettings(hydratedSettings);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hydratedSettings));
        setIsReady(true);
        return;
      }

      const detectedCountry = getDefaultCountryFromDevice();
      const detectedCurrency = getCurrencyForCountry(detectedCountry);
      const detectedLanguage = getLanguageFromDevice();

      const initialSettings: UserSettings = {
        country: detectedCountry,
        currency: detectedCurrency,
        language: detectedLanguage,
        manuallyChangedCountry: false,
        manuallyChangedCurrency: false,
      };

      await saveSettings(initialSettings);
      setIsReady(true);
    } catch (error) {
      console.log('Failed to initialize settings:', error);
      setIsReady(true);
    }
  }, []);

  useEffect(() => {
    initializeSettings();
  }, [initializeSettings]);

  const updateCountry = async (country: string) => {
    const upperCountry = country.toUpperCase();
    const countryDefaultCurrency = getCurrencyForCountry(upperCountry);

    const newSettings: UserSettings = {
      ...settings,
      country: upperCountry,
      manuallyChangedCountry: true,
      currency: settings.manuallyChangedCurrency ? settings.currency : countryDefaultCurrency,
    };

    await saveSettings(newSettings);
  };

  const updateCurrency = async (currency: string) => {
    const upperCurrency = currency.toUpperCase();

    const newSettings: UserSettings = {
      ...settings,
      currency: upperCurrency,
      manuallyChangedCurrency: true,
    };

    await saveSettings(newSettings);
  };

  const updateLanguage = async (language: string) => {
    const newSettings: UserSettings = {
      ...settings,
      language,
    };

    await saveSettings(newSettings);
  };

  const resetCurrencyToCountryDefault = async () => {
    const defaultCurrency = getCurrencyForCountry(settings.country);

    const newSettings: UserSettings = {
      ...settings,
      currency: defaultCurrency,
      manuallyChangedCurrency: false,
    };

    await saveSettings(newSettings);
  };

  const detectAndApplyDeviceRegion = async () => {
    const detectedCountry = getDefaultCountryFromDevice();
    const detectedCurrency = getCurrencyForCountry(detectedCountry);

    const newSettings: UserSettings = {
      ...settings,
      country: detectedCountry,
      manuallyChangedCountry: false,
      currency: settings.manuallyChangedCurrency ? settings.currency : detectedCurrency,
      language: settings.language || getLanguageFromDevice(),
    };

    await saveSettings(newSettings);
  };

  const setDisplayName = async (nextDisplayName: string) => {
    const safeName = nextDisplayName.trim() || 'NOOD Shopper';
    setDisplayNameState(safeName);
    await AsyncStorage.setItem(DISPLAY_NAME_KEY, safeName);
  };

  const markSignedIn = async (nextDisplayName?: string) => {
    const existingMemberProfileId = await AsyncStorage.getItem(MEMBER_PROFILE_ID_KEY);
    const nextMemberProfileId = existingMemberProfileId || createProfileId('member');

    if (!existingMemberProfileId) {
      await AsyncStorage.setItem(MEMBER_PROFILE_ID_KEY, nextMemberProfileId);
    }

    setIsSignedIn(true);
    setProfileId(nextMemberProfileId);
    await AsyncStorage.setItem(SIGNED_IN_KEY, 'true');

    if (nextDisplayName) {
      await setDisplayName(nextDisplayName);
    }
  };

  const signOut = async () => {
    const existingGuestProfileId = await AsyncStorage.getItem(GUEST_PROFILE_ID_KEY);
    const nextGuestProfileId = existingGuestProfileId || createProfileId('guest');

    if (!existingGuestProfileId) {
      await AsyncStorage.setItem(GUEST_PROFILE_ID_KEY, nextGuestProfileId);
    }

    setIsSignedIn(false);
    setProfileId(nextGuestProfileId);
    await AsyncStorage.setItem(SIGNED_IN_KEY, 'false');
  };

  return (
    <UserContext.Provider
      value={{
        settings,
        isReady,
        isSignedIn,
        profileId,
        displayName,
        updateCountry,
        updateCurrency,
        updateLanguage,
        resetCurrencyToCountryDefault,
        detectAndApplyDeviceRegion,
        markSignedIn,
        setDisplayName,
        signOut,
        availableCountries: COUNTRY_DATA,
        availableCurrencies,
        availableLanguages,
      }}
    >
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);

  if (!context) {
    throw new Error('useUser must be used inside UserProvider');
  }

  return context;
}
