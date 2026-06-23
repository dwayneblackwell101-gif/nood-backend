import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Image,
  Linking,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
  FlatList,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  Animated,
  DeviceEventEmitter,
  InteractionManager,
  ImageSourcePropType,
  Platform,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigationState } from '@react-navigation/native';
import { useFocusEffect, useNavigation, usePathname, useRouter } from 'expo-router';
import { VideoView, useVideoPlayer, type VideoSource } from 'expo-video';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { useCart } from '../../context/CartContext';
import NoodSpinner from '../../components/NoodSpinner';
import { BASE_CURRENCY } from '../../utils/currency';
import {
  catalogFetch,
  clearCatalogProductListCache,
  fetchHomeProductFeedPath,
  getHomeProductFeedSession,
  isHomeProductFeedSessionActive,
  startHomeProductFeedSession,
} from '../../utils/catalog';
import {
  buildBalancedHomeFeed,
  refreshBalancedHomeFeedProducts,
} from '../../utils/homeFeed';
import { buildProductRouteParams } from '../../utils/product-navigation';
import {
  LACE_FRONT_VIDEO_1,
  LACE_FRONT_VIDEO_2,
  LACE_FRONT_VIDEO_3,
  LACE_FRONT_VIDEO_4,
} from '../../assets/videos/homeVideos';

const HOME_PRODUCTS_CACHE_VERSION = 2;
const HOME_PRODUCTS_CACHE_KEY = 'NOOD_HOME_PRODUCTS_CACHE_V2';
const HOME_SHOWCASE_CACHE_KEY = 'NOOD_HOME_SHOWCASE_CACHE_V1';

const PRODUCTS_PER_PAGE = 48;
const HOME_SHOWCASE_PRODUCTS_PER_SECTION = 60;
const HOME_VISIBLE_PRODUCTS_STEP = 60;
const HOME_PROFILE_LOGS_ENABLED = __DEV__ && process.env.EXPO_PUBLIC_HOME_PERF_LOGS === '1';
const homeModuleStartedAt = getNow();
const SLIDESHOW_SLIDE_3_VIDEO = require('../../assets/videos/slideshow-slide-3.mp4');

const LACE_FRONT_VIDEOS = [
  { id: 'lace-front-1', assetId: LACE_FRONT_VIDEO_1 },
  { id: 'lace-front-2', assetId: LACE_FRONT_VIDEO_2 },
  { id: 'lace-front-3', assetId: LACE_FRONT_VIDEO_3 },
  { id: 'lace-front-4', assetId: LACE_FRONT_VIDEO_4 },
];

const HOME_PERF_INVESTIGATION_ENABLED = __DEV__;
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

const homePerfInvestigation = {
  homeScreenRenders: 0,
  productCardMounts: 0,
  categoryCardMounts: 0,
  videoMounts: 0,
  slideChanges: 0,
  homeListMounted: false,
  topHeaderMounted: false,
  scrollableHeaderMounted: false,
  heroMounted: false,
  firstVisibleAt: 0,
  homeScreenStartAt: 0,
};

const VIDEO_ASSET_FILE_NAMES: Record<number, string> = {
  [LACE_FRONT_VIDEO_1]: 'lace-front-1.mp4',
  [LACE_FRONT_VIDEO_2]: 'lace-front-2.mp4',
  [LACE_FRONT_VIDEO_3]: 'lace-front-3.mp4',
  [LACE_FRONT_VIDEO_4]: 'lace-front-4.mp4',
  [SLIDESHOW_SLIDE_3_VIDEO]: 'slideshow-slide-3.mp4',
};

const VIDEO_ASSET_SIZES_MB: Record<string, number> = {
  'lace-front-1.mp4': 9.07,
  'lace-front-2.mp4': 8.52,
  'lace-front-3.mp4': 2.84,
  'lace-front-4.mp4': 8.45,
  'slideshow-slide-3.mp4': 6.55,
};

function homeLog(message: string, data?: Record<string, unknown> | number) {
  if (!HOME_PERF_INVESTIGATION_ENABLED) return;

  if (typeof data === 'number') {
    console.log(message, data);
    return;
  }

  console.log(message, data ?? '');
}

function getVideoPerfMeta(assetId: number) {
  const fileName = VIDEO_ASSET_FILE_NAMES[assetId] || 'unknown';
  return {
    assetId,
    fileName,
    sizeMB: VIDEO_ASSET_SIZES_MB[fileName] ?? null,
  };
}

function logHomePerfInvestigationSummary(reason: string) {
  if (!HOME_PERF_INVESTIGATION_ENABLED) return;

  homeLog('[HOME PERF] investigation summary', {
    reason,
    homeScreenRenders: homePerfInvestigation.homeScreenRenders,
    productCardMounts: homePerfInvestigation.productCardMounts,
    categoryCardMounts: homePerfInvestigation.categoryCardMounts,
    videoMounts: homePerfInvestigation.videoMounts,
    slideChanges: homePerfInvestigation.slideChanges,
    firstVisibleAt: homePerfInvestigation.firstVisibleAt,
    elapsedSinceStartMs:
      homePerfInvestigation.firstVisibleAt > 0
        ? homePerfInvestigation.firstVisibleAt - homePerfInvestigation.homeScreenStartAt
        : null,
    videoAssetSizesMB: VIDEO_ASSET_SIZES_MB,
    androidListRemoveClippedSubviews: false,
    usesFlatListNotFlashList: true,
  });
}


type HomeHeroSlide = {
  id: string;
  type: 'image' | 'video' | 'updates';
  title: string;
  subtitle: string;
  imageUrl?: string;
  videoUrl?: VideoSource;
  posterSource?: ImageSourcePropType;
  posterUrl?: string;
};

type LoopedHomeHeroSlide = HomeHeroSlide & {
  loopKey: string;
  realIndex: number;
  isClone?: boolean;
};

// Add or replace your customer update slides here.
// For images: { id: 'your-id', type: 'image', imageUrl: 'https://your-image-url.jpg', title: 'Title', subtitle: 'Text' }
// For videos: { id: 'your-id', type: 'video', videoUrl: 'https://your-video-url.mp4', title: 'Title', subtitle: 'Text' }
const HOME_HERO_SLIDES: HomeHeroSlide[] = [
  {
    id: 'buy-more-pay-less-video',
    type: 'image',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/videoframe_0.png?v=1781905180',
    title: 'Buy More Pay Less',
    subtitle: '',
  },
  {
    id: 'customer-update-2',
    type: 'image',
    title: 'Buying in Hauls = More Savings',
    subtitle:
      'Order more together and save more on shipping. Bigger hauls help reduce the cost per item.',
  },
  {
    id: 'customer-update-3',
    type: 'video',
    videoUrl: SLIDESHOW_SLIDE_3_VIDEO,
    title: '',
    subtitle: '',
  },
  {
    id: 'rewards-update',
    type: 'updates',
    title: 'NOOD Inbox',
    subtitle: 'Deals, rewards, shipping notes, app changes, and sales updates live here.',
  },
];

const HERO_SLIDE_DURATION_MS = 12000;
const HERO_SLIDE_RESET_DELAY_MS = 650;
const SLIDE_3_SHOP_NOW_LINK = 'https://noodcaribbean.com/products/swatch-x-ap-royal-pop';
const HERO_VIDEO_POSTER_SOURCE = require('../../assets/images/nood-brand-logo.png');
const HERO_IMAGE_FALLBACK_SOURCE = require('../../assets/images/nood-brand-splash.png');
const REWARDS_HERO_SLIDE_INDEX = Math.max(
  0,
  HOME_HERO_SLIDES.findIndex((slide) => slide.id === 'rewards-update')
);
let homeHeroSlidesPrefetchPromise: Promise<unknown> | null = null;
let homeHeroSlidesPrefetched = false;

function getHomeHeroPrefetchUrls(slides: HomeHeroSlide[]) {
  return Array.from(
    new Set(
      slides
        .flatMap((slide) => [slide.imageUrl, slide.posterUrl])
        .filter((url): url is string => typeof url === 'string' && !!url.trim())
    )
  );
}

function prefetchHomeHeroSlides(slides: HomeHeroSlide[]) {
  if (homeHeroSlidesPrefetched) {
    return Promise.resolve();
  }

  if (homeHeroSlidesPrefetchPromise) {
    return homeHeroSlidesPrefetchPromise;
  }

  const urls = getHomeHeroPrefetchUrls(slides);
  console.log('HOME_SLIDES_PREFETCH_START', { count: urls.length });

  homeHeroSlidesPrefetchPromise = Promise.allSettled(
    urls.map((url) => ExpoImage.prefetch(url, 'memory-disk'))
  )
    .then((results) => {
      homeHeroSlidesPrefetched = true;
      console.log('HOME_SLIDES_PREFETCH_DONE', {
        loaded: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
      });
    })
    .catch((error) => {
      console.log('HOME_SLIDES_PREFETCH_DONE', { loaded: 0, failed: urls.length, error });
    });

  return homeHeroSlidesPrefetchPromise;
}

const HOT_BADGE_COLORS = [
  '#ff4d00',
  '#ff6a00',
  '#ff7a1a',
  '#ff8a00',
  '#ff5f1f',
  '#f25c05',
  '#ff3d00',
];

const webShadow = (value: string) => (Platform.OS === 'web' ? { boxShadow: value } : {});
const platformShadow = (webValue: string, nativeValue: object) =>
  Platform.OS === 'web' ? webShadow(webValue) : nativeValue;

const HOME_COLLECTION_TABS = [
  { title: 'Men', handle: 'clothing' },
  { title: 'Women', handle: 'women' },
  { title: 'Kids', handle: 'kids' },
  { title: 'Shoes', handle: 'shoes' },
  { title: 'Bags', handle: 'bags' },
  { title: 'Beauty', handle: 'beauty' },
  { title: 'Electronics', handle: 'electronics' },
  { title: 'Home', handle: 'home' },
  { title: 'Kitchen', handle: 'kitchen' },
  { title: 'Machinery', handle: 'machinery' },
  { title: 'Appliances', handle: 'appliances' },
  { title: 'Accessories', handle: 'accessories' },
  { title: 'Lace Front', handle: 'lacefront' },
];

const HOME_SHOWCASE_SECTIONS = [
  { title: 'Men', handle: 'clothing' },
  { title: 'Women', handle: 'women' },
  { title: 'Kids', handle: 'kids' },
  { title: 'Shoes', handle: 'shoes' },
  { title: 'Electronics', handle: 'electronics' },
];

type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  brand: string;
  category: string;
  description: string;
  tags: string[];
  image: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  price: string;
  oldPrice?: string | null;
  priceAmount: number;
  oldPriceAmount?: number | null;
  currencyCode: string;
  collectionHandle: string;
  collectionTitle?: string;
  collectionHandles?: string[];
  collectionTitles?: string[];
  availableForSale?: boolean;
  variantId?: string;
  variantTitle?: string;
};

type HomeProductsCache = {
  version: number;
  products: ShopifyProduct[];
  nextCursor: string | null;
  hasMore: boolean;
  mixKey?: number;
  savedAt?: string;
};

function isValidHomeProductsPagination(
  productCount: number,
  cursor: string | null,
  hasMore: boolean
): boolean {
  if (productCount <= 0) {
    return false;
  }

  if (productCount >= PRODUCTS_PER_PAGE && !cursor) {
    return false;
  }

  if (hasMore) {
    return Boolean(cursor);
  }

  return true;
}

function parseStoredHomeProductsCache(raw: string | null): {
  products: ShopifyProduct[];
  nextCursor: string | null;
  hasMore: boolean;
  mixKey: number | null;
} {
  if (!raw) {
    return { products: [], nextCursor: null, hasMore: false, mixKey: null };
  }

  try {
    const parsed = JSON.parse(raw) as ShopifyProduct[] | HomeProductsCache;

    if (Array.isArray(parsed)) {
      return {
        products: parsed,
        nextCursor: null,
        hasMore: false,
        mixKey: null,
      };
    }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.products)) {
      return {
        products: parsed.products,
        nextCursor: parsed.nextCursor ?? null,
        hasMore: Boolean(parsed.hasMore),
        mixKey: typeof parsed.mixKey === 'number' ? parsed.mixKey : null,
      };
    }
  } catch {
    return { products: [], nextCursor: null, hasMore: false, mixKey: null };
  }

  return { products: [], nextCursor: null, hasMore: false, mixKey: null };
}

type HomeShowcaseCache = Record<string, ShopifyProduct[]>;

type HomeSessionSnapshot = {
  allProducts: ShopifyProduct[];
  products: ShopifyProduct[];
  showcaseProducts: Record<string, ShopifyProduct[]>;
  nextProductsCursor: string | null;
  hasMoreProducts: boolean;
  hotBadgeSeed: number;
  visibleProductCount: number;
  scrollOffset: number;
};

let homeSessionSnapshot: HomeSessionSnapshot | null = null;

function isHomeTabPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/(tabs)' ||
    pathname === '/index' ||
    pathname === '/(tabs)/index'
  );
}

const COLLECTION_PRODUCTS_QUERY = `
  query CollectionProducts($handle: String!, $first: Int!) {
    collectionByHandle(handle: $handle) {
      products(first: $first, sortKey: MANUAL) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            description
            tags
            availableForSale
            featuredImage {
              url
              width
              height
            }
            priceRange {
              minVariantPrice {
                amount
                currencyCode
              }
            }
            compareAtPriceRange {
              maxVariantPrice {
                amount
                currencyCode
              }
            }
            collections(first: 10) {
              edges {
                node {
                  id
                  handle
                  title
                }
              }
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  title
                  availableForSale
                  quantityAvailable
                }
              }
            }
          }
        }
      }
    }
  }
`;

function formatMoney(amount?: string | null) {
  if (!amount) return '$0.00';
  return `$${Number(amount).toFixed(2)}`;
}

function shuffleArray<T>(array: T[]) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getShowcaseProductSignature(showcase: Record<string, ShopifyProduct[]>) {
  return Object.keys(showcase)
    .sort()
    .map((handle) => {
      const products = showcase[handle] || [];
      return `${handle}:${products.map((product) => product.id).join(',')}`;
    })
    .join('|');
}

function productMatchesSearch(product: ShopifyProduct, query: string) {
  const collectionLabel =
    HOME_COLLECTION_TABS.find((tab) => tab.handle === product.collectionHandle)?.title || '';
  const searchableText = [
    product.title,
    product.handle,
    product.brand,
    product.category,
    product.description,
    product.tags.join(' '),
    collectionLabel,
    product.collectionHandle,
    product.price,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => searchableText.includes(term));
}

function getOptimizedImageUrl(url?: string | null, width = 520) {
  if (!url) return 'https://via.placeholder.com/600x700.png?text=No+Image';

  try {
    const parsed = new URL(url);
    parsed.searchParams.set('width', String(width));
    return parsed.toString();
  } catch {
    return url;
  }
}

function getProductCategory(
  productType: string,
  collectionHandle: string,
  collectionTitles: string[]
) {
  return (
    productType ||
    collectionTitles[0] ||
    HOME_COLLECTION_TABS.find((tab) => tab.handle === collectionHandle)?.title ||
    collectionHandle ||
    ''
  );
}

function getNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

type HomePerfStore = {
  counts: Record<string, number>;
  totalRenderMs: Record<string, number>;
  slowRenders: { name: string; duration: number; detail?: string; at: number }[];
};

const homePerfStore: HomePerfStore = {
  counts: {},
  totalRenderMs: {},
  slowRenders: [],
};

function recordHomeRender(name: string, startedAt: number, detail?: string) {
  if (!HOME_PROFILE_LOGS_ENABLED) return;

  const duration = getNow() - startedAt;
  homePerfStore.counts[name] = (homePerfStore.counts[name] || 0) + 1;
  homePerfStore.totalRenderMs[name] =
    (homePerfStore.totalRenderMs[name] || 0) + duration;

  if (duration >= 8) {
    homePerfStore.slowRenders.push({
      name,
      duration,
      detail,
      at: Date.now(),
    });
    homePerfStore.slowRenders = homePerfStore.slowRenders
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 20);
  }

  const count = homePerfStore.counts[name];
  if (count === 1 || count % 25 === 0 || duration >= 16) {
    console.log(
      `[Home perf] render ${name} #${count}: ${duration.toFixed(2)}ms${detail ? ` ${detail}` : ''}`
    );
  }
}

function useHomeRenderCounter(name: string, detail?: string) {
  const startedAt = HOME_PROFILE_LOGS_ENABLED ? getNow() : 0;

  useEffect(() => {
    if (!HOME_PROFILE_LOGS_ENABLED) return;
    recordHomeRender(name, startedAt, detail);
  });
}

function logHomePerfSummary(reason: string) {
  if (!HOME_PROFILE_LOGS_ENABLED) return;

  const averages = Object.entries(homePerfStore.counts)
    .map(([name, count]) => ({
      name,
      count,
      avgMs: (homePerfStore.totalRenderMs[name] || 0) / count,
    }))
    .sort((a, b) => b.avgMs - a.avgMs);

  console.log(`[Home perf] summary: ${reason}`, {
    renderCounts: homePerfStore.counts,
    averageRenderMs: averages.slice(0, 10),
    slowestRenders: homePerfStore.slowRenders.slice(0, 10),
  });
}

function getRandomSeed() {
  return Math.floor(Math.random() * 1000000);
}

function getHotBadgeColor(key: string, seed: number) {
  let hash = seed;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return HOT_BADGE_COLORS[hash % HOT_BADGE_COLORS.length];
}

function shouldShowHotBadge(key: string, seed: number) {
  let hash = seed + 17;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  }
  return hash % 100 < 45;
}

type ProductCardProps = {
  item: ShopifyProduct;
  hotBadgeSeed: number;
  displayPrice: string;
  displayOldPrice?: string | null;
  onOpen: (item: ShopifyProduct) => void;
  onAddToCart: (item: ShopifyProduct) => void;
};

