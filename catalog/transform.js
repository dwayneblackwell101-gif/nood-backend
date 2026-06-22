function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stripHtml(html) {
  return safeString(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toStorefrontMoney(amount, currencyCode = 'TTD') {
  const num = Number(amount);
  const safeAmount = Number.isFinite(num) ? num.toFixed(2) : '0.00';
  return { amount: safeAmount, currencyCode: safeString(currencyCode, 'TTD') };
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
    price,
    selectedOptions: Array.isArray(variant?.selectedOptions)
      ? variant.selectedOptions.map((option) => ({
          name: safeString(option?.name),
          value: safeString(option?.value),
        }))
      : [],
  };
}

function transformAdminProduct(adminProduct, currencyCode = 'TTD') {
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
    },
  }));

  const mediaEdges = imageEdges.map((edge, index) => ({
    node: {
      __typename: 'MediaImage',
      id: `${adminProduct?.id || 'media'}_${index}`,
      image: {
        url: edge.node.url,
        altText: edge.node.altText,
      },
    },
  }));

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
    status: safeString(adminProduct?.status, 'ACTIVE'),
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

function transformStorefrontProduct(node, currencyCode = 'TTD') {
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
      minVariantPrice: toStorefrontMoney(0, 'TTD'),
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

function searchProducts(products, query) {
  const needle = safeString(query).toLowerCase();
  if (!needle) return products;

  return products.filter((product) => {
    const haystack = [
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      product.description,
      ...(product.tags || []),
      ...(product.collectionHandles || []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
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
  toStorefrontListProduct,
  paginateItems,
  paginateListProducts,
  searchProducts,
  shuffleProducts,
};