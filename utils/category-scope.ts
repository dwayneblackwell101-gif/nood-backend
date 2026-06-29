export const WEBSITE_MAIN_CATEGORIES = [
  'Men',
  'Women',
  'Kids',
  'Shoes',
  'Electronics',
  'Accessories',
  'Beauty',
] as const;

export type MainCategoryTitle = (typeof WEBSITE_MAIN_CATEGORIES)[number];

export type CategoryMappingSource = 'shopify-menu' | 'backend-collections' | 'explicit-map' | 'cache' | 'default';

export type ScopedCategoryProduct = {
  id: string;
  handle: string;
  title: string;
  image: string;
  price: string;
  priceAmount: number;
  currencyCode: string;
  availableForSale?: boolean;
  variants?: { edges?: any[] };
  sourceSubcategoryHandle?: string;
  sourceSubcategoryTitle?: string;
};

export type ScopedCategoryItem = {
  id: string;
  title: string;
  handle: string;
  image: string;
  fallbackImage?: string | null;
  displayImage?: string | null;
  productsCount?: number;
  previewProducts: ScopedCategoryProduct[];
};

export type ScopedCategoryGroup = {
  id: string;
  title: string;
  handle: string;
  items: ScopedCategoryItem[];
};

export type CategoryHeroSlide = {
  id: string;
  image: string;
  eyebrow: string;
  title: string;
  targetHandle: string;
  subcategoryTitle: string;
};

export type CollectionLike = {
  id?: string;
  title: string;
  handle: string;
  image?: string;
  fallbackImage?: string | null;
  displayImage?: string | null;
  productsCount?: number;
  previewProducts?: ScopedCategoryProduct[];
};

/** Matches NOOD website Men dropdown order. */
export const MEN_DROPDOWN_DEFINITIONS: Array<{ handle: string; title: string }> = [
  { handle: 'casablanca-collection', title: 'Casablanca' },
  { handle: 'chrome-of-hearts', title: 'Chrome of Hearts' },
  { handle: 'denim-tears', title: 'Denim Tears' },
  { handle: 'essentials-fog-1', title: 'Essentials FOG' },
  { handle: 'godspeed', title: 'GodSPEED' },
  { handle: 'gallery-dept-r', title: 'Gallery DEPT.' },
  { handle: 'glo-gang', title: 'GLO Gang' },
  { handle: 'hellstar', title: 'HELLSTAR' },
  { handle: 'house-of-errors', title: 'House Of Errors' },
  { handle: 'majestik', title: 'MAJESTIK' },
  { handle: 'nike-1', title: 'Nike' },
  { handle: 'offwhite-1', title: 'OFFWhite' },
  { handle: 'rhude', title: 'RHUDE' },
  { handle: 'sp5der-apparel-collection', title: 'Sp5der' },
  { handle: 'saint-mxxxxxx', title: 'Saint Mxxxxxx' },
  { handle: 'cough-syrup-collection', title: "That's A Awful Lot Of Cough Syrup" },
  { handle: 'valley', title: 'VALLEY' },
  { handle: 'project-capri', title: 'VERTABRAE' },
];

export const MEN_DROPDOWN_HANDLES = new Set(MEN_DROPDOWN_DEFINITIONS.map((item) => item.handle));

/** Alternate Shopify handles for Men dropdown entries (canonical handle is the map key). */
export const MEN_COLLECTION_HANDLE_ALIASES: Record<string, string[]> = {
  'nike-1': ['nike'],
  'offwhite-1': ['offwhite'],
};

export const MEN_PARENT_HANDLE = 'clothing';

const WOMEN_COLLECTION_HANDLES = new Set([
  'women',
  'clothing-2',
  'tops-blouses',
  'tops',
  'jackets',
  'dresses',
  'jeans-pants',
  'loungwear-pajamas',
  'two-piece-sets',
  'swimwear',
  'bodysuit',
  'underwear',
  'sets',
]);

const MAIN_CATEGORY_MAIN_HANDLES: Record<string, string[]> = {
  Men: ['clothing', 'men'],
  Women: ['women', 'clothing-2'],
  Kids: ['kids'],
  Shoes: ['shoes'],
  Electronics: ['electronics'],
  Accessories: ['accessories'],
  Beauty: ['beauty'],
};

