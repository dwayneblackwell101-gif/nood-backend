import { getBackendJson } from './backend';

export type NoodDiscountKind = 'automatic' | 'coupon' | 'free_shipping';
export type NoodDiscountType = 'percentage' | 'fixed_amount' | 'free_shipping' | 'bxgy' | 'other';
export type NoodDiscountStatus = 'active' | 'expired' | 'scheduled';

export type NoodDiscount = {
  id: string;
  title: string;
  summary?: string;
  kind: NoodDiscountKind;
  discountType: NoodDiscountType;
  valueLabel: string;
  code?: string | null;
  codes?: string[];
  minimumRequirement?: string;
  minQuantity?: number | null;
  percentage?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  status: NoodDiscountStatus;
  isActive: boolean;
  appliesAutomatically: boolean;
};

export type NoodDiscountsResponse = {
  success: boolean;
  source?: string;
  code?: string;
  message?: string;
  cached?: boolean;
  fetchedAt?: string;
  automatic: NoodDiscount[];
  coupons: NoodDiscount[];
  shipping: NoodDiscount[];
  all: NoodDiscount[];
};

function normalizeDiscountList(value: unknown): NoodDiscount[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const raw = entry as Partial<NoodDiscount>;
      const id = String(raw?.id || '').trim();
      if (!id) {
        return null;
      }

      return {
        id,
        title: String(raw.title || 'Discount'),
        summary: raw.summary ? String(raw.summary) : undefined,
        kind: (raw.kind || 'automatic') as NoodDiscountKind,
        discountType: (raw.discountType || 'other') as NoodDiscountType,
        valueLabel: String(raw.valueLabel || raw.title || 'Discount'),
        code: raw.code ? String(raw.code) : null,
        codes: Array.isArray(raw.codes) ? raw.codes.map((code) => String(code)) : [],
        minimumRequirement: raw.minimumRequirement ? String(raw.minimumRequirement) : undefined,
        minQuantity:
          raw.minQuantity === null || raw.minQuantity === undefined
            ? null
            : Number(raw.minQuantity),
        percentage:
          raw.percentage === null || raw.percentage === undefined
            ? null
            : Number(raw.percentage),
        startsAt: raw.startsAt ? String(raw.startsAt) : null,
        endsAt: raw.endsAt ? String(raw.endsAt) : null,
        status: (raw.status || 'active') as NoodDiscountStatus,
        isActive: Boolean(raw.isActive),
        appliesAutomatically: Boolean(raw.appliesAutomatically),
      };
    })
    .filter(Boolean) as NoodDiscount[];
}

export async function fetchShopifyDiscounts(options?: {
  signal?: AbortSignal;
  refresh?: boolean;
}): Promise<NoodDiscountsResponse> {
  const query = options?.refresh ? '?refresh=1' : '';

  try {
    const response = await getBackendJson(`/api/discounts${query}`, {
      signal: options?.signal,
      timeoutMs: 15000,
    });

    return {
      success: Boolean(response?.success),
      source: response?.source ? String(response.source) : undefined,
      code: response?.code ? String(response.code) : undefined,
      message: response?.message ? String(response.message) : undefined,
      cached: Boolean(response?.cached),
      fetchedAt: response?.fetchedAt ? String(response.fetchedAt) : undefined,
      automatic: normalizeDiscountList(response?.automatic),
      coupons: normalizeDiscountList(response?.coupons),
      shipping: normalizeDiscountList(response?.shipping),
      all: normalizeDiscountList(response?.all),
    };
  } catch (error) {
    console.log('Failed to load Shopify discounts:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Could not load discounts.',
      automatic: [],
      coupons: [],
      shipping: [],
      all: [],
    };
  }
}

export function formatDiscountExpiry(endsAt?: string | null) {
  if (!endsAt) {
    return 'No expiry listed';
  }

  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) {
    return 'No expiry listed';
  }

  return `Ends ${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

export function getShippingOfferCopy(discount: NoodDiscount) {
  if (discount.minimumRequirement) {
    return discount.minimumRequirement;
  }

  if (discount.summary) {
    return discount.summary;
  }

  return 'Applies to eligible orders at checkout';
}