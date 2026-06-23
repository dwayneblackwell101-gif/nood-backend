export type HomeFeedProduct = {
  id: string;
  collectionHandle: string;
  collectionHandles?: string[];
  category?: string;
  tags?: string[];
};

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
] as const;

type MainCategory = (typeof ALL_CATEGORIES)[number];

const CATEGORY_MATCH_ORDER: MainCategory[] = [
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

const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

function homeLog(message: string, data?: Record<string, unknown>) {
  if (__DEV__) {
    console.log(message, data);
  }
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function seededShuffle<T>(array: T[], seed: number): T[] {
  const copy = [...array];
  const random = createSeededRandom(seed);

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

export function resolveMainCategory(product: HomeFeedProduct): MainCategory {
  const handles = (product.collectionHandles?.length
    ? product.collectionHandles
    : [product.collectionHandle]
  ).map(normalizeText);

  const searchableText = [
    product.category || '',
    ...handles,
    ...(product.tags || []),
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

function getCategoryStreak<T extends HomeFeedProduct>(items: T[]) {
  if (!items.length) {
    return { category: null as MainCategory | null, streak: 0 };
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

function repairCategoryStreaks<T extends HomeFeedProduct>(
  items: T[],
  maxStreak: number
): T[] {
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

function getRotatedCategoryOrder(activeCategories: MainCategory[], mixSeed: number) {
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

function takeNextProductFromCategory<T extends HomeFeedProduct>(
  category: MainCategory,
  groups: Map<MainCategory, T[]>,
  pointers: Map<MainCategory, number>,
  resultIds: Set<string>
) {
  const group = groups.get(category) || [];
  let pointer = pointers.get(category) || 0;

  while (pointer < group.length) {
    const product = group[pointer];
    pointer += 1;
    pointers.set(category, pointer);

    if (!resultIds.has(product.id)) {
      return product;
    }
  }

  return null;
}

export function refreshBalancedHomeFeedProducts<T extends HomeFeedProduct>(
  balancedFeed: T[],
  latestProducts: T[]
): T[] {
  const productsById = new Map(latestProducts.map((product) => [product.id, product]));

  return balancedFeed
    .map((product) => productsById.get(product.id))
    .filter((product): product is T => Boolean(product));
}

export function appendBalancedHomeFeed<T extends HomeFeedProduct>(
  existingFeed: T[],
  newProducts: T[],
  mixSeed = 0
): T[] {
  const existingIds = new Set(existingFeed.map((product) => product.id));
  const uniqueNewProducts = newProducts.filter((product) => !existingIds.has(product.id));

  if (!uniqueNewProducts.length) {
    return existingFeed;
  }

  const mixedNewProducts = buildBalancedHomeFeed(
    uniqueNewProducts,
    mixSeed + existingFeed.length * 13
  );

  return [...existingFeed, ...mixedNewProducts];
}

export function buildBalancedHomeFeed<T extends HomeFeedProduct>(
  products: T[],
  mixSeed = 0
): T[] {
  const mixStartedAt = perfNow();
  homeLog('[HOME PERF] mix start', {
    source: 'utils/homeFeed.buildBalancedHomeFeed',
    seed: mixSeed,
    productCount: products.length,
    time: mixStartedAt,
  });

  const seenIds = new Set<string>();
  const groups = new Map<MainCategory, T[]>();

  ALL_CATEGORIES.forEach((category) => {
    groups.set(category, []);
  });

  products.forEach((product) => {
    if (seenIds.has(product.id)) {
      return;
    }

    seenIds.add(product.id);
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
  const pointers = new Map<MainCategory, number>();

  activeCategories.forEach((category) => {
    pointers.set(category, 0);
  });

  const result: T[] = [];
  const resultIds = new Set<string>();
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
      resultIds.add(product.id);
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
      resultIds.add(product.id);
      placedInRound = true;
      break;
    }

    if (!placedInRound) {
      break;
    }
  }

  products.forEach((product) => {
    if (!resultIds.has(product.id)) {
      result.push(product);
      resultIds.add(product.id);
    }
  });

  const mixed = repairCategoryStreaks(result, 2);
  const countsByCategory = Object.fromEntries(
    ALL_CATEGORIES.map((category) => [
      category,
      mixed.filter((product) => resolveMainCategory(product) === category).length,
    ])
  );

  homeLog('[HOME MIX] super mixed feed', {
    seed: mixSeed,
    total: mixed.length,
    countsByCategory,
    first40Categories: mixed.slice(0, 40).map((product) => resolveMainCategory(product)),
  });

  homeLog('[HOME PERF] mix end', {
    source: 'utils/homeFeed.buildBalancedHomeFeed',
    seed: mixSeed,
    productCount: products.length,
    resultCount: mixed.length,
    durationMs: perfNow() - mixStartedAt,
    time: perfNow(),
  });

  return mixed;
}