const COLLECTION_HANDLE_MAIN_CATEGORY: Record<string, MainCategoryTitle> = {
  clothing: 'Men',
  men: 'Men',
  women: 'Women',
  'clothing-2': 'Women',
  kids: 'Kids',
  shoes: 'Shoes',
  electronics: 'Electronics',
  accessories: 'Accessories',
  beauty: 'Beauty',
  'tops-blouses': 'Women',
  tops: 'Women',
  jackets: 'Women',
  dresses: 'Women',
  'jeans-pants': 'Women',
  bodysuit: 'Women',
  'loungwear-pajamas': 'Women',
  'two-piece-sets': 'Women',
  swimwear: 'Women',
  underwear: 'Women',
  sets: 'Women',
};

MEN_DROPDOWN_DEFINITIONS.forEach((item) => {
  COLLECTION_HANDLE_MAIN_CATEGORY[item.handle] = 'Men';
});

const NON_CATEGORY_MENU_KEYS = new Set([
  'home',
  'about us',
  'order tracking',
  'track order',
  'contact',
  'search',
  'account',
  'cart',
]);

export function normalizeCategoryText(value?: string | null) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWomenSignal(value: string) {
  return /\b(women|womens|woman|ladies|female|girls?|dresses?|bras?|panties|blouses?|skirts?|jumpsuits?|off shoulder)\b/.test(
    value
  );
}

function hasMenSignal(value: string) {
  return /\b(mens|men|male|boys?)\b/.test(value);
}

export function findMainCategoryForCollection(input?: {
  title?: string | null;
  handle?: string | null;
}): MainCategoryTitle | '' {
  const handle = String(input?.handle || '').trim();
  const normalizedHandle = normalizeCategoryText(handle);

  if (MEN_DROPDOWN_HANDLES.has(handle)) return 'Men';
  if (WOMEN_COLLECTION_HANDLES.has(handle)) return 'Women';

  const mapped = COLLECTION_HANDLE_MAIN_CATEGORY[normalizedHandle];
  if (mapped) return mapped;

  const title = normalizeCategoryText(input?.title);
  const combined = `${title} ${normalizedHandle}`.trim();
  if (!combined) return '';

  if (hasWomenSignal(combined) && !hasMenSignal(combined)) return 'Women';

  if (/\b(kids?|children|child|baby)\b/.test(combined) && !/\b(shoes?)\b/.test(combined)) {
    return 'Kids';
  }
  if (/\b(shoes?|sneakers?|sandals?|boots?|slides?|footwear)\b/.test(combined)) {
    return 'Shoes';
  }
  if (
    /\b(electronics?|computer|laptop|phone|tablet|audio|headphones?|earbuds?|speaker|charger|cable|console)\b/.test(
      combined
    )
  ) {
    return 'Electronics';
  }
  if (
    /\b(accessories|accessory|watch|watches|jewelry|jewellery|bag|bags|wallet|hat|cap|sunglasses?|scarf)\b/.test(
      combined
    )
  ) {
    return 'Accessories';
  }
  if (
    /\b(beauty|cologne|perfume|fragrance|hair|extensions?|lacefront|lashes?|makeup|cosmetic|skincare)\b/.test(
      combined
    )
  ) {
    return 'Beauty';
  }

  return '';
}

export function isMainCategoryTitle(title?: string | null) {
  const normalized = normalizeCategoryText(title);
  return Boolean(normalized && !NON_CATEGORY_MENU_KEYS.has(normalized));
}

export function createSeededMainCategoryGroups(): ScopedCategoryGroup[] {
  return WEBSITE_MAIN_CATEGORIES.map((title) => {
    const key = normalizeCategoryText(title);
    const items =
      title === 'Men'
        ? MEN_DROPDOWN_DEFINITIONS.map((definition) => ({
            id: `men-seed-${definition.handle}`,
            title: definition.title,
            handle: definition.handle,
            image: '',
            previewProducts: [],
          }))
        : [];

    return {
      id: `main-category-${key}`,
      title,
      handle: title === 'Men' ? MEN_PARENT_HANDLE : key,
      items,
    };
  });
}

function getFirstPreviewProductImage(products: ScopedCategoryProduct[] = []) {
  const firstProduct = products[0];
  if (!firstProduct) return '';

  const featuredImage = String(firstProduct.image || '').trim();
  if (featuredImage) return featuredImage;

  return products.find((product) => String(product.image || '').trim())?.image || '';
}

export function resolveCategoryBubbleImage(
  item: Pick<ScopedCategoryItem, 'image' | 'displayImage' | 'fallbackImage' | 'previewProducts'>
): string {
  const collectionImage = String(item.image || '').trim();
  if (collectionImage) return collectionImage;

  const displayImage = String(item.displayImage || '').trim();
  if (displayImage) return displayImage;

  const fallbackImage = String(item.fallbackImage || '').trim();
  if (fallbackImage) return fallbackImage;

  return getFirstPreviewProductImage(item.previewProducts || []);
}

