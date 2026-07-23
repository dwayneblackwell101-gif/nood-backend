const { shuffleProducts, safeString } = require('./transform');
const { resolveProductFromReference } = require('./product-lookup');

function getActiveProducts(products) {
  return products.filter((product) => safeString(product?.status, 'ACTIVE').toUpperCase() === 'ACTIVE');
}

function toRecommendationItem(product) {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    featuredImage: product.featuredImage,
    priceRange: product.priceRange,
  };
}

function buildFallbackRecommendations(allProducts, currentProduct, seed) {
  const excludeHandle = safeString(currentProduct?.handle);
  const excludeId = safeString(currentProduct?.id);

  const candidates = allProducts.filter((item) => {
    if (excludeHandle && item.handle === excludeHandle) return false;
    if (excludeId && item.id === excludeId) return false;
    return true;
  });

  const sameCollection = currentProduct?.collectionHandles?.length
    ? candidates.filter((item) =>
        item.collectionHandles?.some((collectionHandle) =>
          currentProduct.collectionHandles.includes(collectionHandle)
        )
      )
    : [];

  const pool = sameCollection.length >= 6 ? sameCollection : candidates;
  const seedValue = seed || `${excludeHandle || excludeId || 'catalog'}_${Date.now()}`;

  return shuffleProducts(pool, seedValue).slice(0, 12).map(toRecommendationItem);
}

async function getProductRecommendations(cache, rawReference) {
  try {
    const product = await resolveProductFromReference(cache, rawReference);
    const allProducts = getActiveProducts(await cache.getAllProducts());

    if (!product) {
      console.log('[NOOD catalog] recommendations fallback used because product not found', {
        reference: safeString(rawReference),
      });

      return {
        items: buildFallbackRecommendations(allProducts, null, safeString(rawReference)),
        usedFallback: true,
        source: 'cache',
      };
    }

    const sameCollection = product.collectionHandles?.length
      ? allProducts.filter(
          (item) =>
            item.id !== product.id &&
            item.collectionHandles?.some((collectionHandle) =>
              product.collectionHandles.includes(collectionHandle)
            )
        )
      : allProducts.filter((item) => item.id !== product.id);

    const picks =
      sameCollection.length >= 4
        ? shuffleProducts(sameCollection, `${product.handle}_${Date.now()}`).slice(0, 12)
        : buildFallbackRecommendations(allProducts, product, product.handle);

    return {
      items: picks.map(toRecommendationItem),
      usedFallback: false,
      source: 'cache',
    };
  } catch (error) {
    console.warn('[NOOD catalog] recommendations failed, using safe fallback:', error.message);

    try {
      const allProducts = getActiveProducts(await cache.getAllProducts());
      return {
        items: buildFallbackRecommendations(allProducts, null, safeString(rawReference)),
        usedFallback: true,
        source: 'cache',
      };
    } catch {
      return {
        items: [],
        usedFallback: true,
        source: 'cache',
      };
    }
  }
}

module.exports = {
  getProductRecommendations,
};
