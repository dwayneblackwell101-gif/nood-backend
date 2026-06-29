import { normalizeShopifyGalleryImageUrl } from './shopify-image-url';

export type VariantOptionMap = Record<string, string>;

export type ColorImageEntry = {
  url: string;
  altText: string | null;
  variantId: string;
  availableForSale: boolean;
  source?: 'exact-variant' | 'same-color-variant' | 'alt-text' | 'numeric-gallery' | 'none';
};

export type OptionSelectionState = {
  exists: boolean;
  purchasable: boolean;
};

type VariantOptionEntry = {
  name: string;
  normalizedName: string;
  value: string;
};

function logVariantImages(message: string, data?: Record<string, unknown>) {
  if (!__DEV__) return;
  console.log(message, data ?? '');
}

export function logVariantClickDebug(message: string, data?: Record<string, unknown>) {
  if (!__DEV__) return;
  console.log(message, data ?? '');
}

export function normalizeOptionName(name: string) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/colour/g, 'color');
}

export function normalizeOptionValue(value: string | number | null | undefined) {
  return String(value ?? '').trim();
}

export function optionValuesEqual(
  left: string | number | null | undefined,
  right: string | number | null | undefined
) {
  return normalizeOptionValue(left) === normalizeOptionValue(right);
}

export function isColorOptionName(optionName: string) {
  return normalizeOptionName(optionName) === 'color';
}

export function isSizeOptionName(optionName: string) {
  return normalizeOptionName(optionName) === 'size';
}

export function getColorDisplayLabel(colorOptionName: string, colorValue: string) {
  const value = normalizeOptionValue(colorValue);
  if (!value) return 'Choose';

  if (/^\d+$/.test(value)) {
    return `${colorOptionName} ${value}`;
  }

  return value;
}

export function getVariantOptionEntries(variant: any): VariantOptionEntry[] {
  return (variant?.selectedOptions || [])
    .map((option: any) => {
      const name = String(option?.name || '').trim();
      const value = normalizeOptionValue(option?.value);
      if (!name || !value) return null;

      return {
        name,
        normalizedName: normalizeOptionName(name),
        value,
      };
    })
    .filter(Boolean) as VariantOptionEntry[];
}

export function getVariantOptionMap(variant: any): VariantOptionMap {
  return Object.fromEntries(
    getVariantOptionEntries(variant).map((entry) => [entry.name, entry.value])
  );
}

export function variantHasOptionValue(
  variant: any,
  optionName: string,
  optionValue: string
) {
  const targetName = normalizeOptionName(optionName);
  const targetValue = normalizeOptionValue(optionValue);

  return getVariantOptionEntries(variant).some(
    (entry) =>
      entry.normalizedName === targetName && optionValuesEqual(entry.value, targetValue)
  );
}

export function findVariantsForOptionValue(
  variantNodes: any[],
  optionName: string,
  optionValue: string,
  selectedOptions: VariantOptionMap = {},
  optionsToIgnore: string[] = []
) {
  const ignoreNormalized = new Set(optionsToIgnore.map((name) => normalizeOptionName(name)));
  const changingNormalized = normalizeOptionName(optionName);

  return variantNodes.filter((variant) => {
    if (!variantHasOptionValue(variant, optionName, optionValue)) {
      return false;
    }

    return Object.entries(selectedOptions).every(([name, value]) => {
      if (!value) return true;

      const nameNormalized = normalizeOptionName(name);
      if (nameNormalized === changingNormalized) return true;
      if (ignoreNormalized.has(nameNormalized)) return true;

      return variantHasOptionValue(variant, name, value);
    });
  });
}

export function findVariantForOptions(variantNodes: any[], selectedOptions: VariantOptionMap) {
  return (
    variantNodes.find((variant) =>
      Object.entries(selectedOptions).every(([name, value]) => {
        if (!value) return true;
        return variantHasOptionValue(variant, name, value);
      })
    ) || null
  );
}

export function getColorsForSize(
  variantNodes: any[],
  sizeOptionName: string,
  sizeValue: string,
  colorOptionName: string
) {
  const colors: string[] = [];
  const seen = new Set<string>();

  variantNodes.forEach((variant) => {
    if (!variantHasOptionValue(variant, sizeOptionName, sizeValue)) return;

    getVariantOptionEntries(variant).forEach((entry) => {
      if (entry.normalizedName !== normalizeOptionName(colorOptionName)) return;
      if (seen.has(entry.value)) return;
      seen.add(entry.value);
      colors.push(entry.value);
    });
  });

  return colors;
}