function lookupMenCollection(
  definition: { handle: string; title: string },
  collectionByHandle: Map<string, CollectionLike>
): CollectionLike | null {
  const direct = collectionByHandle.get(definition.handle);
  if (direct) return direct;

  const aliases = MEN_COLLECTION_HANDLE_ALIASES[definition.handle] || [];
  for (const alias of aliases) {
    const match = collectionByHandle.get(alias);
    if (match) {
      return {
        ...match,
        handle: definition.handle,
        title: definition.title || match.title,
      };
    }
  }

  return null;
}

function collectionToScopedItem(collection: CollectionLike, index: number): ScopedCategoryItem {
  const previewProducts = Array.isArray(collection.previewProducts) ? collection.previewProducts : [];
  const collectionImage = String(collection.image || '').trim();
  const fallbackImage = String(collection.fallbackImage || '').trim();
  const displayImage = String(collection.displayImage || '').trim();
  const firstProductImage = getFirstPreviewProductImage(previewProducts);

  return {
    id: `${collection.id || collection.handle}-item-${index}`,
    title: collection.title,
    handle: collection.handle,
    image: collectionImage,
    fallbackImage: fallbackImage || firstProductImage || null,
    displayImage: displayImage || null,
    productsCount: collection.productsCount,
    previewProducts,
  };
}

function buildMenItemsFromCollections(collections: CollectionLike[]) {
  const collectionByHandle = new Map(
    collections
      .filter((collection) => collection.handle)
      .map((collection) => [collection.handle, collection])
  );

  const matchedHandles: string[] = [];
  const items: ScopedCategoryItem[] = [];

  MEN_DROPDOWN_DEFINITIONS.forEach((definition, index) => {
    const collection = lookupMenCollection(definition, collectionByHandle);
    if (!collection) return;

    matchedHandles.push(definition.handle);
    items.push(
      collectionToScopedItem(
        {
          ...collection,
          title: definition.title || collection.title,
        },
        index
      )
    );
  });

  return { items, matchedHandles };
}

function buildWomenItemsFromCollections(collections: CollectionLike[]) {
  const items: ScopedCategoryItem[] = [];
  const seen = new Set<string>();

  collections.forEach((collection, index) => {
    const handle = String(collection.handle || '').trim();
    if (!handle || seen.has(handle)) return;

    const mapped = findMainCategoryForCollection(collection);
    if (mapped !== 'Women') return;
    if (isMainCategoryShellItem('Women', {
      id: '',
      title: collection.title,
      handle,
      image: '',
      previewProducts: [],
    })) {
      return;
    }

    seen.add(handle);
    items.push(collectionToScopedItem(collection, index));
  });

  return items;
}

function buildGenericItemsFromCollections(mainTitle: MainCategoryTitle, collections: CollectionLike[]) {
  const items: ScopedCategoryItem[] = [];
  const seen = new Set<string>();

  collections.forEach((collection, index) => {
    const handle = String(collection.handle || '').trim();
    if (!handle || seen.has(handle)) return;
    if (MEN_DROPDOWN_HANDLES.has(handle)) return;

    const mapped = findMainCategoryForCollection(collection);
    if (mapped !== mainTitle) return;
    if (
      isMainCategoryShellItem(mainTitle, {
        id: '',
        title: collection.title,
        handle,
        image: '',
        previewProducts: [],
      })
    ) {
      return;
    }

    seen.add(handle);
    items.push(collectionToScopedItem(collection, index));
  });

  return items;
}

export function buildCategoryGroupsFromCollections(collections: CollectionLike[]): {
  groups: ScopedCategoryGroup[];
  mappingSource: CategoryMappingSource;
  menMatchedHandles: string[];
  allCollectionCount: number;
} {
  const seeded = createSeededMainCategoryGroups();
  const collectionList = Array.isArray(collections) ? collections : [];
  const { items: menItems, matchedHandles } = buildMenItemsFromCollections(collectionList);

  const groups = seeded.map((group) => {
    if (group.title === 'Men') {
      return {
        ...group,
        handle: MEN_PARENT_HANDLE,
        items: menItems.length ? menItems : group.items,
      };
    }

    if (group.title === 'Women') {
      const womenItems = buildWomenItemsFromCollections(collectionList);
      return {
        ...group,
        items: womenItems,
      };
    }

    const genericItems = buildGenericItemsFromCollections(group.title as MainCategoryTitle, collectionList);
    return {
      ...group,
      items: genericItems,
    };
  });

  return {
    groups,
    mappingSource: 'explicit-map',
    menMatchedHandles: matchedHandles,
    allCollectionCount: collectionList.length,
  };
}

