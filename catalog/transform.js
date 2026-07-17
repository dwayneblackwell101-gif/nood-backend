function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stripHtml(html) {
  return safeString(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toStorefrontMoney(amount, currencyCode = 'USD') {
  const num = Number(amount);
  const safeAmount = Number.isFinite(num) ? num.toFixed(2) : '0.00';
  return { amount: safeAmount, currencyCode: safeString(currencyCode, 'USD') };
}

function isActiveProductStatus(status) {
  return safeString(status, 'ACTIVE').toUpperCase() === 'ACTIVE';
}

function variantAvailable(variant) {
  const quantity = Number(variant?.inventoryQuantity ?? variant?.quantityAvailable ?? 0);
  const policy = safeString(variant?.inventoryPolicy).toUpperCase();
  if (policy === 'CONTINUE') return true;
  return quantity > 0;
}

function transformAdminVariant(variant, currencyCode) {
  const price = toStorefrontMoney(variant?.price, currencyCode);
  return {
    id: variant.id,
    title: safeString(variant?.title, 'Default Title'),
    availableForSale: variantAvailable(variant),
    quantityAvailable: Number(variant?.inventoryQuantity ?? 0),
    sku: safeString(variant?.sku),
    barcode: safeString(variant?.barcode),
    price,
    selectedOptions: Array.isArray(variant?.selectedOptions)
      ? variant.selectedOptions.map((option) => ({
          name: safeString(option?.name),
          value: safeString(option?.value),
        }))
      : [],
  };
}

function normalizeMediaEdge(edge, fallbackId, fallbackImageNode = null) {
  const node = edge?.node || {};
  const mediaType = safeString(node.__typename) || safeString(node.mediaContentType);
  const image = node.image || null;
  const previewImage = node.previewImage || node.preview?.image || null;
  const sources = Array.isArray(node.sources)
    ? node.sources.map((source) => ({
        url: safeString(source?.url),
        mimeType: safeString(source?.mimeType),
        format: safeString(source?.format),
        height: source?.height ?? null,
        width: source?.width ?? null,
      })).filter((source) => source.url)
    : [];

  if (mediaType === 'Video' || mediaType === 'VIDEO') {
    return {
      node: {
        __typename: 'Video',
        id: safeString(node.id, fallbackId),
        previewImage: previewImage?.url
          ? {
              url: previewImage.url,
              altText: previewImage.altText || null,
            }
          : null,
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
        previewImage: previewImage?.url
          ? {
              url: previewImage.url,
              altText: previewImage.altText || null,
            }
          : null,
      },
    };
  }

  if (mediaType === 'Model3d' || mediaType === 'MODEL_3D') {
    return {
      node: {
        __typename: 'Model3d',
        id: safeString(node.id, fallbackId),
        previewImage: previewImage?.url
          ? {
              url: previewImage.url,
              altText: previewImage.altText || null,
            }
          : null,
        sources,
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
  );
  const firstVariant = variants[0] || null;
  const prices = variants
    .map((variant) => Number(variant?.price?.amount || 0))
    .filter((value) => Number.isFinite(value));
  const compareAtPrices = (adminProduct?.variants?.edges || [])
    .map((edge) => Number(edge?.node?.compareAtPrice || 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxCompareAt = compareAtPrices.length ? Math.max(...compareAtPrices) : null;

  const collectionEdges = (adminProduct?.collections?.edges || []).map((edge) => ({
    node: {
      id: edge?.node?.id || '',
      handle: edge?.node?.handle || '',
      title: edge?.node?.title || '',
    },
  }));

  const imageEdges = (adminProduct?.images?.edges || []).map((edge) => ({
    node: {
      url: edge?.node?.url || '',
      altText: edge?.node?.altText || null,
      width: edge?.node?.width ?? null,
      height: edge?.node?.height ?? null,
    },
  }));

  const adminMediaEdges = (adminProduct?.media?.edges || [])
    .map((edge, index) => normalizeMediaEdge(edge, `${adminProduct?.id || 'media'}_${index}`))
    .filter(
      (edge) =>
        edge?.node?.image?.url ||
        edge?.node?.previewImage?.url ||
        edge?.node?.sources?.length ||
        edge?.node?.embedUrl ||
        edge?.node?.originUrl
    );

  const mediaEdges = adminMediaEdges.length
    ? adminMediaEdges
    : imageEdges.map((edge, index) =>
        normalizeMediaEdge(null, `${adminProduct?.id || 'media'}_${index}`, edge.node)
      );

  const provisionalFeatured = adminProduct?.featuredImage?.url
    ? {
        url: adminProduct.featuredImage.url,
        altText: adminProduct.featuredImage.altText || null,
        width: adminProduct.featuredImage.width ?? null,
        height: adminProduct.featuredImage.height ?? null,
      }
    : imageEdges[0]?.node?.url
      ? {
          url: imageEdges[0].node.url,
          altText: imageEdges[0].node.altText || null,
          width: imageEdges[0].node.width ?? null,
          height: imageEdges[0].node.height ?? null,
        }
      : null;

  const productRecord = {
    id: adminProduct.id,
    title: safeString(adminProduct?.title, 'Product'),
    handle: safeString(adminProduct?.handle),
    descriptionHtml: safeString(adminProduct?.descriptionHtml),
    description: stripHtml(adminProduct?.descriptionHtml),
    vendor: safeString(adminProduct?.vendor),
    productType: safeString(adminProduct?.productType),
    tags: Array.isArray(adminProduct?.tags) ? adminProduct.tags : [],
    status: safeString(adminProduct?.status, 'ACTIVE').toUpperCase(),
    availableForSale: variants.some((variant) => variant.availableForSale),
    featuredImage: provisionalFeatured,
    images: { edges: imageEdges },
    media: { edges: mediaEdges },
    priceRange: {
      minVariantPrice: toStorefrontMoney(minPrice, currencyCode),
    },
    compareAtPriceRange: maxCompareAt
      ? { maxVariantPrice: toStorefrontMoney(maxCompareAt, currencyCode) }
      : { maxVariantPrice: null },
    collections: { edges: collectionEdges },
    variants: {
      edges: variants.map((variant) => ({ node: variant })),
    },
    updatedAt: adminProduct?.updatedAt || new Date().toISOString(),
    collectionHandles: collectionEdges.map((edge) => edge.node.handle).filter(Boolean),
    firstVariantId: firstVariant?.id || null,
    firstVariantTitle: firstVariant?.title || null,
  };

  // Ensure featuredImage is populated from images/media when Admin featuredImage is absent.
  const resolvedPrimary = resolvePrimaryListImage(productRecord);
  if (resolvedPrimary) {
    productRecord.featuredImage = resolvedPrimary;
  }

  return productRecord;
}

function getStorefrontVariantEdges(node) {
  if (Array.isArray(node?.variants?.edges)) return node.variants.edges;
  if (Array.isArray(node?.variants?.nodes)) {
    return node.variants.nodes.map((variantNode) => ({ node: variantNode }));
  }
  if (Array.isArray(node?.variants)) {
    return node.variants.map((entry) => ({ node: entry?.node || entry }));
  }
  return [];
}

function transformStorefrontProduct(node, currencyCode = 'USD') {
  if (!node) return null;
  const variants = getStorefrontVariantEdges(node).map((edge) => {
    const v = edge?.node || edge;
    const afsExplicit = v?.availableForSale;
    return {
      node: {
        id: v?.id,
        title: v?.title,
        // Never invent false from missing flag — that sold out the entire catalog after hydrate.
        availableForSale:
          afsExplicit === undefined || afsExplicit === null
            ? v?.currentlyNotInStock === true
              ? false
              : true
            : Boolean(afsExplicit),
        quantityAvailable:
          v?.quantityAvailable === undefined || v?.quantityAvailable === null
            ? null
            : Number(v.quantityAvailable),
        currentlyNotInStock:
          v?.currentlyNotInStock === undefined || v?.currentlyNotInStock === null
            ? undefined
            : Boolean(v.currentlyNotInStock),
        price: v?.price || toStorefrontMoney(0, currencyCode),
        selectedOptions: v?.selectedOptions || [],
      },
    };
  });

  const anyVariantForSale = variants.some((edge) => edge?.node?.availableForSale === true);
  const productAvailableForSale =
    node.availableForSale === undefined || node.availableForSale === null
      ? anyVariantForSale
      : Boolean(node.availableForSale) || anyVariantForSale;

  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    descriptionHtml: node.descriptionHtml || '',
    description: stripHtml(node.descriptionHtml || node.description || ''),
    vendor: node.vendor || '',
    productType: node.productType || '',
    tags: Array.isArray(node.tags) ? node.tags : [],
    status: 'ACTIVE',
    availableForSale: productAvailableForSale,
    featuredImage: node.featuredImage || null,
    images: node.images || { edges: [] },
    media: node.media || { edges: [] },
    priceRange: node.priceRange || { minVariantPrice: toStorefrontMoney(0, currencyCode) },
    compareAtPriceRange: node.compareAtPriceRange || { maxVariantPrice: null },
    collections: node.collections || { edges: [] },
    variants: { edges: variants },
    updatedAt: node.updatedAt || new Date().toISOString(),
    collectionHandles:
      node.collections?.edges?.map((edge) => edge?.node?.handle).filter(Boolean) || [],
    firstVariantId: variants[0]?.node?.id || null,
    firstVariantTitle: variants[0]?.node?.title || null,
  };
}

/**
 * RC1 CRITICAL — never set CACHE_MAX_IMAGES to 1.
 * Production global gallery failure was caused by:
 *   CACHE_MAX_IMAGES = 1
 *   CACHE_MAX_DESCRIPTION_HTML_CHARS = 800
 * which made every Redis product a single-preview row with truncated HTML.
 * Product detail requires full multi-image galleries + full descriptionHtml.
 */
const CACHE_MAX_IMAGES = 30;
const CACHE_MAX_VARIANTS = 250;
// Intentionally NO max on descriptionHtml length (was 800 — truncated mid-tag, killed <img>).

function compactVariantForCache(variant) {
  if (!variant) {
    return null;
  }

  return {
    id: variant.id,
    title: safeString(variant.title, 'Default Title'),
    availableForSale: Boolean(variant.availableForSale),
    quantityAvailable: Number(variant.quantityAvailable ?? variant.inventoryQuantity ?? 0),
    sku: safeString(variant.sku),
    barcode: safeString(variant.barcode),
    price: variant.price || toStorefrontMoney(0, 'USD'),
    selectedOptions: Array.isArray(variant.selectedOptions)
      ? variant.selectedOptions.map((option) => ({
          name: safeString(option?.name),
          value: safeString(option?.value),
        }))
      : [],
  };
}

function compactProductForCache(product) {
  if (!product || !product.handle || !product.id) {
    return null;
  }
  if (!isActiveProductStatus(product.status)) {
    return null;
  }

  const imageEdges = (product?.images?.edges || []).slice(0, CACHE_MAX_IMAGES);
  const mediaEdges = (product?.media?.edges || []).slice(0, CACHE_MAX_IMAGES).map((edge, index) =>
    normalizeMediaEdge(edge, `${product.id || 'media'}_${index}`)
  );
  const normalizedMediaEdges = mediaEdges.length
    ? mediaEdges
    : imageEdges.map((edge, index) =>
        normalizeMediaEdge(null, `${product.id || 'media'}_${index}`, edge?.node)
      );
  const collectionEdges = product?.collections?.edges || [];
  const collectionHandles = Array.isArray(product.collectionHandles) && product.collectionHandles.length
    ? product.collectionHandles
    : collectionEdges.map((edge) => safeString(edge?.node?.handle)).filter(Boolean);
  const variantEdges = (product?.variants?.edges || [])
    .slice(0, CACHE_MAX_VARIANTS)
    .map((edge) => {
      const compactVariant = compactVariantForCache(edge?.node);
      return compactVariant ? { node: compactVariant } : null;
    })
    .filter(Boolean);

  // RC1: never truncate descriptionHtml — product detail + embedded <img> tags depend on full HTML.
  const fullDescriptionHtml = typeof product.descriptionHtml === 'string'
    ? product.descriptionHtml
    : safeString(product.descriptionHtml);

  const compact = {
    id: product.id,
    title: product.title,
    handle: product.handle,
    descriptionHtml: fullDescriptionHtml,
    // Plain-text companion only — never used as the sole detail description when HTML exists.
    description: stripHtml(fullDescriptionHtml || product.description || ''),
    vendor: safeString(product.vendor),
    productType: safeString(product.productType),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 20) : [],
    status: safeString(product.status, 'ACTIVE').toUpperCase(),
    // Prefer true if any variant is for sale — never collapse missing/false over real stock.
    availableForSale:
      Boolean(product.availableForSale) ||
      variantEdges.some((edge) => edge?.node?.availableForSale === true),
    featuredImage: product.featuredImage || null,
    images: { edges: imageEdges },
    media: { edges: normalizedMediaEdges },
    priceRange: product.priceRange || {
      minVariantPrice: toStorefrontMoney(0, 'USD'),
    },
    collections: {
      edges: collectionEdges.slice(0, 10).map((edge) => ({
        node: {
          id: edge?.node?.id || '',
          handle: edge?.node?.handle || '',
          title: edge?.node?.title || '',
        },
      })),
    },
    variants: { edges: variantEdges },
    updatedAt: product.updatedAt || new Date().toISOString(),
    collectionHandles,
    firstVariantId: product.firstVariantId || null,
    firstVariantTitle: product.firstVariantTitle || null,
  };

  if (product.compareAtPriceRange?.maxVariantPrice) {
    compact.compareAtPriceRange = product.compareAtPriceRange;
  }

  // Persist resolved primary image so list feeds do not re-derive from empty featuredImage.
  const resolvedPrimary = resolvePrimaryListImage(compact);
  if (resolvedPrimary) {
    compact.featuredImage = resolvedPrimary;
  }

  return compact;
}

function toProductEdge(product) {
  return { node: product };
}

function getCollectionEdges(product, maxCollections = 10) {
  const existing = product?.collections?.edges || [];
  if (existing.length) {
    return existing.slice(0, maxCollections).map((edge) => ({
      node: {
        id: edge?.node?.id || '',
        handle: edge?.node?.handle || '',
        title: edge?.node?.title || '',
      },
    }));
  }

  return (product?.collectionHandles || [])
    .slice(0, maxCollections)
    .map((handle, index) => ({
      node: {
        id: `${product?.id || 'collection'}_${index}`,
        handle,
        title: handle,
      },
    }));
}

/**
 * Shared image URL extraction (same sources as product detail gallery).
 * Prefer: node.url / src / image.url / previewImage.url
 */
function getImageNodeUrl(node) {
  return safeString(
    node?.url ||
      node?.src ||
      node?.image?.url ||
      node?.previewImage?.url ||
      node?.preview?.image?.url
  );
}

function getImageNodeAlt(node) {
  return safeString(
    node?.altText || node?.alt || node?.image?.altText || node?.previewImage?.altText
  );
}

function addGalleryImage(images, seen, node) {
  const url = getImageNodeUrl(node);
  if (!url || seen.has(url)) {
    return;
  }

  seen.add(url);
  images.push({
    id: safeString(node?.id) || url,
    url,
    src: url,
    altText: getImageNodeAlt(node) || null,
    width: node?.width ?? node?.image?.width ?? node?.previewImage?.width ?? null,
    height: node?.height ?? node?.image?.height ?? node?.previewImage?.height ?? null,
  });
}

/**
 * Product detail gallery:
 * 1) images.edges (order preserved)
 * 2) media.edges merged in (dedupe by URL — never skip media just because images has items)
 * 3) thumbnail / featuredImage only if still empty
 */
function buildProductGalleryImages(product) {
  const images = [];
  const seen = new Set();
  const handle = safeString(product?.handle) || '(no-handle)';
  const imagesEdgesIn = (product?.images?.edges || []).length;
  const mediaEdgesIn = (product?.media?.edges || []).length;

  for (const edge of product?.images?.edges || []) {
    addGalleryImage(images, seen, edge?.node);
  }
  const afterImages = images.length;

  // RC1: always merge media; do not require images to be empty first.
  for (const edge of product?.media?.edges || []) {
    const node = edge?.node;
    // Prefer MediaImage.image / Video preview / generic node URL extractors.
    addGalleryImage(images, seen, node?.image || node?.previewImage || node);
  }
  const afterMedia = images.length;

  if (!images.length) {
    addGalleryImage(images, seen, product?.thumbnail || product?.featuredImage);
  }

  console.log('[GALLERY DEBUG] buildProductGalleryImages', {
    handle,
    stage: 'buildProductGalleryImages',
    imagesEdgesIn,
    mediaEdgesIn,
    afterImages,
    afterMediaMerge: afterMedia,
    galleryOut: images.length,
  });

  return images;
}

/**
 * Primary image for list endpoints (home, categories, search, recommendations).
 * Preference (investigation Fix 1):
 * 1) featuredImage when present
 * 2) first valid product image
 * 3) first valid media image / preview
 * 4) thumbnail
 */
function resolvePrimaryListImage(product) {
  if (!product || typeof product !== 'object') {
    return null;
  }

  const featuredUrl = safeString(product?.featuredImage?.url || product?.featuredImage?.src);
  if (featuredUrl) {
    return {
      url: featuredUrl,
      width: product.featuredImage.width ?? null,
      height: product.featuredImage.height ?? null,
      altText: product.featuredImage.altText ?? product.featuredImage.alt ?? null,
    };
  }

  for (const edge of product?.images?.edges || []) {
    const url = getImageNodeUrl(edge?.node);
    if (url) {
      return {
        url,
        width: edge?.node?.width ?? edge?.node?.image?.width ?? null,
        height: edge?.node?.height ?? edge?.node?.image?.height ?? null,
        altText: getImageNodeAlt(edge?.node) || null,
      };
    }
  }

  for (const edge of product?.media?.edges || []) {
    const node = edge?.node;
    const url = getImageNodeUrl(node);
    if (url) {
      return {
        url,
        width: node?.width ?? node?.image?.width ?? node?.previewImage?.width ?? null,
        height: node?.height ?? node?.image?.height ?? node?.previewImage?.height ?? null,
        altText: getImageNodeAlt(node) || null,
      };
    }
  }

  const thumbUrl = getImageNodeUrl(product?.thumbnail);
  if (thumbUrl) {
    return {
      url: thumbUrl,
      width: product?.thumbnail?.width ?? null,
      height: product?.thumbnail?.height ?? null,
      altText: getImageNodeAlt(product?.thumbnail) || null,
    };
  }

  return null;
}

function toStorefrontListProduct(product) {
  const firstVariant = product?.variants?.edges?.[0]?.node || null;
  const featuredImage = resolvePrimaryListImage(product);

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor || '',
    productType: product.productType || '',
    description: product.description || '',
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 12) : [],
    availableForSale: Boolean(product.availableForSale),
    featuredImage,
    priceRange: product.priceRange || {
      minVariantPrice: toStorefrontMoney(0, 'USD'),
    },
    compareAtPriceRange: product.compareAtPriceRange || { maxVariantPrice: null },
    collections: {
      edges: getCollectionEdges(product, 10),
    },
    variants: {
      edges: firstVariant
        ? [
            {
              node: {
                id: firstVariant.id,
                title: firstVariant.title || 'Default Title',
                availableForSale: Boolean(firstVariant.availableForSale),
                quantityAvailable: firstVariant.quantityAvailable ?? null,
              },
            },
          ]
        : [],
    },
  };
}

function paginateItems(items, first, after) {
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;
  const slice = items.slice(start, start + limit);
  const nextIndex = start + slice.length;
  const hasNextPage = nextIndex < items.length;

  return {
    edges: slice.map(toProductEdge),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? String(nextIndex) : null,
    },
  };
}

function paginateListProducts(items, first, after) {
  const limit = Math.max(1, Math.min(Number(first) || 50, 250));
  const start = Number(after) > 0 ? Number(after) : 0;
  const slice = items.slice(start, start + limit);
  const nextIndex = start + slice.length;
  const hasNextPage = nextIndex < items.length;

  return {
    edges: slice.map((product) => ({ node: toStorefrontListProduct(product) })),
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? String(nextIndex) : null,
    },
  };
}