export function getFirstColorForSize(
  variantNodes: any[],
  sizeOptionName: string,
  sizeValue: string,
  colorOptionName: string
) {
  return getColorsForSize(variantNodes, sizeOptionName, sizeValue, colorOptionName)[0] || null;
}

export function getOptionSelectionState(
  variantNodes: any[],
  optionName: string,
  optionValue: string,
  selectedOptions: VariantOptionMap,
  options: {
    colorOptionName?: string | null;
    sizeOptionName?: string | null;
  } = {}
): OptionSelectionState {
  const isSize =
    Boolean(options.sizeOptionName) &&
    normalizeOptionName(optionName) === normalizeOptionName(options.sizeOptionName || '');
  const isColor =
    Boolean(options.colorOptionName) &&
    normalizeOptionName(optionName) === normalizeOptionName(options.colorOptionName || '');

  let matchingVariants: any[] = [];

  if (isSize) {
    matchingVariants = findVariantsForOptionValue(
      variantNodes,
      optionName,
      optionValue,
      selectedOptions,
      options.colorOptionName ? [options.colorOptionName] : []
    );
  } else if (isColor) {
    const sizeOptionName = options.sizeOptionName;
    const sizeValue = sizeOptionName ? selectedOptions[sizeOptionName] : '';

    if (sizeOptionName && sizeValue) {
      matchingVariants = variantNodes.filter(
        (variant) =>
          variantHasOptionValue(variant, optionName, optionValue) &&
          variantHasOptionValue(variant, sizeOptionName, sizeValue)
      );
    } else {
      matchingVariants = variantNodes.filter((variant) =>
        variantHasOptionValue(variant, optionName, optionValue)
      );
    }
  } else {
    matchingVariants = findVariantsForOptionValue(
      variantNodes,
      optionName,
      optionValue,
      selectedOptions
    );
  }

  return {
    exists: matchingVariants.length > 0,
    purchasable: matchingVariants.some((variant) => variant?.availableForSale !== false),
  };
}

export function getVariantImageUrl(variant: any): string | null {
  const direct = String(variant?.image?.url || '').trim();
  return direct || null;
}

const SWATCH_FALLBACK_ALT_BLOCKLIST =
  /label|banner|box|screenshot|size chart|chart|text only|logo|tag|sticker|qr|barcode|promo|collage/i;

function scoreProductImageForSwatch(image: any) {
  let score = 0;
  const rawUrl = String(image?.url || '').trim();
  const altText = normalizeAltText(image?.altText);

  if (!rawUrl) return -1000;

  const normalizedUrl = normalizeShopifyGalleryImageUrl(rawUrl);
  if (normalizedUrl !== rawUrl) {
    score -= 30;
  }

  if (/_\d{1,2}x\d{1,2}(?:_|\.)/i.test(rawUrl) || /[?&]width=(?:[1-9]|[1-9]\d|1[01]\d|120)(?:&|$)/i.test(rawUrl)) {
    score -= 25;
  }

  if (SWATCH_FALLBACK_ALT_BLOCKLIST.test(altText)) {
    score -= 60;
  }

  if (altText && /shoe|sneaker|product|color|style|view|angle|side|front/i.test(altText)) {
    score += 8;
  }

  return score;
}

function getProductImageEdges(productImageEdges: any[] = []) {
  const seenNormalized = new Map<string, any>();

  productImageEdges
    .map((edge) => edge?.node || edge)
    .forEach((node) => {
      const rawUrl = String(node?.url || '').trim();
      if (!rawUrl) return;

      const normalizedUrl = normalizeShopifyGalleryImageUrl(rawUrl);
      const dedupeKey = normalizedUrl || rawUrl;
      const candidate = {
        ...node,
        url: normalizedUrl || rawUrl,
      };

      const existing = seenNormalized.get(dedupeKey);
      if (!existing) {
        seenNormalized.set(dedupeKey, candidate);
        return;
      }

      if (scoreProductImageForSwatch(candidate) > scoreProductImageForSwatch(existing)) {
        seenNormalized.set(dedupeKey, candidate);
      }
    });

  return Array.from(seenNormalized.values());
}

