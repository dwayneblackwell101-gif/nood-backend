import React, { useCallback, useMemo, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Image,
  useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCart } from '../../context/CartContext';
import { useUser } from '../../context/UserContext';
import { buildProductRouteParams } from '../../utils/product-navigation';

const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/140x140.png?text=NOOD';
const REVIEWS_STORAGE_PREFIX = 'NOOD_CUSTOMER_REVIEWS';

type CustomerReview = {
  id: string;
  profileId: string;
  orderId: string;
  orderItemId: string;
  productId?: string;
  title: string;
  image: string;
  handle: string;
  variantTitle?: string;
  rating: number;
  comment: string;
  submittedAt: string;
};

type ReviewItem = {
  id: string;
  title: string;
  image: string;
  handle: string;
  orderId: string;
  orderItemId: string;
  date: string;
  variantTitle?: string;
  rating?: number;
  comment?: string;
};

function getReviewsStorageKey(profileId: string) {
  return `${REVIEWS_STORAGE_PREFIX}:${profileId}`;
}

function getOrderDisplayId(orderId: string) {
  const clean = String(orderId || '').replace(/^#/, '');
  return clean ? `#${clean}` : 'Order';
}

function formatShortDate(value?: string, prefix = '') {
  if (!value) return prefix ? `${prefix} recent` : 'Recent';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return prefix ? `${prefix} ${value}` : value;

  return `${prefix}${date.toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
  })}`;
}

function getItemReviewId(orderId: string, item: any, index: number) {
  const rawItemId = String(
    item?.reviewItemId ||
      item?.lineItemId ||
      item?.id ||
      item?.variantId ||
      item?.productId ||
      `item-${index}`
  );

  return `${orderId}:${rawItemId}:${index}`;
}

function isReviewEligibleOrder(order: any) {
  const status = String(order?.status || order?.fulfillmentStatus || '').toLowerCase();
  if (status.includes('cancel') || status.includes('refund')) return false;

  return (
    status.includes('delivered') ||
    status.includes('complete') ||
    status.includes('fulfilled') ||
    status.includes('paid')
  );
}

function StarRow({ rating = 0 }: { rating?: number }) {
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Ionicons
          key={n}
          name={n <= rating ? 'star' : 'star-outline'}
          size={16}
          color="#ff7a00"
        />
      ))}
    </View>
  );
}

