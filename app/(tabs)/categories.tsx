import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import NoodSpinner from '../../components/NoodSpinner';
import { BASE_CURRENCY } from '../../utils/currency';
import { fetchCatalogPath } from '../../utils/catalog';
import { buildProductRouteParams } from '../../utils/product-navigation';

const NOOD_LOGO = require('../../assets/images/logo.png');

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/600x600.png?text=NOOD';
const CATEGORIES_CACHE_KEY = 'NOOD_CATEGORIES_CACHE_V17_SHOPIFY_MENU_AUTO';
const webShadow = (value: string) => (Platform.OS === 'web' ? { boxShadow: value } : {});
const platformShadow = (webValue: string, nativeValue: object) =>
  Platform.OS === 'web' ? webShadow(webValue) : nativeValue;
const SHOPIFY_CATEGORIES_MENU_HANDLES = [
  'main-menu',
  'header-menu',
  'primary-menu',
  'main-navigation',
  'nood-app-categories',
];
const WEBSITE_MAIN_CATEGORY_TITLES = [
  'Men',
  'Women',
  'Kids',
  'Shoes',
  'Electronics',
  'Accessories',
  'Beauty',
];
const WEBSITE_MAIN_CATEGORY_KEYS = WEBSITE_MAIN_CATEGORY_TITLES.map((title) =>
  title.toLowerCase()
);
const CATEGORY_HERO_COPY: Record<string, { eyebrow: string; title: string }> = {
  Men: { eyebrow: "Men's Streetwear", title: 'New drops, viral fits, premium looks' },
  Women: { eyebrow: "Women's Fashion", title: 'Fresh styles, standout picks, everyday glam' },
  Kids: { eyebrow: 'Kids Favorites', title: 'Cute finds, comfy fits, ready-to-go looks' },
  Shoes: { eyebrow: 'Shoe Edit', title: 'Statement pairs, fresh soles, daily rotation' },
  Electronics: { eyebrow: 'Smart Tech', title: 'Useful tech, clean audio, everyday upgrades' },
  Accessories: { eyebrow: 'Accessory Picks', title: 'Finishing touches, bold details, easy gifts' },
  Beauty: { eyebrow: 'Beauty Essentials', title: 'Glow picks, fresh scents, beauty must-haves' },
};
const CATEGORY_CARD_BADGES = ['NEW', 'HOT', 'BEST SELLER'];
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
const CATEGORY_MENU_QUERY = `
  query NoodCategoriesMenu($handle: String!) {
    menu(handle: $handle) {
      title
      items {
        title
        url
        type
        resource {
          ... on Collection {
            id
            handle
            title
            image {
              url
              altText
            }
            products(first: 24) {
              nodes {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        items {
          title
          url
          type
          resource {
            ... on Collection {
            id
            handle
            title
            image {
              url
              altText
            }
            products(first: 24) {
              nodes {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
            }
          }
          items {
            title
            url
            type
            resource {
              ... on Collection {
            id
            handle
            title
            image {
              url
              altText
            }
            products(first: 24) {
              nodes {
                id
                title
                handle
                featuredImage {
                  url
                  altText
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
              }
            }
          }
        }
      }
    }
  }
`;