function isMainCategoryShellItem(mainTitle: string, item: ScopedCategoryItem) {
  const mainNorm = normalizeCategoryText(mainTitle);
  const itemTitle = normalizeCategoryText(item.title);
  const itemHandle = normalizeCategoryText(item.handle);
  const mainHandles = MAIN_CATEGORY_MAIN_HANDLES[mainTitle] || [];

  if (itemTitle === mainNorm) return true;
  if (mainHandles.includes(itemHandle)) return true;

  return false;
}

export function getScopedSubcategoryItems(
  group: Pick<ScopedCategoryGroup, 'title' | 'handle' | 'items'> | null | undefined
) {
  if (!group) return [];

  const mainTitle = group.title;

  if (mainTitle === 'Men') {
    const itemByHandle = new Map(
      (group.items || [])
        .filter((item) => item?.handle)
        .map((item) => [String(item.handle).trim(), item])
    );

    return MEN_DROPDOWN_DEFINITIONS.map((definition) => {
      const item = itemByHandle.get(definition.handle);
      if (!item || isMainCategoryShellItem(mainTitle, item)) return null;

      if (
        item.previewProducts.some((product) => !productBelongsToMainCategory(product, 'Men'))
      ) {
        console.log('[NOOD categories] excluded women item from men reason', {
          reason: 'women-product-in-collection',
          handle: item.handle,
          title: item.title,
        });
      }

      return {
        ...item,
        title: definition.title,
        handle: definition.handle,
      };
    }).filter(Boolean) as ScopedCategoryItem[];
  }

  const seen = new Set<string>();

  return group.items.filter((item) => {
    const handle = String(item.handle || '').trim();
    if (!handle || seen.has(handle)) return false;
    seen.add(handle);

    if (isMainCategoryShellItem(mainTitle, item)) return false;

    if (mainTitle === 'Men') {
      if (!MEN_DROPDOWN_HANDLES.has(handle)) {
        console.log('[NOOD categories] excluded women item from men reason', {
          reason: 'not-in-men-dropdown',
          handle,
          title: item.title,
        });
        return false;
      }
    } else {
      const mapped = findMainCategoryForCollection({ title: item.title, handle: item.handle });
      if (mapped && mapped !== mainTitle) return false;
    }

    if (mainTitle === 'Men' && item.previewProducts.some((product) => !productBelongsToMainCategory(product, 'Men'))) {
      console.log('[NOOD categories] excluded women item from men reason', {
        reason: 'women-product-in-collection',
        handle,
        title: item.title,
      });
    }

    return true;
  });
}

export function productBelongsToMainCategory(
  product: Pick<ScopedCategoryProduct, 'title' | 'handle'>,
  mainTitle: MainCategoryTitle | string
) {
  const blob = normalizeCategoryText(`${product.title} ${product.handle}`);
  if (!blob) return false;

  if (mainTitle === 'Men') {
    if (hasWomenSignal(blob)) return false;
    if (/\bwomen\b/.test(blob) || /\bwomens\b/.test(blob)) return false;
    if (/\bgirl\b/.test(blob) && !hasMenSignal(blob)) return false;
    return true;
  }

  if (mainTitle === 'Women') {
    if (hasMenSignal(blob) && !hasWomenSignal(blob)) return false;
    return true;
  }

  return true;
}

function filterCollectionProductsForMain(
  item: ScopedCategoryItem,
  mainTitle: string
): ScopedCategoryItem {
  const previewProducts = (item.previewProducts || []).filter((product) =>
    productBelongsToMainCategory(product, mainTitle)
  );

  return {
    ...item,
    previewProducts,
  };
}