function normalizeSearchText(value) {
  return safeString(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function compactSearchToken(value) {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, '');
}

function getSearchVariantNodes(product) {
  return (product?.variants?.edges || []).map((edge) => edge?.node).filter(Boolean);
}

function buildProductSearchIndex(product) {
  const parts = [
    product.title,
    product.handle,
    product.vendor,
    product.productType,
    product.description,
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.collectionHandles) ? product.collectionHandles : []),
  ];

  for (const collectionEdge of product?.collections?.edges || []) {
    parts.push(collectionEdge?.node?.title);
    parts.push(collectionEdge?.node?.handle);
  }

  for (const variant of getSearchVariantNodes(product)) {
    parts.push(variant.title);
    parts.push(variant.sku);
    parts.push(variant.barcode);
    for (const option of variant.selectedOptions || []) {
      parts.push(option?.name);
      parts.push(option?.value);
    }
  }

  const text = parts.map((part) => safeString(part)).filter(Boolean).join(' ');
  const normalized = normalizeSearchText(text);
  const compact = compactSearchToken(text);

  return {
    text: normalized,
    compact,
    title: normalizeSearchText(product.title),
    titleCompact: compactSearchToken(product.title),
    handle: normalizeSearchText(product.handle),
    handleCompact: compactSearchToken(product.handle),
    description: normalizeSearchText(product.description),
    product,
  };
}