const CATEGORY_BROWSER_QUERY = `
  query GetCategoryBrowser($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          image {
            url
          }
          products(first: 24) {
            edges {
              node {
                id
                handle
                title
                featuredImage {
                  url
                }
                priceRange {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type CategoryProduct = {
  id: string;
  handle: string;
  title: string;
  image: string;
  price: string;
  priceAmount: number;
  currencyCode: string;
  groupId?: string;
  groupTitle?: string;
};

type MenuCategoryItem = {
  id: string;
  title: string;
  handle: string;
  image: string;
  previewProducts: CategoryProduct[];
};

type MenuCategoryGroup = {
  id: string;
  title: string;
  handle: string;
  items: MenuCategoryItem[];
};

type CategoryCollection = {
  id: string;
  title: string;
  handle: string;
  image: string;
  previewProducts: CategoryProduct[];
};

type CategoriesSessionSnapshot = {
  groups: MenuCategoryGroup[];
  activeGroupId: string;
  scrollOffset: number;
};

let categoriesSessionSnapshot: CategoriesSessionSnapshot | null = null;

function formatMoney(amount?: string | null) {
  if (!amount) return '$0.00';
  return `$${Number(amount).toFixed(2)}`;
}

function isRealProductImage(uri?: string | null) {
  const image = String(uri || '').trim();

  if (!image) return false;
  if (image === PLACEHOLDER_IMAGE) return false;
  if (image.toLowerCase().includes('via.placeholder.com')) return false;

  return true;
}

function getOptimizedImageUrl(uri?: string | null, width = 360) {
  const image = String(uri || '').trim();
  if (!isRealProductImage(image)) return PLACEHOLDER_IMAGE;

  try {
    const parsed = new URL(image);
    if (parsed.hostname.includes('cdn.shopify.com')) {
      parsed.searchParams.set('width', String(width));
      return parsed.toString();
    }
  } catch {
    return image;
  }

  return image;
}

function normalizeProductNode(productNode: any, fallbackId: string): CategoryProduct {
  const priceAmount = Number(productNode?.priceRange?.minVariantPrice?.amount || 0);

  return {
    id: String(productNode?.id || fallbackId),
    handle: String(productNode?.handle || ''),
    title: String(productNode?.title || 'Product'),
    image: isRealProductImage(productNode?.featuredImage?.url)
      ? productNode.featuredImage.url
      : PLACEHOLDER_IMAGE,
    price: formatMoney(String(priceAmount)),
    priceAmount,
    currencyCode:
      productNode?.priceRange?.minVariantPrice?.currencyCode || BASE_CURRENCY,
  };
}

function getProductNodes(products: any) {
  if (Array.isArray(products?.nodes)) return products.nodes;
  if (Array.isArray(products?.edges)) return products.edges.map((edge: any) => edge?.node).filter(Boolean);
  return [];
}

function normalizeCollectionNode(node: any): CategoryCollection {
  const previewProducts: CategoryProduct[] = getProductNodes(node?.products).map(
    (productNode: any, index: number) => normalizeProductNode(productNode, `${node?.id || 'product'}-${index}`)
  );

  return {
    id: String(node?.id || Math.random()),
    title: String(node?.title || 'Collection'),
    handle: String(node?.handle || ''),
    image: (isRealProductImage(node?.image?.url) ? node.image.url : '') ||
      previewProducts.find((product) => isRealProductImage(product.image))?.image ||
      PLACEHOLDER_IMAGE,
    previewProducts,
  };
}

function normalizeCollection(edge: any): CategoryCollection {
  return normalizeCollectionNode(edge?.node || edge || {});
}

function getCollectionHandleFromMenuItem(item: any) {
  const resourceHandle = String(item?.resource?.handle || '').trim();
  if (resourceHandle) return resourceHandle;

  const url = String(item?.url || '').trim();
  if (!url) return '';

  const match = url.match(/\/collections\/([^/?#]+)/i);
  if (match?.[1]) return decodeURIComponent(match[1]).trim();

  return '';
}

function buildMenuItemFromCollection(item: any, index: number): MenuCategoryItem | null {
  const resource = item?.resource || {};
  const handle = getCollectionHandleFromMenuItem(item);
  if (!handle) return null;

  const collection = normalizeCollectionNode({
    ...resource,
    handle,
    title: resource?.title || item?.title,
  });

  return {
    id: String(resource?.id || `${handle}-${index}`),
    title: String(item?.title || collection.title || handle),
    handle,
    image: collection.image,
    previewProducts: collection.previewProducts,
  };
}

function getNestedMenuItems(item: any) {
  const directChildren = Array.isArray(item?.items) ? item.items : [];
  const allChildren: any[] = [];

  directChildren.forEach((child: any) => {
    allChildren.push(child);

    if (Array.isArray(child?.items) && child.items.length) {
      child.items.forEach((grandChild: any) => {
        allChildren.push(grandChild);
      });
    }
  });

  return allChildren;
}

function dedupeMenuItemsByHandle(items: MenuCategoryItem[]) {
  const seenHandles = new Set<string>();
  return items.filter((item) => {
    if (!item.handle) return false;
    if (seenHandles.has(item.handle)) return false;

    seenHandles.add(item.handle);
    return true;
  });
}

function normalizeMenuTitle(title?: string | null) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getCategoryIcon(title?: string | null): React.ComponentProps<typeof Ionicons>['name'] {
  const normalized = normalizeMenuTitle(title);

  if (normalized.includes('women')) return 'woman-outline';
  if (normalized.includes('men')) return 'person-outline';
  if (normalized.includes('kid') || normalized.includes('baby')) return 'happy-outline';
  if (normalized.includes('shoe')) return 'walk-outline';
  if (normalized.includes('bag')) return 'bag-handle-outline';
  if (normalized.includes('electronic') || normalized.includes('audio')) return 'headset-outline';
  if (normalized.includes('accessor') || normalized.includes('watch')) return 'watch-outline';
  if (normalized.includes('beauty')) return 'sparkles-outline';
  if (normalized.includes('home') || normalized.includes('kitchen')) return 'home-outline';

  return 'grid-outline';
}

function isMainCategoryTitle(title?: string | null) {
  const normalized = normalizeMenuTitle(title);
  return Boolean(normalized && !NON_CATEGORY_MENU_KEYS.has(normalized));
}

function getMainCategoryDisplayTitle(title?: string | null) {
  const normalized = normalizeMenuTitle(title);
  return WEBSITE_MAIN_CATEGORY_TITLES.find((mainTitle) => normalizeMenuTitle(mainTitle) === normalized) ||
    String(title || 'Category');
}

function sortMainGroupsByWebsiteOrder(groups: MenuCategoryGroup[]) {
  const order = new Map(
    WEBSITE_MAIN_CATEGORY_TITLES.map((title, index) => [normalizeMenuTitle(title), index])
  );

  return [...groups].sort((a, b) => {
    const aOrder = order.get(normalizeMenuTitle(a.title)) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(normalizeMenuTitle(b.title)) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}

function createWebsiteMainCategoryGroups(): MenuCategoryGroup[] {
  return WEBSITE_MAIN_CATEGORY_TITLES.map((title) => {
    const key = normalizeMenuTitle(title);

    return {
      id: `main-category-${key}`,
      title,
      handle: key,
      items: [],
    };
  });
}

function findMainCategoryForCollection(collection?: Pick<CategoryCollection, 'title' | 'handle'> | null) {
  const normalized = normalizeMenuTitle(`${collection?.title || ''} ${collection?.handle || ''}`);
  if (!normalized) return '';

  if (/\b(women|woman|ladies|dress|dresses|bra|bras|panty|panties|heels?)\b/.test(normalized)) {
    return 'Women';
  }
  if (/\b(men|man|mens|t shirts?|tees?|shirts?|jeans|shorts|tracksuits?|jackets?)\b/.test(normalized)) {
    return 'Men';
  }
  if (/\b(kids?|children|child|baby|boys?|girls?)\b/.test(normalized)) {
    return 'Kids';
  }
  if (/\b(shoes?|sneakers?|sandals?|boots?|slides?|heels?)\b/.test(normalized)) {
    return 'Shoes';
  }
  if (/\b(electronics?|computer|laptop|phone|tablet|audio|headphones?|earbuds?|speaker|charger|cable)\b/.test(normalized)) {
    return 'Electronics';
  }
  if (/\b(accessories|accessory|watch|watches|jewelry|jewellery|bag|bags|wallet|hat|cap|sunglasses?|scarf)\b/.test(normalized)) {
    return 'Accessories';
  }
  if (/\b(beauty|cologne|perfume|fragrance|hair|extensions?|lacefront|lashes?|makeup|cosmetic|skincare|skin care)\b/.test(normalized)) {
    return 'Beauty';
  }

  return '';
}

function getMainCategoryGroupKey(title?: string | null) {
  const normalized = normalizeMenuTitle(title);
  if (WEBSITE_MAIN_CATEGORY_KEYS.includes(normalized)) return normalized;

  const matchedTitle = findMainCategoryForCollection({ title: String(title || ''), handle: '' });
  return normalizeMenuTitle(matchedTitle);
}

function getCompactMatchKey(value?: string | null) {
  return normalizeMenuTitle(value).replace(/\b(and|of|the|a)\b/g, '').replace(/\s+/g, '');
}

function findBestCollectionMatch(
  config: { title: string; handle: string },
  collections: CategoryCollection[]
) {
  const configHandle = normalizeMenuTitle(config.handle);
  const configTitle = normalizeMenuTitle(config.title);
  const compactConfigTitle = getCompactMatchKey(config.title);
  const compactConfigHandle = getCompactMatchKey(config.handle);

  return collections.find((collection) => {
    const handle = normalizeMenuTitle(collection.handle);
    const title = normalizeMenuTitle(collection.title);
    const compactTitle = getCompactMatchKey(collection.title);
    const compactHandle = getCompactMatchKey(collection.handle);

    return (
      handle === configHandle ||
      title === configTitle ||
      compactTitle === compactConfigTitle ||
      compactHandle === compactConfigHandle ||
      compactTitle.includes(compactConfigTitle) ||
      compactConfigTitle.includes(compactTitle) ||
      compactHandle.includes(compactConfigHandle) ||
      compactConfigHandle.includes(compactHandle)
    );
  });
}

function applyWebsiteSubcategoryLists(
  groups: MenuCategoryGroup[],
  _collections: CategoryCollection[] = []
) {
  return sortMainGroupsByWebsiteOrder(groups).map((group) => {
    return {
      ...group,
      items: dedupeMenuItemsByHandle(group.items),
    };
  });
}

function buildGroupFromTopMenuItem(topItem: any, groupIndex: number): MenuCategoryGroup | null {
  const topCollectionItem = buildMenuItemFromCollection(topItem, 0);
  const nestedCollectionItems = getNestedMenuItems(topItem)
    .map((item: any, itemIndex: number) => buildMenuItemFromCollection(item, itemIndex))
    .filter(Boolean) as MenuCategoryItem[];

  const items = dedupeMenuItemsByHandle(
    nestedCollectionItems.length
      ? nestedCollectionItems
      : topCollectionItem
        ? [topCollectionItem]
        : []
  );

  if (!items.length) return null;

  return {
    id: String(topItem?.resource?.id || topItem?.id || topItem?.title || `menu-group-${groupIndex}`),
    title: getMainCategoryDisplayTitle(topItem?.title || topCollectionItem?.title || `Category ${groupIndex + 1}`),
    handle: getCollectionHandleFromMenuItem(topItem),
    items,
  };
}

function buildGroupsFromFlatMenu(topItems: any[]): MenuCategoryGroup[] {
  const groups: MenuCategoryGroup[] = [];
  let currentGroup: MenuCategoryGroup | null = null;

  topItems.forEach((topItem: any, index: number) => {
    const topTitle = String(topItem?.title || '').trim();
    const topCollectionItem = buildMenuItemFromCollection(topItem, index);
    const nestedCollectionItems = getNestedMenuItems(topItem)
      .map((item: any, itemIndex: number) => buildMenuItemFromCollection(item, itemIndex))
      .filter(Boolean) as MenuCategoryItem[];

    if (isMainCategoryTitle(topTitle)) {
      currentGroup = {
        id: String(topItem?.resource?.id || topItem?.id || `main-category-${normalizeMenuTitle(topTitle)}`),
        title: getMainCategoryDisplayTitle(topTitle),
        handle: getCollectionHandleFromMenuItem(topItem),
        items: [],
      };

      if (nestedCollectionItems.length) {
        currentGroup.items = dedupeMenuItemsByHandle(nestedCollectionItems);
      } else if (topCollectionItem) {
        // Keep the main collection as a right-side tile only when Shopify has no nested subcategories.
        currentGroup.items = [topCollectionItem];
      }

      groups.push(currentGroup);
      return;
    }

    // If Shopify menu is accidentally flat, treat non-main titles as subcategories
    // under the most recent main category instead of showing them on the left.
    if (currentGroup && topCollectionItem) {
      currentGroup.items = dedupeMenuItemsByHandle([
        ...currentGroup.items,
        topCollectionItem,
        ...nestedCollectionItems,
      ]);
    }
  });

  return groups.filter((group) => group.items.length > 0);
}

function buildGroupsFromMenu(menu: any): MenuCategoryGroup[] {
  const topItems = Array.isArray(menu?.items) ? menu.items : [];
  if (!topItems.length) return [];

  const menuGroups = topItems
    .filter((topItem: any) => {
      if (!isMainCategoryTitle(topItem?.title)) return false;
      const hasCollection = Boolean(getCollectionHandleFromMenuItem(topItem));
      const hasChildren = Array.isArray(topItem?.items) && topItem.items.length > 0;
      return hasCollection || hasChildren;
    })
    .map((topItem: any, groupIndex: number) => buildGroupFromTopMenuItem(topItem, groupIndex))
    .filter(Boolean) as MenuCategoryGroup[];

  if (menuGroups.length) return sortMainGroupsByWebsiteOrder(menuGroups);

  return sortMainGroupsByWebsiteOrder(buildGroupsFromFlatMenu(topItems));
}

function buildGroupsFromCollections(collections: CategoryCollection[]): MenuCategoryGroup[] {
  const groups = createWebsiteMainCategoryGroups();
  const groupByKey = new Map(groups.map((group) => [normalizeMenuTitle(group.title), group]));

  collections.forEach((collection, index) => {
    if (!collection.handle) return;

    const mainTitle = findMainCategoryForCollection(collection);
    const group = groupByKey.get(normalizeMenuTitle(mainTitle));
    if (!group) return;

    group.items.push({
      id: `${collection.id || collection.handle}-item-${index}`,
      title: collection.title,
      handle: collection.handle,
      image: collection.image,
      previewProducts: collection.previewProducts,
    });
  });

  return applyWebsiteSubcategoryLists(
    groups.map((group) => ({
      ...group,
      items: dedupeMenuItemsByHandle(group.items),
    })),
    collections
  );
}

function enrichMenuGroupsWithCollections(
  menuGroups: MenuCategoryGroup[],
  collections: CategoryCollection[]
) {
  return menuGroups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const collection = findBestCollectionMatch(
        { title: item.title, handle: item.handle },
        collections
      );
      if (!collection) return item;

      const image =
        isRealProductImage(item.image) ? item.image :
        collection.image ||
        collection.previewProducts.find((product) => isRealProductImage(product.image))?.image ||
        '';

      return {
        ...item,
        title: item.title || collection.title,
        handle: collection.handle || item.handle,
        image,
        previewProducts: collection.previewProducts,
      };
    }),
  }));
}

function normalizeGroupsToWebsiteMainCategories(groups: MenuCategoryGroup[]) {
  const sourceGroups = Array.isArray(groups) ? groups : [];

  const groupsByKey = new Map(
    createWebsiteMainCategoryGroups().map((group) => [normalizeMenuTitle(group.title), group])
  );

  sourceGroups.forEach((group) => {
    const groupItems = Array.isArray(group.items) ? group.items : [];
    const groupKey = getMainCategoryGroupKey(group.title);
    const mainGroup = groupsByKey.get(groupKey);

    if (mainGroup && isMainCategoryTitle(group.title)) {
      mainGroup.handle = group.handle || mainGroup.handle;
      mainGroup.items.push(...groupItems);

      if (!groupItems.length && group.handle) {
        mainGroup.items.push({
          id: `${group.id || group.handle}-main-item`,
          title: group.title,
          handle: group.handle,
          image: '',
          previewProducts: [],
        });
      }
      return;
    }

    const fallbackGroup = groupsByKey.get(groupKey);
    if (!fallbackGroup) return;

    if (groupItems.length) {
      fallbackGroup.items.push(...groupItems);
      return;
    }

    if (group.handle) {
      fallbackGroup.items.push({
        id: `${group.id || group.handle}-legacy-item`,
        title: group.title,
        handle: group.handle,
        image: '',
        previewProducts: [],
      });
    }
  });

  return applyWebsiteSubcategoryLists(
    Array.from(groupsByKey.values()).map((group) => ({
      ...group,
      items: dedupeMenuItemsByHandle(group.items),
    }))
  );
}

export default function CategoriesScreen() {
  console.log('NOOD CategoriesScreen V17 running: live Shopify categories first');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isDesktop = width >= 768;
  const isTablet = width >= 700 && width < 768;
  const isMobile = width < 700;
  const [groups, setGroups] = useState<MenuCategoryGroup[]>(
    () => normalizeGroupsToWebsiteMainCategories(categoriesSessionSnapshot?.groups ?? [])
  );
  const groupsRef = useRef<MenuCategoryGroup[]>(
    normalizeGroupsToWebsiteMainCategories(categoriesSessionSnapshot?.groups ?? [])
  );
  const [loading, setLoading] = useState(!categoriesSessionSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [activeGroupId, setActiveGroupId] = useState(
    () => categoriesSessionSnapshot?.activeGroupId || ''
  );
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollOffsetRef = useRef(categoriesSessionSnapshot?.scrollOffset ?? 0);
  const restoredScrollRef = useRef(false);

  useEffect(() => {
    void (async () => {
      if (groupsRef.current.length || categoriesSessionSnapshot?.groups?.length) {
        return;
      }

      try {
        const cachedRaw = await AsyncStorage.getItem(CATEGORIES_CACHE_KEY);
        if (!cachedRaw) return;

        const cachedGroups = normalizeGroupsToWebsiteMainCategories(JSON.parse(cachedRaw));
        if (!cachedGroups.length) return;

        setGroups(cachedGroups);
        setActiveGroupId((current) => {
          if (cachedGroups.some((group) => group.id === current)) return current;
          return cachedGroups[0]?.id || '';
        });
        setLoading(false);
      } catch (error) {
        console.log('Categories immediate cache load error:', error);
      }
    })();
  }, []);

  useEffect(() => {
    groupsRef.current = groups;
    if (!groups.length) return;

    categoriesSessionSnapshot = {
      groups,
      activeGroupId,
      scrollOffset: scrollOffsetRef.current,
    };
  }, [activeGroupId, groups]);

  useEffect(() => {
    if (restoredScrollRef.current || !groups.length) return;
    if (!categoriesSessionSnapshot || categoriesSessionSnapshot.scrollOffset <= 0) return;

    restoredScrollRef.current = true;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        y: categoriesSessionSnapshot?.scrollOffset ?? 0,
        animated: false,
      });
    });
  }, [groups.length]);

  const openCategoryTarget = useCallback(
    (item?: MenuCategoryItem | null) => {
      if (!item) return;

      categoriesSessionSnapshot = {
        groups,
        activeGroupId,
        scrollOffset: scrollOffsetRef.current,
      };

      if (item.handle) {
        router.push({
          pathname: '/collection/[handle]',
          params: { handle: item.handle, from: 'categories' },
        });
        return;
      }

      const fallbackProductHandle = item.previewProducts?.[0]?.handle;
      if (!fallbackProductHandle) return;

      const previewProduct = item.previewProducts?.[0];
      router.push({
        pathname: '/product/[handle]',
        params: buildProductRouteParams(
          previewProduct || { handle: fallbackProductHandle },
          { from: 'categories' }
        ),
      });
    },
    [activeGroupId, groups, router]
  );

  const fetchCategoriesMenu = useCallback(async () => {
    for (const handle of SHOPIFY_CATEGORIES_MENU_HANDLES) {
      try {
        const json: any = await fetchCatalogPath(`/api/catalog/menus/${encodeURIComponent(handle)}`);
        if (json?.errors?.length) {
          console.log(`Categories menu GraphQL error for ${handle}:`, json.errors);
        }

        const menu = json?.data?.menu;
        const groupsFromMenu = buildGroupsFromMenu(menu);

        console.log('Shopify menu check:', {
          handle,
          menuTitle: menu?.title || null,
          topItems: Array.isArray(menu?.items) ? menu.items.map((item: any) => item?.title) : [],
          nestedItems: Array.isArray(menu?.items)
            ? menu.items.map((item: any) => ({
                title: item?.title,
                children: Array.isArray(item?.items)
                  ? item.items.map((child: any) => ({
                      title: child?.title,
                      children: Array.isArray(child?.items)
                        ? child.items.map((grandChild: any) => grandChild?.title)
                        : [],
                    }))
                  : [],
              }))
            : [],
          groupsCount: groupsFromMenu.length,
        });

        if (groupsFromMenu.length) {
          console.log(`Loaded Shopify categories from menu: ${handle}`);
          return groupsFromMenu;
        }
      } catch (error) {
        console.log(`Categories menu load error for ${handle}:`, error);
      }
    }

    console.log('No Shopify navigation menu returned category groups. Falling back to all collections.');
    return [];
  }, []);

  const fetchCategoryCollections = useCallback(async () => {
    const collections: CategoryCollection[] = [];
    const seenHandles = new Set<string>();
    let after: string | null = null;
    let hasMore = true;
    let guard = 0;

    while (hasMore && guard < 20) {
      const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
      const json: any = await fetchCatalogPath(`/api/catalog/collections?limit=250&first=250${afterParam}`);
      if (json?.errors?.length) {
        console.log('Categories collections GraphQL error:', json.errors);
      }

      const pageCollections = (json?.data?.collections?.edges || [])
        .map(normalizeCollection)
        .filter((item: CategoryCollection) => item.handle);

      pageCollections.forEach((collection: CategoryCollection) => {
        if (seenHandles.has(collection.handle)) return;
        seenHandles.add(collection.handle);
        collections.push(collection);
      });

      const pageInfo: { hasNextPage?: boolean; endCursor?: string | null } =
        json?.data?.collections?.pageInfo || {};
      after = pageInfo?.endCursor ?? null;
      hasMore = Boolean(pageInfo?.hasNextPage && after);
      guard += 1;
    }

    return collections;
  }, []);

  const loadCategories = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) {
        setRefreshing(true);
      } else if (!groupsRef.current.length && !categoriesSessionSnapshot?.groups?.length) {
        setLoading(true);
      }

      const [collections, menuGroups] = await Promise.all([
        fetchCategoryCollections(),
        fetchCategoriesMenu(),
      ]);

      const enrichedMenuGroups = menuGroups.length
        ? enrichMenuGroupsWithCollections(menuGroups, collections)
        : [];

      const nextGroups = enrichedMenuGroups.length
        ? enrichedMenuGroups
        : buildGroupsFromCollections(collections);

      console.log(`[NOOD app] using backend cache`);
      console.log(`[NOOD app] backend collections loaded count=${collections.length}`);

      const currentGroups = groupsRef.current.length
        ? groupsRef.current
        : categoriesSessionSnapshot?.groups || [];
      let safeCachedGroups: MenuCategoryGroup[] = [];
      if (!nextGroups.length && !currentGroups.length) {
        try {
          const cachedRaw = await AsyncStorage.getItem(CATEGORIES_CACHE_KEY);
          safeCachedGroups = cachedRaw
            ? normalizeGroupsToWebsiteMainCategories(JSON.parse(cachedRaw))
            : [];
        } catch {
          safeCachedGroups = [];
        }
      }
      const groupsToSave = nextGroups.length ? nextGroups : currentGroups.length ? currentGroups : safeCachedGroups;
      const normalizedGroupsToSave = normalizeGroupsToWebsiteMainCategories(groupsToSave);

      console.log('Final app category groups:', normalizedGroupsToSave.map((group: MenuCategoryGroup) => ({
        title: group.title,
        handle: group.handle,
        subcategories: group.items.map((item: MenuCategoryItem) => item.title),
      })));

      setGroups(normalizedGroupsToSave);
      setActiveGroupId((current) => {
        if (normalizedGroupsToSave.some((group) => group.id === current)) return current;
        return normalizedGroupsToSave[0]?.id || '';
      });
      await AsyncStorage.setItem(
        CATEGORIES_CACHE_KEY,
        JSON.stringify(normalizedGroupsToSave)
      );
    } catch (error) {
      console.log('Categories load error:', error);
      try {
        const cachedRaw = await AsyncStorage.getItem(CATEGORIES_CACHE_KEY);
        const cachedGroups = cachedRaw ? normalizeGroupsToWebsiteMainCategories(JSON.parse(cachedRaw)) : [];
        const currentGroups = groupsRef.current.length ? groupsRef.current : categoriesSessionSnapshot?.groups || [];
        const fallbackGroups = normalizeGroupsToWebsiteMainCategories(
          currentGroups.length ? currentGroups : Array.isArray(cachedGroups) ? cachedGroups : []
        );
        setGroups(fallbackGroups);
        setActiveGroupId((current) => current || fallbackGroups[0]?.id || '');
      } catch (cacheError) {
        console.log('Categories fallback cache error:', cacheError);
        const currentGroups = normalizeGroupsToWebsiteMainCategories(
          groupsRef.current.length ? groupsRef.current : categoriesSessionSnapshot?.groups || []
        );
        setGroups(currentGroups);
        setActiveGroupId((current) => current || currentGroups[0]?.id || '');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchCategoriesMenu, fetchCategoryCollections]);

  useFocusEffect(
    useCallback(() => {
      void loadCategories();
    }, [loadCategories])
  );

  const baseGroups = groups;

  const filteredGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return baseGroups;

    return baseGroups
      .map((group) => {
        const titleMatch = group.title.toLowerCase().includes(query);
        const items = group.items.filter((item) =>
          item.title.toLowerCase().includes(query)
        );

        if (titleMatch) return group;
        if (!items.length) return null;

        return { ...group, items };
      })
      .filter(Boolean) as MenuCategoryGroup[];
  }, [baseGroups, search]);

  const rawGroupsToRender = filteredGroups.length ? filteredGroups : baseGroups;
  const groupsToRender = sortMainGroupsByWebsiteOrder(rawGroupsToRender);

  const activeGroup = activeGroupId
    ? groupsToRender.find((group) => group.id === activeGroupId) ||
      baseGroups.find((group) => group.id === activeGroupId) ||
      groupsToRender[0] ||
      baseGroups[0] ||
      null
    : groupsToRender[0] || baseGroups[0] || null;
  const resolvedActiveGroup = activeGroup || null;

  const featuredItems = useMemo(() => resolvedActiveGroup?.items || [], [resolvedActiveGroup]);
  const trendingItems = useMemo(
    () =>
      [...featuredItems]
        .sort((a, b) => b.previewProducts.length - a.previewProducts.length)
        .slice(0, 4),
    [featuredItems]
  );
  const heroContent = useMemo(() => {
    const title = resolvedActiveGroup?.title || 'Category';
    return CATEGORY_HERO_COPY[title] || { eyebrow: title, title: `Shop ${title}` };
  }, [resolvedActiveGroup?.title]);
  const heroImage = useMemo(
    () => featuredItems.find((item) => isRealProductImage(item.image))?.image || '',
    [featuredItems]
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          !isDesktop && { paddingTop: Math.max(0, insets.top > 0 ? 0 : 0) },
        ]}
        scrollEventThrottle={32}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        onScroll={(event) => {
          const offset = event.nativeEvent.contentOffset.y;
          scrollOffsetRef.current = offset;
          if (categoriesSessionSnapshot) {
            categoriesSessionSnapshot.scrollOffset = offset;
          }
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void loadCategories(true);
            }}
            tintColor="#ff6a00"
            colors={['#ff6a00']}
            progressBackgroundColor="#ffffff"
          />
        }
      >
        <View style={[styles.contentShell, isDesktop && styles.contentShellDesktop]}>
          <View style={styles.aliexpressTopBar}>
            <View style={styles.noodLogoWrap}>
              <Image
                source={NOOD_LOGO}
                style={styles.noodLogoImage}
                resizeMode="contain"
              />
            </View>

            <View style={styles.topActions}>
              <TouchableOpacity activeOpacity={0.85} style={styles.topSearchIcon}>
                <Ionicons name="camera-outline" size={25} color="#171717" />
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.85} style={styles.topSearchIcon}>
                <Ionicons name="search-outline" size={29} color="#171717" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.searchWrap}>
            <Ionicons name="search-outline" size={18} color="#9a9a9a" />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search categories"
              placeholderTextColor="#9a9a9a"
              style={styles.searchInput}
            />
            <View style={styles.searchBadge}>
              <Ionicons name="grid-outline" size={14} color="#ff6a00" />
            </View>
          </View>

          <View style={[styles.browserWrap, isMobile && styles.browserWrapMobile]}>
            <View
              style={[
                styles.railShell,
                isDesktop ? styles.railDesktop : isTablet ? styles.railTablet : styles.railMobile,
              ]}
            >
              <ScrollView
                style={styles.railScroll}
                contentContainerStyle={styles.railContent}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
                removeClippedSubviews
              >
                {groupsToRender.map((group) => {
                  const active = group.id === resolvedActiveGroup?.id;

                  return (
                    <TouchableOpacity
                      key={group.id}
                      style={[
                        styles.railItem,
                        isDesktop ? styles.railItemDesktop : styles.railItemMobile,
                        active && styles.railItemActive,
                      ]}
                      activeOpacity={0.9}
                      onPress={() => setActiveGroupId(group.id)}
                    >
                      {active ? <View style={styles.railAccent} /> : null}
                      <Ionicons
                        name={getCategoryIcon(group.title)}
                        size={isMobile ? 21 : 23}
                        color={active ? '#ff6a00' : '#747474'}
                        style={styles.railIcon}
                      />
                      <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={[
                          styles.railText,
                          !isDesktop && styles.railTextMobile,
                          active && styles.railTextActive,
                        ]}
                      >
                        {group.title}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            <View style={[styles.panel, isMobile && styles.panelMobile]}>
              {loading && !groups.length ? (
                <View style={styles.loadingPanel}>
                  <NoodSpinner size={48} />
                  <Text style={styles.loadingPanelText}>Loading categories...</Text>
                </View>
              ) : resolvedActiveGroup ? (
                <>
                  <Text numberOfLines={1} style={styles.categoryPanelTitle}>
                    {resolvedActiveGroup.title}
                  </Text>

                  {featuredItems.length ? (
                    <>
                      <TouchableOpacity
                        activeOpacity={0.9}
                        style={[styles.dynamicHeroCard, isMobile && styles.dynamicHeroCardMobile]}
                        onPress={() => openCategoryTarget(trendingItems[0] || featuredItems[0])}
                      >
                        {isRealProductImage(heroImage) ? (
                          <Image
                            source={{ uri: getOptimizedImageUrl(heroImage, isDesktop ? 900 : 520) }}
                            style={styles.dynamicHeroImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={styles.dynamicHeroPlaceholder}>
                            <Ionicons name="image-outline" size={34} color="#777" />
                          </View>
                        )}
                        <View style={styles.dynamicHeroShade} />
                        <View style={styles.dynamicHeroPaint} />
                        <View style={styles.dynamicHeroContent}>
                          <Text numberOfLines={1} style={styles.dynamicHeroEyebrow}>
                            {heroContent.eyebrow}
                          </Text>
                          <Text numberOfLines={3} style={[styles.dynamicHeroTitle, isMobile && styles.dynamicHeroTitleMobile]}>
                            {heroContent.title}
                          </Text>
                          <View style={styles.dynamicHeroButton}>
                            <Text style={styles.dynamicHeroButtonText}>Shop now</Text>
                            <Ionicons name="arrow-forward" size={16} color="#fff" />
                          </View>
                        </View>
                      </TouchableOpacity>

                      <View style={styles.heroDots}>
                        <View style={[styles.heroDot, styles.heroDotActive]} />
                        <View style={styles.heroDot} />
                        <View style={styles.heroDot} />
                      </View>

                      <View style={styles.categorySectionHeader}>
                        <Text style={styles.categorySectionTitle}>Trending now</Text>
                        <Text style={styles.categorySectionAction}>View all</Text>
                      </View>

                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.trendingCardsRow}
                      >
                        {trendingItems.map((item, index) => (
                          <TouchableOpacity
                            key={`trending-category-${item.id}`}
                            activeOpacity={0.88}
                            style={[styles.trendingCategoryCard, isDesktop && styles.trendingCategoryCardDesktop]}
                            onPress={() => openCategoryTarget(item)}
                          >
                            {isRealProductImage(item.image) ? (
                              <Image
                                source={{ uri: getOptimizedImageUrl(item.image, 260) }}
                                style={styles.trendingCategoryImage}
                                resizeMode="cover"
                              />
                            ) : (
                              <View style={styles.trendingCategoryPlaceholder}>
                                <Ionicons name="image-outline" size={24} color="#b8b8b8" />
                              </View>
                            )}
                            <Text numberOfLines={2} style={styles.trendingCategoryTitle}>
                              {item.title}
                            </Text>
                            <View style={styles.smallOrangeBadge}>
                              <Text style={styles.smallOrangeBadgeText}>
                                {CATEGORY_CARD_BADGES[index % CATEGORY_CARD_BADGES.length]}
                              </Text>
                            </View>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>

                      <View style={styles.categorySectionHeader}>
                        <Text style={styles.categorySectionTitle}>All categories</Text>
                      </View>

                      <View style={styles.allCategoryGrid}>
                        {featuredItems.map((item, index) => (
                          <TouchableOpacity
                            key={`all-category-${item.id}`}
                            activeOpacity={0.88}
                            style={[styles.allCategoryCard, isDesktop && styles.allCategoryCardDesktop]}
                            onPress={() => openCategoryTarget(item)}
                          >
                            {isRealProductImage(item.image) ? (
                              <Image
                                source={{ uri: getOptimizedImageUrl(item.image, 300) }}
                                style={styles.allCategoryImage}
                                resizeMode="cover"
                              />
                            ) : (
                              <View style={styles.allCategoryPlaceholder}>
                                <Ionicons name="image-outline" size={24} color="#b8b8b8" />
                              </View>
                            )}
                            <View style={styles.allCategoryInfo}>
                              <View style={styles.allCategoryBadge}>
                                <Text style={styles.allCategoryBadgeText}>
                                  {CATEGORY_CARD_BADGES[index % CATEGORY_CARD_BADGES.length]}
                                </Text>
                              </View>
                              <Text numberOfLines={2} style={styles.allCategoryTitle}>
                                {item.title}
                              </Text>
                              <Text numberOfLines={1} style={styles.allCategoryMeta}>
                                {item.previewProducts.length ? `${item.previewProducts.length} products` : 'Shop collection'}
                              </Text>
                              <View style={styles.allCategoryCta}>
                                <Text style={styles.allCategoryCtaText}>Shop now</Text>
                                <Ionicons name="arrow-forward" size={16} color="#ff6a00" />
                              </View>
                            </View>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  ) : (
                    <View style={styles.emptyWrap}>
                      <Text style={styles.emptyText}>No subcategories available yet.</Text>
                      <Text style={styles.emptySubText}>Add Shopify collections under this category to show them here.</Text>
                    </View>
                  )}
                </>
              ) : (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyText}>No categories available yet.</Text>
                  <Text style={styles.emptySubText}>Check Metro logs for Shopify menu and collection errors.</Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    paddingTop: 0,
    paddingBottom: 120,
    backgroundColor: '#fff',
  },
  contentShell: {
    width: '100%',
    backgroundColor: '#fff',
  },
  contentShellDesktop: {
    maxWidth: 1180,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: 16,
  },
  loadingWrap: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: '#666',
    fontWeight: '600',
  },
  pageTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
    marginBottom: 4,
  },
  pageTitleMobile: {
    display: 'none',
  },
  pageSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: '#6e6e73',
    textAlign: 'center',
    marginBottom: 14,
    paddingHorizontal: 18,
  },
  pageSubtitleMobile: {
    display: 'none',
  },
  aliexpressTopBar: {
    height: 74,
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  noodLogoWrap: {
    minWidth: 104,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  noodLogoImage: {
    width: 96,
    height: 34,
  },
  noodLogoText: {
    fontSize: 31,
    lineHeight: 34,
    fontWeight: '900',
    color: '#111',
    letterSpacing: -1.4,
  },
  noodLogoSubText: {
    marginTop: -2,
    fontSize: 11,
    fontWeight: '800',
    color: '#ff6a00',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  topSearchIcon: {
    width: 34,
    height: 44,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchWrap: {
    marginHorizontal: 24,
    marginTop: 0,
    marginBottom: 16,
    height: 47,
    borderRadius: 14,
    backgroundColor: '#f8f8f8',
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ededed',
    ...platformShadow('0 8px 18px rgba(17,17,17,0.06)', {
      shadowColor: '#000',
      shadowOpacity: 0.06,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 6 },
      elevation: 2,
    }),
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    color: '#111',
    fontSize: 14,
    fontWeight: '600',
  },
  searchBadge: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  browserWatermark: {
    position: 'absolute',
    top: 108,
    left: 6,
    right: 8,
    height: 230,
    opacity: 0.18,
    zIndex: 1,
  },
  recommendedWrap: {
    backgroundColor: 'transparent',
    paddingTop: 8,
    paddingBottom: 8,
  },
  recommendedHeader: {
    minHeight: 34,
    justifyContent: 'center',
    marginBottom: 8,
    position: 'relative',
    overflow: 'visible',
  },
  noodWatermark: {
    position: 'absolute',
    left: 4,
    top: -8,
    fontSize: 54,
    lineHeight: 60,
    fontWeight: '900',
    color: 'rgba(255,106,0,0.06)',
    letterSpacing: -2,
  },
  noodLogoWatermark: {
    position: 'absolute',
    left: -18,
    top: -22,
    width: 220,
    height: 112,
    opacity: 0,
  },
  recommendedTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#ff6a00',
    letterSpacing: 0.2,
    paddingLeft: 6,
  },
  recommendedTitleMobile: {
    fontSize: 20,
  },
  selectedMainCategoryText: {
    marginTop: 4,
    paddingLeft: 6,
    fontSize: 13,
    lineHeight: 18,
    color: '#777',
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  recommendedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingBottom: 6,
  },
  recommendedItem: {
    width: '33.333%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 14,
  },
  recommendedImageBubble: {
    width: 86,
    height: 86,
    borderRadius: 43,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#f3e4d6',
    overflow: 'hidden',
    ...platformShadow('0 10px 20px rgba(17,17,17,0.08)', {
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 8 },
      elevation: 3,
    }),
  },
  recommendedImage: {
    width: '100%',
    height: '100%',
    borderRadius: 43,
    backgroundColor: '#fff',
  },
  recommendedPlaceholder: {
    width: '100%',
    height: '100%',
    borderRadius: 43,
    backgroundColor: '#f6f6f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recommendedText: {
    marginTop: 10,
    minHeight: 36,
    fontSize: 13,
    lineHeight: 17,
    color: '#222',
    fontWeight: '700',
    textAlign: 'center',
  },
  curatedHero: {
    marginHorizontal: 10,
    marginTop: 12,
    marginBottom: 4,
    minHeight: 86,
    borderRadius: 20,
    backgroundColor: '#fff4e8',
    borderWidth: 1,
    borderColor: '#ffe2cf',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  curatedHeroMobile: {
    minHeight: 78,
    borderRadius: 18,
    marginTop: 12,
  },
  curatedHeroAccent: {
    width: 4,
    height: 42,
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    marginRight: 12,
  },
  curatedHeroTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  curatedHeroTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    letterSpacing: 0.1,
  },
  curatedHeroCopy: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: '#6b5b50',
    fontWeight: '600',
  },
  tipBar: {
    marginTop: 10,
    backgroundColor: '#fff0df',
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tipBarMobile: {
    display: 'none',
  },
  tipText: {
    flex: 1,
    marginLeft: 8,
    color: '#333',
    fontSize: 13,
    fontWeight: '600',
  },
  browserWrap: {
    flexDirection: 'row',
    marginTop: 0,
    minHeight: 680,
    alignItems: 'stretch',
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: '#fff',
    position: 'relative',
    overflow: 'hidden',
  },
  browserWrapMobile: {
    flexDirection: 'row',
    minHeight: 0,
    marginTop: 0,
  },
  railShell: {
    width: 154,
    backgroundColor: '#fafafa',
    flexShrink: 0,
    position: 'relative',
    overflow: 'hidden',
    borderRightWidth: 1,
    borderRightColor: '#ececec',
    zIndex: 2,
  },
  railScroll: {
    flex: 1,
  },
  railDesktop: {
    width: 154,
  },
  railTablet: {
    width: 136,
  },
  railMobile: {
    width: 132,
    minWidth: 132,
    maxWidth: 136,
    borderRightWidth: 1,
    backgroundColor: '#fafafa',
  },
  railContent: {
    paddingVertical: 0,
  },
  railContentMobile: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: 8,
    backgroundColor: '#f5f5f5',
  },
  railItem: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 11,
  },
  railItemDesktop: {
    minHeight: 68,
    paddingHorizontal: 16,
  },
  railItemMobile: {
    minHeight: 68,
    paddingHorizontal: 13,
    gap: 9,
  },
  railItemActive: {
    backgroundColor: '#fff',
    borderRightWidth: 0,
  },
  railAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: '#ff6a00',
  },
  railText: {
    color: '#5f5f5f',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
    flex: 1,
  },
  railTextMobile: {
    fontSize: 13,
    lineHeight: 16,
    flexShrink: 1,
  },
  railTextActive: {
    color: '#ff6a00',
    fontWeight: '900',
  },
  railIcon: {
    width: 23,
    textAlign: 'center',
  },
  railEdgeIndicator: {
    position: 'absolute',
    top: 13,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    ...platformShadow('0 2px 5px rgba(0,0,0,0.08)', {
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 5,
        elevation: 2,
    }),
  },
  railEdgeIndicatorLeft: {
    left: 4,
  },
  railEdgeIndicatorRight: {
    right: 4,
  },
  panel: {
    flex: 1,
    flexBasis: 0,
    flexGrow: 1,
    alignSelf: 'stretch',
    minWidth: 0,
    paddingHorizontal: 24,
    paddingTop: 21,
    paddingBottom: 26,
    backgroundColor: '#fff',
    zIndex: 2,
  },
  panelMobile: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 18,
    paddingTop: 20,
    backgroundColor: '#fff',
  },
  categoryPanelTitle: {
    marginBottom: 18,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '900',
    color: '#111',
  },
  dynamicHeroCard: {
    width: '100%',
    minHeight: 182,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#151515',
    marginBottom: 8,
    position: 'relative',
    ...platformShadow('0 12px 24px rgba(17,17,17,0.12)', {
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 8 },
      elevation: 3,
    }),
  },
  dynamicHeroCardMobile: {
    minHeight: 154,
    borderRadius: 16,
  },
  dynamicHeroImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  dynamicHeroPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#161616',
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 28,
  },
  dynamicHeroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.46)',
  },
  dynamicHeroPaint: {
    position: 'absolute',
    right: -20,
    bottom: -28,
    width: 170,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(255,106,0,0.72)',
    transform: [{ rotate: '-16deg' }],
  },
  dynamicHeroContent: {
    minHeight: 182,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    paddingVertical: 22,
    maxWidth: '72%',
  },
  dynamicHeroEyebrow: {
    color: '#ff6a00',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  dynamicHeroTitle: {
    color: '#fff',
    fontSize: 27,
    lineHeight: 32,
    fontWeight: '900',
  },
  dynamicHeroTitleMobile: {
    fontSize: 22,
    lineHeight: 27,
  },
  dynamicHeroButton: {
    marginTop: 18,
    minHeight: 42,
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dynamicHeroButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  heroDots: {
    height: 20,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  heroDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#a7a7a7',
  },
  heroDotActive: {
    width: 18,
    backgroundColor: '#ff6a00',
  },
  categorySectionHeader: {
    marginTop: 14,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  categorySectionTitle: {
    color: '#111',
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '900',
  },
  categorySectionAction: {
    color: '#ff6a00',
    fontSize: 13,
    fontWeight: '900',
  },
  trendingCardsRow: {
    gap: 12,
    paddingRight: 4,
    paddingBottom: 4,
  },
  trendingCategoryCard: {
    width: 132,
    minHeight: 168,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ededed',
    overflow: 'hidden',
    alignItems: 'center',
    paddingBottom: 10,
    ...platformShadow('0 8px 18px rgba(17,17,17,0.08)', {
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 5 },
      elevation: 2,
    }),
  },
  trendingCategoryCardDesktop: {
    width: 154,
  },
  trendingCategoryImage: {
    width: '100%',
    height: 104,
    backgroundColor: '#f6f6f6',
  },
  trendingCategoryPlaceholder: {
    width: '100%',
    height: 104,
    backgroundColor: '#f6f6f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trendingCategoryTitle: {
    marginTop: 8,
    minHeight: 34,
    paddingHorizontal: 8,
    color: '#111',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
    textAlign: 'center',
  },
  smallOrangeBadge: {
    marginTop: 6,
    minHeight: 22,
    borderRadius: 7,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallOrangeBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
  },
  allCategoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
    paddingBottom: 24,
  },
  allCategoryCard: {
    width: '100%',
    minHeight: 136,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ededed',
    flexDirection: 'row',
    overflow: 'hidden',
    ...platformShadow('0 8px 18px rgba(17,17,17,0.07)', {
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 5 },
      elevation: 2,
    }),
  },
  allCategoryCardDesktop: {
    width: '48.8%',
  },
  allCategoryImage: {
    width: 118,
    height: '100%',
    minHeight: 136,
    backgroundColor: '#f6f6f6',
  },
  allCategoryPlaceholder: {
    width: 118,
    minHeight: 136,
    backgroundColor: '#f6f6f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  allCategoryInfo: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: 13,
    justifyContent: 'center',
    position: 'relative',
  },
  allCategoryBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    minHeight: 22,
    borderRadius: 7,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allCategoryBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
  },
  allCategoryTitle: {
    paddingRight: 54,
    color: '#111',
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
  },
  allCategoryMeta: {
    marginTop: 7,
    color: '#777',
    fontSize: 13,
    fontWeight: '700',
  },
  allCategoryCta: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  allCategoryCtaText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '900',
  },
  categoryList: {
    gap: 14,
    paddingBottom: 20,
  },
  categoryListRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
  },
  categoryListImage: {
    width: 66,
    height: 66,
    borderRadius: 10,
    backgroundColor: '#f6f6f6',
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  categoryListPlaceholder: {
    width: 66,
    height: 66,
    borderRadius: 10,
    backgroundColor: '#f6f6f6',
    borderWidth: 1,
    borderColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryListText: {
    flex: 1,
    marginLeft: 16,
    marginRight: 8,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
    color: '#242424',
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14,
    paddingBottom: 24,
  },
  categoryGridCard: {
    width: '47%',
    minHeight: 142,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ededed',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 12,
    ...platformShadow('0 5px 14px rgba(17,17,17,0.06)', {
      shadowColor: '#000',
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    }),
  },
  categoryGridCardDesktop: {
    width: 132,
  },
  categoryGridImage: {
    width: '100%',
    height: 92,
    borderRadius: 6,
    backgroundColor: '#f7f7f7',
  },
  categoryGridPlaceholder: {
    width: '100%',
    height: 92,
    borderRadius: 6,
    backgroundColor: '#f7f7f7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryGridText: {
    marginTop: 10,
    minHeight: 34,
    fontSize: 14,
    lineHeight: 17,
    fontWeight: '800',
    color: '#242424',
    textAlign: 'center',
  },
  loadingPanel: {
    flex: 1,
    minHeight: 280,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingPanelText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: '700',
    color: '#6e6258',
  },
  mobileTrendingSection: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  shopByCategoryWrap: {
    width: '100%',
    marginBottom: 18,
  },
  shopByCategoryGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 14,
  },
  shopByCategoryItem: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  shopByCategoryImage: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: '#f3f3f3',
    borderWidth: 2,
    borderColor: '#fff',
    ...platformShadow('0 8px 18px rgba(30,18,10,0.10)', {
      shadowColor: '#000',
      shadowOpacity: 0.1,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 6 },
      elevation: 3,
    }),
  },
  shopByCategoryPlaceholder: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#f3f3f3',
    borderWidth: 1,
    borderColor: '#ededed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shopByCategoryText: {
    marginTop: 7,
    fontSize: 9,
    lineHeight: 12,
    color: '#222',
    fontWeight: '800',
    textAlign: 'center',
  },
  feedLoadingWrap: {
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featuredBrandsWrap: {
    marginTop: -2,
    marginBottom: 16,
    width: '100%',
  },
  smallSectionHeader: {
    marginBottom: 10,
  },
  smallSectionTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#111',
  },
  smallSectionTitleMobile: {
    fontSize: 15,
  },
  featuredBrandsRow: {
    paddingRight: 12,
    gap: 12,
  },
  featuredBrandItem: {
    width: 74,
    alignItems: 'center',
  },
  featuredBrandImage: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#f3f3f3',
    borderWidth: 1,
    borderColor: '#ededed',
  },
  featuredBrandText: {
    marginTop: 6,
    fontSize: 10,
    lineHeight: 12,
    color: '#333',
    fontWeight: '700',
    textAlign: 'center',
  },
  heroCard: {
    width: '100%',
    height: 180,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#f6f0e8',
    marginBottom: 16,
  },
  heroCardMobile: {
    height: 124,
    borderRadius: 16,
    marginBottom: 10,
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,17,0.28)',
  },
  heroContent: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: 16,
  },
  heroChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.88)',
    marginBottom: 10,
  },
  heroChipText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#111',
    textTransform: 'uppercase',
  },
  heroTitle: {
    fontSize: 26,
    lineHeight: 30,
    fontWeight: '800',
    color: '#fff',
  },
  heroTitleMobile: {
    fontSize: 13,
    lineHeight: 16,
  },
  heroCopy: {
    marginTop: 6,
    fontSize: 14,
    color: 'rgba(255,255,255,0.9)',
    fontWeight: '600',
  },
  heroCopyMobile: {
    marginTop: 3,
    fontSize: 10,
    lineHeight: 12,
  },
  panelHeader: {
    width: '100%',
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  panelTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
  },
  panelTitleMobile: {
    fontSize: 14,
  },
  panelMeta: {
    fontSize: 13,
    color: '#8b8b90',
    fontWeight: '700',
  },
  panelMetaMobile: {
    fontSize: 10,
  },
  legacyCategoryGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  categoryGridMobile: {
    justifyContent: 'space-between',
  },
  categoryCard: {
    width: '33.33%',
    alignItems: 'center',
    marginBottom: 22,
    paddingHorizontal: 6,
  },
  categoryCardDesktop: {
    width: '33.33%',
  },
  categoryCardMobile: {
    width: '50%',
    marginBottom: 14,
    paddingHorizontal: 3,
  },
  categoryCardDisabled: {
    opacity: 0.78,
  },
  categoryThumbWrap: {
    width: 94,
    height: 94,
    borderRadius: 47,
    overflow: 'visible',
    backgroundColor: '#f3f3f3',
    marginBottom: 12,
    position: 'relative',
  },
  categoryThumbWrapMobile: {
    width: 64,
    height: 64,
    borderRadius: 32,
    marginBottom: 6,
  },
  categoryThumb: {
    width: '100%',
    height: '100%',
    borderRadius: 47,
  },
  categoryCardText: {
    fontSize: 14,
    lineHeight: 18,
    color: '#222',
    textAlign: 'center',
    fontWeight: '700',
  },
  categoryCardTextMobile: {
    fontSize: 10,
    lineHeight: 12,
  },
  trendingHeader: {
    marginTop: 8,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  trendingHeaderMobile: {
    marginTop: 14,
    marginBottom: 12,
  },
  trendingTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
  },
  trendingTitleMobile: {
    fontSize: 18,
    flex: 1,
    paddingRight: 8,
    fontWeight: '900',
  },
  trendingSort: {
    fontSize: 14,
    color: '#8a6a5a',
    fontWeight: '700',
  },
  trendingSortMobile: {
    fontSize: 12,
    lineHeight: 16,
  },
  trendingList: {
    width: '100%',
    gap: 10,
    backgroundColor: 'transparent',
  },
  trendingListMobile: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 16,
    columnGap: 0,
    backgroundColor: 'transparent',
  },
  fadeInCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  fadeInCardMobile: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ededed',
    padding: 10,
    paddingRight: 54,
    position: 'relative',
    ...platformShadow('0 4px 10px rgba(0,0,0,0.05)', {
        shadowColor: '#000',
        shadowOpacity: 0.05,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        elevation: 2,
    }),
  },
  productCardMobile: {
    width: '48.5%',
    minHeight: 0,
    padding: 0,
    paddingRight: 0,
    paddingBottom: 8,
    borderRadius: 14,
    borderWidth: 0,
    borderColor: '#f1e7dc',
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  productCartBubble: {
    position: 'absolute',
    top: -10,
    right: 8,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '10deg' }],
    ...platformShadow('0 3px 6px rgba(0,0,0,0.08)', {
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 3 },
        elevation: 3,
    }),
  },
  productCartBubbleMobile: {
    top: 78,
    right: 6,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    transform: [{ rotate: '0deg' }],
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  productCartBubbleInner: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  productCartBubblePlus: {
    position: 'absolute',
    top: 4,
    right: 3,
  },
  productImage: {
    width: 60,
    height: 60,
    borderRadius: 14,
    backgroundColor: '#eee',
  },
  productImageMobile: {
    width: '100%',
    height: undefined,
    aspectRatio: 1,
    borderRadius: 12,
    backgroundColor: '#f6f6f6',
  },
  productInfo: {
    flex: 1,
    marginLeft: 8,
  },
  productInfoMobile: {
    marginLeft: 0,
    marginTop: 7,
    paddingHorizontal: 2,
  },
  productTitle: {
    fontSize: 12,
    lineHeight: 16,
    color: '#111',
    fontWeight: '600',
  },
  productTitleMobile: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
  },
  productPrice: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '800',
    color: '#ff6a00',
  },
  productPriceMobile: {
    marginTop: 4,
    fontSize: 14,
    color: '#111',
  },
  popularBrandsWrap: {
    marginTop: 18,
    width: '100%',
  },
  popularBrandsGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  popularBrandsGridMobile: {
    rowGap: 8,
  },
  popularBrandCard: {
    width: '48.5%',
    minHeight: 78,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ededed',
    backgroundColor: '#fff',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  popularBrandCardMobile: {
    width: '100%',
    minHeight: 66,
    borderRadius: 16,
    padding: 8,
  },
  popularBrandImage: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#f3f3f3',
  },
  popularBrandText: {
    flex: 1,
    marginLeft: 10,
    fontSize: 13,
    lineHeight: 16,
    color: '#111',
    fontWeight: '800',
  },
  popularBrandTextMobile: {
    fontSize: 11,
    lineHeight: 14,
  },
  emptyWrap: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    color: '#777',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubText: {
    marginTop: 8,
    color: '#999',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
