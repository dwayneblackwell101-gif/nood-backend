function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function shuffleProducts(products, seed) {
  if (!Array.isArray(products) || products.length === 0) return [];
  const copy = [...products];
  let hash = 0;
  for (let i = 0; i < String(seed || '').length; i++) {
    hash = ((hash << 5) - hash + String(seed).charCodeAt(i)) | 0;
  }
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.abs((hash + i * 2654435761) | 0) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function toStorefrontMoney(amount, currencyCode = 'USD') {
  const safeAmount = Number(amount || 0).toFixed(2);
  return { amount: safeAmount, currencyCode: safeString(currencyCode, 'USD') };
}

function isActiveProductStatus(status) {
  return safeString(status, 'ACTIVE').toUpperCase() === 'ACTIVE';
}

function variantAvailable(variant) {
  const quantity = Number(variant?.inventoryQuantity ?? variant?.quantityAvailable ?? 0);
  const policy = safeString(variant?.inventoryPolicy).toUpperCase();
  return Boolean(variant?.availableForSale || quantity > 0 || policy === 'CONTINUE');
}

function transformAdminVariant(variant, currencyCode) {
  if (!variant) return null;

  const price = toStorefrontMoney(variant?.price || 0, currencyCode);

  // Extract variant-specific media (images)
  let variantImage = null;
  if (variant.media?.edges && variant.media.edges.length > 0) {
    for (const edge of variant.media.edges) {
      const node = edge?.node;
      if (node && (node.__typename === 'MediaImage' || node.mediaContentType === 'IMAGE') && node.image?.url) {
        variantImage = {
          url: safeString(node.image.url),
          altText: safeString(node.image.altText),
          width: node.image.width ?? null,
          height: node.image.height ?? null,
        };
        break; // Use first image
      }
    }
  }

  return {
    id: safeString(variant.id),
    title: safeString(variant.title, 'Default Title'),
    availableForSale: variantAvailable(variant),
    quantityAvailable: Number(variant?.inventoryQuantity ?? 0),
    sku: safeString(variant.sku),
    barcode: safeString(variant.barcode),
    price,
    selectedOptions: Array.isArray(variant.selectedOptions) ? variant.selectedOptions.map((option) => ({
      name: safeString(option.name),
      value: safeString(option.value),
    })) : [],
    image: variantImage,
  };
}

function normalizeMediaEdge(edge, fallbackId, fallbackImageNode = null) {
  const node = edge?.node || {};
  const mediaType = safeString(node.__typename) || safeString(node.mediaContentType);
  const image = node.image || null;
  const previewImage = node.previewImage || node.preview?.image || null;
  const sources = Array.isArray(node.sources) ? node.sources.map((source) => ({
    url: safeString(source?.url),
    mimeType: safeString(source?.mimeType),
    format: safeString(source?.format),
    height: source?.height ?? null,
    width: source?.width ?? null,
  })).filter((source) => source.url) : [];

  if (mediaType === 'Video' || mediaType === 'VIDEO') {
    return {
      node: {
        __typename: 'Video',
        id: safeString(node.id, fallbackId),
        previewImage: previewImage?.url ? {
          url: previewImage.url,
          altText: previewImage.altText || null,
        } : null,
        sources,
      },
    };
  }

  if (mediaType === 'ExternalVideo' || mediaType === 'EXTERNAL_VIDEO') {
    return {
      node: {
        __typename: 'ExternalVideo',
        id: safeString(node.id, fallbackId),
        embedUrl: safeString(node.embedUrl),
        originUrl: safeString(node.originUrl),
        previewImage: previewImage?.url ? {
          url: previewImage.url,
          altText: previewImage.altText || null,
        } : null,
      },
    };
  }

  const mediaImage = image || fallbackImageNode;
  return {
    node: {
      __typename: 'MediaImage',
      id: safeString(node.id, fallbackId),
      image: {
        url: safeString(mediaImage?.url),
        altText: mediaImage?.altText || null,
        width: mediaImage?.width ?? null,
        height: mediaImage?.height ?? null,
      },
    },
  };
}

function transformAdminProduct(adminProduct, currencyCode = 'USD') {
  const variants = (adminProduct?.variants?.edges || []).map((edge) =>
    transformAdminVariant(edge?.node, currencyCode)
  ).filter(Boolean);

  const imageEdges = (adminProduct?.images?.edges || []).map((edge, index) => ({
    node: {
      url: safeString(edge?.node?.url),
      altText: safeString(edge?.node?.altText),
      width: edge?.node?.width ?? null,
      height: edge?.node?.height ?? null,
    },
  }));

  const mediaEdges = (adminProduct?.media?.edges || []).map((edge, index) =>
    normalizeMediaEdge(edge, `${adminProduct?.id || 'media'}_${index}`)
  ).filter(Boolean);

  // Determine featuredImage - fallback to first media image if no featuredImage and no images
  let featuredImage = adminProduct?.featuredImage?.url ? {
    url: adminProduct.featuredImage.url,
    altText: adminProduct.featuredImage.altText || null,
  } : null;

  if (!featuredImage && imageEdges.length === 0 && mediaEdges.length > 0) {
    // Fallback to first media image
    const firstMedia = mediaEdges[0]?.node;
    if (firstMedia?.image?.url) {
      featuredImage = { url: firstMedia.image.url, altText: firstMedia.image.altText || null };
    } else if (firstMedia?.previewImage?.url) {
      featuredImage = { url: firstMedia.previewImage.url, altText: firstMedia.previewImage.altText || null };
    }
  }

  return {
    id: adminProduct.id,
    title: adminProduct.title,
    handle: adminProduct.handle,
    descriptionHtml: safeString(adminProduct.descriptionHtml),
    description: stripHtml(adminProduct.descriptionHtml || adminProduct.description || ''),
    vendor: safeString(adminProduct.vendor),
    productType: safeString(adminProduct.productType),
    tags: Array.isArray(adminProduct.tags) ? adminProduct.tags : [],
    status: safeString(adminProduct.status, 'ACTIVE').toUpperCase(),
    availableForSale: variants.some((variant) => variant.availableForSale),
    featuredImage,
    images: { edges: imageEdges },
    media: { edges: mediaEdges.length ? mediaEdges : imageEdges },
    priceRange: adminProduct.priceRange || null,
    compareAtPriceRange: adminProduct.compareAtPriceRange || { maxVariantPrice: null },
    variants: { edges: variants.map(v => ({ node: v })) },
    collectionHandles: Array.isArray(adminProduct.collectionHandles) ? adminProduct.collectionHandles : [],
  };
}

function compactVariantForCache(variant) {
  if (!variant) return null;
  return {
    id: safeString(variant.id),
    title: safeString(variant.title, 'Default Title'),
    availableForSale: Boolean(variant.availableForSale),
    quantityAvailable: Number(variant.quantityAvailable ?? variant.inventoryQuantity ?? 0),
    sku: safeString(variant.sku),
    barcode: safeString(variant.barcode),
    price: variant.price || toStorefrontMoney(0, 'USD'),
    selectedOptions: Array.isArray(variant.selectedOptions) ? variant.selectedOptions.map((option) => ({
      name: safeString(option.name),
      value: safeString(option.value),
    })) : [],
  };
}

function getImageNodeUrl(node) {
  if (!node) return '';
  // Handle multiple nested structures: direct url, node.url, node.image.url, node.previewImage.url
  return safeString(node.url || node.src || node.image?.url || node.previewImage?.url || node?.node?.url || node?.node?.image?.url || node?.node?.previewImage?.url);
}

function getImageNodeAlt(node) {
  if (!node) return '';
  return safeString(node.altText || node.alt || node.image?.altText || node.previewImage?.altText || node?.node?.altText || node?.node?.image?.altText || node?.node?.previewImage?.altText);
}

function addGalleryImage(images, seen, node) {
  // Accept either a direct node or an edge with .node
  const actualNode = node?.node ?? node;
  const url = getImageNodeUrl(actualNode);
  if (!url || seen.has(url)) {
    return;
  }
  seen.add(url);
  images.push({
    id: safeString(actualNode?.id) || url,
    url,
    src: url,
    altText: getImageNodeAlt(actualNode) || null,
    width: actualNode?.width ?? actualNode?.image?.width ?? null,
    height: actualNode?.height ?? actualNode?.image?.height ?? null,
  });
}

function buildProductGalleryImages(product) {
  if (!product) return [];
  const images = [];
  const seen = new Set();

  // First, collect from images.edges (highest priority for gallery)
  for (const edge of product?.images?.edges || []) {
    addGalleryImage(images, seen, edge);
  }

  // Then, collect from media.edges (add unique ones not already in images)
  for (const edge of product?.media?.edges || []) {
    addGalleryImage(images, seen, edge);
  }

  // Finally, fall back to thumbnail or featuredImage
  if (!images.length) {
    addGalleryImage(images, seen, product?.thumbnail);
    addGalleryImage(images, seen, product?.featuredImage);
  }

  return images;
}

function resolvePrimaryListImage(product) {
  if (!product) return null;
  if (product?.featuredImage?.url) return product.featuredImage;
  for (const edge of product?.images?.edges || []) {
    if (edge?.node?.url) return edge.node;
  }
  for (const edge of product?.media?.edges || []) {
    const node = edge?.node;
    if (node?.image?.url) return node.image;
    if (node?.previewImage?.url) return node.previewImage;
  }
  return null;
}

function transformStorefrontProduct(node, currencyCode = 'USD') {
  const variants = (node?.variants?.edges || []).map((edge) => {
    const v = edge?.node || {};
    const price = v?.price?.amount ? toStorefrontMoney(v.price.amount, currencyCode) : toStorefrontMoney(0, currencyCode);

    // Storefront API variant.image falls back to product image if no variant-specific image
    let variantImage = null;
    if (v.image?.url) {
      variantImage = {
        url: safeString(v.image.url),
        altText: safeString(v.image.altText),
        width: null,
        height: null,
      };
    }

    return {
      id: safeString(v.id),
      title: safeString(v.title, 'Default Title'),
      availableForSale: v.availableForSale ?? (Number(v.quantityAvailable ?? v.inventoryQuantity ?? 0) > 0),
      quantityAvailable: Number(v.quantityAvailable ?? v.inventoryQuantity ?? 0),
      price,
      selectedOptions: Array.isArray(v.selectedOptions) ? v.selectedOptions.map((opt) => ({
        name: safeString(opt.name),
        value: safeString(opt.value),
      })) : [],
      image: variantImage,
    };
  }).filter(Boolean);

  const images = (node?.images?.edges || []).map((edge) => ({
    node: {
      url: safeString(edge?.node?.url),
      altText: safeString(edge?.node?.altText),
      width: edge?.node?.width ?? null,
      height: edge?.node?.height ?? null,
    },
  }));

  const mediaEdges = (node?.media?.edges || []).map((edge, index) =>
    normalizeMediaEdge(edge, `${node?.id || 'media'}_${index}`)
  ).filter(Boolean);

  const featuredImage = node?.featuredImage?.url ? {
    url: node.featuredImage.url,
    altText: node.featuredImage.altText || null,
  } : null;

  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    descriptionHtml: safeString(node.descriptionHtml),
    description: stripHtml(node.descriptionHtml || node.description || ''),
    vendor: safeString(node.vendor),
    productType: safeString(node.productType),
    tags: Array.isArray(node.tags) ? node.tags : [],
    status: safeString(node.status, 'ACTIVE').toUpperCase(),
    availableForSale: variants.some((variant) => variant.availableForSale),
    featuredImage,
    images: { edges: images },
    media: { edges: mediaEdges.length ? mediaEdges : images },
    priceRange: node.priceRange || null,
    compareAtPriceRange: node.compareAtPriceRange || { maxVariantPrice: null },
    variants: { edges: variants.map(v => ({ node: v })) },
    collections: node.collections || { edges: [] },
  };
}