function searchTokenMatchesIndex(token, index) {
  if (!token) {
    return true;
  }

  const compactToken = compactSearchToken(token);
  const words = index.text.split(' ').filter(Boolean);

  if (token.length === 1) {
    return (
      index.text.includes(token) ||
      index.compact.includes(compactToken) ||
      index.title.startsWith(token) ||
      index.titleCompact.startsWith(compactToken) ||
      index.handle.startsWith(token) ||
      index.handleCompact.startsWith(compactToken) ||
      words.some((word) => word.startsWith(token))
    );
  }

  return (
    index.text.includes(token) ||
    index.compact.includes(compactToken) ||
    words.some((word) => word.startsWith(token) || word.includes(token))
  );
}

function scoreSearchMatch(index, query) {
  const normalizedQuery = normalizeSearchText(query);
  const queryCompact = compactSearchToken(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);

  if (!tokens.length) {
    return 0;
  }

  if (!tokens.every((token) => searchTokenMatchesIndex(token, index))) {
    return 0;
  }

  let score = 0;
  const { title, titleCompact, handle, handleCompact, description, text, compact, product } = index;

  if (title === normalizedQuery || titleCompact === queryCompact) {
    score += 10000;
  }
  if (handle === normalizedQuery || handleCompact === queryCompact) {
    score += 9500;
  }

  if (title.startsWith(normalizedQuery) || titleCompact.startsWith(queryCompact)) {
    score += 5000;
  }

  if (tokens.length === 1) {
    const token = tokens[0];
    const tokenCompact = compactSearchToken(token);
    if (title.startsWith(token) || titleCompact.startsWith(tokenCompact)) {
      score += 4500;
    }
    if (handle.startsWith(token) || handleCompact.startsWith(tokenCompact)) {
      score += 4200;
    }
  }

  if (title.includes(normalizedQuery) || titleCompact.includes(queryCompact)) {
    score += 3000;
  }

  if (text.includes(normalizedQuery) || compact.includes(queryCompact)) {
    score += 1200;
  }

  if (tokens.every((token) => title.includes(token) || titleCompact.includes(compactSearchToken(token)))) {
    score += 2000;
  }

  for (const variant of getSearchVariantNodes(product)) {
    const variantTitle = normalizeSearchText(variant.title);
    const variantCompact = compactSearchToken(variant.title);
    if (tokens.some((token) => variantTitle.includes(token) || variantCompact.includes(compactSearchToken(token)))) {
      score += 800;
    }

    for (const option of variant.selectedOptions || []) {
      const optionName = normalizeSearchText(option?.name);
      const optionValue = normalizeSearchText(option?.value);
      if (
        tokens.some(
          (token) => optionName.includes(token) || optionValue.includes(token)
        )
      ) {
        score += 600;
      }
    }

    const sku = normalizeSearchText(variant.sku);
    const barcode = normalizeSearchText(variant.barcode);
    if (tokens.some((token) => (sku && sku.includes(token)) || (barcode && barcode.includes(token)))) {
      score += 700;
    }
  }

  const tags = (Array.isArray(product.tags) ? product.tags : []).map((tag) => normalizeSearchText(tag));
  const collections = (Array.isArray(product.collectionHandles) ? product.collectionHandles : []).map(
    (handleValue) => normalizeSearchText(handleValue)
  );

  if (tokens.some((token) => tags.some((tag) => tag.includes(token)))) {
    score += 400;
  }
  if (tokens.some((token) => collections.some((collection) => collection.includes(token)))) {
    score += 350;
  }

  const matchedInTitle = tokens.some((token) => title.includes(token) || titleCompact.includes(compactSearchToken(token)));
  const matchedInDescriptionOnly =
    tokens.every((token) => description.includes(token)) && !matchedInTitle;

  if (matchedInDescriptionOnly) {
    score += 100;
  } else {
    score += 50;
  }

  return score;
}

function searchProducts(products, query) {
  const trimmed = safeString(query);
  if (!trimmed) {
    return Array.isArray(products) ? products : [];
  }

  return (Array.isArray(products) ? products : [])
    .map((product) => {
      const index = buildProductSearchIndex(product);
      const score = scoreSearchMatch(index, trimmed);
      return score > 0 ? { product, score } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.product);
}

function shuffleProducts(products, seed) {
  const copy = [...products];
  let state = Number(seed) > 0 ? Number(seed) >>> 0 : Date.now() >>> 0;

  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

module.exports = {
  safeString,
  stripHtml,
  transformAdminProduct,
  transformStorefrontProduct,
  compactProductForCache,
  toStorefrontListProduct,
  resolvePrimaryListImage,
  buildProductGalleryImages,
  getImageNodeUrl,
  getImageNodeAlt,
  paginateItems,
  paginateListProducts,
  searchProducts,
  shuffleProducts,
};
