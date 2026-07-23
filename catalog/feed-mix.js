const ALL_CATEGORIES = [
  'women',
  'men',
  'kids',
  'shoes',
  'bags',
  'electronics',
  'accessories',
  'beauty',
  'hair',
  'other',
];

const CATEGORY_MATCH_ORDER = [
  'women',
  'men',
  'kids',
  'shoes',
  'bags',
  'electronics',
  'accessories',
  'beauty',
  'hair',
  'other',
];

const MAX_CACHED_MIX_KEYS = 48;
const mixedFeedCache = new Map();
const mixedHandleOrderCache = new Map();

function createSeededRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function seededShuffle(array, seed) {
  const copy = [...array];
  const random = createSeededRandom(seed);

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function parseMixSeed(mixKey) {
  const numeric = Number(mixKey);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric >>> 0;
  }

  const text = String(mixKey || '');
  if (!text) {
    return Date.now() >>> 0;
  }

  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return hash || (Date.now() >>> 0);
}

function getCollectionHandles(product) {
  if (Array.isArray(product?.collectionHandles) && product.collectionHandles.length) {
    return product.collectionHandles.map(normalizeText);
  }

  const edges = product?.collections?.edges || [];
  return edges.map((edge) => normalizeText(edge?.node?.handle)).filter(Boolean);
}

function resolveMainCategory(product) {
  const handles = getCollectionHandles(product);
  const searchableText = [
    product?.productType || '',
    ...handles,
    ...(Array.isArray(product?.tags) ? product.tags : []),
  ]
    .join(' ')
    .toLowerCase();

  for (const category of CATEGORY_MATCH_ORDER) {
    if (category === 'men') {
      if (handles.some((handle) => handle === 'clothing' || handle === 'men')) {
        return 'men';
      }
      continue;
    }

    if (category === 'hair') {
      if (
        handles.some((handle) => handle === 'lacefront' || handle === 'hair') ||
        searchableText.includes('lace front') ||
        searchableText.includes('lacefront') ||
        searchableText.includes('wig') ||
        (searchableText.includes('lace') && searchableText.includes('front'))
      ) {
        return 'hair';
      }
      continue;
    }

    if (category === 'shoes') {
      if (handles.some((handle) => handle === 'shoes') || searchableText.includes('shoe')) {
        return 'shoes';
      }
      continue;
    }

    if (category === 'other') {
      continue;
    }

    if (handles.some((handle) => handle === category)) {
      return category;
    }
  }

  return 'other';
}

function getCategoryStreak(items) {
  if (!items.length) {
    return { category: null, streak: 0 };
  }

  const category = resolveMainCategory(items[items.length - 1]);
  let streak = 1;

  for (let index = items.length - 2; index >= 0; index -= 1) {
    if (resolveMainCategory(items[index]) !== category) {
      break;
    }
    streak += 1;
  }

  return { category, streak };
}

function repairCategoryStreaks(items, maxStreak) {
  const result = [...items];

  for (let index = maxStreak; index < result.length; index += 1) {
    const currentCategory = resolveMainCategory(result[index]);
    let streak = 1;

    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (resolveMainCategory(result[previous]) !== currentCategory) {
        break;
      }
      streak += 1;
    }

    if (streak <= maxStreak) {
      continue;
    }

    for (let swapIndex = index + 1; swapIndex < result.length; swapIndex += 1) {
      if (resolveMainCategory(result[swapIndex]) === currentCategory) {
        continue;
      }

      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
      break;
    }
  }

  return result;
}

function getRotatedCategoryOrder(activeCategories, mixSeed) {
  const shuffledCategories = seededShuffle(activeCategories, mixSeed);

  if (!shuffledCategories.length) {
    return shuffledCategories;
  }

  const startOffset = mixSeed % shuffledCategories.length;
  return [
    ...shuffledCategories.slice(startOffset),
    ...shuffledCategories.slice(0, startOffset),
  ];
}

function takeNextProductFromCategory(category, groups, pointers, resultIds) {
  const group = groups.get(category) || [];
  let pointer = pointers.get(category) || 0;

  while (pointer < group.length) {
    const product = group[pointer];
    pointer += 1;
    pointers.set(category, pointer);

    if (!resultIds.has(String(product.id))) {
      return product;
    }
  }

  return null;
}

