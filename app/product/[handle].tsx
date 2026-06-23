import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Alert,
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
import { BASE_CURRENCY } from '../../utils/currency';
import { SHOPIFY_STORE_DOMAIN } from '../../utils/shopify';
import { catalogFetch } from '../../utils/catalog';
import { getProductFast } from '../../utils/product-data';
import {
  applyProductVariantState,
  buildProductDetailFromPreview,
  buildProductRouteParams,
  parseProductPreviewFromParams,
} from '../../utils/product-navigation';

const JUDGEME_SHOP_DOMAIN = SHOPIFY_STORE_DOMAIN;
const JUDGEME_PUBLIC_API_TOKEN = 'QOqxbIUd0jzlg0HRjQU_Dwlsqmo';
const PRODUCT_IMAGE_PLACEHOLDER = 'https://via.placeholder.com/600x700.png?text=No+Image';
const REVIEWS_STORAGE_PREFIX = 'NOOD_CUSTOMER_REVIEWS';

const failedJudgeMeHandles = new Set<string>();
const loggedInvalidMediaSources = new Set<string>();

const { width } = Dimensions.get('window');

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

function getReviewsStorageKey(profileId: string) {
  return `${REVIEWS_STORAGE_PREFIX}:${profileId}`;
}

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
type VariantOptionMap = Record<string, string>;

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
    cartCount,
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

  const initialPreview = useMemo(
    () => parseProductPreviewFromParams({ handle, preview }),
    [handle, preview]
  );
  const initialProduct = useMemo(
    () => (initialPreview ? buildProductDetailFromPreview(initialPreview) : null),
    [initialPreview]
  );

  const [product, setProduct] = useState<any>(initialProduct);
  const [recommendedProducts, setRecommendedProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(!initialProduct);
  const [detailRefreshing, setDetailRefreshing] = useState(false);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [judgeMeWidgetHtml, setJudgeMeWidgetHtml] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedVariant, setSelectedVariant] = useState<any>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [showPromoBar, setShowPromoBar] = useState(true);
  const [showFloatingCart, setShowFloatingCart] = useState(true);
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

  const [sectionY, setSectionY] = useState<Record<TabKey, number>>({
    overview: 0,
    details: 0,
    similar: 0,
  });

  const promoTranslateY = useRef(new Animated.Value(40)).current;
  const promoOpacity = useRef(new Animated.Value(0)).current;
  const promoPulse = useRef(new Animated.Value(0)).current;
  const galleryDragY = useRef(new Animated.Value(0)).current;

  const floatingCartScale = useRef(new Animated.Value(1)).current;
  const floatingCartRotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (typeof handle !== 'string' || !handle.trim()) {
      return;
    }

    console.log(`[NOOD product] opened handle=${handle}`);
    const nextPreview = parseProductPreviewFromParams({ handle, preview });

    if (nextPreview) {
      const previewProduct = buildProductDetailFromPreview(nextPreview);
      setProduct(previewProduct);
      setLoading(false);
      setCurrentIndex(0);
      setActiveTab('overview');
      setDescriptionExpanded(false);
      setShowPromoBar(true);
      applyProductVariantState(previewProduct, setSelectedVariant, setSelectedOptionsMap);
      console.log('[NOOD product] rendered from passed data');
    }

    void fetchProduct(handle, Boolean(nextPreview));
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

  useEffect(() => {
    if (!showFloatingCart) {
      floatingCartScale.setValue(1);
      floatingCartRotate.setValue(0);
      return;
    }

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(floatingCartScale, {
            toValue: 1.08,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(floatingCartRotate, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(floatingCartScale, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(floatingCartRotate, {
            toValue: 0,
            duration: 700,
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    pulse.start();

    return () => pulse.stop();
  }, [showFloatingCart, floatingCartScale, floatingCartRotate]);

  const shopifyFetch = async (query: string, variables?: Record<string, any>) => {
    const json = await catalogFetch(query, variables);

    if (json?.errors) {
      console.log('Catalog GraphQL errors:', json.errors);
    }

    return json;
  };

  const fetchProduct = async (productHandle: string, hasPassedPreview = false) => {
    try {
      if (!hasPassedPreview) {
        setLoading(true);
        setCurrentIndex(0);
        setActiveTab('overview');
        setDescriptionExpanded(false);
        setShowPromoBar(true);
      } else {
        setDetailRefreshing(true);
      }

      const p = await getProductFast(productHandle);

      setProduct(p);
      applyProductVariantState(p, setSelectedVariant, setSelectedOptionsMap);

      if (p?.variants?.edges?.length) {
        const initialVariant = p.variants.edges[0].node;
        console.log('[NOOD product load] product detail initial variant', {
          title: p.title,
          handle: p.handle,
          productId: p.id,
          variantId: initialVariant?.id || '',
          variantTitle: initialVariant?.title || '',
        });
      }

      if (p?.id) {
        await fetchRecommendedProducts(p.id);
      } else {
        setRecommendedProducts([]);
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
    } finally {
      setLoading(false);
      setDetailRefreshing(false);
    }
  };

  const fetchRecommendedProducts = async (productId: string) => {
    try {
      const query = `
        query ProductRecommendations($productId: ID!) {
          productRecommendations(productId: $productId) {
            id
            title
            handle
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
      `;

      const json = await shopifyFetch(query, { productId });
      setRecommendedProducts(json?.data?.productRecommendations ?? []);
    } catch (error) {
      console.log('fetchRecommendedProducts error:', error);
      setRecommendedProducts([]);
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

  const gallery = useMemo(() => {
    if (!product) return [];

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
        return mediaItems;
      }
    }

    return (product.images?.edges ?? [])
      .map((edge: any) => {
        const uri = getValidMediaUri(edge?.node?.url);
        if (!uri) {
          logInvalidMediaSource('ProductScreen.galleryFallback', String(product?.handle || 'unknown'));
          return null;
        }

        return {
          id: String(edge?.node?.id || uri),
          type: 'image',
          url: uri,
        };
      })
      .filter(Boolean);
  }, [product]);

  const productPrimaryImage = useMemo(() => {
    return (
      getValidMediaUri(gallery?.[0]?.url) ||
      getValidMediaUri(product?.featuredImage?.url) ||
      PRODUCT_IMAGE_PLACEHOLDER
    );
  }, [gallery, product]);

  useEffect(() => {
    if (openedReviewFromRouteRef.current || !product || openReview !== '1') return;

    openedReviewFromRouteRef.current = true;
    setShowReviewModal(true);
  }, [openReview, product]);

  const variantNodes = useMemo(
    () => (product?.variants?.edges || []).map((edge: any) => edge.node).filter(Boolean),
    [product]
  );

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

  const isOptionValueAvailable = useCallback(
    (optionName: string, optionValue: string) =>
      variantNodes.some((variant: any) => {
        const optionMap = Object.fromEntries(
          (variant?.selectedOptions || []).map((option: any) => [option.name, option.value])
        );

        if (optionMap[optionName] !== optionValue) return false;

        return Object.entries(selectedOptionsMap).every(([name, value]) => {
          if (name === optionName || !value) return true;
          return optionMap[name] === value;
        });
      }),
    [selectedOptionsMap, variantNodes]
  );

  const syncVariantSelection = useCallback(
    (nextOptions: VariantOptionMap) => {
      if (!variantNodes.length) return;

      const exactMatch = variantNodes.find((variant: any) => {
        const optionMap = Object.fromEntries(
          (variant?.selectedOptions || []).map((option: any) => [option.name, option.value])
        );

        return Object.entries(nextOptions).every(([name, value]) => optionMap[name] === value);
      });

      if (exactMatch) {
        setSelectedVariant(exactMatch);
        return;
      }

      const fallbackMatch = variantNodes.find((variant: any) => {
        const optionMap = Object.fromEntries(
          (variant?.selectedOptions || []).map((option: any) => [option.name, option.value])
        );

        return Object.entries(nextOptions).every(([name, value]) => {
          return !value || optionMap[name] === value;
        });
      });

      if (fallbackMatch) {
        setSelectedVariant(fallbackMatch);
        setSelectedOptionsMap(
          Object.fromEntries(
            (fallbackMatch?.selectedOptions || []).map((option: any) => [
              option.name,
              option.value,
            ])
          )
        );
      }
    },
    [variantNodes]
  );

  const formatDisplayPrice = useCallback(
    (amount?: string | number | null, fromCurrency?: string | null) =>
      formatMoney(
        convertPrice(Number(amount || 0), fromCurrency || BASE_CURRENCY, selectedCurrency),
        selectedCurrency
      ),
    [convertPrice, formatMoney, selectedCurrency]
  );

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
    if (!selectedVariant || !product) return;
    setShowVariantPicker(true);
  };

  const confirmAddToCart = () => {
    if (!selectedVariant || !product) return;
    const selectedVariantId = String(selectedVariant.id || '').trim();

    if (!selectedVariantId) {
      console.log('[NOOD cart] missing selected variantId on product detail', {
        product,
        selectedVariant,
      });
      Alert.alert('Product unavailable', 'This product is missing its Shopify variant. Please try again.');
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
      baseCurrency:
        selectedVariant.price?.currencyCode ||
        product?.priceRange?.minVariantPrice?.currencyCode ||
        BASE_CURRENCY,
      image: productPrimaryImage,
      quantity: 1,
    });

    if (added) {
      setShowVariantPicker(false);
      Alert.alert('Added to cart', selectedVariant.title || 'Default Title');
    }
  };

  const handleBuyNow = () => {
    if (!selectedVariant || !product) return;
    const selectedVariantId = String(selectedVariant.id || '').trim();

    if (!selectedVariantId) {
      console.log('[NOOD cart] missing selected variantId on Buy Now', {
        product,
        selectedVariant,
      });
      Alert.alert('Product unavailable', 'This product is missing its Shopify variant. Please try again.');
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
      baseCurrency:
        selectedVariant.price?.currencyCode ||
        product?.priceRange?.minVariantPrice?.currencyCode ||
        BASE_CURRENCY,
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

  const scrollToSection = (key: TabKey) => {
    setActiveTab(key);
    verticalScrollRef.current?.scrollTo({
      y: Math.max(sectionY[key] - 8, 0),
      animated: true,
    });
  };

  const onVerticalScroll = (event: any) => {
    const y = event?.nativeEvent?.contentOffset?.y ?? 0;

    if (y >= sectionY.similar - 120) {
      setActiveTab('similar');
    } else if (y >= sectionY.details - 120) {
      setActiveTab('details');
    } else {
      setActiveTab('overview');
    }
  };

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
            <ScrollView
              style={styles.zoomScroll}
              contentContainerStyle={styles.zoomContent}
              minimumZoomScale={1}
              maximumZoomScale={4}
              pinchGestureEnabled
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              bouncesZoom
            >
              <Image
                source={{ uri: mediaUri }}
                style={styles.galleryModalImage}
                resizeMode="contain"
              />
            </ScrollView>
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
      Alert.alert('Review needed', 'Please enter your review text.');
      return;
    }

    if (reviewOrderId && reviewItemId) {
      if (!isSignedIn || !profileId) {
        Alert.alert('Sign in required', 'Sign in to submit a review for this item.');
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

        Alert.alert('Review submitted', 'Thanks for reviewing your item.', [
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
        Alert.alert('Review not saved', 'Please try submitting your review again.');
      }
      return;
    }

    setShowReviewModal(false);
    setNewReviewText('');
    setNewReviewRating(5);

    const productUrl = product?.handle
      ? `https://noodcaribbean.com/products/${product.handle}`
      : 'https://noodcaribbean.com';

    Alert.alert(
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
                  <View key={group.name} style={styles.optionGroupBlock}>
                    <View style={styles.optionGroupHeader}>
                      <Text style={styles.optionGroupTitle}>{group.name}</Text>
                      <Text style={styles.optionGroupValue}>
                        {selectedOptionsMap[group.name] || 'Choose'}
                      </Text>
                    </View>

                    <View style={styles.optionChipWrap}>
                      {group.values.map((value) => {
                        const active = selectedOptionsMap[group.name] === value;
                        const available = isOptionValueAvailable(group.name, value);

                        return (
                          <TouchableOpacity
                            key={`${group.name}-${value}`}
                            onPress={() => {
                              const nextOptions = {
                                ...selectedOptionsMap,
                                [group.name]: value,
                              };

                              setSelectedOptionsMap(nextOptions);
                              syncVariantSelection(nextOptions);
                            }}
                            style={[
                              styles.optionChip,
                              active && styles.optionChipActive,
                              !available && styles.optionChipDisabled,
                            ]}
                            disabled={!available}
                          >
                            <Text
                              style={[
                                styles.optionChipText,
                                active && styles.optionChipTextActive,
                                !available && styles.optionChipTextDisabled,
                              ]}
                            >
                              {value}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View style={styles.infoCard}>
            <TouchableOpacity
              style={styles.infoRow}
              onPress={() =>
                Alert.alert('Shipping & delivery', 'Estimated delivery: 5–9 business days')
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
                Alert.alert('Safe payments', 'Secure checkout flow and payment protection.')
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
                Alert.alert('Order guarantee', 'Product details, shipping support, and order help.')
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

          {recommendedProducts.length > 0 ? (
            <View style={styles.recommendGrid}>
              {recommendedProducts.map((item: any) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.productCard}
                  onPress={() => {
                    if (!item.handle) return;
                    router.push({
                      pathname: '/product/[handle]',
                      params: buildProductRouteParams(item),
                    });
                  }}
                >
                  <Image
                    source={{
                      uri:
                        item?.featuredImage?.url ||
                        'https://via.placeholder.com/300',
                    }}
                    style={styles.productCardImage}
                    resizeMode="cover"
                  />
                  <Text numberOfLines={2} style={styles.productCardTitle}>
                    {item.title}
                  </Text>
                  <Text style={styles.productCardPrice}>
                    {formatDisplayPrice(
                      item?.priceRange?.minVariantPrice?.amount,
                      item?.priceRange?.minVariantPrice?.currencyCode
                    )}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.fallbackRecommendedWrap}
            >
              {(product?.images?.edges ?? []).slice(0, 6).map((item: any) => (
                getValidMediaUri(item?.node?.url) ? (
                  <Image
                    key={String(item?.node?.id || item.node.url)}
                    source={{ uri: getValidMediaUri(item?.node?.url)! }}
                    style={styles.fallbackRecommendedImage}
                  />
                ) : null
              ))}
            </ScrollView>
          )}
        </View>

        <View style={{ height: 190 }} />
      </ScrollView>

      {showFloatingCart && (
        <Animated.View
          style={[
            styles.floatingCartWrap,
            {
              transform: [
                { scale: floatingCartScale },
                {
                  rotate: floatingCartRotate.interpolate({
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
          >
            {cartCount > 0 && (
              <View style={styles.floatingCartBadge}>
                <Text style={styles.floatingCartBadgeText}>{cartCount}</Text>
              </View>
            )}

            <Text style={styles.floatingCartIcon}>🛒</Text>
            <Text style={styles.floatingCartLabel}>Cart</Text>
            <Text style={styles.floatingCartSub}>Fast checkout</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

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
          style={styles.bottomAddButton}
          onPress={handleAddToCart}
        >
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={styles.bottomAddText}>
            Add to cart
          </Text>
          <Text style={styles.bottomSubText}>Quick action</Text>
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
            style={styles.bottomBuyButton}
            onPress={handleBuyNow}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={styles.bottomBuyText}>
              Buy now
            </Text>
            <Text style={styles.bottomBuySubText}>Ready to order</Text>
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
                <View key={`picker-${group.name}`} style={styles.variantPickerGroup}>
                  <Text style={styles.variantPickerGroupTitle}>{group.name}</Text>

                  <View style={styles.variantPickerChipGrid}>
                    {group.values.map((value) => {
                      const active = selectedOptionsMap[group.name] === value;
                      const available = isOptionValueAvailable(group.name, value);

                      return (
                        <TouchableOpacity
                          key={`picker-${group.name}-${value}`}
                          onPress={() => {
                            const nextOptions = {
                              ...selectedOptionsMap,
                              [group.name]: value,
                            };

                            setSelectedOptionsMap(nextOptions);
                            syncVariantSelection(nextOptions);
                          }}
                          style={[
                            styles.variantPickerChip,
                            active && styles.variantPickerChipActive,
                            !available && styles.variantPickerChipDisabled,
                          ]}
                          disabled={!available}
                        >
                          <Text
                            style={[
                              styles.variantPickerChipText,
                              active && styles.variantPickerChipTextActive,
                              !available && styles.variantPickerChipTextDisabled,
                            ]}
                          >
                            {value}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
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
    paddingTop: 16,
    paddingHorizontal: 0,
    gap: 18,
  },
  optionGroupBlock: {
    gap: 10,
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
    gap: 10,
    rowGap: 10,
    maxWidth: '100%',
  },
  optionChip: {
    maxWidth: '100%',
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d9d9d9',
    backgroundColor: COLORS.card,
    minWidth: 82,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  optionChipActive: {
    backgroundColor: COLORS.dark,
    borderColor: COLORS.dark,
  },
  optionChipDisabled: {
    opacity: 0.35,
  },
  optionChipText: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
    flexShrink: 1,
    flexWrap: 'wrap',
    maxWidth: '100%',
    textAlign: 'center',
  },
  optionChipTextActive: {
    color: '#fff',
  },
  optionChipTextDisabled: {
    color: '#8e8e93',
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
  fallbackRecommendedWrap: {
    paddingBottom: 4,
  },
  fallbackRecommendedImage: {
    width: 130,
    height: 130,
    marginRight: 10,
    borderRadius: 14,
  },
  floatingCartWrap: {
    position: 'absolute',
    right: 14,
    bottom: 170,
    zIndex: 25,
  },
  floatingCartButton: {
    width: 86,
    minHeight: 100,
    backgroundColor: COLORS.card,
    borderRadius: 999,
    borderWidth: 3,
    borderColor: COLORS.cartBorder,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 7,
  },
  floatingCartBadge: {
    position: 'absolute',
    top: -4,
    right: -2,
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: COLORS.orange,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  floatingCartBadgeText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },
  floatingCartIcon: {
    fontSize: 24,
    marginBottom: 2,
  },
  floatingCartLabel: {
    color: COLORS.orange,
    fontWeight: '800',
    fontSize: 18,
    lineHeight: 20,
  },
  floatingCartSub: {
    marginTop: 4,
    color: COLORS.orange,
    backgroundColor: COLORS.cartSoft,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
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
    marginBottom: 20,
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
    gap: 10,
    rowGap: 10,
    maxWidth: '100%',
  },
  variantPickerChip: {
    maxWidth: '100%',
    borderWidth: 1.5,
    borderColor: '#d9d9d9',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 52,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
  },
  variantPickerChipActive: {
    borderColor: COLORS.orange,
    backgroundColor: COLORS.orangeSoft,
  },
  variantPickerChipDisabled: {
    opacity: 0.35,
  },
  variantPickerChipText: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.text,
    lineHeight: 20,
    flexShrink: 1,
    flexWrap: 'wrap',
    maxWidth: '100%',
    textAlign: 'center',
  },
  variantPickerChipTextActive: {
    color: '#c96b00',
  },
  variantPickerChipTextDisabled: {
    color: '#8e8e93',
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