function toStorefrontListProduct(product) {
  const primaryImage = resolvePrimaryListImage(product);
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: safeString(product.vendor),
    featuredImage: primaryImage ? { url: primaryImage.url, altText: primaryImage.altText || null } : null,
    priceRange: product.priceRange || null,
    availableForSale: Boolean(product.availableForSale),
  };
}

function compactProductForCache(product) {
  if (!product || !product.handle || !product.id) {
    return null;
  }
  if (!isActiveProductStatus(product.status)) {
    return null;
  }

  // Return full product data without truncation - all images, media, variants, and full descriptionHtml
  const imageEdges = product?.images?.edges || [];
  const mediaEdges = (product?.media?.edges || []).map((edge, index) =>
    normalizeMediaEdge(edge, `${product.id || 'media'}_${index}`)
  );

  const normalizedMediaEdges = mediaEdges.length ? mediaEdges : imageEdges.map((edge, index) =>
    normalizeMediaEdge(null, `${product.id || 'media'}_${index}`, edge?.node)
  );

  const variantEdges = product?.variants?.edges || [];
  const hasAvailableVariants = variantEdges.some((edge) => edge?.node?.availableForSale === true);

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    descriptionHtml: safeString(product.descriptionHtml),
    description: stripHtml(product.descriptionHtml || product.description || ''),
    vendor: safeString(product.vendor),
    productType: safeString(product.productType),
    tags: Array.isArray(product.tags) ? product.tags : [], // No tag limit
    status: safeString(product.status, 'ACTIVE').toUpperCase(),
    availableForSale: Boolean(product.availableForSale) || hasAvailableVariants,
    featuredImage: product.featuredImage || null,
    images: { edges: imageEdges },
    media: { edges: normalizedMediaEdges },
    priceRange: product.priceRange || null,
    compareAtPriceRange: product.compareAtPriceRange || { maxVariantPrice: null },
    variants: { edges: variantEdges },
    collectionHandles: Array.isArray(product.collectionHandles) ? product.collectionHandles : [],
  };
}

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function paginateItems(items, first, after) {
  const array = Array.isArray(items) ? items : [];
  const start = Number(after) > 0 ? Number(after) : 0;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const end = start + limit;
  const paginated = array.slice(start, end);
  const hasNextPage = end < array.length;

  return {
    edges: paginated.map((node, index) => ({ node, cursor: String(start + index) })),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? String(end) : null,
    },
    total: array.length,
  };
}

function paginateListProducts(items, first, after) {
  const array = Array.isArray(items) ? items : [];
  const start = Number(after) > 0 ? Number(after) : 0;
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const end = start + limit;
  const paginated = array.slice(start, end);
  const hasNextPage = end < array.length;

  return {
    edges: paginated.map((node) => ({ node })),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? String(end) : null,
    },
    total: array.length,
  };
}

function searchProducts(products, query) {
  const needle = safeString(query).toLowerCase();
  if (!needle) return [];

  return (Array.isArray(products) ? products : []).filter((product) => {
    const haystack = [
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      ...(product.tags || []),
      ...(product.collectionHandles || []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

module.exports = {
  toStorefrontMoney,
  isActiveProductStatus,
  transformAdminProduct,
  transformAdminVariant,
  compactProductForCache,
  compactVariantForCache,
  stripHtml,
  normalizeMediaEdge,
  safeString,
  shuffleProducts,
  getImageNodeUrl,
  getImageNodeAlt,
  addGalleryImage,
  buildProductGalleryImages,
  resolvePrimaryListImage,
  transformStorefrontProduct,
  toStorefrontListProduct,
  paginateItems,
  paginateListProducts,
  searchProducts,
};