const ProductCard = React.memo(function ProductCard({
  item,
  hotBadgeSeed,
  displayPrice,
  displayOldPrice,
  onOpen,
  onAddToCart,
}: ProductCardProps) {
  useHomeRenderCounter('ProductCard', item.handle);
  const imageStartedAtRef = useRef(0);
  const showHotBadge = shouldShowHotBadge(item.id, hotBadgeSeed);

  useEffect(() => {
    if (!HOME_PERF_INVESTIGATION_ENABLED) return;

    homePerfInvestigation.productCardMounts += 1;
    homeLog('[HOME PERF] ProductCard mounted', {
      handle: item.handle,
      totalProductCardMounts: homePerfInvestigation.productCardMounts,
      time: perfNow(),
    });
  }, [item.handle]);

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.9}
      onPress={() => onOpen(item)}
    >
      <View style={styles.productImageWrap}>
        <ExpoImage
          source={{ uri: item.image }}
          style={styles.productImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={80}
          onLoadStart={() => {
            imageStartedAtRef.current = getNow();
          }}
          onLoad={(event) => {
            if (HOME_PROFILE_LOGS_ENABLED) {
              const duration = getNow() - imageStartedAtRef.current;
              console.log('[Home perf] ProductCard image loaded', {
                handle: item.handle,
                original: `${item.imageWidth ?? 'unknown'}x${item.imageHeight ?? 'unknown'}`,
                requestedUrl: item.image,
                loaded: event.source
                  ? `${event.source.width ?? 'unknown'}x${event.source.height ?? 'unknown'}`
                  : 'unknown',
                durationMs: duration.toFixed(1),
              });
            }
          }}
        />
        {showHotBadge ? (
          <View
            style={[
              styles.productHotBadge,
              { backgroundColor: getHotBadgeColor(item.id, hotBadgeSeed) },
            ]}
          >
            <Text style={styles.productHotBadgeText}>Hot</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.productTitle} numberOfLines={2}>
        {item.title}
      </Text>

      <View style={styles.priceRow}>
        <Text style={styles.productPrice}>{displayPrice}</Text>
        {displayOldPrice ? <Text style={styles.oldPrice}>{displayOldPrice}</Text> : null}
      </View>

      <View style={styles.cardBottomRow}>
        <Text style={styles.soldText}>Available now</Text>

        <TouchableOpacity
          style={styles.cartButton}
          onPress={(event) => {
            event.stopPropagation();
            onAddToCart(item);
          }}
        >
          <Ionicons name="cart-outline" size={18} color="#000" />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});

type CategoryCardProps = {
  item: ShopifyProduct;
  badgeKey: string;
  showHotBadge: boolean;
  hotBadgeSeed: number;
  displayPrice: string;
  onOpen: (item: ShopifyProduct) => void;
};

const CategoryCard = React.memo(function CategoryCard({
  item,
  badgeKey,
  showHotBadge,
  hotBadgeSeed,
  displayPrice,
  onOpen,
}: CategoryCardProps) {
  useHomeRenderCounter('CategoryCard', item.handle);

  useEffect(() => {
    if (!HOME_PERF_INVESTIGATION_ENABLED) return;

    homePerfInvestigation.categoryCardMounts += 1;
    homeLog('[HOME PERF] CategoryCard mounted', {
      handle: item.handle,
      totalCategoryCardMounts: homePerfInvestigation.categoryCardMounts,
      time: perfNow(),
    });
  }, [item.handle]);
  const imageStartedAtRef = useRef(0);

  return (
    <TouchableOpacity
      style={styles.collectionProductCard}
      activeOpacity={0.9}
      onPress={() => onOpen(item)}
    >
      <ExpoImage
        source={{ uri: item.image }}
        style={styles.collectionProductImage}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={80}
        onLoadStart={() => {
          imageStartedAtRef.current = getNow();
        }}
        onLoad={(event) => {
          if (HOME_PROFILE_LOGS_ENABLED) {
            const duration = getNow() - imageStartedAtRef.current;
            console.log('[Home perf] CategoryCard image loaded', {
              handle: item.handle,
              original: `${item.imageWidth ?? 'unknown'}x${item.imageHeight ?? 'unknown'}`,
              requestedUrl: item.image,
              loaded: event.source
                ? `${event.source.width ?? 'unknown'}x${event.source.height ?? 'unknown'}`
                : 'unknown',
              durationMs: duration.toFixed(1),
            });
          }
        }}
      />
      {showHotBadge ? (
        <View
          style={[
            styles.collectionHotBadge,
            { backgroundColor: getHotBadgeColor(badgeKey, hotBadgeSeed) },
          ]}
        >
          <Text style={styles.collectionHotBadgeText}>Hot</Text>
        </View>
      ) : null}
      <Text style={styles.collectionProductTitle} numberOfLines={2}>
        {item.title}
      </Text>
      <Text style={styles.collectionProductPrice}>{displayPrice}</Text>
    </TouchableOpacity>
  );
});

const Banner = React.memo(function Banner() {
  useHomeRenderCounter('Banner', 'safe-payments');

  return (
    <View style={styles.safeBar}>
      <Text style={styles.safeBarText}>
        Safe payments • Secure privacy • Fast checkout
      </Text>
    </View>
  );
});

type VideoCardProps = {
  uri: VideoSource;
  index: number;
};

const VideoCard = React.memo(function VideoCard({ uri, index }: VideoCardProps) {
  if (Platform.OS !== 'web' && typeof uri === 'string') {
    return <MobileVideoCard uri={uri} />;
  }

  return <WebExpoVideoCard uri={uri} index={index} />;
});

const MobileVideoCard = React.memo(function MobileVideoCard({ uri }: Pick<VideoCardProps, 'uri'>) {
  const html = useMemo(
    () => `<!doctype html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
          <style>
            html, body {
              margin: 0;
              padding: 0;
              width: 100%;
              height: 100%;
              overflow: hidden;
              background: #ededed;
            }
            video {
              width: 100%;
              height: 100%;
              object-fit: cover;
              display: block;
              background: #ededed;
            }
          </style>
        </head>
        <body>
          <video src="${uri}" autoplay muted loop playsinline webkit-playsinline preload="auto"></video>
          <script>
            const video = document.querySelector('video');
            video.muted = true;
            video.defaultMuted = true;
            video.playsInline = true;
            const play = () => video.play().catch(() => {});
            video.addEventListener('loadedmetadata', play);
            video.addEventListener('canplay', play);
            document.addEventListener('visibilitychange', () => {
              if (document.hidden) {
                video.pause();
              } else {
                play();
              }
            });
            play();
            setTimeout(play, 300);
            setTimeout(play, 1000);
            setTimeout(play, 2000);
          </script>
        </body>
      </html>`,
    [uri]
  );

  return (
    <View style={styles.videoCard}>
      <WebView
        key={`home-mobile-video-${uri}`}
        source={{ html, baseUrl: 'https://cdn.shopify.com' }}
        style={styles.videoCardMedia}
        originWhitelist={['*']}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        allowsFullscreenVideo={false}
        setSupportMultipleWindows={false}
        mixedContentMode="always"
        androidLayerType="hardware"
      />
    </View>
  );
});

const WebExpoVideoCard = React.memo(function WebExpoVideoCard({ uri, index }: VideoCardProps) {
  useHomeRenderCounter('VideoCard', `index=${index}`);
  const videoSource = useMemo(() => uri, [uri]);
  const player = useVideoPlayer(videoSource, (videoPlayer) => {
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.volume = 0;
    videoPlayer.audioMixingMode = 'mixWithOthers';
    videoPlayer.staysActiveInBackground = false;
    videoPlayer.keepScreenOnWhilePlaying = false;
    videoPlayer.currentTime = 0;
    try {
      videoPlayer.play();
    } catch {
      // The view may not be attached yet on mobile; effects retry playback.
    }
  });

  useEffect(() => {
    if (HOME_PROFILE_LOGS_ENABLED) {
      console.log(`[Home perf] VideoCard mounted index=${index}`);
    }

    const play = () => {
      try {
        player.muted = true;
        player.volume = 0;
        player.audioMixingMode = 'mixWithOthers';
        player.loop = true;
        player.keepScreenOnWhilePlaying = false;
        player.play();
      } catch {
        // The player may already be releasing during a fast refresh/unmount.
      }
    };

    const sourceLoadSubscription = player.addListener('sourceLoad', play);
    const statusSubscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay') {
        play();
      }
    });

    const playFrame = requestAnimationFrame(play);
    const playTimerOne = setTimeout(play, 350);
    const playTimerTwo = setTimeout(play, 1000);
    const playTimerThree = setTimeout(play, 1800);

    return () => {
      cancelAnimationFrame(playFrame);
      clearTimeout(playTimerOne);
      clearTimeout(playTimerTwo);
      clearTimeout(playTimerThree);
      sourceLoadSubscription.remove();
      statusSubscription.remove();

      try {
        player.pause();
      } catch {
        // The expo-video hook releases the player during unmount.
      }

      if (HOME_PROFILE_LOGS_ENABLED) {
        console.log(`[Home perf] VideoCard unmounted index=${index}`);
      }
    };
  }, [index, player]);

  useFocusEffect(
    useCallback(() => {
      const play = () => {
        try {
          player.muted = true;
          player.volume = 0;
          player.audioMixingMode = 'mixWithOthers';
          player.loop = true;
          player.keepScreenOnWhilePlaying = false;
          player.play();
        } catch {
          // Ignore if the native player is between mount states.
        }
      };

      play();
      const playTimerOne = setTimeout(play, 450);
      const playTimerTwo = setTimeout(play, 1200);
      const playTimerThree = setTimeout(play, 2200);

      return () => {
        clearTimeout(playTimerOne);
        clearTimeout(playTimerTwo);
        clearTimeout(playTimerThree);
        try {
          player.pause();
        } catch {
          // Ignore if the native player has already released.
        }
      };
    }, [player])
  );

  return (
    <View style={styles.videoCard}>
      <VideoView
        key={`home-video-view-${index}-${uri}`}
        player={player}
        style={styles.videoCardMedia}
        nativeControls={false}
        contentFit="cover"
        fullscreenOptions={{ enable: false }}
        surfaceType="textureView"
        allowsPictureInPicture={false}
        startsPictureInPictureAutomatically={false}
        onFirstFrameRender={() => {
          try {
            player.keepScreenOnWhilePlaying = false;
            player.play();
          } catch {
            // Ignore transient native state.
          }
        }}
      />
    </View>
  );
});

type LaceFrontVideoCardProps = {
  assetId: number;
};

function LaceFrontVideoCard({ assetId }: LaceFrontVideoCardProps) {
  const videoMeta = getVideoPerfMeta(assetId);
  const mountAtRef = useRef(perfNow());
  const playerCreatedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!HOME_PERF_INVESTIGATION_ENABLED) return;

    homePerfInvestigation.videoMounts += 1;
    homeLog('[HOME PERF] video mounted', {
      id: videoMeta.fileName,
      ...videoMeta,
      time: mountAtRef.current,
      totalVideoMounts: homePerfInvestigation.videoMounts,
      surfaceType: Platform.OS === 'android' ? 'textureView' : 'default',
    });
  }, [assetId]);

  const player = useVideoPlayer(assetId, (videoPlayer) => {
    playerCreatedAtRef.current = perfNow();
    homeLog('[HOME PERF] video player created', {
      id: videoMeta.fileName,
      ...videoMeta,
      time: playerCreatedAtRef.current,
      sinceMountMs: playerCreatedAtRef.current - mountAtRef.current,
    });
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.play();
  });

  useEffect(() => {
    const sourceLoadSubscription = player.addListener('sourceLoad', () => {
      homeLog('[HOME PERF] video source loaded', {
        id: videoMeta.fileName,
        time: perfNow(),
      });
    });
    const statusSubscription = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'readyToPlay') {
        homeLog('[HOME PERF] video ready', {
          id: videoMeta.fileName,
          time: perfNow(),
        });
      }

      if (status === 'error') {
        homeLog('[HOME PERF] video error', {
          id: videoMeta.fileName,
          time: perfNow(),
          error,
        });
      }
    });

    return () => {
      sourceLoadSubscription.remove();
      statusSubscription.remove();
    };
  }, [player, videoMeta.fileName]);

  return (
    <View style={styles.laceFrontVideoCard}>
      <VideoView
        player={player}
        style={styles.laceFrontVideo}
        nativeControls={false}
        contentFit="cover"
        surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
        onFirstFrameRender={() => {
          homeLog('[HOME PERF] video first frame', {
            id: videoMeta.fileName,
            time: perfNow(),
            sinceMountMs: perfNow() - mountAtRef.current,
          });
        }}
      />
    </View>
  );
}

function LaceFrontVideoSection() {
  const router = useRouter();

  const goToLaceFrontCollection = () => {
    router.push({
      pathname: '/collection/[handle]',
      params: { handle: 'lacefront', from: 'home' },
    });
  };

  return (
    <View style={styles.laceFrontSection}>
      <Text style={styles.laceFrontTitle}>Lace Front</Text>

      <View style={styles.laceFrontGrid}>
        {LACE_FRONT_VIDEOS.map((video) => (
          <LaceFrontVideoCard key={video.id} assetId={video.assetId} />
        ))}
      </View>

      <Pressable style={styles.laceFrontButton} onPress={goToLaceFrontCollection}>
        <Text style={styles.laceFrontButtonText}>See More</Text>
      </Pressable>
    </View>
  );
}

type HeroVideoSlideProps = {
  uri: VideoSource;
  isActive: boolean;
  posterSource?: ImageSourcePropType;
  onReady?: () => void;
};

const HeroVideoSlide = React.memo(function HeroVideoSlide({
  uri,
  isActive,
  posterSource,
  onReady,
}: HeroVideoSlideProps) {
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const reportedReadyRef = useRef(false);
  const mountAtRef = useRef(perfNow());
  const videoId =
    typeof uri === 'number'
      ? VIDEO_ASSET_FILE_NAMES[uri] || `asset-${uri}`
      : 'slideshow-hero-video';

  useEffect(() => {
    if (!HOME_PERF_INVESTIGATION_ENABLED) return;

    homePerfInvestigation.videoMounts += 1;
    homeLog('[HOME PERF] video mounted', {
      id: videoId,
      isActive,
      ...(typeof uri === 'number' ? getVideoPerfMeta(uri) : { assetId: null, fileName: videoId }),
      time: mountAtRef.current,
      totalVideoMounts: homePerfInvestigation.videoMounts,
      surfaceType: 'default',
    });
  }, [isActive, uri, videoId]);

  const player = useVideoPlayer(uri, (videoPlayer) => {
    const createdAt = perfNow();
    homeLog('[HOME PERF] video player created', {
      id: videoId,
      isActive,
      time: createdAt,
      sinceMountMs: createdAt - mountAtRef.current,
    });
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.volume = 0;
    videoPlayer.audioMixingMode = 'mixWithOthers';
    videoPlayer.staysActiveInBackground = false;
    videoPlayer.keepScreenOnWhilePlaying = false;
  });

  useEffect(() => {
    setHasFirstFrame(false);
    reportedReadyRef.current = false;
  }, [uri]);

  useEffect(() => {
    const sourceLoadSubscription = player.addListener('sourceLoad', () => {
      console.log('HOME_SLIDE_MEDIA_LOADED', { type: 'video-source', uri });
      homeLog('[HOME PERF] video source loaded', { id: videoId, isActive, time: perfNow() });
    });
    const statusSubscription = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'readyToPlay') {
        console.log('HOME_SLIDE_MEDIA_LOADED', { type: 'video-ready', uri });
        homeLog('[HOME PERF] video ready', { id: videoId, isActive, time: perfNow() });
      }

      if (status === 'error') {
        console.log('HOME_SLIDE_MEDIA_ERROR', { type: 'video', uri, error });
        homeLog('[HOME PERF] video error', { id: videoId, isActive, time: perfNow(), error });
        if (!reportedReadyRef.current) {
          reportedReadyRef.current = true;
          onReady?.();
        }
      }
    });

    return () => {
      sourceLoadSubscription.remove();
      statusSubscription.remove();
    };
  }, [isActive, onReady, player, uri, videoId]);

  useEffect(() => {
    const play = () => {
      if (!isActive) return;

      try {
        player.muted = true;
        player.volume = 0;
        player.loop = true;
        player.keepScreenOnWhilePlaying = false;
        player.play();
      } catch {
        // Ignore if player is not ready yet.
      }
    };

    const playFrame = requestAnimationFrame(play);
    const playTimerOne = setTimeout(play, 350);
    const playTimerTwo = setTimeout(play, 1200);

    if (!isActive) {
      try {
        player.pause();
      } catch {
        // Ignore if player is not ready yet.
      }
    }

    return () => {
      cancelAnimationFrame(playFrame);
      clearTimeout(playTimerOne);
      clearTimeout(playTimerTwo);
      try {
        player.pause();
      } catch {
        // Ignore release state.
      }
    };
  }, [isActive, player]);

  return (
    <View style={styles.heroSlideMedia}>
      <VideoView
        player={player}
        style={styles.heroSlideMedia}
        nativeControls={false}
        contentFit="cover"
        fullscreenOptions={{ enable: false }}
        allowsPictureInPicture={false}
        startsPictureInPictureAutomatically={false}
        onFirstFrameRender={() => {
          console.log('HOME_SLIDE_MEDIA_LOADED', { type: 'video-first-frame', uri });
          homeLog('[HOME PERF] video first frame', {
            id: videoId,
            isActive,
            time: perfNow(),
            sinceMountMs: perfNow() - mountAtRef.current,
          });
          setHasFirstFrame(true);
          if (!reportedReadyRef.current) {
            reportedReadyRef.current = true;
            onReady?.();
          }
          if (isActive) {
            try {
              player.play();
            } catch {
              // Ignore transient native state.
            }
          }
        }}
      />
      {!hasFirstFrame ? (
        posterSource ? (
          <ExpoImage
            source={posterSource}
            style={[styles.heroVideoPoster, styles.heroVideoPosterNoPointer as any]}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={0}
          />
        ) : (
          <View style={[styles.heroVideoPosterFallback, styles.heroVideoPosterNoPointer]} />
        )
      ) : null}
    </View>
  );
});

type HaulSavingsSlideProps = {
  title: string;
  subtitle: string;
  onReady?: () => void;
};