function getRankedProductImagesForSwatchFallback(productImageEdges: any[] = []) {
  return getProductImageEdges(productImageEdges)
    .map((image, index) => ({
      image,
      score: scoreProductImageForSwatch(image),
      index,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.image);
}

function getNumericFallbackImagePool(productImageEdges: any[] = [], colorCount: number) {
  const rankedImages = getRankedProductImagesForSwatchFallback(productImageEdges);
  if (!rankedImages.length) return [];

  const minimumScore = -45;
  let cleanImages = rankedImages.filter((image) => scoreProductImageForSwatch(image) >= minimumScore);
  if (cleanImages.length < colorCount) {
    cleanImages = rankedImages;
  }

  return cleanImages.length > colorCount ? cleanImages.slice(1) : cleanImages;
}

function normalizeAltText(text: string | null | undefined) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getProductImageMatchingAltText(productImageEdges: any[] = [], altTexts: string[] = []) {
  const normalizedAltTexts = altTexts.map(normalizeAltText).filter(Boolean);
  if (!normalizedAltTexts.length) return null;

  return (
    getProductImageEdges(productImageEdges).find((image) => {
      const imageAlt = normalizeAltText(image?.altText);
      if (!imageAlt) return false;

      return normalizedAltTexts.some(
        (altText) => imageAlt === altText || imageAlt.includes(altText) || altText.includes(imageAlt)
      );
    }) || null
  );
}

function getColorValuesInNumericOrder(variantNodes: any[], colorOptionName: string) {
  const values = new Set<string>();

  variantNodes.forEach((variant) => {
    getVariantOptionEntries(variant).forEach((entry) => {
      if (entry.normalizedName === normalizeOptionName(colorOptionName)) {
        values.add(entry.value);
      }
    });
  });

  const colorValues = Array.from(values);
  const allNumeric = colorValues.length > 0 && colorValues.every((value) => /^\d+$/.test(value));

  return {
    allNumeric,
    colorValues: allNumeric
      ? colorValues.sort((left, right) => Number(left) - Number(right))
      : colorValues,
  };
}

function getNumericGalleryImageForColor(
  variantNodes: any[],
  colorOptionName: string,
  colorValue: string,
  productImageEdges: any[] = []
) {
  const { allNumeric, colorValues } = getColorValuesInNumericOrder(variantNodes, colorOptionName);
  if (!allNumeric || !/^\d+$/.test(colorValue)) return null;

  const hasAnyVariantImageForColor = colorValues.some((value) =>
    variantNodes.some(
      (variant) =>
        variantHasOptionValue(variant, colorOptionName, value) &&
        Boolean(getVariantImageUrl(variant))
    )
  );
  if (hasAnyVariantImageForColor) return null;

  const imagePool = getNumericFallbackImagePool(productImageEdges, colorValues.length);
  if (!imagePool.length) return null;

  const colorIndex = colorValues.findIndex((value) => optionValuesEqual(value, colorValue));
  if (colorIndex < 0 || colorIndex >= imagePool.length) return null;

  return imagePool[colorIndex] || null;
}

export function buildColorImageMap(
  variantNodes: any[],
  colorOptionName: string,
  selectedOptions: VariantOptionMap = {},
  productImageEdges: any[] = []
) {
  const map: Record<string, ColorImageEntry> = {};
  const sizeOptionName = Object.keys(selectedOptions).find((name) => isSizeOptionName(name)) || null;
  const sizeValue = sizeOptionName ? selectedOptions[sizeOptionName] : '';

  const colorValues = new Set<string>();

  variantNodes.forEach((variant) => {
    const colorValue = getVariantOptionEntries(variant).find(
      (entry) => entry.normalizedName === normalizeOptionName(colorOptionName)
    )?.value;

    if (!colorValue) return;
    colorValues.add(colorValue);
  });

  colorValues.forEach((colorValue) => {
    const entry = getColorImageForValue(
      variantNodes,
      colorOptionName,
      colorValue,
      selectedOptions,
      productImageEdges
    );

    if (entry) {
      map[colorValue] = entry;
    }
  });

  return map;
}

export function getColorImageForValue(
  variantNodes: any[],
  colorOptionName: string,
  colorValue: string,
  selectedOptions: VariantOptionMap = {},
  productImageEdges: any[] = []
): ColorImageEntry | null {
  const sizeOptionName = Object.keys(selectedOptions).find((name) => isSizeOptionName(name)) || null;
  const sizeValue = sizeOptionName ? selectedOptions[sizeOptionName] : '';

  const matchingVariant =
    (sizeOptionName && sizeValue
      ? variantNodes.find(
          (variant) =>
            variantHasOptionValue(variant, colorOptionName, colorValue) &&
            variantHasOptionValue(variant, sizeOptionName, sizeValue)
        )
      : null) ||
    variantNodes.find((variant) => variantHasOptionValue(variant, colorOptionName, colorValue));

  if (!matchingVariant) return null;

  const variantsForColor = variantNodes.filter((variant) =>
    variantHasOptionValue(variant, colorOptionName, colorValue)
  );

  const exactSizeImageVariant =
    sizeOptionName && sizeValue
      ? variantsForColor.find(
          (variant) =>
            variantHasOptionValue(variant, sizeOptionName, sizeValue) &&
            Boolean(getVariantImageUrl(variant))
        )
      : null;

  const sameColorImageVariant = variantsForColor.find((variant) =>
    Boolean(getVariantImageUrl(variant))
  );

  const imageVariant = exactSizeImageVariant || sameColorImageVariant;
  const exactImageUrl = exactSizeImageVariant ? getVariantImageUrl(exactSizeImageVariant) || '' : '';
  const sameColorImageUrl = sameColorImageVariant ? getVariantImageUrl(sameColorImageVariant) || '' : '';

  if (imageVariant) {
    const finalImageUrl = getVariantImageUrl(imageVariant) || '';
    logVariantImages('[COLOR SWATCH IMAGE MAP FINAL]', {
      colorValue,
      exactImageUrl: exactImageUrl || null,
      sameColorImageUrl: sameColorImageUrl || null,
      finalImageUrl: finalImageUrl || null,
    });

    return {
      url: finalImageUrl,
      altText: imageVariant?.image?.altText ? String(imageVariant.image.altText) : null,
      variantId: String(matchingVariant?.id || ''),
      availableForSale: matchingVariant?.availableForSale !== false,
      source: exactSizeImageVariant ? 'exact-variant' : 'same-color-variant',
    };
  }

  const variantAltTexts = variantsForColor
    .map((variant) => (variant?.image?.altText ? String(variant.image.altText) : ''))
    .filter(Boolean);
  const productImage = getProductImageMatchingAltText(productImageEdges, variantAltTexts);

  if (productImage?.url) {
    const finalImageUrl = String(productImage.url);
    logVariantImages('[COLOR SWATCH IMAGE MAP FINAL]', {
      colorValue,
      exactImageUrl: exactImageUrl || null,
      sameColorImageUrl: sameColorImageUrl || null,
      finalImageUrl,
    });

    return {
      url: finalImageUrl,
      altText: productImage?.altText ? String(productImage.altText) : null,
      variantId: String(matchingVariant?.id || ''),
      availableForSale: matchingVariant?.availableForSale !== false,
      source: 'alt-text',
    };
  }

  const numericGalleryImage = getNumericGalleryImageForColor(
    variantNodes,
    colorOptionName,
    colorValue,
    productImageEdges
  );

  if (numericGalleryImage?.url) {
    const finalImageUrl = String(numericGalleryImage.url);
    logVariantImages('[VARIANT IMAGE FALLBACK USED]', {
      reason: 'variant images missing; numeric color mapped to product gallery image',
      colorValue,
      mappedImageUrl: finalImageUrl,
    });
    logVariantImages('[COLOR SWATCH IMAGE MAP FINAL]', {
      colorValue,
      exactImageUrl: exactImageUrl || null,
      sameColorImageUrl: sameColorImageUrl || null,
      finalImageUrl,
    });

    return {
      url: finalImageUrl,
      altText: numericGalleryImage?.altText ? String(numericGalleryImage.altText) : null,
      variantId: String(matchingVariant?.id || ''),
      availableForSale: matchingVariant?.availableForSale !== false,
      source: 'numeric-gallery',
    };
  }

  logVariantImages('[COLOR SWATCH IMAGE MAP FINAL]', {
    colorValue,
    exactImageUrl: exactImageUrl || null,
    sameColorImageUrl: sameColorImageUrl || null,
    finalImageUrl: null,
  });

  return {
    url: '',
    altText: null,
    variantId: String(matchingVariant?.id || ''),
    availableForSale: matchingVariant?.availableForSale !== false,
    source: 'none',
  };
}

export function getColorImageMapFromVariantImages(
  variantNodes: any[],
  colorOptionName: string
) {
  const map: Record<string, string> = {};

  variantNodes.forEach((variant) => {
    const colorValue = getVariantOptionEntries(variant).find(
      (entry) => entry.normalizedName === normalizeOptionName(colorOptionName)
    )?.value;
    const imageUrl = getVariantImageUrl(variant);

    if (colorValue && imageUrl && !map[colorValue]) {
      map[colorValue] = imageUrl;
    }
  });

  return map;
}

export function getColorValues(variantNodes: any[], colorOptionName: string) {
  const values = new Set<string>();

  variantNodes.forEach((variant: any) => {
    getVariantOptionEntries(variant).forEach((entry) => {
      if (entry.normalizedName === normalizeOptionName(colorOptionName)) {
        values.add(entry.value);
      }
    });
  });

  return values;
}

function getVariantEdgeFromNode(node: any) {
  return { node };
}

function mergeVariantNode(existingNode: any, storefrontVariant: any) {
  return {
    ...existingNode,
    ...storefrontVariant,
    title: existingNode?.title || storefrontVariant?.title,
    image: storefrontVariant?.image?.url
      ? {
          url: String(storefrontVariant.image.url),
          altText: storefrontVariant?.image?.altText
            ? String(storefrontVariant.image.altText)
            : null,
        }
      : existingNode?.image || storefrontVariant?.image || null,
  };
}

function getVariantId(variant: any) {
  return String(variant?.id || '').trim();
}

export function variantHasImageForColor(variantNodes: any[], colorOptionName: string, colorValue: string) {
  return variantNodes.some(
    (variant) =>
      variantHasOptionValue(variant, colorOptionName, colorValue) &&
      Boolean(getVariantImageUrl(variant))
  );
}

export function productNeedsVariantImageEnrichment(product: any, colorOptionName?: string | null) {
  if (!product?.variants?.edges?.length) return false;

  const variantNodes = product.variants.edges.map((edge: any) => edge?.node).filter(Boolean);
  const hasMissingVariantImages = variantNodes.some((variant: any) => !getVariantImageUrl(variant));

  if (!colorOptionName) {
    return hasMissingVariantImages;
  }

  const colorValues = new Set<string>();
  variantNodes.forEach((variant: any) => {
    getVariantOptionEntries(variant).forEach((entry) => {
      if (entry.normalizedName === normalizeOptionName(colorOptionName)) {
        colorValues.add(entry.value);
      }
    });
  });

  const colorMap = buildColorImageMap(variantNodes, colorOptionName);
  const missingColorImages = Array.from(colorValues).some((value) => !String(colorMap[value]?.url || '').trim());

  return hasMissingVariantImages || missingColorImages;
}

export function mergeVariantImagesIntoProduct(product: any, storefrontVariants: any[] = []) {
  if (!product?.variants?.edges?.length || !storefrontVariants.length) {
    return product;
  }

  const storefrontVariantById = new Map(
    storefrontVariants
      .map((variant) => {
        const id = getVariantId(variant);
        if (!id) return null;
        return [id, variant] as const;
      })
      .filter(Boolean) as Array<readonly [string, any]>
  );

  if (!storefrontVariantById.size) return product;
  const seenVariantIds = new Set<string>();

  const nextEdges = product.variants.edges.map((edge: any) => {
    const node = edge?.node;
    const variantId = getVariantId(node);
    if (variantId) seenVariantIds.add(variantId);

    const storefrontVariant = storefrontVariantById.get(variantId);
    if (!storefrontVariant) return edge;

    return {
      ...edge,
      node: mergeVariantNode(node, storefrontVariant),
    };
  });

  storefrontVariants.forEach((variant) => {
    const variantId = getVariantId(variant);
    if (!variantId || seenVariantIds.has(variantId)) return;
    seenVariantIds.add(variantId);
    nextEdges.push(getVariantEdgeFromNode(mergeVariantNode({}, variant)));
  });

  return {
    ...product,
    variants: {
      ...product.variants,
      edges: nextEdges,
    },
  };
}

export function logProductVariantImageDebug(
  optionGroups: Array<{ name: string; values: string[] }>,
  colorOptionName: string | null,
  selectedOptions: VariantOptionMap,
  selectedVariant: any | null
) {
  if (!__DEV__) return;

  logVariantImages('[PRODUCT VARIANT IMAGES] product options', {
    groups: optionGroups.map((group) => ({
      name: group.name,
      values: group.values,
    })),
  });

  if (colorOptionName) {
    logVariantImages('[PRODUCT VARIANT IMAGES] color option name', { colorOptionName });
  }

  const sizeEntry = Object.entries(selectedOptions).find(([name]) => isSizeOptionName(name));
  if (sizeEntry) {
    logVariantImages('[PRODUCT VARIANT IMAGES] selected size', {
      name: sizeEntry[0],
      value: sizeEntry[1],
    });
  }

  const colorEntry = colorOptionName
    ? [colorOptionName, selectedOptions[colorOptionName]]
    : Object.entries(selectedOptions).find(([name]) => isColorOptionName(name));

  if (colorEntry?.[1]) {
    logVariantImages('[PRODUCT VARIANT IMAGES] selected color', {
      name: colorEntry[0],
      value: colorEntry[1],
    });
  }

  if (selectedVariant?.id) {
    logVariantImages('[PRODUCT VARIANT IMAGES] selected variant id', {
      variantId: String(selectedVariant.id),
    });
  }
}
