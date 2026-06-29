import React, { useCallback, useMemo, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import NoodSpinner from '../../components/NoodSpinner';
import { ACCOUNT_SIGN_IN_GATE_DISABLED } from '../../components/RequireSignIn';
import { useCart } from '../../context/CartContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';

import { getCustomerProfile } from '../../utils/customer-profile';
import {
  CustomerReview,
  getCustomerReviews,
  getReviewStatusColor,
  getReviewStatusLabel,
  getReviewableItemsFromOrders,
  isReviewEligibleOrder,
  submitCustomerReview,
  type ReviewableOrderItem,
} from '../../utils/customer-reviews';
import { buildProductRouteParams } from '../../utils/product-navigation';
import { noodAlert } from '../../utils/nood-alert';

type TabKey = 'toReview' | 'myReviews';

function getOrderDisplayId(orderId: string) {
  const clean = String(orderId || '').replace(/^#/, '');
  return clean ? `#${clean}` : 'Order';
}

function formatDisplayDate(value?: string, prefix = '') {
  if (!value) {
    return prefix ? `${prefix}Recently` : 'Recently';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return prefix ? `${prefix}${value}` : value;
  }

  return `${prefix}${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

function StarPicker({
  rating,
  onChange,
  size = 28,
}: {
  rating: number;
  onChange: (value: number) => void;
  size?: number;
}) {
  return (
    <View style={styles.starPickerRow}>
      {[1, 2, 3, 4, 5].map((star) => (
        <TouchableOpacity
          key={star}
          activeOpacity={0.85}
          onPress={() => onChange(star)}
          style={styles.starPickerBtn}
        >
          <Ionicons
            name={star <= rating ? 'star' : 'star-outline'}
            size={size}
            color="#ff6a00"
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

function StarRow({ rating = 0, size = 15 }: { rating?: number; size?: number }) {
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Ionicons
          key={star}
          name={star <= rating ? 'star' : 'star-outline'}
          size={size}
          color="#ff6a00"
        />
      ))}
    </View>
  );
}

function ProductThumbnail({ uri, compact = false }: { uri?: string; compact?: boolean }) {
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.productImage, compact && styles.productImageCompact]}
        resizeMode="cover"
      />
    );
  }

  return (
    <View style={[styles.productImage, styles.productImagePlaceholder, compact && styles.productImageCompact]}>
      <Ionicons name="image-outline" size={compact ? 22 : 26} color="#c4b5aa" />
    </View>
  );
}

function StatusBadge({ status }: { status: CustomerReview['status'] }) {
  return (
    <View style={[styles.statusBadge, { borderColor: `${getReviewStatusColor(status)}33` }]}>
      <Text style={[styles.statusBadgeText, { color: getReviewStatusColor(status) }]}>
        {getReviewStatusLabel(status)}
      </Text>
    </View>
  );
}

export default function ReviewsScreen() {
  const router = useRouter();
  const { orders = [] } = useCart() || {};
  const { isReady, isSignedIn, profileId } = useUser();
  const { addHistoryEvent } = useHistoryEvents();

  const [tab, setTab] = useState<TabKey>('toReview');
  const [customerEmail, setCustomerEmail] = useState('');
  const [submittedReviews, setSubmittedReviews] = useState<CustomerReview[]>([]);
  const [loading, setLoading] = useState(true);

  const [formVisible, setFormVisible] = useState(false);
  const [activeItem, setActiveItem] = useState<ReviewableOrderItem | null>(null);
  const [formRating, setFormRating] = useState(5);
  const [formTitle, setFormTitle] = useState('');
  const [formText, setFormText] = useState('');
  const [formPhotoUri, setFormPhotoUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    if (!isSignedIn || !profileId) {
      setCustomerEmail('');
      setSubmittedReviews([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const profile = await getCustomerProfile();
      const email = profile?.email || '';
      setCustomerEmail(email);

      const customerReviews = await getCustomerReviews(profileId, email, true);
      setSubmittedReviews(customerReviews);
    } catch (error) {
      console.log('Reviews screen load error:', error);
      setSubmittedReviews([]);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, profileId]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData])
  );

  const sortedOrders = useMemo(
    () => (Array.isArray(orders) ? orders : []),
    [orders]
  );

  const submittedItemIds = useMemo(
    () => new Set(submittedReviews.map((review) => review.orderItemId)),
    [submittedReviews]
  );

  const reviewableItems = useMemo(
    () => getReviewableItemsFromOrders(sortedOrders),
    [sortedOrders]
  );

  const toReviewItems = useMemo(
    () => reviewableItems.filter((item) => !submittedItemIds.has(item.orderItemId)),
    [reviewableItems, submittedItemIds]
  );

  const hasEligibleOrders = useMemo(
    () => sortedOrders.some(isReviewEligibleOrder),
    [sortedOrders]
  );

  const hasAnyPurchases = useMemo(
    () =>
      sortedOrders.some((order) => Array.isArray(order.items) && order.items.length > 0),
    [sortedOrders]
  );

  const goToSignIn = useCallback(() => {
    router.replace('/(tabs)/account' as any);
  }, [router]);

  const openProduct = useCallback(
    (item: { handle: string; title: string; image?: string; orderId: string; orderItemId: string }) => {
      router.push({
        pathname: '/product/[handle]',
        params: buildProductRouteParams(item, { from: 'reviews' }) as any,
      });
    },
    [router]
  );

  const openReviewForm = useCallback((item: ReviewableOrderItem) => {
    setActiveItem(item);
    setFormRating(5);
    setFormTitle('');
    setFormText('');
    setFormPhotoUri(null);
    setFormVisible(true);
  }, []);

  const closeReviewForm = useCallback(() => {
    if (submitting) {
      return;
    }
    setFormVisible(false);
    setActiveItem(null);
  }, [submitting]);

  const pickReviewPhoto = useCallback(async () => {
    if (Platform.OS === 'web') {
      noodAlert('Photos', 'Add a review photo from the NOOD mobile app.');
      return;
    }

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        noodAlert('Photo access needed', 'Allow photo library access to attach a review photo.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.85,
      });

      if (!result.canceled && result.assets?.[0]?.uri) {
        setFormPhotoUri(result.assets[0].uri);
      }
    } catch (error) {
      console.log('Review photo picker error:', error);
      noodAlert('Photo error', 'Could not attach a photo. Please try again.');
    }
  }, []);

  const handleSubmitReview = useCallback(async () => {
    if (!activeItem || !profileId || !isSignedIn) {
      return;
    }

    if (!formText.trim()) {
      noodAlert('Review needed', 'Please enter your review text.');
      return;
    }

    setSubmitting(true);
    try {
      const savedReview = await submitCustomerReview({
        profileId,
        email: customerEmail,
        isSignedIn,
        orderId: activeItem.orderId,
        orderItemId: activeItem.orderItemId,
        title: activeItem.title,
        reviewTitle: formTitle.trim() || undefined,
        image: activeItem.image,
        handle: activeItem.handle,
        variantTitle: activeItem.variantTitle,
        rating: formRating,
        comment: formText.trim(),
        photoUri: formPhotoUri || undefined,
      });

      setSubmittedReviews((current) => [
        savedReview,
        ...current.filter((review) => review.orderItemId !== savedReview.orderItemId),
      ]);
      setFormVisible(false);
      setActiveItem(null);
      setTab('myReviews');

      void addHistoryEvent({
        type: 'review',
        title: 'Review submitted',
        description: `${activeItem.title} — ${formRating} star review saved.`,
        status: savedReview.status,
        relatedId: savedReview.orderItemId,
        metadata: {
          orderId: activeItem.orderId,
          rating: formRating,
          productTitle: activeItem.title,
        },
      });

      const statusMessage =
        savedReview.status === 'published'
          ? 'Your review was submitted and is now published.'
          : 'Your review was saved on this device — not published yet.';

      noodAlert('Review saved', statusMessage);
    } catch (error) {
      console.log('Submit review error:', error);
      noodAlert('Review not saved', 'Please try submitting your review again.');
    } finally {
      setSubmitting(false);
    }
  }, [
    activeItem,
    addHistoryEvent,
    customerEmail,
    formPhotoUri,
    formRating,
    formText,
    formTitle,
    isSignedIn,
    profileId,
  ]);

  const renderGuestState = () => (
    <View style={styles.emptyCard}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="star-half-outline" size={30} color="#ff6a00" />
      </View>
      <Text style={styles.emptyTitle}>Sign in to manage reviews</Text>
      <Text style={styles.emptySubtitle}>
        After you sign in, products you purchased will appear here so you can rate and review them.
      </Text>
      <TouchableOpacity style={styles.primaryWideBtn} activeOpacity={0.9} onPress={goToSignIn}>
        <Ionicons name="person-circle-outline" size={18} color="#fff" />
        <Text style={styles.primaryWideBtnText}>Go to sign in</Text>
      </TouchableOpacity>
    </View>
  );

  const renderSignedInEmpty = () => {
    if (loading) {
      return (
        <View style={styles.loadingCard}>
          <NoodSpinner size={42} />
          <Text style={styles.loadingText}>Loading your reviews...</Text>
        </View>
      );
    }

    if (tab === 'toReview') {
      if (!hasAnyPurchases) {
        return (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="bag-outline" size={30} color="#ff6a00" />
            </View>
            <Text style={styles.emptyTitle}>No items to review yet</Text>
            <Text style={styles.emptySubtitle}>
              Products you buy will appear here after checkout.
            </Text>
          </View>
        );
      }

      if (hasEligibleOrders && toReviewItems.length === 0) {
        return (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="checkmark-circle-outline" size={30} color="#ff6a00" />
            </View>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySubtitle}>You have reviewed all eligible items.</Text>
          </View>
        );
      }

      return (
        <View style={styles.emptyCard}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name="time-outline" size={30} color="#ff6a00" />
          </View>
          <Text style={styles.emptyTitle}>No items to review yet</Text>
          <Text style={styles.emptySubtitle}>
            Products you buy will appear here after checkout.
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyCard}>
        <View style={styles.emptyIconWrap}>
          <Ionicons name="chatbubble-ellipses-outline" size={30} color="#ff6a00" />
        </View>
        <Text style={styles.emptyTitle}>You have not written any reviews yet.</Text>
        <Text style={styles.emptySubtitle}>
          Purchased items you review will appear here with their rating and status.
        </Text>
      </View>
    );
  };

  const renderToReviewCard = (item: ReviewableOrderItem) => (
    <View key={item.id} style={styles.reviewCard}>
      <ProductThumbnail uri={item.image} />
      <View style={styles.reviewInfo}>
        <Text numberOfLines={2} style={styles.productTitle}>
          {item.title}
        </Text>
        {item.variantTitle ? <Text style={styles.variantText}>{item.variantTitle}</Text> : null}
        <Text style={styles.meta}>{getOrderDisplayId(item.orderId)}</Text>
        <Text style={styles.meta}>{formatDisplayDate(item.orderDate, 'Purchased ')}</Text>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.secondaryBtn}
            activeOpacity={0.88}
            onPress={() => openProduct(item)}
          >
            <Text style={styles.secondaryBtnText}>View item</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.primaryBtn}
            activeOpacity={0.88}
            onPress={() => openReviewForm(item)}
          >
            <Text style={styles.primaryBtnText}>Write review</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  const renderSubmittedCard = (review: CustomerReview) => (
    <View key={review.id} style={styles.reviewCard}>
      <ProductThumbnail uri={review.image} />
      <View style={styles.reviewInfo}>
        <View style={styles.submittedHeaderRow}>
          <Text numberOfLines={2} style={[styles.productTitle, styles.productTitleFlex]}>
            {review.title}
          </Text>
          <StatusBadge status={review.status} />
        </View>

        {review.reviewTitle ? (
          <Text numberOfLines={1} style={styles.reviewHeadline}>
            {review.reviewTitle}
          </Text>
        ) : null}

        {review.variantTitle ? <Text style={styles.variantText}>{review.variantTitle}</Text> : null}
        <Text style={styles.meta}>{getOrderDisplayId(review.orderId)}</Text>
        <Text style={styles.meta}>{formatDisplayDate(review.submittedAt, 'Reviewed ')}</Text>
        <StarRow rating={review.rating} />

        {review.comment ? (
          <Text numberOfLines={3} style={styles.commentText}>
            {review.comment}
          </Text>
        ) : null}

        {review.photoUri ? (
          <Image source={{ uri: review.photoUri }} style={styles.reviewPhotoThumb} resizeMode="cover" />
        ) : null}

        <TouchableOpacity
          style={[styles.secondaryBtn, styles.submittedViewBtn]}
          activeOpacity={0.88}
          onPress={() => openProduct(review)}
        >
          <Text style={styles.secondaryBtnText}>View item</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const listData = tab === 'toReview' ? toReviewItems : submittedReviews;
  const showGuestOnly = isReady && !isSignedIn && !ACCOUNT_SIGN_IN_GATE_DISABLED;
  const showSignedInList = isSignedIn && !loading && listData.length > 0;

  if (!isReady) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
            <Ionicons name="arrow-back" size={22} color="#111" />
          </TouchableOpacity>
          <Text style={styles.title}>Reviews</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={[styles.content, styles.loadingScreen]}>
          <NoodSpinner size={48} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Reviews</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.heroCard}>
          <View style={styles.heroLeft}>
            <Text style={styles.heroTitle}>Your reviews</Text>
            <Text style={styles.heroText}>
              Review items you purchased and help other shoppers choose better.
            </Text>
          </View>
          <View style={styles.heroBadge}>
            <Ionicons name="star" size={20} color="#ff6a00" />
          </View>
        </View>

        {isSignedIn ? (
          <View style={styles.tabsWrap}>
            <TouchableOpacity
              style={[styles.tabBtn, tab === 'toReview' && styles.activeTabBtn]}
              activeOpacity={0.88}
              onPress={() => setTab('toReview')}
            >
              <Text style={[styles.tabText, tab === 'toReview' && styles.activeTabText]}>
                To review ({loading ? '…' : toReviewItems.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tabBtn, tab === 'myReviews' && styles.activeTabBtn]}
              activeOpacity={0.88}
              onPress={() => setTab('myReviews')}
            >
              <Text style={[styles.tabText, tab === 'myReviews' && styles.activeTabText]}>
                My reviews ({loading ? '…' : submittedReviews.length})
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {showGuestOnly
          ? renderGuestState()
          : showSignedInList
            ? listData.map((entry) =>
                tab === 'toReview'
                  ? renderToReviewCard(entry as ReviewableOrderItem)
                  : renderSubmittedCard(entry as CustomerReview)
              )
            : renderSignedInEmpty()}
      </ScrollView>

      <Modal
        visible={formVisible}
        transparent
        animationType="slide"
        onRequestClose={closeReviewForm}
      >
        <KeyboardAvoidingView
          style={styles.formOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity style={styles.formBackdrop} activeOpacity={1} onPress={closeReviewForm} />

          <View style={styles.formCard}>
            <View style={styles.formAccentBar} />

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={styles.formHeader}>
                <Text style={styles.formTitle}>Write review</Text>
                <TouchableOpacity onPress={closeReviewForm} disabled={submitting}>
                  <Ionicons name="close" size={24} color="#6f5a4e" />
                </TouchableOpacity>
              </View>

              {activeItem ? (
                <View style={styles.formProductRow}>
                  <ProductThumbnail uri={activeItem.image} compact />
                  <View style={styles.formProductText}>
                    <Text numberOfLines={2} style={styles.formProductTitle}>
                      {activeItem.title}
                    </Text>
                    <Text style={styles.formProductMeta}>
                      {getOrderDisplayId(activeItem.orderId)}
                    </Text>
                  </View>
                </View>
              ) : null}

              <Text style={styles.formLabel}>Your rating</Text>
              <StarPicker rating={formRating} onChange={setFormRating} />

              <Text style={styles.formLabel}>Review title (optional)</Text>
              <TextInput
                value={formTitle}
                onChangeText={setFormTitle}
                placeholder="Summarize your experience"
                placeholderTextColor="#a89b92"
                style={styles.formInput}
                maxLength={80}
              />

              <Text style={styles.formLabel}>Your review</Text>
              <TextInput
                value={formText}
                onChangeText={setFormText}
                placeholder="What did you like or dislike?"
                placeholderTextColor="#a89b92"
                multiline
                style={[styles.formInput, styles.formTextArea]}
                maxLength={1200}
              />

              <TouchableOpacity
                style={styles.photoBtn}
                activeOpacity={0.88}
                onPress={() => void pickReviewPhoto()}
                disabled={submitting}
              >
                <Ionicons name="camera-outline" size={18} color="#ff6a00" />
                <Text style={styles.photoBtnText}>
                  {formPhotoUri ? 'Change photo' : 'Add photo (optional)'}
                </Text>
              </TouchableOpacity>

              {formPhotoUri ? (
                <Image source={{ uri: formPhotoUri }} style={styles.formPhotoPreview} resizeMode="cover" />
              ) : null}

              <Text style={styles.formDisclaimer}>
                Reviews are saved for products you purchased. Reviews stay on this device until
                publishing is connected.
              </Text>

              <TouchableOpacity
                style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                activeOpacity={0.9}
                onPress={() => void handleSubmitReview()}
                disabled={submitting}
              >
                {submitting ? (
                  <NoodSpinner size={24} />
                ) : (
                  <Text style={styles.submitBtnText}>Submit review</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },
  headerSpacer: {
    width: 42,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  heroCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    shadowColor: '#ff6a00',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  heroLeft: {
    flex: 1,
    paddingRight: 12,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
    marginBottom: 6,
  },
  heroText: {
    fontSize: 14,
    color: '#666',
    lineHeight: 21,
    fontWeight: '600',
  },
  heroBadge: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
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
  reviewCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    flexDirection: 'row',
    marginBottom: 12,
  },
  productImage: {
    width: 84,
    height: 84,
    borderRadius: 16,
    backgroundColor: '#f4f4f4',
  },
  productImageCompact: {
    width: 56,
    height: 56,
    borderRadius: 14,
  },
  productImagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  reviewInfo: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0,
  },
  submittedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  productTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111',
    marginBottom: 4,
  },
  productTitleFlex: {
    flex: 1,
    minWidth: 0,
  },
  reviewHeadline: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4e260d',
    marginBottom: 4,
  },
  variantText: {
    fontSize: 12,
    color: '#8a6a5a',
    fontWeight: '700',
    marginBottom: 3,
  },
  meta: {
    fontSize: 12,
    color: '#777',
    marginBottom: 2,
    fontWeight: '600',
  },
  starRow: {
    flexDirection: 'row',
    gap: 3,
    marginTop: 6,
  },
  commentText: {
    fontSize: 13,
    color: '#555',
    marginTop: 8,
    lineHeight: 19,
    fontWeight: '600',
  },
  reviewPhotoThumb: {
    width: 72,
    height: 72,
    borderRadius: 12,
    marginTop: 10,
    backgroundColor: '#f4f4f4',
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  primaryBtn: {
    backgroundColor: '#ff6a00',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  secondaryBtn: {
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  secondaryBtnText: {
    color: '#ff6a00',
    fontSize: 12,
    fontWeight: '800',
  },
  submittedViewBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
  },
  statusBadge: {
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#fff7f2',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  emptyCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
  },
  emptyIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
    marginTop: 14,
    textAlign: 'center',
  },
  emptySubtitle: {
    marginTop: 8,
    fontSize: 13,
    color: '#666',
    lineHeight: 20,
    textAlign: 'center',
    fontWeight: '600',
    maxWidth: 320,
  },
  primaryWideBtn: {
    marginTop: 16,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryWideBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  loadingCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 28,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
    fontWeight: '700',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  formOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(18, 14, 12, 0.48)',
  },
  formBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  formCard: {
    maxHeight: '88%',
    backgroundColor: '#fff9f3',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingBottom: 24,
  },
  formAccentBar: {
    height: 4,
    backgroundColor: '#ff6a00',
    opacity: 0.92,
    marginHorizontal: -18,
    marginBottom: 16,
  },
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  formTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
  },
  formProductRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 12,
    marginBottom: 14,
  },
  formProductText: {
    flex: 1,
    minWidth: 0,
  },
  formProductTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111',
  },
  formProductMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#777',
    fontWeight: '600',
  },
  formLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#4e260d',
    marginBottom: 8,
    marginTop: 4,
  },
  starPickerRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  starPickerBtn: {
    padding: 2,
  },
  formInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#eadfd6',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111',
    fontWeight: '600',
    marginBottom: 8,
  },
  formTextArea: {
    minHeight: 110,
    textAlignVertical: 'top',
  },
  photoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    marginBottom: 8,
  },
  photoBtnText: {
    color: '#ff6a00',
    fontSize: 14,
    fontWeight: '800',
  },
  formPhotoPreview: {
    width: '100%',
    height: 160,
    borderRadius: 16,
    marginBottom: 10,
    backgroundColor: '#f4f4f4',
  },
  formDisclaimer: {
    fontSize: 12,
    lineHeight: 18,
    color: '#8d7a6f',
    fontWeight: '600',
    marginBottom: 14,
  },
  submitBtn: {
    minHeight: 50,
    borderRadius: 16,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.7,
  },
  submitBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
});