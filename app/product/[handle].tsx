import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Animated,
  BackHandler,
  DeviceEventEmitter,
  Dimensions,
  FlatList,
  Image,
  LayoutChangeEvent,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import RenderHtml from 'react-native-render-html';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCart } from '../../context/CartContext';
import { useUser } from '../../context/UserContext';
import NoodSpinner from '../../components/NoodSpinner';
import ZoomableImage from '../../components/ZoomableImage';
import { useScreenPerfReporter } from '../../utils/screen-perf';
import { ACCOUNT_SIGN_IN_GATE_DISABLED } from '../../components/RequireSignIn';
import { BASE_CURRENCY, normalizeCatalogCurrencyCode } from '../../utils/currency';
import { SHOPIFY_STORE_DOMAIN } from '../../utils/shopify';
import { catalogFetch, ensureCatalogFreshness } from '../../utils/catalog';
import {
  getProductFast,
  mergeStrongerProductDetail,
  productVariantCount,
  readProductDetailCache,
  refreshProductDetailFromBackend,
  refreshProductVariantImages,
  resolveInstantProductDetail,
} from '../../utils/product-data';
import {
  applyProductVariantState,
  buildProductDetailFromPreview,
  buildProductRouteParams,
  parseProductPreviewFromParams,
  productHasRenderableVariants,
} from '../../utils/product-navigation';
import {
  computeProductSoldOut,
  getProductAvailabilityLabel,
  isVariantPurchasable,
  logProductStockState,
  resolveListProductSoldOut,
} from '../../utils/product-availability';
import type { CatalogListProduct } from '../../utils/catalog-product-mapper';
import { loadProductPageRecommendations } from '../../utils/product-recommendations';
import {
  buildColorImageMap,
  findVariantForOptions,
  getColorDisplayLabel,
  getColorImageForValue,
  getColorsForSize,
  getFirstColorForSize,
  getOptionSelectionState,
  isColorOptionName,
  isSizeOptionName,
  logProductVariantImageDebug,
  logVariantClickDebug,
  normalizeOptionName,
  optionValuesEqual,
  productNeedsVariantImageEnrichment,
  type VariantOptionMap,
} from '../../utils/product-variant-images';
import { noodAlert } from '../../utils/nood-alert';
import { recordProductView } from '../../utils/recommendation-signals';
import {
  logSwatchImageQuality,
  logSwatchUiQuality,
  resolveColorSwatchImageUrls,
  SWATCH_DISPLAY_SIZE,
  SWATCH_RESIZE_MODE,
} from '../../utils/shopify-image-url';

const JUDGEME_SHOP_DOMAIN = SHOPIFY_STORE_DOMAIN;
const JUDGEME_PUBLIC_API_TOKEN = 'QOqxbIUd0jzlg0HRjQU_Dwlsqmo';
const PRODUCT_IMAGE_PLACEHOLDER = 'https://via.placeholder.com/600x700.png?text=No+Image';

function productHasInstantRenderableDetail(productData: any) {
  if (!productData?.title) return false;
  const imageUrl =
    productData?.featuredImage?.url ||
    productData?.images?.edges?.[0]?.node?.url ||
    productData?.image ||
    '';
  return Boolean(String(imageUrl || '').trim());
}
const REVIEWS_STORAGE_PREFIX = 'NOOD_CUSTOMER_REVIEWS';

const failedJudgeMeHandles = new Set<string>();
const loggedInvalidMediaSources = new Set<string>();

const { width } = Dimensions.get('window');

function logInstantVariants(message: string, detail?: Record<string, unknown>) {
  if (!__DEV__) return;
  console.log(`[PRODUCT INSTANT VARIANTS] ${message}`, detail ?? '');
}

