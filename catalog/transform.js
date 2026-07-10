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

  const featuredImage = adminProduct?.featuredImage?.url
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
          width: null,
          height: null,
        }
      : null;

  return {
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
    featuredImage,
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
}

function transformStorefrontProduct(node, currencyCode = 'USD') {
  if (!node) return null;
  const variants = (node?.variants?.edges || []).map((edge) => ({
    node: {
      id: edge?.node?.id,
      title: edge?.node?.title,
      availableForSale: Boolean(edge?.node?.availableForSale),
      quantityAvailable: edge?.node?.quantityAvailable ?? null,
      price: edge?.node?.price || toStorefrontMoney(0, currencyCode),
      selectedOptions: edge?.node?.selectedOptions || [],
    },
  }));

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
    availableForSale: Boolean(node.availableForSale),
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

const CACHE_MAX_IMAGES = 30;
const CACHE_MAX_VARIANTS = 250;

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

  const compact = {
    id: product.id,
    title: product.title,
    handle: product.handle,
    descriptionHtml: safeString(product.descriptionHtml),
    description: stripHtml(product.descriptionHtml || product.description || ''),
    vendor: safeString(product.vendor),
    productType: safeString(product.productType),
    tags: Array.isArray(product.tags) ? product.tags.slice(0, 20) : [],
    status: safeString(product.status, 'ACTIVE').toUpperCase(),
    availableForSale: Boolean(product.availableForSale),
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

function toStorefrontListProduct(product) {
  const firstVariant = product?.variants?.edges?.[0]?.node || null;
  const featuredImage = product?.featuredImage?.url
    ? {
        url: product.featuredImage.url,
        width: product.featuredImage.width ?? null,
        height: product.featuredImage.height ?? null,
        altText: product.featuredImage.altText ?? null,
      }
    : null;

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
  paginateItems,
  paginateListProducts,
  searchProducts,
  shuffleProducts,
};