function buildBalancedFeed(products, mixSeed = 0) {
  const seenIds = new Set();
  const groups = new Map();

  ALL_CATEGORIES.forEach((category) => {
    groups.set(category, []);
  });

  products.forEach((product) => {
    const productId = String(product?.id || '');
    if (!productId || seenIds.has(productId)) {
      return;
    }

    seenIds.add(productId);
    const category = resolveMainCategory(product);
    groups.get(category)?.push(product);
  });

  groups.forEach((items, category) => {
    groups.set(
      category,
      seededShuffle(items, mixSeed + category.length * 97 + items.length * 17)
    );
  });

  const activeCategories = ALL_CATEGORIES.filter(
    (category) => (groups.get(category)?.length || 0) > 0
  );
  const categoryOrder = getRotatedCategoryOrder(activeCategories, mixSeed);
  const pointers = new Map();

  activeCategories.forEach((category) => {
    pointers.set(category, 0);
  });

  const result = [];
  const resultIds = new Set();
  let safety = products.length * Math.max(activeCategories.length, 1) + 10;

  while (result.length < seenIds.size && safety > 0) {
    safety -= 1;
    let placedInRound = false;

    for (const category of categoryOrder) {
      const remaining = (groups.get(category)?.length || 0) - (pointers.get(category) || 0);
      if (remaining <= 0) {
        continue;
      }

      const { category: streakCategory, streak } = getCategoryStreak(result);
      if (streakCategory === category && streak >= 2) {
        continue;
      }

      const product = takeNextProductFromCategory(category, groups, pointers, resultIds);
      if (!product) {
        continue;
      }

      result.push(product);
      resultIds.add(String(product.id));
      placedInRound = true;
    }

    if (placedInRound) {
      continue;
    }

    for (const category of categoryOrder) {
      const product = takeNextProductFromCategory(category, groups, pointers, resultIds);
      if (!product) {
        continue;
      }

      result.push(product);
      resultIds.add(String(product.id));
      placedInRound = true;
      break;
    }

    if (!placedInRound) {
      break;
    }
  }

  products.forEach((product) => {
    const productId = String(product?.id || '');
    if (productId && !resultIds.has(productId)) {
      result.push(product);
      resultIds.add(productId);
    }
  });

  return repairCategoryStreaks(result, 2);
}

function getMixedFeedCacheKey(mixKey, productCount) {
  return `${String(mixKey)}:${productCount}`;
}

function getOrBuildMixedFeed(products, mixKey) {
  const cacheKey = getMixedFeedCacheKey(mixKey, products.length);
  const cached = mixedFeedCache.get(cacheKey);

  if (cached && cached.productCount === products.length) {
    return { items: cached.items, cacheHit: true };
  }

  const seed = parseMixSeed(mixKey);
  const items = buildBalancedFeed(products, seed);

  if (mixedFeedCache.size >= MAX_CACHED_MIX_KEYS) {
    const oldestKey = mixedFeedCache.keys().next().value;
    if (oldestKey) {
      mixedFeedCache.delete(oldestKey);
    }
  }

  mixedFeedCache.set(cacheKey, {
    items,
    productCount: products.length,
    builtAt: Date.now(),
  });

  return { items, cacheHit: false };
}

function buildBalancedFeedFromMixMeta(mixMetaRows, mixSeed = 0) {
  return buildBalancedFeed(mixMetaRows, mixSeed);
}

function rememberMixedHandleOrder(cacheKey, handles, productCount) {
  if (mixedHandleOrderCache.size >= MAX_CACHED_MIX_KEYS) {
    const oldestKey = mixedHandleOrderCache.keys().next().value;
    if (oldestKey) {
      mixedHandleOrderCache.delete(oldestKey);
    }
  }

  mixedHandleOrderCache.set(cacheKey, {
    handles,
    productCount,
    builtAt: Date.now(),
  });
}

function getOrBuildMixedHandleOrder(mixMetaRows, mixKey) {
  const cacheKey = getMixedFeedCacheKey(mixKey, mixMetaRows.length);
  const cached = mixedHandleOrderCache.get(cacheKey);

  if (cached && cached.productCount === mixMetaRows.length && Array.isArray(cached.handles)) {
    return { handles: cached.handles, cacheHit: true };
  }

  const seed = parseMixSeed(mixKey);
  const mixedRows = buildBalancedFeedFromMixMeta(mixMetaRows, seed);
  const handles = mixedRows.map((row) => String(row?.handle || '')).filter(Boolean);

  rememberMixedHandleOrder(cacheKey, handles, mixMetaRows.length);

  return { handles, cacheHit: false };
}

function clearMixedFeedCache() {
  mixedFeedCache.clear();
  mixedHandleOrderCache.clear();
}

module.exports = {
  buildBalancedFeed,
  buildBalancedFeedFromMixMeta,
  getOrBuildMixedFeed,
  getOrBuildMixedHandleOrder,
  clearMixedFeedCache,
  resolveMainCategory,
};