export function mixProductsAcrossSubcategories(
  items: ScopedCategoryItem[],
  options: {
    mainTitle: string;
    limit?: number;
    includeMainShell?: ScopedCategoryItem | null;
  }
): { products: ScopedCategoryProduct[]; excludedCount: number } {
  const { mainTitle, limit = 48, includeMainShell = null } = options;
  const sanitizedItems = items.map((item) => filterCollectionProductsForMain(item, mainTitle));
  const sanitizedShell = includeMainShell
    ? filterCollectionProductsForMain(includeMainShell, mainTitle)
    : null;

  const buckets = [...sanitizedItems, ...(sanitizedShell ? [sanitizedShell] : [])].map((item) => {
    const seen = new Set<string>();
    const products: ScopedCategoryProduct[] = [];

    for (const product of item.previewProducts || []) {
      const handle = String(product.handle || '').trim();
      if (!handle || seen.has(handle)) continue;
      if (!productBelongsToMainCategory(product, mainTitle)) continue;
      seen.add(handle);
      products.push({
        ...product,
        sourceSubcategoryHandle: item.handle,
        sourceSubcategoryTitle: item.title,
      });
    }

    return products;
  });

  const mixed: ScopedCategoryProduct[] = [];
  const used = new Set<string>();
  let excludedCount = 0;
  let cursor = 0;
  let stagnantRounds = 0;

  while (mixed.length < limit && stagnantRounds < buckets.length + 1) {
    let pickedInRound = false;

    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      const product = bucket[cursor];
      if (!product) continue;

      if (!productBelongsToMainCategory(product, mainTitle)) {
        excludedCount += 1;
        continue;
      }

      if (used.has(product.handle)) continue;

      used.add(product.handle);
      mixed.push(product);
      pickedInRound = true;

      if (mixed.length >= limit) break;
    }

    if (!pickedInRound) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
    }

    cursor += 1;
  }

  return { products: mixed, excludedCount };
}

export function buildCategoryHeroSlides(
  mainTitle: string,
  subcategoryItems: ScopedCategoryItem[],
  heroCopy?: { eyebrow: string; title: string }
): CategoryHeroSlide[] {
  const fallbackCopy = heroCopy || { eyebrow: mainTitle, title: `Shop ${mainTitle}` };
  const slides: CategoryHeroSlide[] = [];

  subcategoryItems.forEach((item) => {
    const sanitized = filterCollectionProductsForMain(item, mainTitle);
    const image = resolveCategoryBubbleImage(sanitized);

    if (!image) return;

    slides.push({
      id: `hero-${sanitized.id}`,
      image,
      eyebrow: sanitized.title,
      title: fallbackCopy.title,
      targetHandle: sanitized.handle,
      subcategoryTitle: sanitized.title,
    });
  });

  return slides.slice(0, 5);
}

export function getMainShellItem(
  group: Pick<ScopedCategoryGroup, 'title' | 'items'> | null | undefined
): ScopedCategoryItem | null {
  if (!group) return null;
  return group.items.find((item) => isMainCategoryShellItem(group.title, item)) || null;
}

export function getCategoryBubbleImage(item: ScopedCategoryItem, mainTitle: string) {
  const sanitized = filterCollectionProductsForMain(item, mainTitle);
  return resolveCategoryBubbleImage(sanitized);
}

/** Force Men to the website dropdown brands; strip leaked Women/generic collections. */
export function sanitizeCategoryGroups(groups: ScopedCategoryGroup[]): ScopedCategoryGroup[] {
  if (!Array.isArray(groups)) return createSeededMainCategoryGroups();

  return groups.map((group) => {
    if (group.title !== 'Men') return group;

    const itemByHandle = new Map(
      (group.items || [])
        .filter((item) => item?.handle)
        .map((item) => [String(item.handle).trim(), item])
    );

    const items: ScopedCategoryItem[] = MEN_DROPDOWN_DEFINITIONS.map((definition, index) => {
      const existing =
        itemByHandle.get(definition.handle) ||
        (MEN_COLLECTION_HANDLE_ALIASES[definition.handle] || [])
          .map((alias) => itemByHandle.get(alias))
          .find(Boolean) ||
        null;
      const previewProducts = (existing?.previewProducts || []).filter((product) =>
        productBelongsToMainCategory(product, 'Men')
      );
      const firstProductImage = getFirstPreviewProductImage(previewProducts);

      const collectionImage = String(existing?.image || '').trim();
      const displayImage = String(existing?.displayImage || '').trim();
      const fallbackImage = String(existing?.fallbackImage || '').trim();

      const scopedItem: ScopedCategoryItem = {
        id: existing?.id || `men-seed-${definition.handle}`,
        title: definition.title,
        handle: definition.handle,
        image: collectionImage,
        fallbackImage: fallbackImage || firstProductImage || null,
        displayImage: displayImage || null,
        productsCount: existing?.productsCount,
        previewProducts: previewProducts.length ? previewProducts : existing?.previewProducts || [],
      };

      return scopedItem;
    });

    return {
      ...group,
      handle: MEN_PARENT_HANDLE,
      items,
    };
  });
}