export default function ReviewsScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { orders = [] } = useCart() || {};
  const { isReady, isSignedIn, profileId } = useUser();
  const [tab, setTab] = useState<'pending' | 'submitted'>('pending');
  const [submittedReviews, setSubmittedReviews] = useState<CustomerReview[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(true);
  const isCompact = width < 390;

  const loadSubmittedReviews = useCallback(async () => {
    if (!profileId || !isSignedIn) {
      setSubmittedReviews([]);
      setLoadingReviews(false);
      return;
    }

    setLoadingReviews(true);
    try {
      const saved = await AsyncStorage.getItem(getReviewsStorageKey(profileId));
      const parsed = saved ? JSON.parse(saved) : [];
      setSubmittedReviews(Array.isArray(parsed) ? parsed : []);
    } catch (error) {
      console.log('Reviews load error:', error);
      setSubmittedReviews([]);
    } finally {
      setLoadingReviews(false);
    }
  }, [isSignedIn, profileId]);

  useFocusEffect(
    useCallback(() => {
      void loadSubmittedReviews();
    }, [loadSubmittedReviews])
  );

  const submittedIds = useMemo(
    () => new Set(submittedReviews.map((review) => review.orderItemId)),
    [submittedReviews]
  );

  const pendingReviews = useMemo<ReviewItem[]>(() => {
    if (!isSignedIn) return [];

    return (Array.isArray(orders) ? orders : [])
      .filter(isReviewEligibleOrder)
      .flatMap((order: any) => {
        const orderId = String(order?.id || '');
        const orderItems = Array.isArray(order?.items) ? order.items : [];

        return orderItems
          .map((item: any, index: number) => {
            const orderItemId = getItemReviewId(orderId, item, index);
            const handle = String(item?.handle || item?.productHandle || '');

            if (!handle || submittedIds.has(orderItemId)) {
              return null;
            }

            return {
              id: orderItemId,
              title: String(item?.title || 'Purchased item'),
              image: String(item?.image || item?.featuredImage || item?.thumbnail || PLACEHOLDER_IMAGE),
              handle,
              orderId,
              orderItemId,
              date: formatShortDate(order?.deliveredAt || order?.date, 'Purchased '),
              variantTitle: item?.variantTitle,
            };
          })
          .filter(Boolean) as ReviewItem[];
      });
  }, [isSignedIn, orders, submittedIds]);

  const myReviews = useMemo<ReviewItem[]>(
    () =>
      submittedReviews.map((review) => ({
        id: review.id,
        title: review.title,
        image: review.image || PLACEHOLDER_IMAGE,
        handle: review.handle,
        orderId: review.orderId,
        orderItemId: review.orderItemId,
        date: formatShortDate(review.submittedAt, 'Reviewed '),
        variantTitle: review.variantTitle,
        rating: review.rating,
        comment: review.comment,
      })),
    [submittedReviews]
  );

  const data = tab === 'pending' ? pendingReviews : myReviews;
  const loading = !isReady || loadingReviews;

  const openProduct = (item: ReviewItem) => {
    router.push({
      pathname: '/product/[handle]',
      params: buildProductRouteParams(item, { from: 'reviews' }),
    });
  };

  const openReviewForm = (item: ReviewItem) => {
    router.push({
      pathname: '/product/[handle]',
      params: {
        ...buildProductRouteParams(item, { from: 'reviews' }),
        openReview: '1',
        reviewOrderId: item.orderId,
        reviewItemId: item.orderItemId,
        reviewTitle: item.title,
        reviewImage: item.image,
        reviewVariantTitle: item.variantTitle || '',
      },
    });
  };

  const renderPendingItem = ({ item }: { item: ReviewItem }) => (
    <View style={[styles.reviewCard, isCompact && styles.reviewCardCompact]}>
      <Image source={{ uri: item.image }} style={[styles.productImage, isCompact && styles.productImageCompact]} />
      <View style={styles.reviewInfo}>
        <Text numberOfLines={2} style={styles.productTitle}>
          {item.title}
        </Text>
        {item.variantTitle ? <Text style={styles.variantText}>{item.variantTitle}</Text> : null}
        <Text style={styles.meta}>{getOrderDisplayId(item.orderId)}</Text>
        <Text style={styles.meta}>{item.date}</Text>

        <View style={[styles.actionRow, isCompact && styles.actionRowCompact]}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => openProduct(item)}>
            <Text style={styles.secondaryBtnText}>View item</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => openReviewForm(item)}>
            <Text style={styles.primaryBtnText}>Write review</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  const renderSubmittedItem = ({ item }: { item: ReviewItem }) => (
    <View style={[styles.reviewCard, isCompact && styles.reviewCardCompact]}>
      <Image source={{ uri: item.image }} style={[styles.productImage, isCompact && styles.productImageCompact]} />
      <View style={styles.reviewInfo}>
        <Text numberOfLines={2} style={styles.productTitle}>
          {item.title}
        </Text>
        {item.variantTitle ? <Text style={styles.variantText}>{item.variantTitle}</Text> : null}
        <Text style={styles.meta}>{getOrderDisplayId(item.orderId)}</Text>
        <Text style={styles.meta}>{item.date}</Text>
        <StarRow rating={item.rating} />
        {!!item.comment && (
          <Text numberOfLines={2} style={styles.commentText}>
            {item.comment}
          </Text>
        )}

        <TouchableOpacity
          style={[styles.secondaryBtn, styles.submittedViewBtn]}
          onPress={() => openProduct(item)}
        >
          <Text style={styles.secondaryBtnText}>View item</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderEmptyState = () => {
    if (!isSignedIn) {
      return (
        <View style={styles.emptyCard}>
          <Ionicons name="person-circle-outline" size={38} color="#ff7a00" />
          <Text style={styles.emptyBig}>Sign in to view and write reviews.</Text>
        </View>
      );
    }

    if (loading) {
      return (
        <View style={styles.emptyCard}>
          <Ionicons name="time-outline" size={34} color="#ff7a00" />
          <Text style={styles.emptyBig}>Loading your reviews...</Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyCard}>
        <Ionicons name="chatbubble-ellipses-outline" size={34} color="#ff7a00" />
        <Text style={styles.emptyBig}>
          {tab === 'pending' ? 'No items waiting for review.' : 'You have not reviewed anything yet.'}
        </Text>
        <Text style={styles.emptyText}>
          {tab === 'pending'
            ? 'Purchased items will appear here after they are completed or delivered.'
            : 'Your submitted product reviews will appear here.'}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Reviews</Text>

        <View style={styles.iconBtnPlaceholder} />
      </View>

      <View style={styles.heroCard}>
        <View style={styles.heroLeft}>
          <Text style={styles.heroTitle}>Your reviews</Text>
          <Text style={styles.heroText}>
            Rate items you bought and help other shoppers choose better.
          </Text>
        </View>

        <View style={styles.heroBadge}>
          <Ionicons name="star" size={18} color="#ff7a00" />
        </View>
      </View>

      {isSignedIn ? (
        <View style={styles.tabsWrap}>
          <TouchableOpacity
            style={[styles.tabBtn, tab === 'pending' && styles.activeTabBtn]}
            onPress={() => setTab('pending')}
          >
            <Text style={[styles.tabText, tab === 'pending' && styles.activeTabText]}>
              Pending ({loading ? 0 : pendingReviews.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabBtn, tab === 'submitted' && styles.activeTabBtn]}
            onPress={() => setTab('submitted')}
          >
            <Text style={[styles.tabText, tab === 'submitted' && styles.activeTabText]}>
              My reviews ({loading ? 0 : myReviews.length})
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!isSignedIn || loading || data.length === 0 ? (
        renderEmptyState()
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={tab === 'pending' ? renderPendingItem : renderSubmittedItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
    paddingHorizontal: 12,
    paddingTop: 10,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },

  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#f3ddd0',
    alignItems: 'center',
    justifyContent: 'center',
  },

  iconBtnPlaceholder: {
    width: 40,
    height: 40,
  },

  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },

  heroCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },

  heroLeft: {
    flex: 1,
    paddingRight: 12,
  },

  heroTitle: {
    fontSize: 19,
    fontWeight: '900',
    color: '#111',
    marginBottom: 5,
  },

  heroText: {
    fontSize: 13,
    color: '#666',
    lineHeight: 19,
  },

  heroBadge: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: '#fff3eb',
    alignItems: 'center',
    justifyContent: 'center',
  },

  tabsWrap: {
    flexDirection: 'row',
    backgroundColor: '#ffeede',
    borderRadius: 18,
    padding: 4,
    marginBottom: 14,
  },

  tabBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 14,
    alignItems: 'center',
  },

  activeTabBtn: {
    backgroundColor: '#fff',
  },

  tabText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#8a6a5a',
  },

  activeTabText: {
    color: '#111',
  },

  listContent: {
    paddingBottom: 30,
  },

  reviewCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    flexDirection: 'row',
    marginBottom: 12,
  },

  reviewCardCompact: {
    padding: 10,
    borderRadius: 16,
  },

  productImage: {
    width: 82,
    height: 82,
    borderRadius: 15,
    backgroundColor: '#f4f4f4',
  },

  productImageCompact: {
    width: 70,
    height: 70,
    borderRadius: 13,
  },

  reviewInfo: {
    flex: 1,
    marginLeft: 11,
    minWidth: 0,
  },

  productTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111',
    marginBottom: 5,
  },

  variantText: {
    fontSize: 11,
    color: '#8a6a5a',
    fontWeight: '700',
    marginBottom: 3,
  },

  meta: {
    fontSize: 12,
    color: '#777',
    marginBottom: 3,
  },

  starRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 6,
  },

  commentText: {
    fontSize: 13,
    color: '#555',
    marginTop: 8,
    lineHeight: 18,
  },

  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },

  actionRowCompact: {
    gap: 6,
  },

  primaryBtn: {
    backgroundColor: '#ff7a00',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 13,
  },

  primaryBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },

  secondaryBtn: {
    backgroundColor: '#fff5ef',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 13,
  },

  secondaryBtnText: {
    color: '#ff7a00',
    fontSize: 12,
    fontWeight: '800',
  },

  submittedViewBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
  },

  emptyCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 22,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    marginTop: 10,
  },

  emptyBig: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginTop: 12,
    marginBottom: 8,
    textAlign: 'center',
  },

  emptyText: {
    fontSize: 13,
    color: '#666',
    lineHeight: 19,
    textAlign: 'center',
  },
});