const HaulSavingsSlide = React.memo(function HaulSavingsSlide({
  title,
  subtitle,
  onReady,
}: HaulSavingsSlideProps) {
  useEffect(() => {
    onReady?.();
  }, [onReady]);

  return (
    <LinearGradient
      colors={['#b83a00', '#dc5a06', '#ff7a12']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.haulSlide}
    >
      <View style={styles.haulGlowTop} />
      <View style={styles.haulGlowBottom} />
      <View style={styles.haulDotCluster}>
        {Array.from({ length: 12 }).map((_, index) => (
          <View key={`haul-dot-${index}`} style={styles.haulTinyDot} />
        ))}
      </View>

      <View style={styles.haulTextColumn}>
        <Text style={styles.haulTitle} numberOfLines={4} adjustsFontSizeToFit minimumFontScale={0.78}>
          {title}
        </Text>
        <View style={styles.haulAccentLine} />
        <Text style={styles.haulSubtitle} numberOfLines={5} adjustsFontSizeToFit minimumFontScale={0.86}>
          {subtitle}
        </Text>
      </View>

      <View style={styles.haulVisualColumn} pointerEvents="none">
        <View style={styles.haulSavingsBadge}>
          <Ionicons name="pricetag" size={28} color="#ff6a00" />
          <Text style={styles.haulSavingsBadgeText}>%</Text>
        </View>
        <View style={[styles.haulSparkle, styles.haulSparkleOne]} />
        <View style={[styles.haulSparkle, styles.haulSparkleTwo]} />
        <View style={styles.haulBoxStack}>
          <View style={[styles.haulBox, styles.haulBoxSmall]}>
            <View style={styles.haulBoxTape} />
            <Text style={styles.haulBoxLogo}>nood</Text>
          </View>
          <View style={[styles.haulBox, styles.haulBoxMedium]}>
            <View style={styles.haulBoxTape} />
            <Text style={styles.haulBoxLogo}>nood</Text>
          </View>
          <View style={[styles.haulBox, styles.haulBoxLarge]}>
            <View style={styles.haulBoxTape} />
            <Text style={styles.haulBoxLogo}>nood</Text>
          </View>
        </View>
        <View style={styles.haulBagLarge}>
          <View style={styles.haulBagHandle} />
          <Text style={styles.haulBagLogo}>nood</Text>
        </View>
        <View style={styles.haulBagSmall}>
          <View style={styles.haulBagHandleSmall} />
          <Text style={styles.haulBagSmallLogo}>nood</Text>
        </View>
      </View>
    </LinearGradient>
  );
});

type HeroSlideItemProps = {
  slide: LoopedHomeHeroSlide;
  index: number;
  width: number;
  activePhysicalIndex: number;
  onOpenUpdates: () => void;
  onOpenSlide3ShopNow: () => void;
  onMediaReady?: (index: number) => void;
};

type HeroImageSlideProps = {
  uri: string;
  posterUrl?: string;
  onReady?: () => void;
};

const HeroImageSlide = React.memo(function HeroImageSlide({
  uri,
  posterUrl,
  onReady,
}: HeroImageSlideProps) {
  const [hasError, setHasError] = useState(false);
  const reportedReadyRef = useRef(false);

  useEffect(() => {
    setHasError(false);
    reportedReadyRef.current = false;
  }, [uri]);

  const reportReady = useCallback(() => {
    if (reportedReadyRef.current) return;

    reportedReadyRef.current = true;
    onReady?.();
  }, [onReady]);

  return (
    <View style={styles.heroSlideMedia}>
      {posterUrl ? (
        <ExpoImage
          source={{ uri: posterUrl }}
          style={styles.heroImagePoster}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={0}
          onLoad={() => {
            console.log('HOME_SLIDE_MEDIA_LOADED', { type: 'poster', uri: posterUrl });
          }}
          onError={(error) => {
            console.log('HOME_SLIDE_MEDIA_ERROR', { type: 'poster', uri: posterUrl, error });
          }}
        />
      ) : (
        <ExpoImage
          source={HERO_IMAGE_FALLBACK_SOURCE}
          style={styles.heroImagePoster}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={0}
        />
      )}

      {!hasError ? (
        <ExpoImage
          source={{ uri }}
          style={styles.heroSlideMedia}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={120}
          onLoad={() => {
            console.log('HOME_SLIDE_MEDIA_LOADED', { type: 'image', uri });
            reportReady();
          }}
          onError={(error) => {
            console.log('HOME_SLIDE_MEDIA_ERROR', { type: 'image', uri, error });
            setHasError(true);
            reportReady();
          }}
        />
      ) : null}
    </View>
  );
});

function heroSlideItemPropsAreEqual(
  prev: HeroSlideItemProps,
  next: HeroSlideItemProps
) {
  if (prev.slide.loopKey !== next.slide.loopKey) return false;
  if (prev.index !== next.index) return false;
  if (prev.width !== next.width) return false;

  const prevIsNearActive = Math.abs(prev.index - prev.activePhysicalIndex) <= 1;
  const nextIsNearActive = Math.abs(next.index - next.activePhysicalIndex) <= 1;
  if (prevIsNearActive !== nextIsNearActive) return false;

  const prevIsActive = prev.index === prev.activePhysicalIndex;
  const nextIsActive = next.index === next.activePhysicalIndex;
  if (prevIsNearActive && prevIsActive !== nextIsActive) return false;

  return true;
}

const HeroSlideItem = React.memo(function HeroSlideItem({
  slide,
  index,
  width,
  activePhysicalIndex,
  onOpenUpdates,
  onOpenSlide3ShopNow,
  onMediaReady,
}: HeroSlideItemProps) {
  const isActive = index === activePhysicalIndex;
  const isNearActive = Math.abs(index - activePhysicalIndex) <= 1;

  useEffect(() => {
    if (!HOME_PERF_INVESTIGATION_ENABLED) return;

    homeLog('[HOME PERF] hero slide item render', {
      slideId: slide.id,
      index,
      isActive,
      isNearActive,
      time: perfNow(),
    });
  });

  return (
    <View style={[styles.heroSlide, { width: width || 1 }]}>
      {slide.type === 'updates' ? (
        isNearActive ? (
          <HeroUpdatesSlide onOpenUpdates={onOpenUpdates} />
        ) : (
          <View style={styles.heroSlideFallback} />
        )
      ) : slide.id === 'customer-update-2' ? (
        isNearActive ? (
          <HaulSavingsSlide
            title={slide.title}
            subtitle={slide.subtitle}
            onReady={() => onMediaReady?.(index)}
          />
        ) : (
          <View style={styles.heroSlideFallback} />
        )
      ) : (
        <>
          {slide.type === 'video' && slide.videoUrl ? (
            isNearActive ? (
              <HeroVideoSlide
                uri={slide.videoUrl}
                isActive={isActive}
                posterSource={slide.posterSource ?? HERO_VIDEO_POSTER_SOURCE}
                onReady={() => onMediaReady?.(index)}
              />
            ) : (
              <View style={styles.heroSlideMedia}>
                <ExpoImage
                  source={slide.posterSource ?? HERO_VIDEO_POSTER_SOURCE}
                  style={styles.heroSlideMedia}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={0}
                />
              </View>
            )
          ) : slide.imageUrl ? (
            <HeroImageSlide
              uri={slide.imageUrl}
              posterUrl={slide.posterUrl ?? slide.imageUrl}
              onReady={() => onMediaReady?.(index)}
            />
          ) : (
            <View style={styles.heroSlideFallback} />
          )}

          <View style={styles.heroSlideOverlay}>
            {slide.id === 'customer-update-3' ? (
              <TouchableOpacity
                style={styles.heroShopNowButton}
                activeOpacity={0.9}
                onPress={onOpenSlide3ShopNow}
              >
                <Text style={styles.heroShopNowButtonText}>Shop Now</Text>
              </TouchableOpacity>
            ) : (
              <>
                {slide.title ? <Text style={styles.heroSlideTitle}>{slide.title}</Text> : null}
                {slide.subtitle ? (
                  <Text style={styles.heroSlideSubtitle}>{slide.subtitle}</Text>
                ) : null}
              </>
            )}
          </View>
        </>
      )}
    </View>
  );
}, heroSlideItemPropsAreEqual);

type HeroDotsProps = {
  slides: HomeHeroSlide[];
  activeIndex: number;
};

const HeroDots = React.memo(function HeroDots({ slides, activeIndex }: HeroDotsProps) {
  return (
    <View style={styles.heroDotsRow}>
      {slides.map((slide, index) => (
        <View
          key={`hero-dot-${slide.id}`}
          style={[styles.heroDot, activeIndex === index && styles.heroDotActive]}
        />
      ))}
    </View>
  );
});


type HeroUpdateItem = {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  time: string;
  action: string;
  tint: string;
};

const HERO_UPDATE_ITEMS: HeroUpdateItem[] = [
  {
    id: 'deals',
    label: 'Deal',
    icon: 'pricetag-outline',
    title: 'New deals just dropped',
    body: "Check out today's best prices before they're gone.",
    time: 'Live now',
    action: 'View deals →',
    tint: '#ff6a00',
  },
  {
    id: 'reward',
    label: 'Reward',
    icon: 'gift-outline',
    title: 'Lucky Spin is live',
    body: 'Win small locked rewards and unlock them with qualifying spend.',
    time: 'Updated today',
    action: 'View rewards →',
    tint: '#6a2cff',
  },
  {
    id: 'shipping',
    label: 'Shipping',
    icon: 'cube-outline',
    title: 'Shipping updates in Orders',
    body: 'Track packages from your Orders page using your tracking number.',
    time: 'Updated today',
    action: 'Track order →',
    tint: '#1686d9',
  },
  {
    id: 'arrival',
    label: 'New Arrival',
    icon: 'bag-handle-outline',
    title: 'New arrivals added',
    body: 'Fresh products are being added across NOOD collections.',
    time: 'Recently added',
    action: 'Shop now →',
    tint: '#ff8a00',
  },
  {
    id: 'app-update',
    label: 'App Update',
    icon: 'sparkles-outline',
    title: 'Address book upgraded',
    body: 'Save multiple addresses and choose your default shipping address.',
    time: 'App update',
    action: 'Open address →',
    tint: '#6a2cff',
  },
  {
    id: 'coupon',
    label: 'Coupon',
    icon: 'ticket-outline',
    title: 'Automatic discount reminder',
    body: 'Add 3 or more items to unlock automatic discounts when available.',
    time: 'Reminder',
    action: 'Open cart →',
    tint: '#ff6a00',
  },
];

type HeroUpdatesSlideProps = {
  onOpenUpdates: () => void;
};

const HeroUpdatesSlide = React.memo(function HeroUpdatesSlide({
  onOpenUpdates,
}: HeroUpdatesSlideProps) {
  return (
    <View style={styles.heroUpdatesSlide}>
      <TouchableOpacity
        style={styles.heroUpdatesHeader}
        activeOpacity={0.98}
        onPress={onOpenUpdates}
      >
        <View style={styles.heroUpdatesBell}>
          <Ionicons name="notifications-outline" size={20} color="#fff" />
        </View>
        <View style={styles.heroUpdatesHeaderTextWrap}>
          <Text style={styles.heroUpdatesTitle}>NOOD Inbox</Text>
          <Text style={styles.heroUpdatesSubtitle}>
            Deals, rewards, shipping notes, app changes, and sales updates live here.
          </Text>
        </View>
        <View style={styles.heroUpdatesCountBadge}>
          <Text style={styles.heroUpdatesCountText}>6 new</Text>
        </View>
      </TouchableOpacity>

      <ScrollView
        style={styles.heroUpdatesList}
        contentContainerStyle={styles.heroUpdatesListContent}
        nestedScrollEnabled={true}
        showsVerticalScrollIndicator={false}
        bounces
      >
        {HERO_UPDATE_ITEMS.map((item) => (
          <View key={item.id} style={styles.heroUpdateCard}>
            <View style={[styles.heroUpdateIconWrap, { backgroundColor: `${item.tint}12` }]}>
              <Ionicons name={item.icon} size={23} color={item.tint} />
            </View>

            <View style={styles.heroUpdateContent}>
              <View style={[styles.heroUpdateLabel, { backgroundColor: `${item.tint}14` }]}>
                <Text style={[styles.heroUpdateLabelText, { color: item.tint }]}>
                  {item.label}
                </Text>
              </View>
              <Text style={styles.heroUpdateTitle}>{item.title}</Text>
              <Text style={styles.heroUpdateBody}>{item.body}</Text>
              <Text style={styles.heroUpdateTime}>{item.time}</Text>
              <Text style={[styles.heroUpdateAction, { color: item.tint }]}>{item.action}</Text>
            </View>

            <View style={[styles.heroUpdateDot, { backgroundColor: item.tint }]} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
});

type HeroSlideshowProps = {
  requestedSlideIndex?: number | null;
  requestedSlideKey?: number;
};

const HomeSlideshow = React.memo(function HomeSlideshow({
  requestedSlideIndex = null,
  requestedSlideKey = 0,
}: HeroSlideshowProps) {
  useHomeRenderCounter('HomeSlideshow');
  useLayoutEffect(() => {
    if (homePerfInvestigation.heroMounted) return;

    homePerfInvestigation.heroMounted = true;
    homeLog('[HOME PERF] hero mounted', perfNow());
    homeLog('[HOME PERF] hero slideshow config', {
      loopedSlideCount: HOME_HERO_SLIDES.length + 2,
      initialNumToRender: 3,
      windowSize: 3,
      lazyVideoMount: true,
      removeClippedSubviews: false,
      time: perfNow(),
    });
  }, []);
  const sliderRef = useRef<FlatList<LoopedHomeHeroSlide> | null>(null);
  const router = useRouter();
  const activeIndexRef = useRef(0);
  const activePhysicalIndexRef = useRef(1);
  const autoplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef = useRef(false);
  const isFocusedRef = useRef(true);
  const firstSlideReadyRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activePhysicalIndex, setActivePhysicalIndex] = useState(1);
  const [sliderWidth, setSliderWidth] = useState(0);
  const [firstSlideReady, setFirstSlideReady] = useState(false);
  const heroSlides = useMemo(() => HOME_HERO_SLIDES, []);
  const loopedHeroSlides = useMemo<LoopedHomeHeroSlide[]>(() => {
    if (!heroSlides.length) return [];

    const lastSlide = heroSlides[heroSlides.length - 1];
    const firstSlide = heroSlides[0];
    const realSlides = heroSlides.map((slide, index) => ({
      ...slide,
      loopKey: `real-${slide.id}-${index}`,
      realIndex: index,
    }));

    return [
      {
        ...lastSlide,
        loopKey: `clone-start-${lastSlide.id}`,
        realIndex: heroSlides.length - 1,
        isClone: true,
      },
      ...realSlides,
      {
        ...firstSlide,
        loopKey: `clone-end-${firstSlide.id}`,
        realIndex: 0,
        isClone: true,
      },
    ];
  }, [heroSlides]);
  const physicalFirstIndex = 1;
  const physicalLastIndex = heroSlides.length;
  const physicalEndCloneIndex = heroSlides.length + 1;

  const openSlide3ShopNow = useCallback(() => {
    const link = SLIDE_3_SHOP_NOW_LINK.trim();

    if (!link) {
      Alert.alert('Shop Now', 'Send the link and I will connect this button.');
      return;
    }

    if (link.startsWith('http://') || link.startsWith('https://')) {
      void Linking.openURL(link);
      return;
    }

    router.push(link as any);
  }, [router]);

  const openUpdatesPage = useCallback(() => {
    router.push('/account/updates' as any);
  }, [router]);

  const clearAutoplayTimer = useCallback(() => {
    if (autoplayTimerRef.current) {
      clearTimeout(autoplayTimerRef.current);
      autoplayTimerRef.current = null;
    }
  }, []);

  const clearLoopResetTimer = useCallback(() => {
    if (loopResetTimerRef.current) {
      clearTimeout(loopResetTimerRef.current);
      loopResetTimerRef.current = null;
    }
  }, []);

  const setActiveIndexes = useCallback((nextIndex: number, nextPhysicalIndex = nextIndex) => {
    activeIndexRef.current = nextIndex;
    activePhysicalIndexRef.current = nextPhysicalIndex;
    setActiveIndex((currentIndex) => (currentIndex === nextIndex ? currentIndex : nextIndex));
    setActivePhysicalIndex((currentIndex) =>
      currentIndex === nextPhysicalIndex ? currentIndex : nextPhysicalIndex
    );
    homePerfInvestigation.slideChanges += 1;
    homeLog('[HOME PERF] slide changed', {
      index: nextIndex,
      physicalIndex: nextPhysicalIndex,
      slideChanges: homePerfInvestigation.slideChanges,
      time: perfNow(),
    });
  }, []);

  const scrollToSlide = useCallback(
    (index: number, animated: boolean) => {
      if (!sliderWidth) return;

      sliderRef.current?.scrollToIndex({
        index,
        animated,
      });
    },
    [sliderWidth]
  );

  const scheduleAutoplay = useCallback(() => {
    clearAutoplayTimer();

    if (
      !isFocusedRef.current ||
      !firstSlideReadyRef.current ||
      isDraggingRef.current ||
      !sliderWidth ||
      heroSlides.length <= 1
    ) {
      return;
    }

    autoplayTimerRef.current = setTimeout(() => {
      const nextPhysicalIndex = activePhysicalIndexRef.current + 1;
      scrollToSlide(nextPhysicalIndex, true);

      const nextLogicalIndex =
        nextPhysicalIndex === physicalEndCloneIndex ? 0 : nextPhysicalIndex - 1;
      setActiveIndexes(nextLogicalIndex, nextPhysicalIndex);
      scheduleAutoplay();
    }, HERO_SLIDE_DURATION_MS);
  }, [
    clearAutoplayTimer,
    heroSlides.length,
    physicalEndCloneIndex,
    scrollToSlide,
    setActiveIndexes,
    sliderWidth,
  ]);

  useEffect(() => {
    let mounted = true;

    void prefetchHomeHeroSlides(heroSlides).finally(() => {
      if (mounted && homeHeroSlidesPrefetched && firstSlideReadyRef.current) {
        scheduleAutoplay();
      }
    });

    return () => {
      mounted = false;
    };
  }, [heroSlides, scheduleAutoplay]);

  const handleMediaReady = useCallback(
    (index: number) => {
      console.log('HOME_SLIDE_MEDIA_LOADED', { physicalIndex: index });
      if (index !== physicalFirstIndex || firstSlideReadyRef.current) return;

      firstSlideReadyRef.current = true;
      setFirstSlideReady(true);
      scheduleAutoplay();
    },
    [scheduleAutoplay]
  );

  const jumpToPhysicalIndex = useCallback(
    (physicalIndex: number, logicalIndex: number) => {
      clearLoopResetTimer();
      loopResetTimerRef.current = setTimeout(() => {
        setActiveIndexes(logicalIndex, physicalIndex);
        scrollToSlide(physicalIndex, false);
        loopResetTimerRef.current = null;
      }, HERO_SLIDE_RESET_DELAY_MS);
    },
    [clearLoopResetTimer, scrollToSlide, setActiveIndexes]
  );

  useEffect(() => {
    if (!sliderWidth || heroSlides.length <= 1) return;

    requestAnimationFrame(() => {
      setActiveIndexes(0, physicalFirstIndex);
      scrollToSlide(physicalFirstIndex, false);
    });

    return () => {
      clearAutoplayTimer();
      clearLoopResetTimer();
    };
  }, [
    clearAutoplayTimer,
    clearLoopResetTimer,
    heroSlides.length,
    physicalFirstIndex,
    scrollToSlide,
    setActiveIndexes,
    sliderWidth,
  ]);

  useEffect(() => {
    scheduleAutoplay();

    return clearAutoplayTimer;
  }, [clearAutoplayTimer, scheduleAutoplay]);

  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      console.log('HOME_FOCUS_RESUME_SLIDESHOW');
      scheduleAutoplay();

      return () => {
        isFocusedRef.current = false;
        clearAutoplayTimer();
      };
    }, [clearAutoplayTimer, scheduleAutoplay])
  );

  const handleMomentumScrollEnd = useCallback(
    (event: any) => {
      if (!sliderWidth) return;

      const nextIndex = Math.round(
        (event?.nativeEvent?.contentOffset?.x ?? 0) / sliderWidth
      );
      const safeIndex = Math.max(0, Math.min(nextIndex, physicalEndCloneIndex));
      const logicalIndex =
        safeIndex === 0
          ? heroSlides.length - 1
          : safeIndex === physicalEndCloneIndex
            ? 0
            : safeIndex - 1;

      setActiveIndexes(logicalIndex, safeIndex);

      if (safeIndex === 0) {
        jumpToPhysicalIndex(physicalLastIndex, heroSlides.length - 1);
      } else if (safeIndex === physicalEndCloneIndex) {
        jumpToPhysicalIndex(physicalFirstIndex, 0);
      }

      isDraggingRef.current = false;
      scheduleAutoplay();
    },
    [
      heroSlides.length,
      jumpToPhysicalIndex,
      physicalEndCloneIndex,
      physicalFirstIndex,
      physicalLastIndex,
      scheduleAutoplay,
      setActiveIndexes,
      sliderWidth,
    ]
  );

  useEffect(() => {
    if (!sliderWidth || requestedSlideIndex === null) return;

    const safeIndex = Math.max(
      0,
      Math.min(requestedSlideIndex, heroSlides.length - 1)
    );
    clearAutoplayTimer();
    clearLoopResetTimer();
    setActiveIndexes(safeIndex, safeIndex + 1);
    scrollToSlide(safeIndex + 1, true);
    scheduleAutoplay();
  }, [
    clearAutoplayTimer,
    clearLoopResetTimer,
    heroSlides.length,
    requestedSlideIndex,
    requestedSlideKey,
    scheduleAutoplay,
    scrollToSlide,
    setActiveIndexes,
    sliderWidth,
  ]);

  const handleLayout = useCallback((event: any) => {
    const nextWidth = event.nativeEvent.layout.width;
    setSliderWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
  }, []);

  const getItemLayout = useCallback(
    (_: ArrayLike<HomeHeroSlide> | null | undefined, index: number) => ({
      length: sliderWidth || 1,
      offset: (sliderWidth || 1) * index,
      index,
    }),
    [sliderWidth]
  );

  const keyExtractor = useCallback((slide: LoopedHomeHeroSlide) => {
    return slide.loopKey;
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: LoopedHomeHeroSlide; index: number }) => (
      <HeroSlideItem
        slide={item}
        index={index}
        width={sliderWidth}
        activePhysicalIndex={activePhysicalIndexRef.current}
        onOpenUpdates={openUpdatesPage}
        onOpenSlide3ShopNow={openSlide3ShopNow}
        onMediaReady={handleMediaReady}
      />
    ),
    [handleMediaReady, openSlide3ShopNow, openUpdatesPage, sliderWidth]
  );

  const handleScrollBeginDrag = useCallback(() => {
    isDraggingRef.current = true;
    clearAutoplayTimer();
    clearLoopResetTimer();
  }, [clearAutoplayTimer, clearLoopResetTimer]);

  const handleScrollEndDrag = useCallback(() => {
    isDraggingRef.current = false;
    scheduleAutoplay();
  }, [scheduleAutoplay]);

  return (
    <View
      style={styles.heroSlideshowWrap}
      onLayout={handleLayout}
    >
      {sliderWidth ? (
        <FlatList
          ref={sliderRef}
          data={loopedHeroSlides}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          extraData={activePhysicalIndex}
          style={styles.heroPager}
          horizontal
          pagingEnabled
          directionalLockEnabled
          nestedScrollEnabled={true}
          showsHorizontalScrollIndicator={false}
          bounces={false}
          removeClippedSubviews={false}
          initialScrollIndex={physicalFirstIndex}
          initialNumToRender={3}
          maxToRenderPerBatch={2}
          windowSize={3}
          getItemLayout={getItemLayout}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onScrollToIndexFailed={() => {
            requestAnimationFrame(() => scrollToSlide(physicalFirstIndex, false));
          }}
        />
      ) : (
        <View style={styles.heroSlideFallback} />
      )}

      {!firstSlideReady ? <View pointerEvents="none" style={styles.heroFirstSlideGuard} /> : null}

      <HeroDots slides={heroSlides} activeIndex={activeIndex} />
    </View>
  );
});