function getValidMediaUri(uri?: string | null) {
  const trimmed = String(uri || '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function logInvalidMediaSource(componentName: string, detail: string) {
  if (!__DEV__) return;

  const key = `${componentName}:${detail}`;
  if (loggedInvalidMediaSources.has(key)) return;
  loggedInvalidMediaSources.add(key);
  console.warn(`[media] skipped empty uri in ${componentName}`, detail);
}

function collectProductMediaImages(product: any) {
  const seenUrls = new Set<string>();
  const images: Array<{ url: string; altText: string | null; id?: string }> = [];

  const addImage = (image: any, id?: string) => {
    const url = getValidMediaUri(image?.url);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    images.push({
      url,
      altText: image?.altText ? String(image.altText) : null,
      id,
    });
  };

  (product?.media?.edges || []).forEach((edge: any) => {
    const node = edge?.node;
    if (node?.__typename === 'MediaImage') {
      addImage(node?.image, node?.id ? String(node.id) : undefined);
    }
  });

  (product?.images?.edges || []).forEach((edge: any) => {
    addImage(edge?.node, edge?.node?.id ? String(edge.node.id) : undefined);
  });

  return images;
}

function logVariantImageFinalCheck(product: any) {
  if (!__DEV__ || !product) return;

  const variants = (product?.variants?.edges || [])
    .map((edge: any) => edge?.node)
    .filter(Boolean);

  console.log('[VARIANT IMAGE FINAL CHECK]', {
    productTitle: product?.title || '',
    variantCount: variants.length,
    first10Variants: variants.slice(0, 10).map((variant: any) => ({
      id: variant?.id,
      title: variant?.title,
      selectedOptions: variant?.selectedOptions,
      image: variant?.image,
      imageUrl: variant?.image?.url,
    })),
  });
}

function countVariantImageUrls(product: any) {
  return (product?.variants?.edges || []).reduce((count: number, edge: any) => {
    return count + (getValidMediaUri(edge?.node?.image?.url) ? 1 : 0);
  }, 0);
}

function getReviewsStorageKey(profileId: string) {
  return `${REVIEWS_STORAGE_PREFIX}:${profileId}`;
}

function RecommendationSkeletonCard() {
  return (
    <View style={styles.productCard}>
      <View style={[styles.productCardImage, styles.recommendationSkeletonBlock]} />
      <View style={[styles.recommendationSkeletonLine, styles.recommendationSkeletonLineWide]} />
      <View style={[styles.recommendationSkeletonLine, styles.recommendationSkeletonLineMedium]} />
      <View style={[styles.recommendationSkeletonLine, styles.recommendationSkeletonLinePrice]} />
    </View>
  );
}

const ProductRecommendationCard = React.memo(function ProductRecommendationCard({
  item,
  priceLabel,
  onOpen,
}: {
  item: CatalogListProduct;
  priceLabel: string;
  onOpen: (item: CatalogListProduct) => void;
}) {
  const isSoldOut = resolveListProductSoldOut(item);

  return (
    <TouchableOpacity
      style={styles.productCard}
      activeOpacity={0.9}
      onPress={() => onOpen(item)}
    >
      <Image
        source={{
          uri: item.image || PRODUCT_IMAGE_PLACEHOLDER,
        }}
        style={styles.productCardImage}
        resizeMode="cover"
      />
      <Text numberOfLines={2} style={styles.productCardTitle}>
        {item.title}
      </Text>
      <Text style={styles.productCardPrice}>{priceLabel}</Text>
      {isSoldOut ? (
        <Text numberOfLines={1} style={styles.recommendationSoldOutText}>
          {getProductAvailabilityLabel(item)}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
});

function ProductVideoPreview({
  previewUri,
  style,
  resizeMode,
}: {
  previewUri?: string | null;
  style: any;
  resizeMode: 'cover' | 'contain';
}) {
  const imageUri = getValidMediaUri(previewUri) || PRODUCT_IMAGE_PLACEHOLDER;

  return (
    <View style={[style, styles.videoPreviewWrap]}>
      <Image source={{ uri: imageUri }} style={styles.videoPreviewImage} resizeMode={resizeMode} />
      <View style={styles.videoPlayBadge}>
        <Ionicons name="play" size={22} color="#111" />
      </View>
    </View>
  );
}

const COLORS = {
  bg: '#f6f3ef',
  card: '#ffffff',
  text: '#111111',
  muted: '#6b7280',
  line: '#ece7df',
  orange: '#ff8a00',
  orangeSoft: '#fff1df',
  peach: '#fff6ee',
  gold: '#d89b2b',
  dark: '#111111',
  cream: '#f9f4ec',
  cartBorder: '#f0a54a',
  cartSoft: '#fff5e8',
};

type TabKey = 'overview' | 'details' | 'similar';

type ProductOptionGroupProps = {
  group: { name: string; values: string[] };
  colorOptionName: string | null;
  sizeOptionName: string | null;
  variantNodes: any[];
  productImageEdges?: any[];
  selectedOptionsMap: VariantOptionMap;
  getSelectionState: (optionName: string, optionValue: string) => {
    exists: boolean;
    purchasable: boolean;
  };
  onSelect: (groupName: string, value: string) => void;
  chipStyle?: 'default' | 'picker';
};

const ProductOptionGroup = React.memo(function ProductOptionGroup({
  group,
  colorOptionName,
  sizeOptionName,
  variantNodes,
  productImageEdges = [],
  selectedOptionsMap,
  getSelectionState,
  onSelect,
  chipStyle = 'default',
}: ProductOptionGroupProps) {
  const isColorGroup = Boolean(
    colorOptionName &&
      normalizeOptionName(group.name) === normalizeOptionName(colorOptionName)
  );
  const isPicker = chipStyle === 'picker';

  const renderColorSwatch = (value: string) => {
    const active = optionValuesEqual(selectedOptionsMap[group.name], value);
    const { exists, purchasable } = getSelectionState(group.name, value);
    const soldOut = exists && !purchasable;
    const swatch = getColorImageForValue(
      variantNodes,
      group.name,
      value,
      selectedOptionsMap,
      productImageEdges
    );
    const { galleryImageUrl, swatchImageUrl } = resolveColorSwatchImageUrls(swatch?.url);
    const label = getColorDisplayLabel(group.name, value);

    if (galleryImageUrl || swatchImageUrl) {
      logSwatchImageQuality({
        colorValue: value,
        originalUrl: galleryImageUrl,
        swatchUrl: swatchImageUrl,
        width: SWATCH_DISPLAY_SIZE,
        height: SWATCH_DISPLAY_SIZE,
      });
    }

    logSwatchUiQuality({
      colorValue: value,
      swatchImageUrl,
      displaySize: SWATCH_DISPLAY_SIZE,
      resizeMode: SWATCH_RESIZE_MODE,
      isSelected: active,
      isSoldOut: soldOut,
      isDisabled: !exists,
    });

    return (
      <Pressable
        key={`${chipStyle}-${group.name}-${value}`}
        onPress={() => {
          if (!exists) return;
          onSelect(group.name, value);
        }}
        style={[
          styles.colorSwatchButton,
          active && styles.colorSwatchButtonActive,
        ]}
      >
        {swatchImageUrl ? (
          <View style={styles.colorSwatchImageWrap}>
            <Image
              source={{ uri: swatchImageUrl }}
              style={styles.colorSwatchImage}
              resizeMode={SWATCH_RESIZE_MODE}
            />
          </View>
        ) : (
          <View style={styles.colorSwatchTextWrap}>
            <Text
              style={[
                styles.colorSwatchText,
                active && styles.colorSwatchTextActive,
              ]}
              numberOfLines={2}
            >
              {label}
            </Text>
          </View>
        )}
      </Pressable>
    );
  };

  const renderOptionChip = (value: string) => {
    const active = optionValuesEqual(selectedOptionsMap[group.name], value);
    const { exists } = getSelectionState(group.name, value);

    return (
      <Pressable
        key={`${chipStyle}-${group.name}-${value}`}
        onPress={() => {
          if (!exists) return;
          onSelect(group.name, value);
        }}
        style={[
          isPicker ? styles.variantPickerChip : styles.optionChip,
          active && (isPicker ? styles.variantPickerChipActive : styles.optionChipActive),
        ]}
      >
        <Text
          style={[
            isPicker ? styles.variantPickerChipText : styles.optionChipText,
            active &&
              (isPicker ? styles.variantPickerChipTextActive : styles.optionChipTextActive),
          ]}
        >
          {value}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={isPicker ? styles.variantPickerGroup : styles.optionGroupBlock}>
      <View style={isPicker ? undefined : styles.optionGroupHeader}>
        <Text style={isPicker ? styles.variantPickerGroupTitle : styles.optionGroupTitle}>
          {group.name}
        </Text>
        {!isPicker ? (
          <Text style={styles.optionGroupValue}>
            {isColorGroup
              ? getColorDisplayLabel(group.name, selectedOptionsMap[group.name] || '')
              : selectedOptionsMap[group.name] || 'Choose'}
          </Text>
        ) : null}
      </View>

      {isColorGroup ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.colorSwatchScrollContent}
        >
          {group.values.map(renderColorSwatch)}
        </ScrollView>
      ) : (
        <View style={isPicker ? styles.variantPickerChipGrid : styles.optionChipWrap}>
          {group.values.map(renderOptionChip)}
        </View>
      )}
    </View>
  );
});

export default function ProductScreen() {
  const {
    handle,
    from,
    preview,
    openReview,
    reviewOrderId,
    reviewItemId,
    reviewTitle,
    reviewImage,
    reviewVariantTitle,
  } = useLocalSearchParams<{
    handle?: string;
    from?: string;
    preview?: string;
    openReview?: string;
    reviewOrderId?: string;
    reviewItemId?: string;
    reviewTitle?: string;
    reviewImage?: string;
    reviewVariantTitle?: string;
  }>();
  const {
    addToCart,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    formatMoney,
  } = useCart();
  const { isSignedIn, profileId } = useUser();
  const insets = useSafeAreaInsets();

  const verticalScrollRef = useRef<ScrollView | null>(null);
  const galleryScrollRef = useRef<FlatList<any> | null>(null);
  const fullscreenGalleryRef = useRef<FlatList<any> | null>(null);
  const openedReviewFromRouteRef = useRef(false);
  const initialGalleryFocusHandleRef = useRef('');
  const variantImageEnrichRef = useRef('');
  const backendVariantRefreshRef = useRef('');
  const productOpenStartedAtRef = useRef(Date.now());
  const recommendationsRequestRef = useRef(0);
  const recommendationsLockedHandleRef = useRef('');

  const initialPreview = useMemo(
    () => parseProductPreviewFromParams({ handle, preview }),
    [handle, preview]
  );
  const initialProduct = useMemo(
    () =>
      typeof handle === 'string' && handle.trim()
        ? resolveInstantProductDetail(handle, initialPreview)
        : null,
    [handle, initialPreview]
  );

  const [product, setProduct] = useState<any>(initialProduct);
  const [recommendedProducts, setRecommendedProducts] = useState<CatalogListProduct[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [loading, setLoading] = useState(() => !productHasInstantRenderableDetail(initialProduct));
  const [detailRefreshing, setDetailRefreshing] = useState(false);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [judgeMeWidgetHtml, setJudgeMeWidgetHtml] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedVariant, setSelectedVariant] = useState<any>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [showPromoBar, setShowPromoBar] = useState(true);
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [showVariantPicker, setShowVariantPicker] = useState(false);
  const [selectedOptionsMap, setSelectedOptionsMap] = useState<VariantOptionMap>({});

  const [reviews] = useState<any[]>([]);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [newReviewText, setNewReviewText] = useState('');
  const [newReviewRating, setNewReviewRating] = useState(5);
  const handleBackPress = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return true;
    }

    if (from === 'categories' || from === 'collection') {
      router.replace('/(tabs)/categories');
      return true;
    }

    if (from === 'account') {
      router.replace('/(tabs)/account');
      return true;
    }

    router.replace('/(tabs)');
    return true;
  }, [from]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [handleBackPress]);

  useEffect(() => {
    recommendationsRequestRef.current += 1;
    recommendationsLockedHandleRef.current = '';
    setRecommendedProducts([]);
    setRecommendationsLoading(false);
  }, [handle]);

  const [sectionY, setSectionY] = useState<Record<TabKey, number>>({
    overview: 0,
    details: 0,
    similar: 0,
  });

  const promoTranslateY = useRef(new Animated.Value(40)).current;
  const promoOpacity = useRef(new Animated.Value(0)).current;
  const promoPulse = useRef(new Animated.Value(0)).current;
  const galleryDragY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (typeof handle !== 'string' || !handle.trim()) {
      return;
    }

    productOpenStartedAtRef.current = Date.now();
    console.log('[NOOD product] route opened', { handle, from: from || null });
    const nextPreview = parseProductPreviewFromParams({ handle, preview });
    const previewProduct = nextPreview ? buildProductDetailFromPreview(nextPreview) : null;
    const instantProduct = resolveInstantProductDetail(handle, nextPreview);
    const routePayloadHasVariants = productHasRenderableVariants(previewProduct);
    const instantHasVariants = productHasRenderableVariants(instantProduct);
    const hasInstantPreview = productHasInstantRenderableDetail(instantProduct);

    logInstantVariants(`routePayloadHasVariants ${routePayloadHasVariants}`);
    logInstantVariants(`instantHasVariants ${instantHasVariants}`);

    void (async () => {
      const cached = await readProductDetailCache(handle);
      logInstantVariants(`localCacheHasVariants ${productHasRenderableVariants(cached)}`);

      if (!cached || !productHasInstantRenderableDetail(cached)) return;

      const merged = mergeStrongerProductDetail(previewProduct, cached);
      if (!merged || !productHasRenderableVariants(merged)) {
        if (!previewProduct && merged) {
          setProduct(merged);
          setLoading(false);
          applyProductVariantState(merged, setSelectedVariant, setSelectedOptionsMap, 'cache');
        }
        return;
      }

      if (
        instantHasVariants &&
        productVariantCount(instantProduct) >= productVariantCount(merged)
      ) {
        return;
      }

      setProduct(merged);
      setLoading(false);
      applyProductVariantState(merged, setSelectedVariant, setSelectedOptionsMap, 'cache');
      logInstantVariants(`asyncCacheUpgrade variantCount=${productVariantCount(merged)}`);
      console.log('[NOOD product] cached product used', {
        handle,
        source: 'detail-cache-upgrade',
      });
      console.log(
        `[NOOD product] detail ready time ${Date.now() - productOpenStartedAtRef.current}ms`
      );
    })();

    if (instantProduct && hasInstantPreview) {
      setProduct(instantProduct);
      setLoading(false);
      setCurrentIndex(0);
      setActiveTab('overview');
      setDescriptionExpanded(false);
      setShowPromoBar(true);
      applyProductVariantState(instantProduct, setSelectedVariant, setSelectedOptionsMap, 'preview');
      logInstantVariants(`firstRenderVariantCount ${productVariantCount(instantProduct)}`);
      logInstantVariants(`firstRenderMs ${Date.now() - productOpenStartedAtRef.current}`);
      console.log('[NOOD product] cached product used', {
        handle,
        source: instantHasVariants ? 'detail-cache' : 'route-preview',
        hasVariants: instantHasVariants || routePayloadHasVariants,
      });
      console.log(
        `[NOOD product] detail ready time ${Date.now() - productOpenStartedAtRef.current}ms`
      );
    }

    variantImageEnrichRef.current = '';
    backendVariantRefreshRef.current = '';

    void fetchProduct(handle, hasInstantPreview, nextPreview);
    void ensureCatalogFreshness('product-detail');
  }, [handle, preview]);

  useEffect(() => {
    if (!showGalleryModal) return;

    galleryDragY.setValue(0);
    setTimeout(() => {
      fullscreenGalleryRef.current?.scrollToIndex({
        index: currentIndex,
        animated: false,
      });
    }, 0);
  }, [currentIndex, galleryDragY, showGalleryModal]);

  useEffect(() => {
    if (typeof handle === 'string' && handle.trim()) {
      fetchJudgeMeWidget(handle);
      return;
    }

    setJudgeMeWidgetHtml('');
  }, [handle]);

  useEffect(() => {
    if (!showPromoBar) {
      promoOpacity.setValue(0);
      promoTranslateY.setValue(40);
      promoPulse.setValue(0);
      return;
    }

    Animated.parallel([
      Animated.timing(promoTranslateY, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(promoOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(promoPulse, {
          toValue: -4,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(promoPulse, {
          toValue: 0,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    );

    loop.start();

    return () => {
      loop.stop();
    };
  }, [showPromoBar, promoOpacity, promoPulse, promoTranslateY]);

  const shopifyFetch = async (query: string, variables?: Record<string, any>) => {
    const json = await catalogFetch(query, variables);

    if (json?.errors) {
      console.log('Catalog GraphQL errors:', json.errors);
    }

    return json;
  };

  const loadRecommendationsForProduct = useCallback(async (productData: any) => {
    const productHandle = String(productData?.handle || '').trim();
    const productId = String(productData?.id || '').trim();

    if (!productHandle || !productId) {
      setRecommendedProducts([]);
      setRecommendationsLoading(false);
      return;
    }

    if (recommendationsLockedHandleRef.current === productHandle) {
      return;
    }

    const requestId = ++recommendationsRequestRef.current;
    setRecommendationsLoading(true);

    try {
      const collectionHandles =
        productData?.collections?.edges
          ?.map((entry: any) => String(entry?.node?.handle || '').trim())
          .filter(Boolean) || [];

      const result = await loadProductPageRecommendations({
        productId,
        handle: productHandle,
        title: productData?.title,
        tags: Array.isArray(productData?.tags) ? productData.tags.map(String) : [],
        productType: productData?.productType,
        collectionHandles,
        vendor: productData?.vendor,
      });

      if (requestId !== recommendationsRequestRef.current) return;

      console.log('[RECOMMENDATIONS_DEBUG]', {
        currentHandle: productHandle,
        currentCollection: collectionHandles[0] || null,
        recommendedCount: result.products.length,
        handles: result.products.map((item) => item.handle),
        source: result.source,
      });

      if (result.products.length > 0) {
        setRecommendedProducts(result.products);
        recommendationsLockedHandleRef.current = productHandle;
      } else {
        setRecommendedProducts([]);
      }
    } catch (error) {
      if (requestId !== recommendationsRequestRef.current) return;
      console.log('loadRecommendationsForProduct error:', error);
      setRecommendedProducts([]);
    } finally {
      if (requestId === recommendationsRequestRef.current) {
        setRecommendationsLoading(false);
      }
    }
  }, []);

  const fetchProduct = async (
    productHandle: string,
    hasInstantRenderable = false,
    routePreview: ReturnType<typeof parseProductPreviewFromParams> = null
  ) => {
    try {
      if (!hasInstantRenderable) {
        setLoading(true);
        setCurrentIndex(0);
        setActiveTab('overview');
        setDescriptionExpanded(false);
        setShowPromoBar(true);
      } else {
        setDetailRefreshing(true);
      }

      let p = await getProductFast(productHandle, routePreview);

      if (p && !productHasRenderableVariants(p)) {
        const refreshed = await refreshProductDetailFromBackend(productHandle, p);
        if (refreshed && productHasRenderableVariants(refreshed)) {
          p = refreshed;
          backendVariantRefreshRef.current = productHandle;
        }
      }

      const resolved = mergeStrongerProductDetail(
        routePreview ? buildProductDetailFromPreview(routePreview) : null,
        p
      );

      logVariantImageFinalCheck(resolved);
      setProduct((current: any) => mergeStrongerProductDetail(current, resolved) || resolved);
      applyProductVariantState(resolved, setSelectedVariant, setSelectedOptionsMap, 'detail');
      logProductStockState(resolved, 'detail', {
        selectedVariant: resolved?.variants?.edges?.[0]?.node,
      });
      setLoading(false);
      setDetailRefreshing(false);
      logInstantVariants(`firstRenderVariantCount ${productVariantCount(resolved)}`);
      logInstantVariants(`firstRenderMs ${Date.now() - productOpenStartedAtRef.current}`);
      console.log(
        `[NOOD product] detail ready time ${Date.now() - productOpenStartedAtRef.current}ms`
      );

      if (resolved?.handle) {
        void recordProductView(
          { profileId: profileId || 'guest', isSignedIn },
          {
            handle: String(resolved.handle),
            id: resolved.id ? String(resolved.id) : undefined,
            title: resolved.title ? String(resolved.title) : undefined,
            tags: Array.isArray(resolved.tags) ? resolved.tags.map(String) : [],
            productType: resolved.productType ? String(resolved.productType) : undefined,
            collectionHandles:
              resolved.collections?.edges?.map((entry: any) => entry?.node?.handle).filter(Boolean) || [],
            vendor: resolved.vendor ? String(resolved.vendor) : undefined,
          }
        );
      }

      if (
        resolved?.variants?.edges?.length &&
        (process.env.EXPO_PUBLIC_PRODUCT_LOAD_DEBUG === 'true' ||
          process.env.EXPO_PUBLIC_PRODUCT_LOAD_DEBUG === '1')
      ) {
        const initialVariant = resolved.variants.edges[0].node;
        console.log('[NOOD product load] product detail initial variant', {
          title: resolved.title,
          handle: resolved.handle,
          productId: resolved.id,
          variantId: initialVariant?.id || '',
          variantTitle: initialVariant?.title || '',
        });
      }

      if (resolved?.id && resolved?.handle) {
        void loadRecommendationsForProduct(resolved);
      } else {
        setRecommendedProducts([]);
        setRecommendationsLoading(false);
      }

      setTimeout(() => {
        verticalScrollRef.current?.scrollTo({ y: 0, animated: false });
      }, 0);
    } catch (error) {
      console.log('fetchProduct error:', error);
      setProduct(null);
      setSelectedVariant(null);
      setSelectedOptionsMap({});
      setRecommendedProducts([]);
      setRecommendationsLoading(false);
    } finally {
      setLoading(false);
      setDetailRefreshing(false);
    }
  };

  const fetchJudgeMeWidget = async (productHandle: string) => {
    if (failedJudgeMeHandles.has(productHandle)) {
      setJudgeMeWidgetHtml('');
      setReviewsLoading(false);
      return;
    }

    try {
      setReviewsLoading(true);

      const params = new URLSearchParams({
        shop_domain: JUDGEME_SHOP_DOMAIN,
        api_token: JUDGEME_PUBLIC_API_TOKEN,
        handle: productHandle,
      });

      const response = await fetch(
        `https://judge.me/api/v1/widgets/product_review?${params.toString()}`
      );
      const html = await response.text();

      if (!response.ok || !html.trim()) {
        throw new Error('Could not load Judge.me reviews.');
      }

      setJudgeMeWidgetHtml(html);
    } catch {
      failedJudgeMeHandles.add(productHandle);
      setJudgeMeWidgetHtml('');
    } finally {
      setReviewsLoading(false);
    }
  };

  const variantNodes = useMemo(
    () => (product?.variants?.edges || []).map((edge: any) => edge.node).filter(Boolean),
    [product]
  );

  const productSwatchImageCandidates = useMemo(
    () => collectProductMediaImages(product),
    [product]
  );

  const gallery = useMemo(() => {
    if (!product) return [];

    let baseItems: Array<{ id: string; type: string; url: string; previewUrl?: string | null }> =
      [];

    if (product.media?.edges?.length) {
      const mediaItems = product.media.edges
        .map((edge: any) => {
          const node = edge.node;

          if (node.__typename === 'MediaImage' && node.image?.url) {
            return {
              id: String(node.id || node.image.url),
              type: 'image',
              url: node.image.url,
            };
          }

          if (node.__typename === 'Video') {
            const source =
              node.sources?.find((s: any) => s.mimeType?.includes('mp4')) ||
              node.sources?.[0];

            if (!source?.url) return null;

            return {
              id: String(node.id || source.url),
              type: 'video',
              url: source.url,
              previewUrl: node.previewImage?.url || product?.featuredImage?.url || null,
            };
          }

          return null;
        })
        .filter(Boolean);

      if (mediaItems.length > 0) {
        baseItems = mediaItems;
      }
    }

    if (!baseItems.length) {
      baseItems = (product.images?.edges ?? [])
        .map((edge: any) => {
          const uri = getValidMediaUri(edge?.node?.url);
          if (!uri) {
            logInvalidMediaSource(
              'ProductScreen.galleryFallback',
              String(product?.handle || 'unknown')
            );
            return null;
          }

          return {
            id: String(edge?.node?.id || uri),
            type: 'image',
            url: uri,
          };
        })
        .filter(Boolean);
    }

    const seenUrls = new Set(baseItems.map((item) => item.url));
    const mergedItems = [...baseItems];

    variantNodes.forEach((variant: any) => {
      const uri = getValidMediaUri(variant?.image?.url);
      if (!uri || seenUrls.has(uri)) return;

      mergedItems.push({
        id: `variant-${variant.id || uri}`,
        type: 'image',
        url: uri,
      });
      seenUrls.add(uri);
    });

    return mergedItems;
  }, [product, variantNodes]);

  const productPrimaryImage = useMemo(() => {
    return (
      getValidMediaUri(selectedVariant?.image?.url) ||
      getValidMediaUri(gallery?.[currentIndex]?.url) ||
      getValidMediaUri(gallery?.[0]?.url) ||
      getValidMediaUri(product?.featuredImage?.url) ||
      PRODUCT_IMAGE_PLACEHOLDER
    );
  }, [currentIndex, gallery, product, selectedVariant]);

  useEffect(() => {
    if (openedReviewFromRouteRef.current || !product || openReview !== '1') return;

    openedReviewFromRouteRef.current = true;
    setShowReviewModal(true);
  }, [openReview, product]);

  const optionGroups = useMemo(() => {
    const groups = new Map<string, string[]>();

    variantNodes.forEach((variant: any) => {
      (variant?.selectedOptions || []).forEach((option: any) => {
        const name = String(option?.name || '').trim();
        const value = String(option?.value || '').trim();
        if (!name || !value) return;

        if (!groups.has(name)) groups.set(name, []);

        const values = groups.get(name)!;
        if (!values.includes(value)) values.push(value);
      });
    });

    return Array.from(groups.entries()).map(([name, values]) => ({ name, values }));
  }, [variantNodes]);

  const colorOptionName = useMemo(
    () => optionGroups.find((group) => isColorOptionName(group.name))?.name || null,
    [optionGroups]
  );

  const sizeOptionName = useMemo(
    () => optionGroups.find((group) => isSizeOptionName(group.name))?.name || null,
    [optionGroups]
  );

  useEffect(() => {
    if (!optionGroups.length) return;

    if (colorOptionName) {
      buildColorImageMap(
        variantNodes,
        colorOptionName,
        selectedOptionsMap,
        productSwatchImageCandidates
      );
    }

    logProductVariantImageDebug(
      optionGroups,
      colorOptionName,
      selectedOptionsMap,
      selectedVariant
    );
  }, [
    colorOptionName,
    optionGroups,
    productSwatchImageCandidates,
    selectedOptionsMap,
    selectedVariant,
    variantNodes,
  ]);

  useEffect(() => {
    const productHandle = String(product?.handle || '').trim();
    if (!productHandle || backendVariantRefreshRef.current === productHandle) return;

    backendVariantRefreshRef.current = productHandle;

    void (async () => {
      const startedAt = Date.now();
      const beforeImageCount = countVariantImageUrls(product);
      logInstantVariants('backendRefreshStarted');

      const refreshed = await refreshProductDetailFromBackend(productHandle, product);
      logInstantVariants(`backendRefreshCompleted ms=${Date.now() - startedAt}`);

      if (!refreshed || refreshed === product) return;

      const afterImageCount = countVariantImageUrls(refreshed);
      const updatedImageCount = Math.max(0, afterImageCount - beforeImageCount);
      const merged = mergeStrongerProductDetail(product, refreshed) || refreshed;

      if (merged === product) return;

      setProduct(merged);

      const matchedVariant = findVariantForOptions(
        (merged?.variants?.edges || []).map((edge: any) => edge?.node).filter(Boolean),
        selectedOptionsMap
      );

      if (matchedVariant) {
        setSelectedVariant(matchedVariant);
      } else {
        applyProductVariantState(merged, setSelectedVariant, setSelectedOptionsMap, 'detail');
      }

      logProductStockState(merged, 'backend', { selectedVariant: matchedVariant });

      if (updatedImageCount > 0) {
        logInstantVariants(`swatchImagesUpdated ${updatedImageCount}`);
      }
    })();
  }, [product, selectedOptionsMap]);

  useEffect(() => {
    const productHandle = String(product?.handle || '').trim();
    if (!productHandle || variantImageEnrichRef.current === productHandle) return;
    if (!productNeedsVariantImageEnrichment(product, colorOptionName)) {
      console.log('[PRODUCT LOAD SPEED] enrichment skipped reason=color-swatch-images-ready');
      return;
    }

    variantImageEnrichRef.current = productHandle;

    void (async () => {
      logInstantVariants('enrichmentStarted reason=missing-variant-or-swatch-images');
      const beforeImageCount = countVariantImageUrls(product);
      const enriched = await refreshProductVariantImages(product, true);
      if (!enriched || enriched === product) return;

      setProduct(enriched);
      const updatedImageCount = Math.max(0, countVariantImageUrls(enriched) - beforeImageCount);
      if (updatedImageCount > 0) {
        logInstantVariants(`swatchImagesUpdated ${updatedImageCount}`);
      }
      const matchedVariant = findVariantForOptions(
        (enriched?.variants?.edges || []).map((edge: any) => edge?.node).filter(Boolean),
        selectedOptionsMap
      );

      if (matchedVariant) {
        setSelectedVariant(matchedVariant);
      }
    })();
  }, [colorOptionName, product, selectedOptionsMap]);

  const getSelectionState = useCallback(
    (optionName: string, optionValue: string) =>
      getOptionSelectionState(variantNodes, optionName, optionValue, selectedOptionsMap, {
        colorOptionName,
        sizeOptionName,
      }),
    [colorOptionName, selectedOptionsMap, sizeOptionName, variantNodes]
  );

  const focusGalleryOnImageUrl = useCallback(
    (imageUrl?: string | null) => {
      const validImageUrl = getValidMediaUri(imageUrl);
      if (!validImageUrl || !gallery.length) return false;

      const targetIndex = gallery.findIndex((item) => item.url === validImageUrl);
      if (targetIndex < 0) return false;

      setCurrentIndex(targetIndex);
      requestAnimationFrame(() => {
        galleryScrollRef.current?.scrollToIndex({ index: targetIndex, animated: true });
      });

      return true;
    },
    [gallery]
  );

  const focusGalleryOnVariant = useCallback(
    (variant: any) => {
      focusGalleryOnImageUrl(variant?.image?.url);
    },
    [focusGalleryOnImageUrl]
  );

  const focusGalleryOnColorValue = useCallback(
    (colorValue: string, optionsMap: VariantOptionMap) => {
      if (!colorOptionName) return false;

      const swatch = getColorImageForValue(
        variantNodes,
        colorOptionName,
        colorValue,
        optionsMap,
        productSwatchImageCandidates
      );

      return focusGalleryOnImageUrl(swatch?.url);
    },
    [colorOptionName, focusGalleryOnImageUrl, productSwatchImageCandidates, variantNodes]
  );

  const syncVariantSelection = useCallback(
    (nextOptions: VariantOptionMap, options: { focusGallery?: boolean } = {}) => {
      if (!variantNodes.length) return;

      const exactMatch = findVariantForOptions(variantNodes, nextOptions);

      if (exactMatch) {
        setSelectedVariant(exactMatch);
        logVariantClickDebug('[PRODUCT VARIANT CLICK DEBUG] selectedVariant', {
          variantId: String(exactMatch.id || ''),
          availableForSale: exactMatch.availableForSale !== false,
          selectedOptions: nextOptions,
        });
        if (options.focusGallery !== false) {
          focusGalleryOnVariant(exactMatch);
        }
        return;
      }

      logVariantClickDebug('[PRODUCT VARIANT CLICK DEBUG] disabled reason', {
        reason: 'no-exact-variant-match',
        selectedOptions: nextOptions,
      });
    },
    [focusGalleryOnVariant, variantNodes]
  );

  const handleOptionSelect = useCallback(
    (groupName: string, value: string) => {
      const isSize = Boolean(sizeOptionName && groupName === sizeOptionName);
      const isColor = Boolean(colorOptionName && groupName === colorOptionName);

      let nextOptions: VariantOptionMap = {
        ...selectedOptionsMap,
        [groupName]: value,
      };

      if (isSize) {
        logVariantClickDebug('[PRODUCT VARIANT CLICK DEBUG] tapped size', {
          size: value,
          previousColor: colorOptionName ? selectedOptionsMap[colorOptionName] : null,
        });

        if (colorOptionName) {
          const validColors = getColorsForSize(
            variantNodes,
            groupName,
            value,
            colorOptionName
          );

          logVariantClickDebug(
            '[PRODUCT VARIANT CLICK DEBUG] matching variants for selected size',
            {
              size: value,
              colors: validColors,
            }
          );

          const currentColor = nextOptions[colorOptionName];
          if (
            !currentColor ||
            !validColors.some((color) => optionValuesEqual(color, currentColor))
          ) {
            const firstColor = getFirstColorForSize(
              variantNodes,
              groupName,
              value,
              colorOptionName
            );

            if (firstColor) {
              nextOptions = {
                ...nextOptions,
                [colorOptionName]: firstColor,
              };
            }
          }
        }
      }

      if (isColor) {
        logVariantClickDebug('[PRODUCT VARIANT CLICK DEBUG] tapped color', {
          color: value,
          selectedSize: sizeOptionName ? nextOptions[sizeOptionName] : null,
        });

        logVariantClickDebug(
          '[PRODUCT VARIANT CLICK DEBUG] matching variants for selected color',
          {
            color: value,
            selectedSize: sizeOptionName ? nextOptions[sizeOptionName] : null,
            variantIds: variantNodes
              .filter((variant: any) => {
                if (!colorOptionName) return false;
                const matchesColor = variant?.selectedOptions?.some(
                  (option: any) =>
                    isColorOptionName(option?.name) &&
                    optionValuesEqual(option?.value, value)
                );
                if (!matchesColor) return false;
                if (sizeOptionName && nextOptions[sizeOptionName]) {
                  return variant?.selectedOptions?.some(
                    (option: any) =>
                      isSizeOptionName(option?.name) &&
                      optionValuesEqual(option?.value, nextOptions[sizeOptionName])
                  );
                }
                return true;
              })
              .map((variant: any) => String(variant?.id || '')),
          }
        );
      }

      const selectionState = getSelectionState(groupName, value);
      if (!selectionState.exists) {
        logVariantClickDebug('[PRODUCT VARIANT CLICK DEBUG] disabled reason', {
          reason: 'variant-combination-missing',
          optionName: groupName,
          optionValue: value,
        });
        return;
      }

      setSelectedOptionsMap(nextOptions);
      syncVariantSelection(nextOptions, { focusGallery: !isColor });

      if (isColor) {
        focusGalleryOnColorValue(value, nextOptions);
      }
    },
    [
      colorOptionName,
      focusGalleryOnColorValue,
      getSelectionState,
      sizeOptionName,
      selectedOptionsMap,
      syncVariantSelection,
      variantNodes,
    ]
  );

  useEffect(() => {
    const productHandle = String(product?.handle || '').trim();
    if (!productHandle || !selectedVariant || !gallery.length) return;
    if (initialGalleryFocusHandleRef.current === productHandle) return;

    initialGalleryFocusHandleRef.current = productHandle;
    focusGalleryOnVariant(selectedVariant);
  }, [focusGalleryOnVariant, gallery.length, product?.handle, selectedVariant]);

  const formatDisplayPrice = useCallback(
    (amount?: string | number | null, fromCurrency?: string | null) =>
      formatMoney(
        convertPrice(
          Number(amount || 0),
          normalizeCatalogCurrencyCode(fromCurrency || undefined),
          selectedCurrency
        ),
        selectedCurrency
      ),
    [convertPrice, formatMoney, selectedCurrency]
  );

  const openRecommendedProduct = useCallback((item: CatalogListProduct) => {
    if (!item.handle) return;

    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(item) as any,
    });
  }, []);

  const recommendationPriceById = useMemo(() => {
    const map = new Map<string, string>();
    recommendedProducts.forEach((item) => {
      const key = `${item.id}-${item.handle}`;
      map.set(key, formatDisplayPrice(item.priceAmount, item.currencyCode));
    });
    return map;
  }, [formatDisplayPrice, recommendedProducts]);

  const productSoldOut = useMemo(() => computeProductSoldOut(product), [product]);

  useEffect(() => {
    if (!product?.handle) return;
    logProductStockState(product, 'detail', { selectedVariant });
  }, [product, selectedVariant]);

  const priceText = useMemo(() => {
    if (selectedVariant?.price?.amount) {
      return formatDisplayPrice(
        selectedVariant.price.amount,
        selectedVariant.price.currencyCode
      );
    }

    if (product?.priceRange?.minVariantPrice?.amount) {
      return formatDisplayPrice(
        product.priceRange.minVariantPrice.amount,
        product.priceRange.minVariantPrice.currencyCode
      );
    }

    return '';
  }, [formatDisplayPrice, selectedVariant, product]);

  const cleanDescriptionHtml = useMemo(() => {
    let html = product?.descriptionHtml || '';

    html = html.replace(/src=(['"])about:[^'"]+\1/gi, 'src=""');
    html = html.replace(/src=(['"])\s*about:\/\/[^'"]+\1/gi, 'src=""');
    html = html.replace(/src=(['"])\s*lazyload[^'"]*\1/gi, 'src=""');
    html = html.replace(/src=(['"])\s*\.\.\/[^'"]+\1/gi, 'src=""');
    html = html.replace(/src=(['"])\s*\/\/([^'"]+)\1/gi, 'src="https://$2"');
    html = html.replace(/data-src=(['"])([^'"]+)\1/gi, 'src="$2"');
    html = html.replace(/data-original=(['"])([^'"]+)\1/gi, 'src="$2"');
    html = html.replace(/<img\b(?=[^>]*\bsrc=(['"])\s*\1)[^>]*>/gi, '');
    html = html.replace(/<img\b(?![^>]*\bsrc=)[^>]*>/gi, '');

    return html;
  }, [product]);

  const reviewAverage = useMemo(() => {
    if (!reviews.length) return '0.0';
    const total = reviews.reduce((sum, r) => sum + r.rating, 0);
    return (total / reviews.length).toFixed(1);
  }, [reviews]);

  const handleAddToCart = () => {
    if (!product) return;
    if (productSoldOut) {
      noodAlert('Sold out', 'This product is currently unavailable.');
      return;
    }
    if (!selectedVariant) return;
    setShowVariantPicker(true);
  };

  const confirmAddToCart = () => {
    if (!selectedVariant || !product) return;

    if (productSoldOut || !isVariantPurchasable(selectedVariant)) {
      noodAlert('Sold out', 'This variant is currently unavailable.');
      return;
    }

    const selectedVariantId = String(selectedVariant.id || '').trim();

    if (!selectedVariantId) {
      console.log('[NOOD cart] missing selected variantId on product detail', {
        product,
        selectedVariant,
      });
      noodAlert('Product unavailable', 'This product is missing its Shopify variant. Please try again.');
      return;
    }

    console.log('[NOOD cart] product detail Add to Cart selected variant', {
      title: product.title,
      handle: product.handle,
      productId: product.id,
      variantId: selectedVariantId,
      variantTitle: selectedVariant.title || 'Default Title',
    });

    const added = addToCart({
      id: selectedVariantId,
      productId: product.id,
      variantId: selectedVariantId,
      title: product.title,
      handle: product.handle,
      variantTitle: selectedVariant.title || 'Default Title',
      price: Number(selectedVariant.price?.amount || 0),
      currencyCode: selectedVariant.price?.currencyCode,
      baseCurrency: normalizeCatalogCurrencyCode(
        selectedVariant.price?.currencyCode ||
          product?.priceRange?.minVariantPrice?.currencyCode
      ),
      image: productPrimaryImage,
      quantity: 1,
    });

    if (added) {
      setShowVariantPicker(false);
      noodAlert('Added to cart', selectedVariant.title || 'Default Title');
    }
  };

  const handleBuyNow = () => {
    if (!product) return;

    if (productSoldOut) {
      noodAlert('Sold out', 'This product is currently unavailable.');
      return;
    }

    if (!selectedVariant) return;

    if (!isVariantPurchasable(selectedVariant)) {
      noodAlert('Sold out', 'This variant is currently unavailable.');
      return;
    }

    const selectedVariantId = String(selectedVariant.id || '').trim();

    if (!selectedVariantId) {
      console.log('[NOOD cart] missing selected variantId on Buy Now', {
        product,
        selectedVariant,
      });
      noodAlert('Product unavailable', 'This product is missing its Shopify variant. Please try again.');
      return;
    }

    console.log('[NOOD cart] product detail Buy Now selected variant', {
      title: product.title,
      handle: product.handle,
      productId: product.id,
      variantId: selectedVariantId,
      variantTitle: selectedVariant.title || 'Default Title',
    });

    const added = addToCart({
      id: selectedVariantId,
      productId: String(product.id),
      variantId: selectedVariantId,
      title: product.title,
      handle: product.handle,
      variantTitle: selectedVariant.title || 'Default Title',
      price: Number(selectedVariant.price?.amount || 0),
      currencyCode: selectedVariant.price?.currencyCode,
      baseCurrency: normalizeCatalogCurrencyCode(
        selectedVariant.price?.currencyCode ||
          product?.priceRange?.minVariantPrice?.currencyCode
      ),
      image: productPrimaryImage,
      quantity: 1,
    });

    if (added) {
      router.push('/(tabs)/cart');
    }
  };

  const onSectionLayout =
    (key: TabKey) =>
    (event: LayoutChangeEvent) => {
      const y = event?.nativeEvent?.layout?.y ?? 0;

      setSectionY((prev) => ({
        ...prev,
        [key]: y,
      }));
    };

  const activeTabRef = useRef<TabKey>('overview');
  const lastTabScrollUpdateRef = useRef(0);

  const scrollToSection = (key: TabKey) => {
    activeTabRef.current = key;
    setActiveTab(key);
    verticalScrollRef.current?.scrollTo({
      y: Math.max(sectionY[key] - 8, 0),
      animated: true,
    });
  };

  const onVerticalScroll = useCallback(
    (event: any) => {
      const y = event?.nativeEvent?.contentOffset?.y ?? 0;

      let nextTab: TabKey = 'overview';
      if (y >= sectionY.similar - 120) {
        nextTab = 'similar';
      } else if (y >= sectionY.details - 120) {
        nextTab = 'details';
      }

      if (nextTab === activeTabRef.current) return;

      const now = Date.now();
      if (now - lastTabScrollUpdateRef.current < 320) return;

      activeTabRef.current = nextTab;
      lastTabScrollUpdateRef.current = now;
      setActiveTab(nextTab);
    },
    [sectionY.details, sectionY.similar]
  );

  const updateGalleryIndex = useCallback((offsetX: number) => {
    const index = Math.max(0, Math.min(gallery.length - 1, Math.round(offsetX / width)));
    setCurrentIndex(index);
  }, [gallery.length]);

  const renderGalleryItem = useCallback(
    ({ item, index }: { item: any; index: number }) => {
      const mediaUri = getValidMediaUri(item.url);

      if (!mediaUri) {
        logInvalidMediaSource('ProductScreen.gallerySlide', String(index));
        return <View style={styles.slide} />;
      }

      return (
        <Pressable
          style={styles.slide}
          onPress={() => {
            setCurrentIndex(index);
            setShowGalleryModal(true);
          }}
        >
          {item.type === 'image' ? (
            <Image
              source={{ uri: mediaUri }}
              style={styles.media}
              resizeMode="cover"
            />
          ) : (
            <ProductVideoPreview
              key={`gallery-video-${item.id}`}
              previewUri={item.previewUrl || productPrimaryImage}
              style={styles.media}
              resizeMode="cover"
            />
          )}

          <View style={styles.galleryHint}>
            <Ionicons name="expand-outline" size={14} color="#fff" />
            <Text style={styles.galleryHintText}>Tap to view and swipe</Text>
          </View>
        </Pressable>
      );
    },
    [productPrimaryImage]
  );

  const renderFullscreenGalleryItem = useCallback(
    ({ item, index }: { item: any; index: number }) => {
      const mediaUri = getValidMediaUri(item.url);

      if (!mediaUri) {
        logInvalidMediaSource('ProductScreen.fullscreenGallery', String(index));
        return <View style={styles.galleryModalSlide} />;
      }

      return (
        <View style={styles.galleryModalSlide}>
          {item.type === 'image' ? (
            <ZoomableImage
              key={`zoom-${item.id || index}-${mediaUri}`}
              uri={mediaUri}
              width={width - 24}
              height={Math.round(width * 0.78)}
              resizeMode="contain"
            />
          ) : (
            <ProductVideoPreview
              key={`fullscreen-video-${item.id}`}
              previewUri={item.previewUrl || productPrimaryImage}
              style={styles.galleryModalImage}
              resizeMode="contain"
            />
          )}
        </View>
      );
    },
    [productPrimaryImage]
  );

  const galleryPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          showGalleryModal &&
          Math.abs(gesture.dy) > 12 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          if (gesture.dy > 0) {
            galleryDragY.setValue(gesture.dy);
          }
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 140 || gesture.vy > 0.9) {
            Animated.timing(galleryDragY, {
              toValue: width,
              duration: 160,
              useNativeDriver: true,
            }).start(() => {
              galleryDragY.setValue(0);
              setShowGalleryModal(false);
            });
            return;
          }

          Animated.spring(galleryDragY, {
            toValue: 0,
            useNativeDriver: true,
            tension: 70,
            friction: 10,
          }).start();
        },
      }),
    [galleryDragY, showGalleryModal]
  );

  const submitReview = async () => {
    if (!newReviewText.trim()) {
      noodAlert('Review needed', 'Please enter your review text.');
      return;
    }

    if (reviewOrderId && reviewItemId) {
      if (!ACCOUNT_SIGN_IN_GATE_DISABLED && (!isSignedIn || !profileId)) {
        noodAlert('Sign in required', 'Sign in to submit a review for this item.');
        return;
      }

      try {
        const storageKey = getReviewsStorageKey(profileId);
        const saved = await AsyncStorage.getItem(storageKey);
        const existingReviews = saved ? JSON.parse(saved) : [];
        const safeReviews = Array.isArray(existingReviews) ? existingReviews : [];
        const reviewId = `${profileId}:${reviewOrderId}:${reviewItemId}`;
        const nextReview = {
          id: reviewId,
          profileId,
          orderId: String(reviewOrderId),
          orderItemId: String(reviewItemId),
          productId: product?.id ? String(product.id) : undefined,
          title: String(reviewTitle || product?.title || 'Purchased item'),
          image: String(reviewImage || productPrimaryImage),
          handle: String(product?.handle || handle || ''),
          variantTitle: reviewVariantTitle ? String(reviewVariantTitle) : undefined,
          rating: newReviewRating,
          comment: newReviewText.trim(),
          submittedAt: new Date().toISOString(),
        };
        const nextReviews = [
          nextReview,
          ...safeReviews.filter((review: any) => review?.orderItemId !== String(reviewItemId)),
        ];

        await AsyncStorage.setItem(storageKey, JSON.stringify(nextReviews));
        DeviceEventEmitter.emit('customerReviewSubmitted', nextReview);
        setShowReviewModal(false);
        setNewReviewText('');
        setNewReviewRating(5);

        noodAlert('Review submitted', 'Thanks for reviewing your item.', [
          {
            text: 'OK',
            onPress: () => {
              if (from === 'reviews' && router.canGoBack()) {
                router.back();
              }
            },
          },
        ]);
      } catch (error) {
        console.log('Save purchased review error:', error);
        noodAlert('Review not saved', 'Please try submitting your review again.');
      }
      return;
    }

    setShowReviewModal(false);
    setNewReviewText('');
    setNewReviewRating(5);

    const productUrl = product?.handle
      ? `https://noodcaribbean.com/products/${product.handle}`
      : 'https://noodcaribbean.com';

    noodAlert(
      'Continue on store',
      'Live Judge.me reviews are connected. Submit the real review on the store product page.',
      [
        {
          text: 'Open product page',
          onPress: () => {
            void Linking.openURL(productUrl);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  useScreenPerfReporter(
    'product',
    {
      itemCount: recommendedProducts.length,
      isFetching: loading || detailRefreshing || recommendationsLoading,
      isRefreshing: detailRefreshing,
    },
    [
      detailRefreshing,
      loading,
      recommendationsLoading,
      recommendedProducts.length,
    ]
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <NoodSpinner size={58} />
      </View>
    );
  }

  if (!product) {
    return (
      <View style={styles.center}>
        <Text>Product not found</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.topNav, { top: insets.top + 10 }]}>
        <TouchableOpacity style={styles.topNavBtn} onPress={handleBackPress}>
          <Text style={styles.topNavBtnText}>←</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.topNavBtn}
          onPress={() => router.push('/(tabs)/cart')}
        >
          <Text style={styles.topNavBtnText}>🛒</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={verticalScrollRef}
        style={styles.container}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        onScroll={onVerticalScroll}
        scrollEventThrottle={16}
      >
        <FlatList
          ref={galleryScrollRef}
          data={gallery}
          keyExtractor={(item) => `gallery-${item.id}`}
          renderItem={renderGalleryItem}
          horizontal
          pagingEnabled
          directionalLockEnabled
          nestedScrollEnabled
          style={styles.galleryCarousel}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          windowSize={3}
          removeClippedSubviews
          getItemLayout={(_data, index) => ({
            length: width,
            offset: width * index,
            index,
          })}
          onMomentumScrollEnd={(event) => {
            updateGalleryIndex(event.nativeEvent.contentOffset.x);
          }}
        />

        <View style={styles.dots}>
          {gallery.map((item: any, i: number) => (
            <View
              key={`dot-${item.id}`}
              style={[styles.dot, i === currentIndex && styles.activeDot]}
            />
          ))}
        </View>

        <View style={styles.perksStrip}>
          <View style={styles.perkItem}>
            <Text style={styles.perkIcon}>🚚</Text>
            <Text style={styles.perkText}>Free shipping</Text>
          </View>

          <View style={styles.perkDivider} />

          <View style={styles.perkItem}>
            <Text style={styles.perkIcon}>⏰</Text>
            <Text style={styles.perkText}>Fast delivery</Text>
          </View>

          <View style={styles.perkDivider} />

          <View style={styles.perkItem}>
            <Text style={styles.perkIcon}>🔒</Text>
            <Text style={styles.perkText}>Safe payments</Text>
          </View>
        </View>

        <View onLayout={onSectionLayout('overview')}>
          <View style={styles.topCard}>
            <View style={styles.priceRow}>
              <Text style={styles.price}>{priceText}</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Featured</Text>
              </View>
            </View>

            <Text style={styles.title}>{product.title}</Text>

            <View style={styles.shippingHighlight}>
              <Text style={styles.shippingHighlightIcon}>🚚</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.shippingHighlightTitle}>Free shipping for this item</Text>
                <Text style={styles.shippingHighlightText}>
                  Fast delivery in 5-8 business days
                </Text>
              </View>
            </View>

            {product?.variants?.edges?.length > 0 && (
              <View style={styles.optionGroupsWrap}>
                {optionGroups.map((group) => (
                  <ProductOptionGroup
                    key={group.name}
                    group={group}
                    colorOptionName={colorOptionName}
                    sizeOptionName={sizeOptionName}
                    variantNodes={variantNodes}
                    productImageEdges={productSwatchImageCandidates}
                    selectedOptionsMap={selectedOptionsMap}
                    getSelectionState={getSelectionState}
                    onSelect={handleOptionSelect}
                  />
                ))}
              </View>
            )}
          </View>

          <View style={styles.infoCard}>
            <TouchableOpacity
              style={styles.infoRow}
              onPress={() =>
                noodAlert('Shipping & delivery', 'Estimated delivery: 5–9 business days')
              }
            >
              <Text style={styles.infoIcon}>🚚</Text>
              <View style={styles.infoTextWrap}>
                <Text style={styles.infoTitle}>Shipping & delivery</Text>
                <Text style={styles.infoText}>
                  Free shipping available. Tap to view delivery details.
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>

            <View style={styles.infoDivider} />

            <TouchableOpacity
              style={styles.infoRow}
              onPress={() =>
                noodAlert('Safe payments', 'Secure checkout flow and payment protection.')
              }
            >
              <Text style={styles.infoIcon}>🔒</Text>
              <View style={styles.infoTextWrap}>
                <Text style={styles.infoTitle}>Safe payments</Text>
                <Text style={styles.infoText}>
                  Secure checkout flow and payment protection.
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>

            <View style={styles.infoDivider} />

            <TouchableOpacity
              style={styles.infoRow}
              onPress={() =>
                noodAlert('Order guarantee', 'Product details, shipping support, and order help.')
              }
            >
              <Text style={styles.infoIcon}>🛍️</Text>
              <View style={styles.infoTextWrap}>
                <Text style={styles.infoTitle}>Order guarantee</Text>
                <Text style={styles.infoText}>
                  Product details, shipping support, and order help.
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.reviewSummaryWrap}>
          <View style={styles.reviewSummaryBar}>
            <View style={styles.reviewSummaryLeft}>
              <Text style={styles.reviewSummaryScore}>{reviewAverage}</Text>
              <Text style={styles.reviewSummaryStars}>★★★★★</Text>
              <Text style={styles.reviewSummaryCount}>
                ({judgeMeWidgetHtml ? 'Live' : reviews.length})
              </Text>
            </View>

            <TouchableOpacity onPress={() => setShowReviewModal(true)}>
              <Text style={styles.leaveReviewText}>Leave review</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.tabsBar}>
            <TouchableOpacity
              style={styles.tabButton}
              onPress={() => scrollToSection('overview')}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === 'overview' && styles.tabTextActive,
                ]}
              >
                Overview
              </Text>
              {activeTab === 'overview' && <View style={styles.tabUnderline} />}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.tabButton}
              onPress={() => setShowReviewModal(true)}
            >
              <Text style={[styles.tabText, styles.tabTextActive]}>Reviews</Text>
              <View style={styles.tabUnderline} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.tabButton}
              onPress={() => scrollToSection('similar')}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === 'similar' && styles.tabTextActive,
                ]}
              >
                Recommended
              </Text>
              {activeTab === 'similar' && <View style={styles.tabUnderline} />}
            </TouchableOpacity>
          </View>
        </View>

        <View onLayout={onSectionLayout('details')} style={styles.sectionCard}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Product details</Text>

            <TouchableOpacity
              onPress={() => setDescriptionExpanded((prev) => !prev)}
            >
              <Text style={styles.seeMoreText}>
                {descriptionExpanded ? 'See less' : 'See more'}
              </Text>
            </TouchableOpacity>
          </View>

          <View
            style={[
              styles.descriptionWrap,
              !descriptionExpanded && styles.descriptionCollapsed,
            ]}
          >
            <RenderHtml
              contentWidth={width - 56}
              source={{ html: cleanDescriptionHtml }}
              tagsStyles={{
                body: {
                  color: COLORS.text,
                  fontSize: 15,
                  lineHeight: 24,
                },
                p: {
                  marginTop: 0,
                  marginBottom: 12,
                },
                img: {
                  marginTop: 10,
                  marginBottom: 10,
                  borderRadius: 12,
                },
              }}
              renderersProps={{
                img: {
                  enableExperimentalPercentWidth: true,
                },
              }}
            />
          </View>

          {!descriptionExpanded && (
            <View style={styles.seeMoreWrap}>
              <TouchableOpacity
                onPress={() => setDescriptionExpanded(true)}
                style={styles.seeMoreButton}
              >
                <Text style={styles.seeMoreButtonText}>See more details</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Customer reviews</Text>
            <TouchableOpacity onPress={() => setShowReviewModal(true)}>
              <Text style={styles.seeMoreText}>Write review</Text>
            </TouchableOpacity>
          </View>

          {reviewsLoading ? (
            <View style={styles.reviewsStateCard}>
              <NoodSpinner size={28} />
              <Text style={styles.reviewsStateText}>Loading live reviews...</Text>
            </View>
          ) : judgeMeWidgetHtml ? (
            <RenderHtml
              contentWidth={width - 56}
              source={{ html: judgeMeWidgetHtml }}
            />
          ) : (
            <View style={styles.reviewsStateCard}>
              <Text style={styles.reviewsStateTitle}>No reviews yet</Text>
              <Text style={styles.reviewsStateText}>Be the first to review this product.</Text>
            </View>
          )}
        </View>

        <View onLayout={onSectionLayout('similar')} style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>You may also like</Text>

          {recommendationsLoading ? (
            <View style={styles.recommendGrid}>
              {Array.from({ length: 6 }).map((_, index) => (
                <RecommendationSkeletonCard key={`recommendation-skeleton-${index}`} />
              ))}
            </View>
          ) : recommendedProducts.length > 0 ? (
            <View style={styles.recommendGrid}>
              {recommendedProducts.map((item) => {
                const itemKey = `${item.id}-${item.handle}`;
                return (
                  <ProductRecommendationCard
                    key={itemKey}
                    item={item}
                    priceLabel={recommendationPriceById.get(itemKey) || ''}
                    onOpen={openRecommendedProduct}
                  />
                );
              })}
            </View>
          ) : null}
        </View>

        <View style={{ height: 190 }} />
      </ScrollView>

      {showPromoBar && (
        <Animated.View
          style={[
            styles.floatingPromoWrap,
            {
              opacity: promoOpacity,
              transform: [
                { translateY: promoTranslateY },
                { translateY: promoPulse },
              ],
            },
          ]}
        >
          <View style={styles.floatingPromo}>
            <View style={styles.floatingPromoLeft}>
              <Text style={styles.floatingPromoIcon}>⏳</Text>
              <View style={styles.floatingPromoTextWrap}>
                <Text style={styles.floatingPromoTitle}>Add now! Free Shipping!</Text>
                <Text style={styles.floatingPromoSub}>
                  Fastest delivery in 5-8 business days
                </Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={() => setShowPromoBar(false)}
              style={styles.floatingPromoClose}
            >
              <Text style={styles.floatingPromoCloseText}>×</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.bottomAddButton, productSoldOut && styles.bottomActionDisabled]}
          onPress={handleAddToCart}
          disabled={productSoldOut}
          activeOpacity={productSoldOut ? 1 : 0.85}
        >
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={styles.bottomAddText}>
            {productSoldOut ? 'Sold out' : 'Add to cart'}
          </Text>
          <Text style={styles.bottomSubText}>
            {productSoldOut ? 'Unavailable' : 'Quick action'}
          </Text>
        </TouchableOpacity>

        <Animated.View
          style={[
            styles.bottomBuyAnimatedWrap,
            {
              transform: [{ translateY: promoPulse }],
            },
          ]}
        >
          <TouchableOpacity
            style={[styles.bottomBuyButton, productSoldOut && styles.bottomActionDisabled]}
            onPress={handleBuyNow}
            disabled={productSoldOut}
            activeOpacity={productSoldOut ? 1 : 0.85}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={styles.bottomBuyText}>
              {productSoldOut ? 'Sold out' : 'Buy now'}
            </Text>
            <Text style={styles.bottomBuySubText}>
              {productSoldOut ? 'Unavailable' : 'Ready to order'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>

      <Modal
        visible={showGalleryModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowGalleryModal(false)}
      >
        <Animated.View
          style={[
            styles.galleryModalOverlay,
            {
              transform: [{ translateY: galleryDragY }],
              opacity: galleryDragY.interpolate({
                inputRange: [0, 220],
                outputRange: [1, 0.72],
                extrapolate: 'clamp',
              }),
            },
          ]}
          {...galleryPanResponder.panHandlers}
        >
          <View style={[styles.galleryModalHeader, { top: insets.top + 14 }]}>
            <TouchableOpacity
              style={styles.galleryModalBtn}
              onPress={() => setShowGalleryModal(false)}
            >
              <Ionicons name="close" size={22} color="#fff" />
            </TouchableOpacity>

            <View style={styles.galleryModalCounter}>
              <Text style={styles.galleryModalCounterText}>
                {gallery.length ? currentIndex + 1 : 0}/{gallery.length}
              </Text>
            </View>
          </View>

          <FlatList
            ref={fullscreenGalleryRef}
            data={gallery}
            keyExtractor={(item) => `fullscreen-${item.id}`}
            renderItem={renderFullscreenGalleryItem}
            horizontal
            pagingEnabled
            directionalLockEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={Math.min(currentIndex, Math.max(gallery.length - 1, 0))}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            windowSize={3}
            getItemLayout={(_data, index) => ({
              length: width,
              offset: width * index,
              index,
            })}
            onScrollToIndexFailed={({ index }) => {
              setTimeout(() => {
                fullscreenGalleryRef.current?.scrollToIndex({ index, animated: false });
              }, 50);
            }}
            onMomentumScrollEnd={(event) => {
              updateGalleryIndex(event.nativeEvent.contentOffset.x);
            }}
          />

          <View style={styles.galleryModalDots}>
            {gallery.map((item: any, i: number) => (
              <View
                key={`modal-dot-${item.id}`}
                style={[styles.galleryModalDot, i === currentIndex && styles.galleryModalDotActive]}
              />
            ))}
          </View>
        </Animated.View>
      </Modal>

      <Modal
        visible={showVariantPicker}
        animationType="slide"
        transparent
        onRequestClose={() => setShowVariantPicker(false)}
      >
        <View style={styles.variantPickerOverlay}>
          <View style={styles.variantPickerSheet}>
            <View style={styles.variantPickerHeader}>
              <View style={styles.variantPickerSummary}>
                <Image
                  source={{ uri: productPrimaryImage }}
                  style={styles.variantPickerThumb}
                />

                <View style={styles.variantPickerTextWrap}>
                  <Text style={styles.variantPickerTitle}>
                    {product.title}
                  </Text>
                  <Text style={styles.variantPickerPrice}>{priceText}</Text>
                  <Text style={styles.variantPickerSelection}>
                    {(selectedVariant?.selectedOptions || [])
                      .map((option: any) => option.value)
                      .join(' / ')}
                  </Text>
                </View>
              </View>

              <TouchableOpacity onPress={() => setShowVariantPicker(false)}>
                <Ionicons name="close" size={28} color="#111" />
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.variantPickerContent}
            >
              {optionGroups.map((group) => (
                <ProductOptionGroup
                  key={`picker-${group.name}`}
                  group={group}
                  colorOptionName={colorOptionName}
                  sizeOptionName={sizeOptionName}
                  variantNodes={variantNodes}
                  productImageEdges={productSwatchImageCandidates}
                  selectedOptionsMap={selectedOptionsMap}
                  getSelectionState={getSelectionState}
                  onSelect={handleOptionSelect}
                  chipStyle="picker"
                />
              ))}
            </ScrollView>

            <TouchableOpacity
              style={styles.variantPickerAddButton}
              onPress={confirmAddToCart}
            >
              <Text style={styles.variantPickerAddButtonText}>Add now! Choose this one</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showReviewModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowReviewModal(false)}
      >
        <View style={styles.reviewModalOverlay}>
          <View style={styles.reviewModalCard}>
            <View style={styles.reviewModalHeader}>
              <Text style={styles.reviewModalTitle}>Leave a review</Text>
              <TouchableOpacity onPress={() => setShowReviewModal(false)}>
                <Text style={styles.reviewModalClose}>×</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.reviewLabel}>Your rating</Text>
            <View style={styles.starPickerRow}>
              {[1, 2, 3, 4, 5].map((star) => (
                <Pressable key={star} onPress={() => setNewReviewRating(star)}>
                  <Text
                    style={[
                      styles.starPicker,
                      star <= newReviewRating && styles.starPickerActive,
                    ]}
                  >
                    ★
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.reviewLabel}>Your review</Text>
            <TextInput
              value={newReviewText}
              onChangeText={setNewReviewText}
              placeholder="Write your review here..."
              multiline
              style={styles.reviewInput}
            />

            <TouchableOpacity style={styles.submitReviewButton} onPress={submitReview}>
              <Text style={styles.submitReviewButtonText}>Submit review</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.card,
  },
  topNav: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    zIndex: 40,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  topNavBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  topNavBtnText: {
    fontSize: 20,
    color: COLORS.text,
    fontWeight: '800',
  },
  galleryCarousel: {
    height: width * 1.14,
  },
  slide: {
    width,
    height: width * 1.14,
    backgroundColor: COLORS.card,
  },
  media: {
    width: '100%',
    height: '100%',
  },
  videoPreviewWrap: {
    overflow: 'hidden',
    backgroundColor: '#ededed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoPreviewImage: {
    width: '100%',
    height: '100%',
  },
  videoPlayBadge: {
    position: 'absolute',
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderWidth: 1,
    borderColor: 'rgba(17,17,17,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryHint: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    pointerEvents: 'none',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(17,17,17,0.5)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  galleryHintText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 6,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 10,
    marginBottom: 8,
  },
  dot: {
    width: 7,
    height: 7,
    backgroundColor: '#cfcfcf',
    marginHorizontal: 4,
    borderRadius: 20,
  },
  activeDot: {
    width: 22,
    backgroundColor: COLORS.orange,
  },
  perksStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.peach,
    marginHorizontal: 12,
    marginBottom: 10,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#f6dcc0',
  },
  perkItem: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  perkIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  perkText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.dark,
  },
  perkDivider: {
    width: 1,
    height: 18,
    backgroundColor: '#efd3b6',
  },
  topCard: {
    backgroundColor: COLORS.card,
    marginHorizontal: 12,
    borderRadius: 18,
    padding: 16,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  price: {
    fontSize: 30,
    fontWeight: '800',
    color: COLORS.text,
    marginRight: 10,
  },
  badge: {
    backgroundColor: COLORS.orangeSoft,
    borderColor: COLORS.orange,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  badgeText: {
    color: COLORS.orange,
    fontWeight: '700',
    fontSize: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
    lineHeight: 26,
    marginTop: 10,
    marginBottom: 4,
  },
  shippingHighlight: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.peach,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#f6dcc0',
  },
  shippingHighlightIcon: {
    fontSize: 20,
    marginRight: 10,
  },
  shippingHighlightTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 2,
  },
  shippingHighlightText: {
    fontSize: 13,
    color: COLORS.orange,
    fontWeight: '700',
  },
  variantsWrap: {
    paddingTop: 16,
    paddingBottom: 6,
  },
  optionGroupsWrap: {
    paddingTop: 18,
    paddingHorizontal: 0,
    gap: 22,
  },
  optionGroupBlock: {
    gap: 12,
    maxWidth: '100%',
  },
  optionGroupHeader: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    marginBottom: 2,
    maxWidth: '100%',
  },
  optionGroupTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
    lineHeight: 21,
    marginBottom: 4,
    maxWidth: '100%',
  },
  optionGroupValue: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.orange,
    lineHeight: 20,
    flexShrink: 1,
    maxWidth: '100%',
  },
  optionChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 11,
    rowGap: 11,
    maxWidth: '100%',
  },
  optionChip: {
    maxWidth: '100%',
    minHeight: 50,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1.25,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    minWidth: 82,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  optionChipActive: {
    backgroundColor: '#FFF7ED',
    borderColor: '#FF7A00',
    borderWidth: 2,
    shadowColor: '#ff7a00',
    shadowOpacity: 0.12,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  optionChipText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 20,
    flexShrink: 1,
    flexWrap: 'wrap',
    maxWidth: '100%',
    textAlign: 'center',
  },
  optionChipTextActive: {
    color: '#FF6A00',
  },
  colorSwatchScrollContent: {
    paddingRight: 12,
    alignItems: 'center',
  },
  colorSwatchButton: {
    width: SWATCH_DISPLAY_SIZE,
    height: SWATCH_DISPLAY_SIZE,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    marginBottom: 10,
    shadowColor: '#111827',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  colorSwatchButtonActive: {
    borderColor: '#FF7A00',
    borderWidth: 2,
    backgroundColor: '#FFF7ED',
    shadowColor: '#FF7A00',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  colorSwatchImageWrap: {
    width: '100%',
    height: '100%',
    padding: 5,
    backgroundColor: '#FFFFFF',
  },
  colorSwatchImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#FFFFFF',
  },
  colorSwatchTextWrap: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    backgroundColor: '#FFFFFF',
  },
  colorSwatchText: {
    color: '#111827',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 16,
  },
  colorSwatchTextActive: {
    color: '#FF6A00',
  },
  variantButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d9d9d9',
    backgroundColor: COLORS.card,
    minWidth: 90,
  },
  variantButtonActive: {
    backgroundColor: COLORS.dark,
    borderColor: COLORS.dark,
  },
  variantText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
    flexShrink: 1,
    maxWidth: '100%',
  },
  variantTextActive: {
    color: '#fff',
  },
  infoCard: {
    backgroundColor: COLORS.card,
    marginHorizontal: 12,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 4,
    marginBottom: 10,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  infoIcon: {
    fontSize: 20,
    marginRight: 12,
    marginTop: 2,
  },
  infoTextWrap: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 4,
  },
  infoText: {
    fontSize: 13,
    color: COLORS.muted,
    lineHeight: 19,
  },
  chevron: {
    fontSize: 24,
    color: COLORS.orange,
    marginLeft: 8,
  },
  infoDivider: {
    height: 1,
    backgroundColor: COLORS.line,
  },
  reviewSummaryWrap: {
    marginHorizontal: 12,
    marginBottom: 10,
  },
  reviewSummaryBar: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  reviewSummaryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reviewSummaryScore: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.text,
    marginRight: 8,
  },
  reviewSummaryStars: {
    fontSize: 18,
    color: COLORS.orange,
    marginRight: 8,
  },
  reviewSummaryCount: {
    fontSize: 15,
    color: COLORS.muted,
    fontWeight: '600',
  },
  leaveReviewText: {
    color: COLORS.orange,
    fontWeight: '800',
    fontSize: 14,
  },
  tabsBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 18,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
  },
  tabText: {
    color: '#8a8a8a',
    fontSize: 16,
    fontWeight: '700',
  },
  tabTextActive: {
    color: COLORS.text,
  },
  tabUnderline: {
    marginTop: 6,
    width: 26,
    height: 4,
    borderRadius: 10,
    backgroundColor: COLORS.orange,
  },
  sectionCard: {
    backgroundColor: COLORS.card,
    marginHorizontal: 12,
    borderRadius: 18,
    padding: 16,
    marginBottom: 10,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 14,
  },
  seeMoreText: {
    color: COLORS.orange,
    fontWeight: '800',
    fontSize: 14,
  },
  descriptionWrap: {
    overflow: 'hidden',
  },
  descriptionCollapsed: {
    maxHeight: 520,
  },
  seeMoreWrap: {
    paddingTop: 8,
    alignItems: 'center',
  },
  seeMoreButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: '#f3f3f3',
  },
  seeMoreButtonText: {
    color: COLORS.text,
    fontWeight: '700',
  },
  verifiedBar: {
    backgroundColor: COLORS.orangeSoft,
    borderColor: '#ffd7ae',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 14,
  },
  verifiedBarText: {
    color: '#c96b00',
    fontWeight: '700',
    fontSize: 13,
  },
  reviewsStateCard: {
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
  },
  reviewsStateText: {
    marginTop: 10,
    color: COLORS.muted,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  reviewsStateTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  reviewCard: {
    paddingBottom: 16,
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  reviewTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  reviewName: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
  },
  reviewDate: {
    fontSize: 13,
    color: '#888',
  },
  reviewStars: {
    fontSize: 16,
    color: COLORS.orange,
    marginBottom: 8,
  },
  reviewText: {
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.text,
    marginBottom: 10,
  },
  reviewActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reviewActionText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  reviewActionDivider: {
    color: '#999',
    marginHorizontal: 8,
  },
  recommendGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  productCard: {
    width: '48.5%',
    marginBottom: 14,
  },
  productCardImage: {
    width: '100%',
    height: 160,
    borderRadius: 16,
    backgroundColor: '#eee',
  },
  productCardTitle: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '700',
    lineHeight: 20,
    marginTop: 8,
    minHeight: 40,
  },
  productCardPrice: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
    marginTop: 6,
  },
  recommendationSoldOutText: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '700',
    color: '#b42318',
  },
  recommendationSkeletonBlock: {
    backgroundColor: '#e8e8e8',
  },
  recommendationSkeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: '#ececec',
    marginTop: 8,
  },
  recommendationSkeletonLineWide: {
    width: '92%',
  },
  recommendationSkeletonLineMedium: {
    width: '72%',
  },
  recommendationSkeletonLinePrice: {
    width: '42%',
    marginTop: 10,
  },
  floatingPromoWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 92,
    zIndex: 20,
  },
  floatingPromo: {
    backgroundColor: COLORS.orange,
    borderRadius: 999,
    minHeight: 62,
    paddingLeft: 16,
    paddingRight: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  floatingPromoLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  floatingPromoTextWrap: {
    flex: 1,
  },
  floatingPromoIcon: {
    fontSize: 20,
    marginRight: 10,
  },
  floatingPromoTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  floatingPromoSub: {
    color: '#fff',
    fontSize: 12,
    marginTop: 2,
    opacity: 0.95,
  },
  floatingPromoClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  floatingPromoCloseText: {
    color: '#fff',
    fontSize: 20,
    lineHeight: 22,
    fontWeight: '700',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
  },
  bottomActionDisabled: {
    opacity: 0.55,
  },
  bottomAddButton: {
    flex: 1,
    minWidth: 0,
    backgroundColor: COLORS.card,
    borderWidth: 2,
    borderColor: COLORS.dark,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  bottomAddText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    flexShrink: 1,
    maxWidth: '100%',
  },
  bottomSubText: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
    textAlign: 'center',
  },
  bottomBuyAnimatedWrap: {
    flex: 1.2,
    minWidth: 0,
  },
  bottomBuyButton: {
    backgroundColor: COLORS.orange,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomBuyText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    flexShrink: 1,
    maxWidth: '100%',
  },
  bottomBuySubText: {
    color: '#fff',
    fontSize: 12,
    marginTop: 2,
    opacity: 0.95,
    textAlign: 'center',
  },
  variantPickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'flex-end',
  },
  variantPickerSheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 18,
    maxHeight: '82%',
  },
  variantPickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  variantPickerSummary: {
    flex: 1,
    flexDirection: 'row',
    marginRight: 12,
  },
  variantPickerThumb: {
    width: 84,
    height: 84,
    borderRadius: 16,
    backgroundColor: '#eee',
    marginRight: 12,
  },
  variantPickerTextWrap: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  variantPickerTitle: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '800',
    color: COLORS.text,
    flexShrink: 1,
    maxWidth: '100%',
  },
  variantPickerPrice: {
    marginTop: 8,
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
  },
  variantPickerSelection: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.orange,
    lineHeight: 19,
    flexShrink: 1,
    maxWidth: '100%',
  },
  variantPickerContent: {
    paddingBottom: 10,
  },
  variantPickerGroup: {
    marginBottom: 22,
    maxWidth: '100%',
  },
  variantPickerGroupTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 12,
    lineHeight: 24,
    maxWidth: '100%',
  },
  variantPickerChipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 11,
    rowGap: 11,
    maxWidth: '100%',
  },
  variantPickerChip: {
    maxWidth: '100%',
    borderWidth: 1.25,
    borderColor: '#E5E7EB',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 50,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
  },
  variantPickerChipActive: {
    borderColor: '#FF7A00',
    borderWidth: 2,
    backgroundColor: '#FFF7ED',
    shadowColor: '#ff7a00',
    shadowOpacity: 0.12,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  variantPickerChipText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111827',
    lineHeight: 20,
    flexShrink: 1,
    flexWrap: 'wrap',
    maxWidth: '100%',
    textAlign: 'center',
  },
  variantPickerChipTextActive: {
    color: '#FF6A00',
  },
  variantPickerAddButton: {
    marginTop: 4,
    backgroundColor: COLORS.orange,
    borderRadius: 999,
    paddingVertical: 18,
    alignItems: 'center',
  },
  variantPickerAddButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    flexShrink: 1,
    maxWidth: '100%',
  },
  galleryModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
  },
  galleryModalHeader: {
    position: 'absolute',
    top: 46,
    left: 16,
    right: 16,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  galleryModalBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryModalCounter: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  galleryModalCounterText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
  galleryModalSlide: {
    width,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  galleryModalImage: {
    width: width - 24,
    height: '78%',
  },
  zoomScroll: {
    width,
    height: '100%',
  },
  zoomContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryModalDots: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 34,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  galleryModalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.35)',
    marginHorizontal: 4,
  },
  galleryModalDotActive: {
    width: 24,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  reviewModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  reviewModalCard: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 18,
    maxHeight: '82%',
  },
  reviewModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  reviewModalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.text,
  },
  reviewModalClose: {
    fontSize: 32,
    color: COLORS.muted,
    lineHeight: 32,
  },
  reviewLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
    marginTop: 8,
  },
  starPickerRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  starPicker: {
    fontSize: 32,
    color: '#ddd',
    marginRight: 8,
  },
  starPickerActive: {
    color: COLORS.orange,
  },
  reviewInput: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlignVertical: 'top',
    fontSize: 15,
    color: COLORS.text,
  },
  submitReviewButton: {
    marginTop: 14,
    backgroundColor: COLORS.orange,
    borderRadius: 999,
    paddingVertical: 15,
    alignItems: 'center',
  },
  submitReviewButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
});
