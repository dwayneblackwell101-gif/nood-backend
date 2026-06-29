import AsyncStorage from '@react-native-async-storage/async-storage';

export const BASE_CURRENCY = 'USD';
/** Shopify catalog prices are always stored and shown in USD. */
export const CATALOG_CURRENCY = BASE_CURRENCY;

export function normalizeCatalogCurrencyCode(_currency?: string) {
  return CATALOG_CURRENCY;
}
const RATE_CACHE_KEY = 'NOOD_EXCHANGE_RATES_USD_V1';
const RATE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export const FALLBACK_EXCHANGE_RATES: Record<string, number> = {
  USD: 1,
  TTD: 6.78,
  GBP: 0.79,
  EUR: 0.92,
  CAD: 1.36,
  AUD: 1.52,
  NZD: 1.66,
  JMD: 156.4,
  BBD: 2,
  GYD: 209.5,
  XCD: 2.7,
  BSD: 1,
  BZD: 2,
  MXN: 16.9,
  BRL: 5.1,
  ARS: 860,
  CLP: 945,
  COP: 3920,
  PEN: 3.74,
  INR: 83.2,
  CNY: 7.24,
  JPY: 151.8,
  KRW: 1348,
  SGD: 1.35,
  MYR: 4.72,
  THB: 36.4,
  IDR: 15850,
  PHP: 56.2,
  AED: 3.67,
  SAR: 3.75,
  ZAR: 18.4,
  NGN: 1480,
  KES: 129,
  EGP: 48.6,
  CHF: 0.9,
  SEK: 10.5,
  NOK: 10.7,
  DKK: 6.87,
  PLN: 3.96,
  CZK: 23.2,
  HUF: 361,
  RON: 4.57,
  TRY: 32.3,
  RUB: 92.5,
};

export let EXCHANGE_RATES: Record<string, number> = {
  ...FALLBACK_EXCHANGE_RATES,
};

type CachedRates = {
  base: string;
  rates: Record<string, number>;
  fetchedAt: number;
};

let rateRequest: Promise<Record<string, number>> | null = null;

function normalizeCurrency(currency?: string) {
  return (currency || BASE_CURRENCY).toUpperCase();
}

function applyRates(rates: Record<string, number>) {
  EXCHANGE_RATES = {
    ...FALLBACK_EXCHANGE_RATES,
    ...rates,
    [BASE_CURRENCY]: 1,
  };

  return EXCHANGE_RATES;
}

function normalizeRates(rates: Record<string, unknown> = {}) {
  return Object.entries(rates).reduce<Record<string, number>>((acc, [currency, value]) => {
    const rate = Number(value);

    if (Number.isFinite(rate) && rate > 0) {
      acc[normalizeCurrency(currency)] = rate;
    }

    return acc;
  }, {});
}

async function readCachedRates() {
  const saved = await AsyncStorage.getItem(RATE_CACHE_KEY);
  if (!saved) return null;

  try {
    const parsed = JSON.parse(saved) as CachedRates;
    const rates = normalizeRates(parsed.rates);

    if (parsed.base === BASE_CURRENCY && Object.keys(rates).length) {
      return {
        ...parsed,
        rates,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function refreshExchangeRates() {
  const response = await fetch(`https://open.er-api.com/v6/latest/${BASE_CURRENCY}`);

  if (!response.ok) {
    throw new Error(`Exchange rate request failed: ${response.status}`);
  }

  const payload = await response.json();
  const rates = normalizeRates(payload?.rates);

  if (!Object.keys(rates).length) {
    throw new Error('Exchange rate response did not include rates.');
  }

  const nextRates = applyRates(rates);
  const cachedRates: CachedRates = {
    base: BASE_CURRENCY,
    rates: nextRates,
    fetchedAt: Date.now(),
  };

  await AsyncStorage.setItem(RATE_CACHE_KEY, JSON.stringify(cachedRates));
  return nextRates;
}

export async function ensureExchangeRates(forceRefresh = false) {
  if (rateRequest) return rateRequest;

  rateRequest = (async () => {
    const cached = await readCachedRates();
    const cacheIsFresh = cached && Date.now() - Number(cached.fetchedAt || 0) < RATE_CACHE_TTL_MS;

    if (cached) {
      applyRates(cached.rates);
    }

    if (cacheIsFresh && !forceRefresh) {
      return EXCHANGE_RATES;
    }

    try {
      return await refreshExchangeRates();
    } catch (error) {
      console.log('Using cached/fallback exchange rates:', error);
      return EXCHANGE_RATES;
    }
  })();

  try {
    return await rateRequest;
  } finally {
    rateRequest = null;
  }
}

export function convertPrice(
  amount: number,
  fromCurrency: string = BASE_CURRENCY,
  toCurrency: string = BASE_CURRENCY
) {
  const safeAmount = Number(amount || 0);
  const fromRate = EXCHANGE_RATES[normalizeCurrency(fromCurrency)] || 1;
  const toRate = EXCHANGE_RATES[normalizeCurrency(toCurrency)] || 1;

  const usdAmount = safeAmount / fromRate;
  return usdAmount * toRate;
}

export function formatMoney(amount: number, currency: string) {
  const safeAmount = Number(amount || 0);

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch {
    return `${currency} ${safeAmount.toFixed(2)}`;
  }
}

export function convertAndFormatPrice(
  amount: number,
  toCurrency: string,
  fromCurrency: string = BASE_CURRENCY
) {
  const converted = convertPrice(amount, fromCurrency, toCurrency);
  return formatMoney(converted, toCurrency);
}