export default function HomeScreen() {
  useHomeRenderCounter('HomeScreen');
  homePerfInvestigation.homeScreenRenders += 1;

  if (homePerfInvestigation.homeScreenStartAt === 0) {
    homePerfInvestigation.homeScreenStartAt = perfNow();
    homeLog('[HOME PERF] render start', homePerfInvestigation.homeScreenStartAt);
    homeLog('[HOME PERF] video asset sizes on disk', VIDEO_ASSET_SIZES_MB);
  }

  if (homePerfInvestigation.homeScreenRenders === 1) {
    homeLog('[HOME PERF] HomeScreen first render', perfNow());
  } else if (HOME_PERF_INVESTIGATION_ENABLED && homePerfInvestigation.homeScreenRenders % 10 === 0) {
    homeLog('[HOME PERF] HomeScreen render count', {
      count: homePerfInvestigation.homeScreenRenders,
      time: perfNow(),
    });
  }

  useLayoutEffect(() => {
    homeLog('[HOME PERF] HomeScreen mounted', perfNow());
  }, []);

  const router = useRouter();
  const navigation = useNavigation();
  const pathname = usePathname();
  const isHomeTabActive = useNavigationState(
    (state) => state.routes[state.index]?.name === 'index'
  );
  const shouldIgnoreHomeTabPress = isHomeTabActive && isHomeTabPath(pathname);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [allProducts, setAllProducts] = useState<ShopifyProduct[]>(
    () => homeSessionSnapshot?.allProducts ?? []
  );
  const [products, setProducts] = useState<ShopifyProduct[]>(
    () => homeSessionSnapshot?.products ?? []
  );
  const [showcaseProducts, setShowcaseProducts] = useState<Record<string, ShopifyProduct[]>>(
    () => homeSessionSnapshot?.showcaseProducts ?? {}
  );
  const showcaseProductsRef = useRef(showcaseProducts);

  useEffect(() => {
    showcaseProductsRef.current = showcaseProducts;
  }, [showcaseProducts]);

  const {
    addToCart,
    cartCount,
    selectedCurrency = BASE_CURRENCY,
    convertPrice: convertCurrencyPrice,
    formatMoney: formatCurrencyMoney,
  } = useCart();

  const [loading, setLoading] = useState(!homeSessionSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [homeContentReady, setHomeContentReady] = useState(Boolean(homeSessionSnapshot));
  const [searchText, setSearchText] = useState('');
  const [selectedCollectionHandle, setSelectedCollectionHandle] = useState('all');
  const [hotBadgeSeed, setHotBadgeSeed] = useState(
    () => homeSessionSnapshot?.hotBadgeSeed ?? getRandomSeed()
  );
  const [feedMixKey, setFeedMixKey] = useState(() => getRandomSeed());
  const [balancedFeedProducts, setBalancedFeedProducts] = useState<ShopifyProduct[]>([]);
  const [visibleProductCount, setVisibleProductCount] = useState(
    () => homeSessionSnapshot?.visibleProductCount ?? HOME_VISIBLE_PRODUCTS_STEP
  );
  const [nextProductsCursor, setNextProductsCursor] = useState<string | null>(
    () => homeSessionSnapshot?.nextProductsCursor ?? null
  );
  const [hasMoreProducts, setHasMoreProducts] = useState(
    () => homeSessionSnapshot?.hasMoreProducts ?? true
  );
  const [loadingMoreProducts, setLoadingMoreProducts] = useState(false);
  const [requestedHeroSlide, setRequestedHeroSlide] = useState<{ index: number | null; key: number }>({
    index: null,
    key: 0,
  });
  const [cameraVisible, setCameraVisible] = useState(false);
  const [takingPicture, setTakingPicture] = useState(false);
  const [visualSearchLoading, setVisualSearchLoading] = useState(false);
  const [visualSearchMode, setVisualSearchMode] = useState(false);

  const isFetchingRef = React.useRef(false);
  const isFetchingMoreRef = React.useRef(false);
  const loadMoreLockedRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const allProductsRef = useRef<ShopifyProduct[]>([]);
  const nextProductsCursorRef = useRef<string | null>(nextProductsCursor);
  const hasMoreProductsRef = useRef(hasMoreProducts);
  const catalogDrainActiveRef = useRef(false);
  const homeFeedSessionRef = useRef(getHomeProductFeedSession());
  const enrichInFlightRef = useRef(false);
  const balancedFeedMixKeyRef = useRef(feedMixKey);
  const feedMixKeyRef = useRef(feedMixKey);
  const balancedFeedRef = useRef<ShopifyProduct[]>([]);
  const pendingRefreshSnapshotRef = useRef<{
    products: ShopifyProduct[];
    nextCursor: string | null;
    hasMore: boolean;
    mixKey: number;
    balancedFeedProducts: ShopifyProduct[];
  } | null>(null);
  const filteredProductsLengthRef = useRef(0);
  const listRef = useRef<FlatList<ShopifyProduct>>(null);
  const cameraRef = useRef<CameraView>(null);
  const homeScrollOffsetRef = useRef(homeSessionSnapshot?.scrollOffset ?? 0);
  const restoredHomeScrollRef = useRef(false);

  const scale = useRef(new Animated.Value(1)).current;
  const rotate = useRef(new Animated.Value(0)).current;

  const currencyConversionCountRef = useRef(0);

  const getDisplayPrice = useCallback(
    (item: ShopifyProduct) => {
      const startedAt = perfNow();
      const amount =
        Number.isFinite(Number(item.priceAmount)) && Number(item.priceAmount) > 0
          ? Number(item.priceAmount)
          : Number(String(item.price || '').replace(/[^0-9.]/g, '')) || 0;
      const currency = item.currencyCode || BASE_CURRENCY;
      const result = formatCurrencyMoney(
        convertCurrencyPrice(amount, currency, selectedCurrency),
        selectedCurrency
      );

      if (HOME_PERF_INVESTIGATION_ENABLED) {
        currencyConversionCountRef.current += 1;
        if (currencyConversionCountRef.current % 25 === 0) {
          homeLog('[HOME PERF] currency conversion sample', {
            count: currencyConversionCountRef.current,
            durationMs: perfNow() - startedAt,
            handle: item.handle,
            time: perfNow(),
          });
        }
      }

      return result;
    },
    [convertCurrencyPrice, formatCurrencyMoney, selectedCurrency]
  );

  const getDisplayOldPrice = useCallback(
    (item: ShopifyProduct) => {
      if (!item.oldPrice && !item.oldPriceAmount) return null;

      const amount =
        Number.isFinite(Number(item.oldPriceAmount)) && Number(item.oldPriceAmount) > 0
          ? Number(item.oldPriceAmount)
          : Number(String(item.oldPrice || '').replace(/[^0-9.]/g, '')) || 0;

      if (!amount) return null;

      return formatCurrencyMoney(
        convertCurrencyPrice(amount, item.currencyCode || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      );
    },
    [convertCurrencyPrice, formatCurrencyMoney, selectedCurrency]
  );

  useEffect(() => {
    allProductsRef.current = allProducts;
  }, [allProducts]);

  useEffect(() => {
    feedMixKeyRef.current = feedMixKey;
  }, [feedMixKey]);

  useEffect(() => {
    nextProductsCursorRef.current = nextProductsCursor;
  }, [nextProductsCursor]);

  useEffect(() => {
    hasMoreProductsRef.current = hasMoreProducts;
  }, [hasMoreProducts]);

  useEffect(() => {
    if (!homeContentReady || loading || !allProducts.length) return;

    homeSessionSnapshot = {
      allProducts,
      products,
      showcaseProducts,
      nextProductsCursor,
      hasMoreProducts,
      hotBadgeSeed,
      visibleProductCount,
      scrollOffset: homeScrollOffsetRef.current,
    };
  }, [
    allProducts,
    hasMoreProducts,
    homeContentReady,
    hotBadgeSeed,
    loading,
    nextProductsCursor,
    products,
    showcaseProducts,
    visibleProductCount,
  ]);

  useEffect(() => {
    if (restoredHomeScrollRef.current || !homeContentReady || loading) return;
    if (!homeSessionSnapshot || homeSessionSnapshot.scrollOffset <= 0) return;

    restoredHomeScrollRef.current = true;
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({
        offset: homeSessionSnapshot?.scrollOffset ?? 0,
        animated: false,
      });
    });
  }, [homeContentReady, loading]);

  useEffect(() => {
    if (!homeContentReady || loading) return;

    requestAnimationFrame(() => {
      DeviceEventEmitter.emit('homeContentReady');
    });
  }, [homeContentReady, loading]);

  useEffect(() => {
    if (!HOME_PROFILE_LOGS_ENABLED) return;

    console.log(`[Home perf] time to first paint: ${(getNow() - homeModuleStartedAt).toFixed(1)}ms`);
    const task = InteractionManager.runAfterInteractions(() => {
      console.log(
        `[Home perf] time to interactive: ${(getNow() - homeModuleStartedAt).toFixed(1)}ms`
      );
      logHomePerfSummary('after initial interactions');
    });

    return () => task.cancel();
  }, []);

  useEffect(() => {
    if (!HOME_PROFILE_LOGS_ENABLED) return;

    let rafId = 0;
    let frames = 0;
    let last = getNow();
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;

      frames += 1;
      const now = getNow();
      if (now - last >= 1000) {
        console.log(`[Home perf] JS FPS sample: ${Math.round((frames * 1000) / (now - last))}`);
        frames = 0;
        last = now;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, []);

  const mapAllStoreProducts = useCallback((edges: any[]): ShopifyProduct[] => {
    return (edges || [])
      .map((edge) => {
        if (!edge?.node) return null;

      const priceAmount = Number(edge.node.priceRange?.minVariantPrice?.amount || 0);
      const oldPriceAmount = edge.node.compareAtPriceRange?.maxVariantPrice?.amount
        ? Number(edge.node.compareAtPriceRange.maxVariantPrice.amount)
        : null;
      const currencyCode =
        edge.node.priceRange?.minVariantPrice?.currencyCode ||
        edge.node.compareAtPriceRange?.maxVariantPrice?.currencyCode ||
        BASE_CURRENCY;
      const collectionHandles =
        edge.node.collections?.edges?.map((c: any) => c.node?.handle).filter(Boolean) || [];
      const collectionTitles =
        edge.node.collections?.edges?.map((c: any) => c.node?.title).filter(Boolean) || [];
      const matchedCollection = collectionHandles[0] || 'all';
      const productCategory = getProductCategory(
        edge.node.productType || '',
        matchedCollection,
        collectionTitles
      );
      const firstVariant = edge.node.variants?.edges?.[0]?.node || null;

      const product = {
        id: String(edge.node.id),
        title: edge.node.title,
        handle: edge.node.handle,
        brand: edge.node.vendor || '',
        category: productCategory,
        description: edge.node.description || '',
        tags: Array.isArray(edge.node.tags) ? edge.node.tags : [],
        image: getOptimizedImageUrl(edge.node.featuredImage?.url),
        imageWidth: edge.node.featuredImage?.width ?? null,
        imageHeight: edge.node.featuredImage?.height ?? null,
        price: formatMoney(String(priceAmount)),
        oldPrice: oldPriceAmount ? formatMoney(String(oldPriceAmount)) : null,
        priceAmount,
        oldPriceAmount,
        currencyCode,
        collectionHandle: matchedCollection,
        collectionTitle: collectionTitles[0] || matchedCollection,
        collectionHandles,
        collectionTitles,
        availableForSale: Boolean(edge.node.availableForSale ?? firstVariant?.availableForSale ?? true),
        variantId: firstVariant?.id ? String(firstVariant.id) : undefined,
        variantTitle: firstVariant?.title ? String(firstVariant.title) : undefined,
      };
      console.log('[NOOD product load] home all product first variant', {
        title: edge.node.title,
        handle: edge.node.handle,
        productId: edge.node.id,
        variantId: firstVariant?.id || '',
        variantTitle: firstVariant?.title || '',
      });
      return product;
      })
      .filter((product): product is ShopifyProduct => Boolean(product));
  }, []);

  const mapCollectionProducts = useCallback(
    (edges: any[], collectionHandle: string): ShopifyProduct[] => {
      return (edges || []).map((edge) => {
        const priceAmount = Number(edge.node.priceRange?.minVariantPrice?.amount || 0);
        const oldPriceAmount = edge.node.compareAtPriceRange?.maxVariantPrice?.amount
          ? Number(edge.node.compareAtPriceRange.maxVariantPrice.amount)
          : null;
        const currencyCode =
          edge.node.priceRange?.minVariantPrice?.currencyCode ||
          edge.node.compareAtPriceRange?.maxVariantPrice?.currencyCode ||
          BASE_CURRENCY;
        const collectionHandles =
          edge.node.collections?.edges?.map((c: any) => c.node?.handle).filter(Boolean) ||
          [collectionHandle];
        const collectionTitles =
          edge.node.collections?.edges?.map((c: any) => c.node?.title).filter(Boolean) || [];
        const firstVariant = edge.node.variants?.edges?.[0]?.node || null;

        const product = {
          id: String(edge.node.id),
          title: edge.node.title,
          handle: edge.node.handle,
          brand: edge.node.vendor || '',
          category: edge.node.productType || collectionHandle,
          description: edge.node.description || '',
          tags: Array.isArray(edge.node.tags) ? edge.node.tags : [],
          image: getOptimizedImageUrl(edge.node.featuredImage?.url),
          imageWidth: edge.node.featuredImage?.width ?? null,
          imageHeight: edge.node.featuredImage?.height ?? null,
          price: formatMoney(String(priceAmount)),
          oldPrice: oldPriceAmount ? formatMoney(String(oldPriceAmount)) : null,
          priceAmount,
          oldPriceAmount,
          currencyCode,
          collectionHandle,
          collectionTitle: collectionTitles[0] || collectionHandle,
          collectionHandles,
          collectionTitles,
          availableForSale: Boolean(edge.node.availableForSale ?? firstVariant?.availableForSale ?? true),
          variantId: firstVariant?.id ? String(firstVariant.id) : undefined,
          variantTitle: firstVariant?.title ? String(firstVariant.title) : undefined,
        };
        console.log('[NOOD product load] home collection product first variant', {
          title: edge.node.title,
          handle: edge.node.handle,
          productId: edge.node.id,
          variantId: firstVariant?.id || '',
          variantTitle: firstVariant?.title || '',
        });
        return product;
      });
    },
    []
  );

  const persistHomeProductsCache = useCallback(
    async (
      products: ShopifyProduct[],
      cursor: string | null,
      hasMore: boolean,
      mixKey = feedMixKeyRef.current
    ) => {
      const startedAt = perfNow();
      homeLog('[HOME PERF] cache write start', {
        type: 'home-products',
        count: products.length,
        time: startedAt,
      });

      await AsyncStorage.setItem(
        HOME_PRODUCTS_CACHE_KEY,
        JSON.stringify({
          version: HOME_PRODUCTS_CACHE_VERSION,
          products,
          nextCursor: cursor,
          hasMore,
          mixKey,
          savedAt: new Date().toISOString(),
        } satisfies HomeProductsCache)
      );

      homeLog('[HOME PERF] cache write end', {
        type: 'home-products',
        count: products.length,
        durationMs: perfNow() - startedAt,
        time: perfNow(),
      });
    },
    []
  );

  const mixTrendingFromShowcase = useCallback(
    (showcase: Record<string, ShopifyProduct[]>, mixSeed = feedMixKeyRef.current) => {
      const seenIds = new Set<string>();
      const combined = HOME_SHOWCASE_SECTIONS.flatMap((section) => showcase[section.handle] || []).filter(
        (product) => {
          if (seenIds.has(product.id)) return false;
          seenIds.add(product.id);
          return true;
        }
      );

      return buildBalancedHomeFeed(combined, mixSeed);
    },
    []
  );

  const loadHomeCollectionBundle = useCallback(async () => {
    const startedAt = perfNow();
    homeLog('[HOME PERF] collection bundle start', { time: startedAt });

    const fetchShowcaseSection = async (section: (typeof HOME_SHOWCASE_SECTIONS)[number]) => {
      try {
        const json = await catalogFetch(COLLECTION_PRODUCTS_QUERY, {
          handle: section.handle,
          first: HOME_SHOWCASE_PRODUCTS_PER_SECTION,
        });
        const edges = json?.data?.collectionByHandle?.products?.edges || [];
        const products = mapCollectionProducts(edges, section.handle);
        if (!products.length) {
          return [section.handle, showcaseProductsRef.current[section.handle] || []] as const;
        }
        return [section.handle, products] as const;
      } catch (error) {
        console.log(
          `[NOOD home] showcase refresh failed handle=${section.handle}`,
          String(error)
        );
        return [section.handle, showcaseProductsRef.current[section.handle] || []] as const;
      }
    };

    const entries: Array<readonly [string, ShopifyProduct[]]> = [];
    for (let index = 0; index < HOME_SHOWCASE_SECTIONS.length; index += 2) {
      const batch = HOME_SHOWCASE_SECTIONS.slice(index, index + 2);
      const batchEntries = await Promise.all(batch.map(fetchShowcaseSection));
      entries.push(...batchEntries);
    }

    const rawShowcaseProducts = Object.fromEntries(entries);
    const nextShowcaseProducts = {
      ...showcaseProductsRef.current,
      ...Object.fromEntries(
        Object.entries(rawShowcaseProducts).map(([handle, products]) => [
          handle,
          products.length ? shuffleArray(products) : showcaseProductsRef.current[handle] || [],
        ])
      ),
    };
    const currentSignature = getShowcaseProductSignature(showcaseProductsRef.current);
    const nextSignature = getShowcaseProductSignature(nextShowcaseProducts);
    showcaseProductsRef.current = nextShowcaseProducts;

    if (nextSignature !== currentSignature) {
      setShowcaseProducts(nextShowcaseProducts);
    } else {
      homeLog('[HOME PERF] showcase refresh skipped state update', {
        reason: 'same-product-ids',
        time: perfNow(),
      });
    }

    void AsyncStorage.setItem(
      HOME_SHOWCASE_CACHE_KEY,
      JSON.stringify(nextShowcaseProducts satisfies HomeShowcaseCache)
    ).catch((error) => {
      console.log('Home showcase cache write error:', error);
    });

    homeLog('[HOME PERF] collection bundle end', {
      sections: Object.keys(nextShowcaseProducts).length,
      durationMs: perfNow() - startedAt,
      time: perfNow(),
    });

    return {
      showcase: nextShowcaseProducts,
    };
  }, [mapCollectionProducts]);

  const captureRefreshFeedSnapshot = useCallback(() => {
    pendingRefreshSnapshotRef.current = {
      products: [...allProductsRef.current],
      nextCursor: nextProductsCursorRef.current,
      hasMore: hasMoreProductsRef.current,
      mixKey: feedMixKeyRef.current,
      balancedFeedProducts: [...balancedFeedRef.current],
    };
  }, []);

  const restoreRefreshFeedSnapshot = useCallback((message: string) => {
    const snapshot = pendingRefreshSnapshotRef.current;
    pendingRefreshSnapshotRef.current = null;
    setRefreshing(false);
    setLoading(false);
    setHomeContentReady(true);

    if (!snapshot?.products.length) {
      console.log(message);
      return false;
    }

    feedMixKeyRef.current = snapshot.mixKey;
    setFeedMixKey(snapshot.mixKey);
    setAllProducts(snapshot.products);
    setProducts(snapshot.products);
    balancedFeedRef.current = snapshot.balancedFeedProducts.length
      ? snapshot.balancedFeedProducts
      : snapshot.products;
    balancedFeedMixKeyRef.current = snapshot.mixKey;
    setBalancedFeedProducts(balancedFeedRef.current);
    allProductsRef.current = snapshot.products;
    setNextProductsCursor(snapshot.nextCursor);
    setHasMoreProducts(snapshot.hasMore);
    nextProductsCursorRef.current = snapshot.nextCursor;
    hasMoreProductsRef.current = snapshot.hasMore;
    console.log(message);
    return true;
  }, []);

  const fetchStoreProductsPage = useCallback(
    async (
      after: string | null = null,
      mixKey = feedMixKeyRef.current,
      session = homeFeedSessionRef.current,
      manualRefresh = false
    ) => {
      const emptyCancelledPage = {
        products: [] as ShopifyProduct[],
        endCursor: null,
        hasNextPage: false,
        edgesCount: 0,
        cancelled: true,
        failed: true,
      };

      if (!isHomeProductFeedSessionActive(session)) {
        return emptyCancelledPage;
      }

      const afterParam = after ? `&after=${encodeURIComponent(String(after))}` : '';
      const path = `/api/catalog/products?limit=${PRODUCTS_PER_PAGE}&first=${PRODUCTS_PER_PAGE}&sort=updated${afterParam}`;

      console.log(
        `[NOOD home] page request mixKey=${mixKey} cursor=${after ?? 'null'}`
      );

      const feedResult = await fetchHomeProductFeedPath(path, {
        session,
        mixKey,
        manualRefresh,
      });

      if (!isHomeProductFeedSessionActive(session)) {
        return emptyCancelledPage;
      }

      if (feedResult.cancelled) {
        return {
          products: [],
          endCursor: null,
          hasNextPage: false,
          edgesCount: 0,
          cancelled: true,
          failed: true,
        };
      }

      if (feedResult.failed || !feedResult.payload?.data) {
        return {
          products: [],
          endCursor: null,
          hasNextPage: false,
          edgesCount: 0,
          cancelled: false,
          failed: true,
        };
      }

      const payload = feedResult.payload;
      const edges = (payload.data as any)?.products?.edges || [];
      const pageInfo = (payload.data as any)?.products?.pageInfo;
      const products = mapAllStoreProducts(edges);
      const endCursor = pageInfo?.endCursor ?? null;
      const hasNextPage = Boolean(pageInfo?.hasNextPage && endCursor);

      if (!products.length) {
        return {
          products: [],
          endCursor: null,
          hasNextPage: false,
          edgesCount: 0,
          cancelled: false,
          failed: true,
        };
      }

      return {
        products,
        endCursor,
        hasNextPage,
        edgesCount: edges.length,
        cancelled: false,
        failed: false,
      };
    },
    [mapAllStoreProducts]
  );

  const enrichTrendingFromCatalog = useCallback(async () => {
    const session = homeFeedSessionRef.current;
    if (enrichInFlightRef.current) {
      return;
    }
    enrichInFlightRef.current = true;

    try {
      let after: string | null = null;
      let guard = 0;

      while (guard < 4) {
        if (!isHomeProductFeedSessionActive(session)) {
          break;
        }

        const page = await fetchStoreProductsPage(after, feedMixKeyRef.current, session);
        if (page.cancelled || page.failed) break;
        if (!page.products.length) break;

        const seen = new Set(allProductsRef.current.map((product) => product.id));
        const uniqueProducts = page.products.filter((product) => !seen.has(product.id));
        if (!uniqueProducts.length) break;

        const nextProducts = [...allProductsRef.current, ...uniqueProducts];
        setAllProducts(nextProducts);
        setProducts(nextProducts);
        balancedFeedRef.current = nextProducts;
        setBalancedFeedProducts(nextProducts);
        setHasMoreProducts(Boolean(page.hasNextPage && page.endCursor));
        setNextProductsCursor(page.endCursor);

        void persistHomeProductsCache(
          nextProducts,
          page.endCursor,
          Boolean(page.hasNextPage && page.endCursor)
        ).catch((error) => {
          console.log('Home products cache write error:', error);
        });

        if (!page.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
        guard += 1;
      }
    } catch (error) {
      console.log('[NOOD feed] background catalog enrich skipped', String(error));
    } finally {
      enrichInFlightRef.current = false;
    }
  }, [fetchStoreProductsPage, persistHomeProductsCache]);

  const applyHomeProductFeed = useCallback(
    (
      nextProducts: ShopifyProduct[],
      cursor: string | null = null,
      hasMore = false,
      options: { persist?: boolean } = {}
    ) => {
      setAllProducts(nextProducts);
      setProducts(nextProducts);
      balancedFeedRef.current = nextProducts;
      balancedFeedMixKeyRef.current = feedMixKeyRef.current;
      setBalancedFeedProducts(nextProducts);
      setNextProductsCursor(cursor);
      setHasMoreProducts(hasMore);
      allProductsRef.current = nextProducts;
      nextProductsCursorRef.current = cursor;
      hasMoreProductsRef.current = hasMore;
      setHomeContentReady(true);
      setLoading(false);
      setRefreshing(false);

      const shouldPersist = options.persist !== false && nextProducts.length > 0;
      if (shouldPersist) {
        void persistHomeProductsCache(nextProducts, cursor, hasMore).catch((error) => {
          console.log('Home products cache write error:', error);
        });
      }
    },
    [persistHomeProductsCache]
  );

  const appendStoreProductsPage = useCallback(
    async (after: string | null) => {
      console.log(`[NOOD home] load more requested cursor=${after ?? 'null'}`);

      const page = await fetchStoreProductsPage(
        after,
        feedMixKeyRef.current,
        homeFeedSessionRef.current,
        false
      );

      if (page.cancelled || page.failed) {
        console.log(`[NOOD home] load more failed keeping cursor=${after ?? 'null'}`);
        return page;
      }

      const seen = new Set(allProductsRef.current.map((product) => product.id));
      const uniqueProducts = page.products.filter((product) => !seen.has(product.id));

      if (!uniqueProducts.length && page.hasNextPage && page.endCursor) {
        setNextProductsCursor(page.endCursor);
        setHasMoreProducts(true);
        nextProductsCursorRef.current = page.endCursor;
        hasMoreProductsRef.current = true;
        console.log(
          `[NOOD home] load more skipped duplicates advancing cursor=${page.endCursor}`
        );
        return page;
      }

      if (!uniqueProducts.length) {
        console.log(`[NOOD home] load more failed keeping cursor=${after ?? 'null'}`);
        return { ...page, failed: true };
      }

      const nextProducts = [...allProductsRef.current, ...uniqueProducts];
      const addedCount = nextProducts.length - allProductsRef.current.length;

      setAllProducts(nextProducts);
      setProducts(nextProducts);
      balancedFeedRef.current = nextProducts;
      balancedFeedMixKeyRef.current = feedMixKeyRef.current;
      setBalancedFeedProducts(nextProducts);
      allProductsRef.current = nextProducts;

      const nextHasMore = Boolean(page.hasNextPage && page.endCursor);
      setNextProductsCursor(page.endCursor);
      setHasMoreProducts(nextHasMore);
      nextProductsCursorRef.current = page.endCursor;
      hasMoreProductsRef.current = nextHasMore;

      if (nextProducts.length > 0) {
        await persistHomeProductsCache(nextProducts, page.endCursor, nextHasMore);
      }

      console.log(
        `[NOOD home] load more applied added=${addedCount} nextCursor=${page.endCursor ?? 'null'} hasMore=${nextHasMore}`
      );

      return page;
    },
    [fetchStoreProductsPage, persistHomeProductsCache]
  );

  const drainRemainingCatalogPages = useCallback(async () => {
    if (catalogDrainActiveRef.current) return;

    catalogDrainActiveRef.current = true;

    const preservedCursor = nextProductsCursorRef.current;
    const preservedHasMore = hasMoreProductsRef.current;
    let reachedCatalogEnd = false;

    try {
      if (!preservedHasMore || !preservedCursor) {
        console.log('[NOOD home] drain skipped preserving pagination');
        return;
      }

      while (hasMoreProductsRef.current && nextProductsCursorRef.current) {
        if (isFetchingMoreRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }

        isFetchingMoreRef.current = true;

        try {
          const page = await appendStoreProductsPage(nextProductsCursorRef.current);
          if (page.cancelled || page.failed) {
            break;
          }
          if (!page.hasNextPage) {
            reachedCatalogEnd = true;
            break;
          }
        } finally {
          isFetchingMoreRef.current = false;
        }
      }

      if (reachedCatalogEnd) {
        setNextProductsCursor(null);
        setHasMoreProducts(false);
        nextProductsCursorRef.current = null;
        hasMoreProductsRef.current = false;
        await persistHomeProductsCache(allProductsRef.current, null, false);
        return;
      }

      console.log('[NOOD home] drain skipped preserving pagination');
    } catch (error) {
      console.log('Home catalog drain error:', error);
      console.log('[NOOD home] drain skipped preserving pagination');
    } finally {
      catalogDrainActiveRef.current = false;
    }
  }, [appendStoreProductsPage, persistHomeProductsCache]);

  const loadPreparedHomeFromCache = useCallback(async () => {
    console.log(`[NOOD home] cache version=V${HOME_PRODUCTS_CACHE_VERSION}`);

    const [cachedProducts, cachedShowcase] = await Promise.all([
      AsyncStorage.getItem(HOME_PRODUCTS_CACHE_KEY),
      AsyncStorage.getItem(HOME_SHOWCASE_CACHE_KEY),
    ]);

    let nextShowcaseProducts: Record<string, ShopifyProduct[]> = {};
    if (cachedShowcase) {
      try {
        const parsedShowcase = JSON.parse(cachedShowcase) as HomeShowcaseCache;
        if (parsedShowcase && typeof parsedShowcase === 'object') {
          nextShowcaseProducts = Object.fromEntries(
            Object.entries(parsedShowcase).map(([handle, sectionProducts]) => [
              handle,
              Array.isArray(sectionProducts) ? sectionProducts : [],
            ])
          );
        }
      } catch (error) {
        console.log('Home showcase cache parse error:', error);
      }
    }

    let nextProducts: ShopifyProduct[] = [];
    let nextCursor: string | null = null;
    let nextHasMore = false;
    let cachedMixKey: number | null = null;

    if (cachedProducts) {
      const parsedCache = parseStoredHomeProductsCache(cachedProducts);
      if (parsedCache.products.length) {
        nextProducts = parsedCache.products;
        nextCursor = parsedCache.nextCursor;
        nextHasMore = parsedCache.hasMore;
        cachedMixKey = parsedCache.mixKey;
      }
    }

    if (!nextProducts.length && Object.keys(nextShowcaseProducts).length) {
      nextProducts = mixTrendingFromShowcase(nextShowcaseProducts);
      nextHasMore = nextProducts.length > HOME_VISIBLE_PRODUCTS_STEP;
      nextCursor = null;
    }

    if (!nextProducts.length) {
      return { loaded: false, shouldResumeDrain: false, needsPaginationRepair: false };
    }

    const paginationValid = isValidHomeProductsPagination(
      nextProducts.length,
      nextCursor,
      nextHasMore
    );
    const needsPaginationRepair = !paginationValid;

    if (needsPaginationRepair) {
      console.log('[NOOD home] startup cache pagination invalid, repairing');
      nextHasMore = true;
    }

    if (cachedMixKey !== null) {
      feedMixKeyRef.current = cachedMixKey;
      setFeedMixKey(cachedMixKey);
    }

    console.log(`[NOOD home] startup cache loaded count=${nextProducts.length}`);

    setAllProducts(nextProducts);
    setProducts(nextProducts);
    setShowcaseProducts(nextShowcaseProducts);
    setNextProductsCursor(nextCursor);
    setHasMoreProducts(nextHasMore);
    allProductsRef.current = nextProducts;
    nextProductsCursorRef.current = nextCursor;
    hasMoreProductsRef.current = nextHasMore;
    balancedFeedRef.current = nextProducts;
    balancedFeedMixKeyRef.current = feedMixKeyRef.current;
    setBalancedFeedProducts(nextProducts);
    setHomeContentReady(true);
    setLoading(false);

    return {
      loaded: true,
      shouldResumeDrain: paginationValid && Boolean(nextHasMore && nextCursor),
      needsPaginationRepair,
    };
  }, [mixTrendingFromShowcase]);

  const loadInitialFeed = useCallback(
    async (isRefresh = false, options: { repairPagination?: boolean } = {}) => {
      const repairPagination = Boolean(options.repairPagination);

      if (isFetchingRef.current) {
        if (!isRefresh && !repairPagination) return;
        isFetchingRef.current = false;
      }

      const hasExistingProducts = allProductsRef.current.length > 0;
      const startedAt = Date.now();
      homeLog('[HOME PERF] shopify refresh start', {
        type: isRefresh
          ? 'pull-to-refresh'
          : repairPagination
            ? 'startup-pagination-repair'
            : hasExistingProducts
              ? 'silent-background'
              : 'initial',
        time: perfNow(),
      });

      if (!isRefresh && hasExistingProducts && !repairPagination) {
        void (async () => {
          const silentStartedAt = perfNow();
          try {
            await loadHomeCollectionBundle();
          } catch (error) {
            console.log('Home silent refresh error:', error);
            homeLog('[HOME PERF] shopify refresh error', {
              type: 'silent-background',
              durationMs: perfNow() - silentStartedAt,
              time: perfNow(),
              error: String(error),
            });
          } finally {
            homeLog('[HOME PERF] shopify refresh end', {
              type: 'silent-background',
              durationMs: perfNow() - silentStartedAt,
              time: perfNow(),
            });
          }
        })();
        return;
      }

      if (!isRefresh && hasExistingProducts && repairPagination) {
        isFetchingRef.current = true;

        try {
          const session = homeFeedSessionRef.current;
          const firstPage = await fetchStoreProductsPage(
            null,
            feedMixKeyRef.current,
            session,
            false
          );

          void loadHomeCollectionBundle().catch((error) => {
            console.log('Home collection bundle background error:', error);
          });

          if (
            !firstPage.cancelled &&
            !firstPage.failed &&
            firstPage.products.length > 0
          ) {
            const hasMore = Boolean(firstPage.hasNextPage && firstPage.endCursor);
            setNextProductsCursor(firstPage.endCursor);
            setHasMoreProducts(hasMore);
            nextProductsCursorRef.current = firstPage.endCursor;
            hasMoreProductsRef.current = hasMore;

            void persistHomeProductsCache(
              allProductsRef.current,
              firstPage.endCursor,
              hasMore
            ).catch((error) => {
              console.log('Home products cache write error:', error);
            });

            console.log(
              `[NOOD home] startup backend page applied cursor=${firstPage.endCursor ?? 'null'} hasMore=${hasMore}`
            );
            void enrichTrendingFromCatalog();
            return;
          }

          console.log(
            '[NOOD home] startup pagination repair failed, keeping cached products'
          );
          if (!hasMoreProductsRef.current) {
            setHasMoreProducts(true);
            hasMoreProductsRef.current = true;
          }
        } catch (error) {
          console.log('Home pagination repair error:', error);
          if (!hasMoreProductsRef.current) {
            setHasMoreProducts(true);
            hasMoreProductsRef.current = true;
          }
        } finally {
          isFetchingRef.current = false;
        }

        return;
      }

      isFetchingRef.current = true;

      if (isRefresh) {
        homeFeedSessionRef.current = startHomeProductFeedSession();
        enrichInFlightRef.current = false;
        setHotBadgeSeed(getRandomSeed());
        setVisibleProductCount(HOME_VISIBLE_PRODUCTS_STEP);
        setRefreshing(true);
        if (!allProductsRef.current.length) {
          setLoading(true);
          setHomeContentReady(false);
        } else if (!pendingRefreshSnapshotRef.current) {
          captureRefreshFeedSnapshot();
          console.log('[NOOD home] keeping old feed until refresh succeeds');
        }
      } else if (!hasExistingProducts) {
        setLoading(true);
        setHomeContentReady(false);
      }

      try {
        const session = homeFeedSessionRef.current;
        const shouldPrimeShowcaseWithFeed = !isRefresh && !hasExistingProducts;
        const firstPage = shouldPrimeShowcaseWithFeed
          ? (
              await Promise.all([
                loadHomeCollectionBundle(),
                fetchStoreProductsPage(
                  null,
                  feedMixKeyRef.current,
                  session,
                  isRefresh
                ),
              ])
            )[1]
          : await fetchStoreProductsPage(
              null,
              feedMixKeyRef.current,
              session,
              isRefresh
            );

        if (!shouldPrimeShowcaseWithFeed) {
          void loadHomeCollectionBundle().catch((error) => {
            console.log('Home collection bundle background error:', error);
          });
        }

        if (isRefresh && (firstPage.cancelled || firstPage.failed || !firstPage.products.length)) {
          const snapshot = pendingRefreshSnapshotRef.current;
          pendingRefreshSnapshotRef.current = null;
          setRefreshing(false);
          setLoading(false);
          setHomeContentReady(true);

          if (snapshot?.products.length) {
            const mixedProducts = buildBalancedHomeFeed(
              snapshot.products,
              feedMixKeyRef.current
            );
            applyHomeProductFeed(mixedProducts, snapshot.nextCursor, snapshot.hasMore);
            console.log(
              `[NOOD home] refresh reshuffled previous feed mixKey=${feedMixKeyRef.current} count=${mixedProducts.length}`
            );
            return;
          }

          restoreRefreshFeedSnapshot('[NOOD home] refresh failed, keeping previous feed');
          return;
        }

        if (firstPage.cancelled || firstPage.failed || !firstPage.products.length) {
          if (!isRefresh && allProductsRef.current.length) {
            console.log('[NOOD home] feed incomplete, keeping cached products');
            setHomeContentReady(true);
            setLoading(false);
            if (
              !isValidHomeProductsPagination(
                allProductsRef.current.length,
                nextProductsCursorRef.current,
                hasMoreProductsRef.current
              )
            ) {
              void loadInitialFeed(false, { repairPagination: true });
            }
            return;
          }

          if (firstPage.cancelled) {
            throw new Error('Home product feed request cancelled.');
          }
        }

        const firstProducts = firstPage.products;
        const hasMore = Boolean(firstPage.hasNextPage && firstPage.endCursor);

        pendingRefreshSnapshotRef.current = null;
        applyHomeProductFeed(firstProducts, firstPage.endCursor, hasMore);

        console.log(
          `[NOOD home] page1 applied count=${firstProducts.length} cursor=${firstPage.endCursor ?? 'null'} hasMore=${hasMore}`
        );

        if (isRefresh) {
          console.log(
            `[NOOD home] refreshed feed applied mixKey=${feedMixKeyRef.current}`
          );
        }

        if (__DEV__) {
          console.log(
            `[Home perf] backend mixed feed: ${Date.now() - startedAt}ms, products=${firstProducts.length}, mixKey=${feedMixKeyRef.current}, cursor=null`
          );
        }

        void enrichTrendingFromCatalog();
      } catch (error) {
        console.log('Initial feed error:', error);
        void clearCatalogProductListCache();
        homeLog('[HOME PERF] shopify refresh error', {
          type: isRefresh ? 'pull-to-refresh' : 'initial',
          durationMs: Date.now() - startedAt,
          time: perfNow(),
          error: String(error),
        });

        if (isRefresh) {
          const snapshot = pendingRefreshSnapshotRef.current;
          pendingRefreshSnapshotRef.current = null;
          setRefreshing(false);
          setLoading(false);
          setHomeContentReady(true);

          if (snapshot?.products.length) {
            const mixedProducts = buildBalancedHomeFeed(
              snapshot.products,
              feedMixKeyRef.current
            );
            applyHomeProductFeed(mixedProducts, snapshot.nextCursor, snapshot.hasMore);
            console.log(
              `[NOOD home] refresh reshuffled previous feed mixKey=${feedMixKeyRef.current} count=${mixedProducts.length}`
            );
            return;
          }

          restoreRefreshFeedSnapshot('[NOOD home] refresh failed, keeping previous feed');
          return;
        }

        let recoveredProducts: ShopifyProduct[] = [];

        try {
          const cached = await AsyncStorage.getItem(HOME_PRODUCTS_CACHE_KEY);
          const parsedCache = parseStoredHomeProductsCache(cached);
          if (parsedCache.products.length) {
            recoveredProducts = parsedCache.products;
            console.log('[NOOD feed] home fallback used cached products', {
              count: parsedCache.products.length,
            });
          }
        } catch (cacheError) {
          console.log('Home products cache fallback error:', cacheError);
        }

        if (!recoveredProducts.length) {
          try {
            const bundle = await loadHomeCollectionBundle();
            recoveredProducts = mixTrendingFromShowcase(bundle.showcase);
            console.log('[NOOD feed] home fallback used collection bundle', {
              count: recoveredProducts.length,
            });
          } catch (bootstrapError) {
            console.log('Home collection bundle fallback error:', bootstrapError);
          }
        }

        const recoveredHasMore = isValidHomeProductsPagination(
          recoveredProducts.length,
          null,
          recoveredProducts.length > HOME_VISIBLE_PRODUCTS_STEP
        )
          ? recoveredProducts.length > HOME_VISIBLE_PRODUCTS_STEP
          : true;

        applyHomeProductFeed(recoveredProducts, null, recoveredHasMore);
        if (recoveredProducts.length > 0) {
          void loadInitialFeed(false, { repairPagination: true });
        }
        void enrichTrendingFromCatalog();
      } finally {
        homeLog('[HOME PERF] shopify refresh end', {
          type: isRefresh ? 'pull-to-refresh' : 'initial',
          durationMs: Date.now() - startedAt,
          time: perfNow(),
        });
        isFetchingRef.current = false;
      }
    },
    [
      applyHomeProductFeed,
      captureRefreshFeedSnapshot,
      enrichTrendingFromCatalog,
      fetchStoreProductsPage,
      loadHomeCollectionBundle,
      mixTrendingFromShowcase,
      persistHomeProductsCache,
      restoreRefreshFeedSnapshot,
    ]
  );

  const loadNextProductsPage = useCallback(async () => {
    if (
      isFetchingMoreRef.current ||
      !hasMoreProducts ||
      !nextProductsCursor ||
      searchText.trim() ||
      selectedCollectionHandle !== 'all'
    ) {
      return;
    }

    isFetchingMoreRef.current = true;
    setLoadingMoreProducts(true);
    const startedAt = Date.now();
    const requestedCursor = nextProductsCursor;

    try {
      const page = await appendStoreProductsPage(requestedCursor);

      if (page.cancelled || page.failed) {
        return;
      }

      const totalCount = allProductsRef.current.length;

      setVisibleProductCount((current) => Math.max(current, totalCount));

      if (!page.hasNextPage) {
        setNextProductsCursor(null);
        setHasMoreProducts(false);
        nextProductsCursorRef.current = null;
        hasMoreProductsRef.current = false;
        await persistHomeProductsCache(allProductsRef.current, null, false);
      }

      if (__DEV__) {
        console.log(
          `[Home perf] next Shopify page: ${Date.now() - startedAt}ms, pageSize=${page.products.length}, total=${totalCount}`
        );
      }
      if (HOME_PROFILE_LOGS_ENABLED) {
        console.log(
          '[Home perf] next Shopify page image sample',
          page.products.slice(0, 5).map((item) => ({
            handle: item.handle,
            original: `${item.imageWidth ?? 'unknown'}x${item.imageHeight ?? 'unknown'}`,
            requestedUrl: item.image,
          }))
        );
        logHomePerfSummary('after next Shopify page');
      }
    } catch (error) {
      console.log('Next feed page error:', error);
    } finally {
      setLoadingMoreProducts(false);
      isFetchingMoreRef.current = false;
    }
  }, [
    appendStoreProductsPage,
    hasMoreProducts,
    nextProductsCursor,
    persistHomeProductsCache,
    searchText,
    selectedCollectionHandle,
  ]);

  useEffect(() => {
    let isMounted = true;

    const loadHomeProducts = async () => {
      try {
        if (homeSessionSnapshot) {
          void loadInitialFeed(false);
          return;
        }

        const cacheResult = await loadPreparedHomeFromCache();
        if (!isMounted) return;

        if (cacheResult.loaded) {
          if (cacheResult.shouldResumeDrain) {
            void drainRemainingCatalogPages();
          }
          void loadInitialFeed(false, {
            repairPagination: cacheResult.needsPaginationRepair,
          });
          return;
        }

        await loadInitialFeed(false);
      } catch (error) {
        console.log('Home products load error:', error);
        if (isMounted) {
          setHomeContentReady(true);
          setLoading(false);
        }
      }
    };

    void loadHomeProducts();

    return () => {
      isMounted = false;
    };
  }, [drainRemainingCatalogPages, loadInitialFeed, loadPreparedHomeFromCache]);

  const getSavedHomeScrollOffset = useCallback(() => {
    return Math.max(
      homeScrollOffsetRef.current,
      homeSessionSnapshot?.scrollOffset ?? 0
    );
  }, []);

  const restoreHomeScroll = useCallback(() => {
    const offset = getSavedHomeScrollOffset();
    if (offset <= 0) return undefined;

    homeScrollOffsetRef.current = offset;
    if (homeSessionSnapshot) {
      homeSessionSnapshot.scrollOffset = offset;
    }

    const applyOffset = () => {
      listRef.current?.scrollToOffset({ offset, animated: false });
    };

    applyOffset();

    const timers = [16, 50, 150, 350, 600].map((delay) => setTimeout(applyOffset, delay));

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [getSavedHomeScrollOffset]);

  useFocusEffect(
    useCallback(() => {
      if (!allProductsRef.current.length) {
        void loadInitialFeed(false);
      }
    }, [loadInitialFeed])
  );

  useFocusEffect(
    useCallback(() => {
      return restoreHomeScroll();
    }, [restoreHomeScroll])
  );

  useFocusEffect(
    useCallback(() => {
      return () => {
        const offset = getSavedHomeScrollOffset();
        homeScrollOffsetRef.current = offset;
        if (homeSessionSnapshot) {
          homeSessionSnapshot.scrollOffset = offset;
        }
      };
    }, [getSavedHomeScrollOffset])
  );

  useLayoutEffect(() => {
    if (!isHomeTabPath(pathname)) return;
    return restoreHomeScroll();
  }, [pathname, restoreHomeScroll]);

  useEffect(() => {
    const tabNavigation = navigation.getParent();
    if (!tabNavigation) return;

    const unsubscribe = (tabNavigation as any).addListener(
      'tabPress',
      (event: { preventDefault?: () => void }) => {
        if (!navigation.isFocused() || !shouldIgnoreHomeTabPress) return;
        event.preventDefault?.();
        restoreHomeScroll();
      }
    );

    return unsubscribe;
  }, [navigation, restoreHomeScroll, shouldIgnoreHomeTabPress]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, {
            toValue: 1.08,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(rotate, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(scale, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(rotate, {
            toValue: 0,
            duration: 700,
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [rotate, scale]);

  const openProduct = useCallback((item: ShopifyProduct) => {
    logHomePerfSummary(`before opening product ${item.handle}`);
    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(item, { from: 'home' }),
    });
  }, [router]);

  const addHomeProductToCart = useCallback((item: ShopifyProduct) => {
    if (!item.variantId) {
      console.log('[NOOD cart] missing variantId on home product', item);
      Alert.alert('Product unavailable', 'This product is missing its Shopify variant. Please open the product and try again.');
      return;
    }

    console.log('[NOOD cart] home Add to Cart selected variant', {
      title: item.title,
      handle: item.handle,
      productId: item.id,
      variantId: item.variantId,
      variantTitle: item.variantTitle || 'Default Title',
    });

    const added = addToCart({
      id: String(item.variantId),
      productId: String(item.id),
      variantId: String(item.variantId),
      title: item.title,
      handle: item.handle,
      variantTitle: item.variantTitle || 'Default Title',
      price: Number(item.priceAmount || 0),
      currencyCode: item.currencyCode || BASE_CURRENCY,
      baseCurrency: item.currencyCode || BASE_CURRENCY,
      image: item.image,
      quantity: 1,
    });

    if (added) {
      Alert.alert('Added to cart', item.title);
    }
  }, [addToCart]);

  const getVisualSearchFallbackProducts = useCallback(() => {
    const sourceProducts = allProductsRef.current;
    const termCounts = new Map<string, number>();

    sourceProducts.forEach((product) => {
      [product.category, product.collectionHandle, ...product.tags]
        .map((term) => String(term || '').trim().toLowerCase())
        .filter((term) => term.length >= 3 && term !== 'all')
        .forEach((term) => {
          termCounts.set(term, (termCounts.get(term) || 0) + 1);
        });
    });

    const fallbackTerms = [...termCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([term]) => term);

    const matchedProducts = sourceProducts.filter((product) => {
      const productTerms = [
        product.category,
        product.collectionHandle,
        ...product.tags,
      ]
        .join(' ')
        .toLowerCase();

      return fallbackTerms.some((term) => productTerms.includes(term));
    });

    return shuffleArray(matchedProducts.length ? matchedProducts : sourceProducts);
  }, []);

  const openCameraSearch = useCallback(async () => {
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();

    if (!permission.granted) {
      Alert.alert(
        'Camera permission needed',
        'Please allow camera access to search by photo.'
      );
      return;
    }

    setCameraVisible(true);
  }, [cameraPermission, requestCameraPermission]);

  const captureSearchPhoto = useCallback(async () => {
    if (!cameraRef.current || takingPicture) return;

    try {
      setTakingPicture(true);
      await cameraRef.current.takePictureAsync({
        quality: 0.7,
        skipProcessing: true,
      });

      setCameraVisible(false);
      setVisualSearchMode(true);
      setVisualSearchLoading(true);
      setSearchText('');
      setSelectedCollectionHandle('all');
      setProducts([]);
      setVisibleProductCount(HOME_VISIBLE_PRODUCTS_STEP);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });

      setTimeout(() => {
        const fallbackResults = getVisualSearchFallbackProducts();
        setProducts(fallbackResults);
        setVisualSearchLoading(false);
      }, 900);
    } catch (error) {
      console.log('Camera search error:', error);
      Alert.alert('Camera error', 'Could not take a picture. Please try again.');
    } finally {
      setTakingPicture(false);
    }
  }, [getVisualSearchFallbackProducts, takingPicture]);

  useLayoutEffect(() => {
    const shouldUseBalancedFeed =
      selectedCollectionHandle === 'all' && !searchText.trim() && !visualSearchMode;

    if (!shouldUseBalancedFeed) {
      return;
    }

    const sourceProducts = allProducts.length > 0 ? allProducts : products;

    if (!sourceProducts.length) {
      balancedFeedRef.current = [];
      setBalancedFeedProducts([]);
      return;
    }

    const currentFeed = balancedFeedRef.current;
    const currentIds = new Set(currentFeed.map((product) => product.id));
    const sourceIds = new Set(sourceProducts.map((product) => product.id));
    const mixKeyChanged = feedMixKey !== balancedFeedMixKeyRef.current;
    const orderChanged =
      sourceProducts.length !== currentFeed.length ||
      sourceProducts.some((product, index) => product.id !== currentFeed[index]?.id);
    const isSameIdSet =
      sourceIds.size === currentIds.size &&
      [...currentIds].every((productId) => sourceIds.has(productId));

    if (isSameIdSet && !mixKeyChanged && !orderChanged && currentFeed.length > 0) {
      const refreshedFeed = refreshBalancedHomeFeedProducts(currentFeed, sourceProducts);
      const feedChanged = refreshedFeed.some(
        (product, index) => product !== currentFeed[index]
      );

      if (feedChanged) {
        balancedFeedRef.current = refreshedFeed;
        setBalancedFeedProducts(refreshedFeed);
      }
      return;
    }

    homeLog('[HOME PERF] backend mixed feed applied', {
      productCount: sourceProducts.length,
      seed: feedMixKey,
      mixKeyChanged,
      orderChanged,
      time: perfNow(),
    });
    balancedFeedRef.current = sourceProducts;
    balancedFeedMixKeyRef.current = feedMixKey;
    setBalancedFeedProducts(sourceProducts);
  }, [
    allProducts,
    feedMixKey,
    products,
    searchText,
    selectedCollectionHandle,
    visualSearchMode,
  ]);

  const baseProducts = useMemo(() => {
    const shouldUseBalancedFeed =
      selectedCollectionHandle === 'all' && !searchText.trim() && !visualSearchMode;

    const sourceProducts = shouldUseBalancedFeed
      ? allProducts.length > 0
        ? allProducts
        : balancedFeedProducts.length > 0
          ? balancedFeedProducts
          : products
      : products;

    if (selectedCollectionHandle === 'all') {
      return sourceProducts;
    }

    return sourceProducts.filter((item) =>
      item.collectionHandles?.length
        ? item.collectionHandles.includes(selectedCollectionHandle)
        : item.collectionHandle === selectedCollectionHandle
    );
  }, [
    allProducts,
    balancedFeedProducts,
    products,
    searchText,
    selectedCollectionHandle,
    visualSearchMode,
  ]);

  const filteredProducts = useMemo(() => {
    const startedAt = perfNow();
    const trimmedSearch = searchText.trim();
    const result = !trimmedSearch
      ? baseProducts
      : baseProducts.filter((item) => productMatchesSearch(item, trimmedSearch));

    homeLog('[HOME PERF] product filter end', {
      inputCount: baseProducts.length,
      outputCount: result.length,
      hasSearch: Boolean(trimmedSearch),
      durationMs: perfNow() - startedAt,
      time: perfNow(),
    });

    return result;
  }, [baseProducts, searchText]);

  const visibleProducts = useMemo(() => {
    const startedAt = perfNow();
    const result = filteredProducts.slice(0, visibleProductCount);
    homeLog('[HOME PERF] visible product batch end', {
      visibleCount: result.length,
      totalFiltered: filteredProducts.length,
      visibleProductCount,
      durationMs: perfNow() - startedAt,
      time: perfNow(),
    });
    return result;
  }, [filteredProducts, visibleProductCount]);
  const isPreparingHomeProducts = !homeContentReady || loading;
  const homeListProducts = isPreparingHomeProducts ? [] : visibleProducts;

  useEffect(() => {
    if (!HOME_PERF_INVESTIGATION_ENABLED) return;
    if (!homeContentReady || loading || !homeListProducts.length) return;
    if (homePerfInvestigation.firstVisibleAt > 0) return;

    homePerfInvestigation.firstVisibleAt = perfNow();
    homeLog('[HOME PERF] first visible content', homePerfInvestigation.firstVisibleAt);
    logHomePerfInvestigationSummary('first-visible-products');
  }, [homeContentReady, homeListProducts.length, loading]);

  useEffect(() => {
    filteredProductsLengthRef.current = filteredProducts.length;
  }, [filteredProducts.length]);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      filteredProducts
        .slice(visibleProductCount, visibleProductCount + 10)
        .forEach((item) => {
          if (item.image) {
            ExpoImage.prefetch(item.image);
          }
        });
    });

    return () => task.cancel();
  }, [filteredProducts, visibleProductCount]);

  const unlockLoadMoreSoon = useCallback(() => {
    setTimeout(() => {
      loadMoreLockedRef.current = false;
    }, 350);
  }, []);

  const loadMoreVisibleProducts = useCallback(async () => {
    if (loadMoreLockedRef.current || isPreparingHomeProducts) return;

    const now = Date.now();
    if (now - lastLoadMoreAtRef.current < 650) return;

    loadMoreLockedRef.current = true;
    lastLoadMoreAtRef.current = now;

    if (visibleProductCount < filteredProductsLengthRef.current) {
      setVisibleProductCount((current) => {
        if (current >= filteredProductsLengthRef.current) return current;
        return Math.min(current + HOME_VISIBLE_PRODUCTS_STEP, filteredProductsLengthRef.current);
      });
      unlockLoadMoreSoon();
      return;
    }

    try {
      await loadNextProductsPage();
    } finally {
      unlockLoadMoreSoon();
    }
  }, [isPreparingHomeProducts, loadNextProductsPage, unlockLoadMoreSoon, visibleProductCount]);
  const canLoadMoreShopifyProducts =
    !searchText.trim() && selectedCollectionHandle === 'all' && hasMoreProducts;
  const hasMoreVisibleProducts =
    !isPreparingHomeProducts &&
    (visibleProductCount < filteredProducts.length ||
      loadingMoreProducts ||
      canLoadMoreShopifyProducts);

  const handleScrollBegin = useCallback(() => {
    if (HOME_PROFILE_LOGS_ENABLED) {
      console.log('[Home perf] scroll begin');
    }
  }, []);

  const handleScroll = useCallback((event: any) => {
    const offset = event?.nativeEvent?.contentOffset?.y ?? 0;
    homeScrollOffsetRef.current = offset;

    if (homeSessionSnapshot) {
      homeSessionSnapshot.scrollOffset = offset;
    }
  }, []);

  const handleScrollEnd = useCallback((event?: any) => {
    const offset = event?.nativeEvent?.contentOffset?.y ?? homeScrollOffsetRef.current;
    homeScrollOffsetRef.current = offset;

    if (homeSessionSnapshot) {
      homeSessionSnapshot.scrollOffset = offset;
    }

    logHomePerfSummary('after scroll');
  }, []);

  const refreshHome = useCallback(() => {
    homeSessionSnapshot = null;
    homeScrollOffsetRef.current = 0;
    restoredHomeScrollRef.current = false;
    setSearchText('');
    setSelectedCollectionHandle('all');
    setVisualSearchMode(false);
    setVisualSearchLoading(false);
    const nextMixKey = getRandomSeed();
    console.log(`[NOOD home] manual refresh new mixKey=${nextMixKey}`);
    enrichInFlightRef.current = false;
    isFetchingMoreRef.current = false;
    catalogDrainActiveRef.current = false;
    loadMoreLockedRef.current = false;

    if (allProductsRef.current.length) {
      captureRefreshFeedSnapshot();
      console.log('[NOOD home] keeping old feed until refresh succeeds');
    }

    feedMixKeyRef.current = nextMixKey;
    setFeedMixKey(nextMixKey);
    setVisibleProductCount(HOME_VISIBLE_PRODUCTS_STEP);
    setRefreshing(true);

    if (!allProductsRef.current.length) {
      setLoading(true);
      setHomeContentReady(false);
    }

    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    void loadInitialFeed(true);
  }, [captureRefreshFeedSnapshot, loadInitialFeed]);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('refreshHome', refreshHome);
    return () => subscription.remove();
  }, [refreshHome]);

  const openSearchScreen = useCallback(() => {
    homeSessionSnapshot = {
      allProducts,
      products,
      showcaseProducts,
      nextProductsCursor,
      hasMoreProducts,
      hotBadgeSeed,
      visibleProductCount,
      scrollOffset: homeScrollOffsetRef.current,
    };
    router.push('/search' as any);
  }, [
    allProducts,
    hasMoreProducts,
    hotBadgeSeed,
    nextProductsCursor,
    products,
    router,
    showcaseProducts,
    visibleProductCount,
  ]);

  const showRewardsInSlideshow = useCallback(() => {
    setSearchText('');
    setSelectedCollectionHandle('all');
    setVisualSearchMode(false);
    setVisualSearchLoading(false);
    setRequestedHeroSlide({
      index: REWARDS_HERO_SLIDE_INDEX,
      key: Date.now(),
    });
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
  }, []);

  const renderTopHeader = () => (
    <View
      style={styles.headerWrap}
      onLayout={() => {
        if (homePerfInvestigation.topHeaderMounted) return;
        homePerfInvestigation.topHeaderMounted = true;
        homeLog('[HOME PERF] header mounted', perfNow());
      }}
    >
      <TouchableOpacity activeOpacity={0.85} onPress={refreshHome}>
        <Image
          source={require('../../assets/images/nood-brand-logo.png')}
          style={styles.logo}
          resizeMode="contain"
          fadeDuration={0}
        />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.searchBox}
        activeOpacity={0.95}
        onPress={openSearchScreen}
      >
        <TextInput
          placeholder="Search products"
          placeholderTextColor="#666"
          style={styles.input}
          value=""
          editable={false}
          onPressIn={openSearchScreen}
        />

        <View style={styles.searchIconButton}>
          <TouchableOpacity
            style={styles.searchBarIconTap}
            activeOpacity={0.8}
            onPress={openCameraSearch}
          >
            <Ionicons
              name="camera-outline"
              size={20}
              color="#000"
              style={styles.cameraIcon}
            />
          </TouchableOpacity>
          <Ionicons
            name="search"
            size={22}
            color="#000"
            onPress={openSearchScreen}
          />
        </View>
      </TouchableOpacity>
    </View>
  );

  const showTrendingNow = useCallback(() => {
    const mixStartedAt = perfNow();
    const nextMixKey = getRandomSeed();
    homeLog('[HOME PERF] mix start', {
      type: 'trending-now',
      time: mixStartedAt,
    });
    setSearchText('');
    setSelectedCollectionHandle('all');
    setVisualSearchMode(false);
    setVisualSearchLoading(false);
    homeFeedSessionRef.current = startHomeProductFeedSession();
    enrichInFlightRef.current = false;
    feedMixKeyRef.current = nextMixKey;
    setFeedMixKey(nextMixKey);
    setVisibleProductCount(HOME_VISIBLE_PRODUCTS_STEP);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });

    const hasShowcaseData = HOME_SHOWCASE_SECTIONS.some(
      (section) => (showcaseProducts[section.handle] || []).length > 0
    );

    if (hasShowcaseData) {
      const rawShowcase = Object.fromEntries(
        HOME_SHOWCASE_SECTIONS.map((section) => [
          section.handle,
          showcaseProducts[section.handle] || [],
        ])
      );
      const trending = mixTrendingFromShowcase(rawShowcase, nextMixKey);
      applyHomeProductFeed(trending, null, trending.length > HOME_VISIBLE_PRODUCTS_STEP);
      homeLog('[HOME PERF] mix end', {
        type: 'trending-now-instant',
        durationMs: perfNow() - mixStartedAt,
        time: perfNow(),
      });
      void enrichTrendingFromCatalog();
      return;
    }

    homeLog('[HOME PERF] mix end', {
      type: 'trending-now-trigger',
      durationMs: perfNow() - mixStartedAt,
      time: perfNow(),
    });
    void loadInitialFeed(true);
  }, [
    applyHomeProductFeed,
    enrichTrendingFromCatalog,
    loadInitialFeed,
    mixTrendingFromShowcase,
    showcaseProducts,
  ]);

  const renderCollectionShowcase = useCallback(
    (title: string, handle: string) => {
      const collectionProducts =
        showcaseProducts[handle] && showcaseProducts[handle].length
          ? showcaseProducts[handle]
          : allProducts.filter((item) =>
              item.collectionHandles?.length
                ? item.collectionHandles.includes(handle)
                : item.collectionHandle === handle
            );

      if (!collectionProducts.length) {
        return null;
      }

      return (
        <View style={styles.showcaseWrap}>
          <View style={styles.showcaseHeaderRow}>
            <Text style={styles.showcaseTitle}>{title}</Text>

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() =>
                router.push({
                  pathname: '/collection/[handle]',
                  params: { handle, from: 'home' },
                })
              }
            >
              <Text style={styles.viewAllText}>View All →</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.showcaseRow}
            removeClippedSubviews={false}
          >
            {collectionProducts.slice(0, 10).map((item) => {
              const badgeKey = `${handle}-${item.id}`;
              const showHotBadge = shouldShowHotBadge(badgeKey, hotBadgeSeed);

              return (
                <CategoryCard
                  key={badgeKey}
                  item={item}
                  badgeKey={badgeKey}
                  showHotBadge={showHotBadge}
                  hotBadgeSeed={hotBadgeSeed}
                  displayPrice={getDisplayPrice(item)}
                  onOpen={openProduct}
                />
              );
            })}
          </ScrollView>
        </View>
      );
    },
    [allProducts, getDisplayPrice, hotBadgeSeed, openProduct, router, showcaseProducts]
  );

  const scrollableHeader = useMemo(() => {
    homeLog('[HOME PERF] scrollable header built', perfNow());

    if (visualSearchLoading) {
      return (
        <View style={styles.visualSearchStatusWrap}>
          <NoodSpinner size={42} />
          <Text style={styles.visualSearchStatusText}>Searching similar items...</Text>
        </View>
      );
    }

    if (visualSearchMode) {
      return (
        <View style={styles.feedHeaderWrap}>
          <Text style={styles.feedHeaderTitle}>Similar items</Text>
        </View>
      );
    }

    if (searchText.trim()) return null;

    return (
      <>
        <View style={styles.homeTopInfoRow}>
          <TouchableOpacity style={styles.homePill} activeOpacity={0.9} onPress={showTrendingNow}>
            <Text style={styles.homePillText}>Trending now</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.homePill}
            activeOpacity={0.92}
            onPress={showRewardsInSlideshow}
          >
            <Text style={styles.homePillText}>Rewards</Text>
          </TouchableOpacity>
        </View>
        <Banner />
        <HomeSlideshow
          requestedSlideIndex={requestedHeroSlide.index}
          requestedSlideKey={requestedHeroSlide.key}
        />

        {renderCollectionShowcase('Men', 'clothing')}
        {renderCollectionShowcase('Women', 'women')}
        {renderCollectionShowcase('Kids', 'kids')}
        {renderCollectionShowcase('Shoes', 'shoes')}
        {renderCollectionShowcase('Electronics', 'electronics')}
        <LaceFrontVideoSection />

        <View style={styles.feedHeaderWrap}>
          <Text style={styles.feedHeaderTitle}>Trending now</Text>
        </View>
      </>
    );
  }, [
    renderCollectionShowcase,
    requestedHeroSlide.index,
    requestedHeroSlide.key,
    searchText,
    showRewardsInSlideshow,
    showTrendingNow,
    visualSearchLoading,
    visualSearchMode,
  ]);

  const renderItem = useCallback(
    ({ item }: { item: ShopifyProduct }) => (
      <ProductCard
        item={item}
        hotBadgeSeed={hotBadgeSeed}
        displayPrice={getDisplayPrice(item)}
        displayOldPrice={getDisplayOldPrice(item)}
        onOpen={openProduct}
        onAddToCart={addHomeProductToCart}
      />
    ),
    [addHomeProductToCart, getDisplayOldPrice, getDisplayPrice, hotBadgeSeed, openProduct]
  );

  const listFooterComponent = useMemo(() => {
    if (!hasMoreVisibleProducts) {
      return <View style={styles.homeBottomSpacer} />;
    }

    return (
      <View style={styles.feedFooterLoading}>
        <NoodSpinner size={34} />
      </View>
    );
  }, [hasMoreVisibleProducts]);

  const listEmptyComponent = useMemo(() => {
    if (visualSearchLoading) return null;

    if (isPreparingHomeProducts) {
      return (
        <View style={styles.emptyWrap}>
          <NoodSpinner size={54} />
        </View>
      );
    }

    if (!allProducts.length) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>Could not load products</Text>
        </View>
      );
    }

    if (searchText.trim() || selectedCollectionHandle !== 'all' || visualSearchMode) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No products found</Text>
        </View>
      );
    }

    return null;
  }, [
    allProducts.length,
    isPreparingHomeProducts,
    searchText,
    selectedCollectionHandle,
    visualSearchLoading,
    visualSearchMode,
  ]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {renderTopHeader()}

      <FlatList
        ref={listRef}
        data={homeListProducts}
        keyExtractor={(item) => `${item.id}-${item.handle}`}
        numColumns={2}
        renderItem={renderItem}
        extraData={`${hotBadgeSeed}-${selectedCurrency}`}
        ListHeaderComponent={scrollableHeader}
        onLayout={() => {
          if (homePerfInvestigation.homeListMounted) return;
          homePerfInvestigation.homeListMounted = true;
          homeLog('[HOME PERF] FlatList mounted', perfNow());
          homeLog('[HOME PERF] android list config', {
            removeClippedSubviews: false,
            initialNumToRender: 8,
            listType: 'FlatList',
            time: perfNow(),
          });
        }}
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={styles.columnWrap}
        showsVerticalScrollIndicator={false}
        scrollsToTop={false}
        removeClippedSubviews={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={50}
        windowSize={5}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBegin}
        onMomentumScrollEnd={handleScrollEnd}
        onScrollEndDrag={handleScrollEnd}
        onEndReached={loadMoreVisibleProducts}
        onEndReachedThreshold={0.35}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshHome}
            tintColor="#ff6a00"
            colors={['#ff6a00']}
            progressBackgroundColor="#ffffff"
          />
        }
        ListFooterComponent={listFooterComponent}
        ListEmptyComponent={listEmptyComponent}
      />

      <Modal
        visible={cameraVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setCameraVisible(false)}
      >
        <View style={styles.cameraScreen}>
          <CameraView ref={cameraRef} style={styles.cameraPreview} facing="back" />

          <SafeAreaView style={styles.cameraControls}>
            <TouchableOpacity
              style={styles.cameraCloseButton}
              activeOpacity={0.85}
              onPress={() => setCameraVisible(false)}
            >
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cameraCaptureButton}
              activeOpacity={0.85}
              onPress={captureSearchPhoto}
              disabled={takingPicture}
            >
              {takingPicture ? (
                <NoodSpinner size={32} />
              ) : (
                <View style={styles.cameraCaptureInner} />
              )}
            </TouchableOpacity>
          </SafeAreaView>
        </View>
      </Modal>

      <Animated.View
        style={[
          styles.cartWrap,
          {
            transform: [
              { scale },
              {
                rotate: rotate.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', '6deg'],
                }),
              },
            ],
          },
        ]}
      >
        <TouchableOpacity
          style={styles.floatingCartButton}
          onPress={() => router.push('/(tabs)/cart')}
          activeOpacity={0.92}
        >
          {cartCount > 0 && (
            <View style={styles.floatingCartBadge}>
              <Text style={styles.floatingCartBadgeText}>{cartCount}</Text>
            </View>
          )}

          <Ionicons name="cart-outline" size={28} color="#9b9b9b" style={styles.floatingCartIcon} />
          <Text style={styles.floatingCartText}>Cart</Text>
          <Text style={styles.floatingCartSubText}>Fast checkout</Text>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fbf7f2',
  },

  loadingScreen: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },

  loadingLabel: {
    marginTop: 12,
    fontSize: 16,
    color: '#444',
    fontWeight: '600',
  },

  collectionLoadingWrap: {
    paddingVertical: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },

  listContent: {
    paddingBottom: 0,
    paddingTop: 0,
  },

  headerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 12,
    paddingHorizontal: 14,
    paddingBottom: 6,
    backgroundColor: '#fff',
  },

  logo: {
    width: 95,
    height: 40,
    marginRight: 12,
  },

  searchBox: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    paddingLeft: 16,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f5f5f5',
    borderWidth: 0,
    ...platformShadow('0 2px 6px rgba(0,0,0,0.08)', {
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 6,
        elevation: 2,
    }),
  },

  input: {
    flex: 1,
    fontSize: 15,
    color: '#111',
    marginRight: 8,
  },

  searchIconButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  searchBarIconTap: {
    paddingVertical: 8,
    paddingLeft: 4,
    paddingRight: 2,
  },

  cameraIcon: {
    marginRight: 8,
  },

  categoryStripWrap: {
    paddingBottom: 14,
    paddingTop: 4,
  },

  categoryStripContent: {
    paddingHorizontal: 14,
    paddingRight: 30,
  },

  categoryChip: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#f8f8f8',
    borderWidth: 1,
    borderColor: '#eee',
    marginRight: 10,
  },

  categoryChipActive: {
    backgroundColor: '#ff6a00',
    borderColor: '#ff6a00',
  },

  categoryChipActiveShadow: {
    ...platformShadow('0 2px 6px rgba(255,106,0,0.3)', {
        shadowColor: '#ff6a00',
        shadowOpacity: 0.3,
        shadowRadius: 6,
        elevation: 4,
    }),
  },

  categoryChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
  },

  categoryChipTextActive: {
    color: '#fff',
  },

  homeTopInfoRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 10,
  },

  homePill: {
    backgroundColor: '#fff3e8',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  homePillText: {
    color: '#ff6a00',
    fontWeight: '800',
    fontSize: 13,
  },

  safeBar: {
    marginHorizontal: 14,
    marginBottom: 16,
    backgroundColor: '#6a2cff',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 16,
    ...platformShadow('0 0 16px rgba(143,98,255,0.45)', {
        shadowColor: '#8f62ff',
        shadowOpacity: 0.45,
        shadowRadius: 16,
        shadowOffset: {
          width: 0,
          height: 0,
        },
        elevation: 10,
    }),
    borderWidth: 1,
    borderColor: '#b59aff',
  },

  safeBarText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },


  heroSlideshowWrap: {
    marginHorizontal: 14,
    marginBottom: 18,
    height: 390,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#fff3e8',
    ...platformShadow('0 6px 18px rgba(0,0,0,0.12)', {
        shadowColor: '#000',
        shadowOpacity: 0.12,
        shadowRadius: 18,
        shadowOffset: {
          width: 0,
          height: 6,
        },
        elevation: 5,
    }),
  },

  heroPager: {
    flex: 1,
    height: 390,
  },

  heroSlide: {
    height: 390,
    backgroundColor: '#ff6a00',
    overflow: 'hidden',
  },

  heroSlideMedia: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    backgroundColor: '#ff6a00',
  },

  heroSlideFallback: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ff6a00',
  },

  heroImagePoster: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    backgroundColor: '#ff6a00',
  },

  heroFirstSlideGuard: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },

  heroVideoPoster: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    backgroundColor: '#ff6a00',
  },

  heroVideoPosterFallback: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ff6a00',
  },
  heroVideoPosterNoPointer: {
    pointerEvents: 'none',
  },

  heroSlideOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    paddingHorizontal: 18,
    paddingBottom: 24,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },

  heroSlideTitle: {
    color: '#fff',
    fontSize: 23,
    fontWeight: '900',
  },

  heroSlideSubtitle: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
    marginTop: 5,
    maxWidth: '82%',
  },

  haulSlide: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#d85205',
  },

  haulGlowTop: {
    position: 'absolute',
    top: -42,
    right: -34,
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: 'rgba(255,149,38,0.42)',
  },

  haulGlowBottom: {
    position: 'absolute',
    bottom: -72,
    left: -34,
    width: 224,
    height: 154,
    borderRadius: 112,
    backgroundColor: 'rgba(115,31,0,0.22)',
  },

  haulDotCluster: {
    position: 'absolute',
    top: 30,
    left: 22,
    width: 58,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    opacity: 0.72,
  },

  haulTinyDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,232,199,0.9)',
  },

  haulTextColumn: {
    position: 'absolute',
    left: 26,
    top: 68,
    bottom: 42,
    width: '58%',
    justifyContent: 'center',
    zIndex: 2,
  },

  haulTitle: {
    color: '#fff',
    fontSize: 39,
    lineHeight: 44,
    fontWeight: '900',
    letterSpacing: 0,
    textShadowColor: 'rgba(85,24,0,0.24)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },

  haulAccentLine: {
    width: 82,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#ff8a2b',
    marginTop: 18,
    marginBottom: 18,
  },

  haulSubtitle: {
    color: '#fff',
    fontSize: 17,
    lineHeight: 25,
    fontWeight: '700',
    maxWidth: '82%',
    textShadowColor: 'rgba(85,24,0,0.2)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },

  haulVisualColumn: {
    position: 'absolute',
    right: 8,
    top: 24,
    bottom: 22,
    width: '48%',
    zIndex: 1,
  },

  haulSavingsBadge: {
    position: 'absolute',
    top: 28,
    right: 38,
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: '#fff1d5',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.34)',
    transform: [{ rotate: '-10deg' }],
    ...platformShadow('0 9px 18px rgba(78,22,0,0.18)', {
      shadowColor: '#4e1600',
      shadowOpacity: 0.18,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 9 },
      elevation: 3,
    }),
  },

  haulSavingsBadgeText: {
    position: 'absolute',
    color: '#ff6a00',
    fontSize: 20,
    fontWeight: '900',
  },

  haulSparkle: {
    position: 'absolute',
    width: 15,
    height: 15,
    backgroundColor: '#fff6e8',
    transform: [{ rotate: '45deg' }],
    opacity: 0.9,
  },

  haulSparkleOne: {
    top: 76,
    left: 20,
  },

  haulSparkleTwo: {
    top: 135,
    right: 11,
    width: 12,
    height: 12,
    opacity: 0.72,
  },

  haulBoxStack: {
    position: 'absolute',
    right: 10,
    bottom: 32,
    width: 150,
    height: 185,
  },

  haulBox: {
    position: 'absolute',
    backgroundColor: '#cb842f',
    borderWidth: 1,
    borderColor: 'rgba(107,50,7,0.15)',
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    ...platformShadow('0 8px 14px rgba(83,28,0,0.18)', {
      shadowColor: '#531c00',
      shadowOpacity: 0.18,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 8 },
      elevation: 2,
    }),
  },

  haulBoxSmall: {
    top: 0,
    right: 25,
    width: 92,
    height: 54,
    backgroundColor: '#d69038',
  },

  haulBoxMedium: {
    top: 58,
    right: 10,
    width: 124,
    height: 67,
    backgroundColor: '#c88230',
  },

  haulBoxLarge: {
    bottom: 0,
    right: 0,
    width: 148,
    height: 76,
    backgroundColor: '#bc7628',
  },

  haulBoxTape: {
    position: 'absolute',
    top: 0,
    width: 22,
    height: '100%',
    backgroundColor: 'rgba(255,211,139,0.58)',
  },

  haulBoxLogo: {
    color: 'rgba(255,106,0,0.72)',
    fontSize: 18,
    fontWeight: '900',
  },

  haulBagLarge: {
    position: 'absolute',
    left: 8,
    bottom: 24,
    width: 78,
    height: 93,
    borderRadius: 6,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-2deg' }],
    ...platformShadow('0 10px 16px rgba(76,23,0,0.18)', {
      shadowColor: '#4c1700',
      shadowOpacity: 0.18,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 10 },
      elevation: 2,
    }),
  },

  haulBagHandle: {
    position: 'absolute',
    top: -15,
    width: 38,
    height: 28,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderRightWidth: 3,
    borderColor: '#f5d2a2',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },

  haulBagLogo: {
    color: '#fff4e9',
    fontSize: 19,
    fontWeight: '900',
  },

  haulBagSmall: {
    position: 'absolute',
    left: 79,
    bottom: 10,
    width: 51,
    height: 63,
    borderRadius: 5,
    backgroundColor: '#ffe3bb',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '3deg' }],
  },

  haulBagHandleSmall: {
    position: 'absolute',
    top: -11,
    width: 25,
    height: 20,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderColor: '#c58a48',
    borderTopLeftRadius: 15,
    borderTopRightRadius: 15,
  },

  haulBagSmallLogo: {
    color: '#db6509',
    fontSize: 13,
    fontWeight: '900',
  },

  heroUpdatesTouchable: {
    flex: 1,
  },

  heroShopNowButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#ff6a00',
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: 999,
  },

  heroShopNowButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },


  heroDotsRow: {
    position: 'absolute',
    bottom: 9,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },

  heroDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },

  heroDotActive: {
    width: 18,
    backgroundColor: '#fff',
  },


  heroUpdatesSlide: {
    flex: 1,
    backgroundColor: '#fffaf4',
  },

  heroUpdatesHeader: {
    height: 76,
    backgroundColor: '#080808',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },

  heroUpdatesBell: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },

  heroUpdatesHeaderTextWrap: {
    flex: 1,
  },

  heroUpdatesTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },

  heroUpdatesSubtitle: {
    color: '#d8d8d8',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    marginTop: 2,
  },

  heroUpdatesCountBadge: {
    backgroundColor: '#f0e7ff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 8,
  },

  heroUpdatesCountText: {
    color: '#6a2cff',
    fontSize: 11,
    fontWeight: '900',
  },

  heroUpdatesList: {
    flex: 1,
  },

  heroUpdatesListContent: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 42,
  },

  heroUpdateCard: {
    minHeight: 112,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffb066',
    backgroundColor: '#fffaf4',
    marginBottom: 10,
    padding: 10,
    flexDirection: 'row',
    position: 'relative',
  },

  heroUpdateIconWrap: {
    width: 54,
    height: 54,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },

  heroUpdateContent: {
    flex: 1,
    paddingRight: 12,
  },

  heroUpdateLabel: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 5,
  },

  heroUpdateLabelText: {
    fontSize: 10,
    fontWeight: '900',
  },

  heroUpdateTitle: {
    color: '#111',
    fontSize: 14,
    fontWeight: '900',
  },

  heroUpdateBody: {
    color: '#56504a',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    marginTop: 3,
  },

  heroUpdateTime: {
    color: '#8d8278',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 5,
  },

  heroUpdateAction: {
    fontSize: 12,
    fontWeight: '900',
    marginTop: 4,
  },

  heroUpdateDot: {
    position: 'absolute',
    top: 14,
    right: 12,
    width: 9,
    height: 9,
    borderRadius: 5,
  },

  showcaseWrap: {
    paddingTop: 6,
    paddingBottom: 12,
  },

  showcaseHeaderRow: {
    marginLeft: 14,
    marginRight: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  showcaseTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
  },

  viewAllText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ff6a00',
  },

  showcaseRow: {
    paddingHorizontal: 14,
    paddingRight: 26,
    paddingBottom: 6,
  },

  collectionProductCard: {
    width: 170,
    marginRight: 12,
    position: 'relative',
  },

  collectionProductImage: {
    width: '100%',
    height: 250,
    borderRadius: 12,
    backgroundColor: '#eee',
  },

  collectionHotBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: '#ff6a00',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },

  collectionHotBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },

  collectionProductTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111',
    marginTop: 6,
  },

  collectionProductPrice: {
    fontSize: 14,
    color: '#ff4d00',
    fontWeight: '800',
    marginTop: 4,
  },

  laceFrontSection: {
    paddingTop: 10,
    paddingBottom: 18,
    paddingHorizontal: 10,
  },

  laceFrontTitle: {
    fontSize: 34,
    fontWeight: '500',
    color: '#111',
    marginBottom: 8,
  },

  laceFrontGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },

  laceFrontVideoCard: {
    width: '48%',
    aspectRatio: 0.72,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#eee',
  },

  laceFrontVideo: {
    width: '100%',
    height: '100%',
  },

  laceFrontButton: {
    alignSelf: 'center',
    marginTop: 18,
    paddingVertical: 12,
    paddingHorizontal: 28,
    backgroundColor: '#ff5a00',
    borderRadius: 25,
  },

  laceFrontButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },

  videoCard: {
    width: '47.5%',
    aspectRatio: 0.74,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#ededed',
    position: 'relative',
  },

  videoCardMedia: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    backgroundColor: '#ededed',
    alignItems: 'center',
    justifyContent: 'center',
  },

  videoCardPlaceholder: {
    zIndex: 2,
  },

  videoPlaceholderBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -21,
    marginLeft: -21,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.86)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(17,17,17,0.16)',
  },

  feedHeaderWrap: {
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 12,
  },

  feedHeaderTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111',
  },

  visualSearchStatusWrap: {
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  visualSearchStatusText: {
    marginTop: 14,
    fontSize: 17,
    fontWeight: '700',
    color: '#111',
  },

  cameraScreen: {
    flex: 1,
    backgroundColor: '#000',
  },

  cameraPreview: {
    flex: 1,
  },

  cameraControls: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 34,
  },

  cameraCloseButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },

  cameraCaptureButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 5,
    borderColor: 'rgba(255, 255, 255, 0.6)',
  },

  cameraCaptureInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#111',
  },
  feedFooterLoading: {
    height: 78,
    alignItems: 'center',
    justifyContent: 'center',
  },

  homeBottomSpacer: {
    height: 78,
  },

  columnWrap: {
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },

  card: {
    width: '48%',
    marginBottom: 18,
    backgroundColor: '#fff',
    borderRadius: 12,
  },

  productImageWrap: {
    position: 'relative',
  },

  productImage: {
    width: '100%',
    height: 230,
    borderRadius: 10,
    backgroundColor: '#eee',
  },

  productHotBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: '#ff6a00',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },

  productHotBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },

  productTitle: {
    fontSize: 14,
    color: '#111',
    marginTop: 8,
    lineHeight: 18,
    fontWeight: '600',
  },

  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    flexWrap: 'wrap',
  },

  productPrice: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ff4d00',
    marginRight: 8,
  },

  oldPrice: {
    fontSize: 14,
    color: '#666',
    textDecorationLine: 'line-through',
  },

  cardBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },

  soldText: {
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
  },

  cartButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    borderColor: '#ddd',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },

  emptyWrap: {
    paddingVertical: 36,
    alignItems: 'center',
  },

  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
    marginBottom: 6,
  },

  emptyText: {
    fontSize: 14,
    color: '#666',
  },

  cartWrap: {
    position: 'absolute',
    right: 14,
    bottom: 24,
    zIndex: 50,
  },

  floatingCartButton: {
    width: 110,
    height: 140,
    borderRadius: 55,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: '#eda344',
    alignItems: 'center',
    justifyContent: 'center',
  },

  floatingCartBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#ff8a00',
    borderRadius: 14,
    paddingHorizontal: 6,
    height: 28,
    justifyContent: 'center',
    minWidth: 28,
  },

  floatingCartBadgeText: {
    color: '#fff',
    fontWeight: '800',
    textAlign: 'center',
  },

  floatingCartIcon: {
    marginBottom: 5,
  },

  floatingCartText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#ff8a00',
  },

  floatingCartSubText: {
    fontSize: 11,
    backgroundColor: '#fdf0dd',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 999,
    marginTop: 6,
    color: '#b97b1f',
    fontWeight: '700',
  },

  loadingText: {
    textAlign: 'center',
    fontSize: 15,
    color: '#666',
    paddingVertical: 16,
  },
});
