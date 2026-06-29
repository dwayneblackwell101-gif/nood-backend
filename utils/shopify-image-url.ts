const SHOPIFY_CDN_HOST_PATTERN = /cdn\.shopify\.com/i;
const DIMENSION_SUFFIX_PATTERN = /_(\d+)x(\d+)(?:_[^.]*)?(\.(?:jpe?g|png|gif|webp|avif))/i;
const SMALL_THUMBNAIL_MAX = 120;
export const SWATCH_THUMBNAIL_SIZE = 300;
export const SWATCH_DISPLAY_SIZE = 76;
export const SWATCH_RESIZE_MODE = 'contain' as const;

export function isShopifyCdnImageUrl(url: string) {
  return SHOPIFY_CDN_HOST_PATTERN.test(String(url || '').trim());
}

function stripSmallDimensionSuffix(url: string) {
  return url.replace(DIMENSION_SUFFIX_PATTERN, (match, widthText, heightText, extension) => {
    const width = Number(widthText);
    const height = Number(heightText);

    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width <= SMALL_THUMBNAIL_MAX &&
      height <= SMALL_THUMBNAIL_MAX
    ) {
      return extension;
    }

    return match;
  });
}

function stripSmallDimensionQueryParams(url: string) {
  try {
    const parsed = new URL(url);
    const width = Number(parsed.searchParams.get('width') || 0);
    const height = Number(parsed.searchParams.get('height') || 0);

    if (width > 0 && width <= SMALL_THUMBNAIL_MAX) {
      parsed.searchParams.delete('width');
    }

    if (height > 0 && height <= SMALL_THUMBNAIL_MAX) {
      parsed.searchParams.delete('height');
    }

    return parsed.toString();
  } catch {
    return url
      .replace(/([?&])width=(?:[1-9]|[1-9]\d|1[01]\d|120)(?=&|$)/gi, '$1')
      .replace(/([?&])height=(?:[1-9]|[1-9]\d|1[01]\d|120)(?=&|$)/gi, '$1')
      .replace(/\?&/g, '?')
      .replace(/[?&]$/g, '');
  }
}

export function normalizeShopifyGalleryImageUrl(url?: string | null) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  if (!isShopifyCdnImageUrl(trimmed)) {
    return trimmed;
  }

  let normalized = stripSmallDimensionSuffix(trimmed);
  normalized = stripSmallDimensionQueryParams(normalized);
  return normalized;
}

export function getShopifySwatchImageUrl(
  url?: string | null,
  size: number = SWATCH_THUMBNAIL_SIZE
) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const galleryImageUrl = normalizeShopifyGalleryImageUrl(trimmed);
  if (!isShopifyCdnImageUrl(galleryImageUrl)) {
    return galleryImageUrl;
  }

  try {
    const parsed = new URL(galleryImageUrl);
    const existingWidth = Number(parsed.searchParams.get('width') || 0);
    const existingHeight = Number(parsed.searchParams.get('height') || 0);

    if (existingWidth >= 280) {
      return parsed.toString();
    }

    if (existingHeight >= 280) {
      return parsed.toString();
    }

    parsed.searchParams.delete('width');
    parsed.searchParams.delete('height');
    parsed.searchParams.set('width', String(size));
    return parsed.toString();
  } catch {
    if (/[?&]width=\d+/i.test(galleryImageUrl)) {
      return galleryImageUrl.replace(/width=\d+/i, `width=${size}`);
    }

    const joiner = galleryImageUrl.includes('?') ? '&' : '?';
    return `${galleryImageUrl}${joiner}width=${size}`;
  }
}

export function resolveColorSwatchImageUrls(originalUrl?: string | null) {
  const galleryImageUrl = String(originalUrl || '').trim();
  const swatchImageUrl = galleryImageUrl
    ? getShopifySwatchImageUrl(galleryImageUrl)
    : '';

  return {
    galleryImageUrl,
    swatchImageUrl,
  };
}

const SWATCH_PERF_DEBUG = false;

export function logSwatchImageQuality(detail: {
  colorValue: string;
  originalUrl: string;
  swatchUrl: string;
  width: number;
  height: number;
}) {
  if (!__DEV__ || !SWATCH_PERF_DEBUG) return;

  console.log('[SWATCH IMAGE QUALITY]', {
    colorValue: detail.colorValue,
    originalUrl: detail.originalUrl || null,
    swatchUrl: detail.swatchUrl || null,
    width: detail.width,
    height: detail.height,
  });
}

export function logSwatchUiQuality(detail: {
  colorValue: string;
  swatchImageUrl: string;
  displaySize: number;
  resizeMode: 'cover' | 'contain';
  isSelected: boolean;
  isSoldOut: boolean;
  isDisabled: boolean;
}) {
  if (!__DEV__ || !SWATCH_PERF_DEBUG) return;

  console.log('[SWATCH UI QUALITY]', {
    colorValue: detail.colorValue,
    swatchImageUrl: detail.swatchImageUrl || null,
    displaySize: detail.displaySize,
    resizeMode: detail.resizeMode,
    isSelected: detail.isSelected,
    isSoldOut: detail.isSoldOut,
    isDisabled: detail.isDisabled,
  });
}