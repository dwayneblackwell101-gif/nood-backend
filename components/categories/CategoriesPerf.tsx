import React, { memo, useCallback } from 'react';
import {
  FlatList,
  Platform,
  Text,
  TouchableOpacity,
  View,
  type ImageStyle,
  type ListRenderItem,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CATALOG_LIST_PROPS } from '../catalog/ListPerf';

export const PERF_CATEGORIES_DEBUG = false;
export const CATEGORY_RAIL_ITEM_HEIGHT = 68;

type CategoryStyles = Record<string, any>;

type CategoryRailGroup = {
  id: string;
  title: string;
};

type CategoryRailItemProps = {
  group: CategoryRailGroup;
  active: boolean;
  isDesktop: boolean;
  isMobile: boolean;
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  styles: CategoryStyles;
  onPress: (groupId: string) => void;
};

export const CategoryRailItem = memo(function CategoryRailItem({
  group,
  active,
  isDesktop,
  isMobile,
  iconName,
  styles,
  onPress,
}: CategoryRailItemProps) {
  const handlePress = useCallback(() => {
    onPress(group.id);
  }, [group.id, onPress]);

  return (
    <TouchableOpacity
      style={[
        styles.railItem,
        isDesktop ? styles.railItemDesktop : styles.railItemMobile,
        active && styles.railItemActive,
      ]}
      activeOpacity={0.9}
      onPress={handlePress}
    >
      {active ? <View style={styles.railAccent} /> : null}
      <Ionicons
        name={iconName}
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
});

type CategoryOptimizedImageProps = {
  uri: string;
  style: StyleProp<ImageStyle>;
  recyclingKey?: string;
  contentFit?: 'cover' | 'contain';
};

export const CategoryOptimizedImage = memo(function CategoryOptimizedImage({
  uri,
  style,
  recyclingKey,
  contentFit = 'cover',
}: CategoryOptimizedImageProps) {
  return (
    <ExpoImage
      source={{ uri }}
      style={style}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      recyclingKey={recyclingKey || uri}
      transition={0}
    />
  );
});

type CategoryBubbleCellProps = {
  itemId: string;
  itemHandle: string;
  title: string;
  imageUri?: string;
  badge?: string | null;
  placeholderIcon: React.ComponentProps<typeof Ionicons>['name'];
  hasImage: boolean;
  styles: CategoryStyles;
  onPress: () => void;
};

export const CategoryBubbleCell = memo(function CategoryBubbleCell({
  itemId,
  itemHandle,
  title,
  imageUri,
  badge,
  placeholderIcon,
  hasImage,
  styles,
  onPress,
}: CategoryBubbleCellProps) {
  return (
    <TouchableOpacity
      activeOpacity={0.88}
      style={styles.shopByCategoryBubbleCell}
      onPress={onPress}
    >
      <View style={styles.shopByCategoryBubbleRing}>
        {hasImage && imageUri ? (
          <CategoryOptimizedImage
            uri={imageUri}
            style={styles.shopByCategoryBubbleImage}
            recyclingKey={`bubble-${itemHandle}`}
          />
        ) : (
          <View style={styles.shopByCategoryBubblePlaceholder}>
            <Ionicons name={placeholderIcon} size={22} color="#b8b8b8" />
          </View>
        )}
        {badge ? (
          <View style={styles.shopByCategoryBubbleBadge}>
            <Text style={styles.shopByCategoryBubbleBadgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text numberOfLines={2} style={styles.shopByCategoryBubbleLabel}>
        {title}
      </Text>
    </TouchableOpacity>
  );
});

type CategoryProductCardProps = {
  productId: string;
  productHandle: string;
  title: string;
  price: string;
  imageUri?: string;
  imageWidth: number;
  hasImage: boolean;
  isMobile: boolean;
  meta?: string | null;
  availabilityLabel?: string | null;
  badgeText?: string | null;
  cardStyle: StyleProp<ViewStyle>;
  imageStyle: StyleProp<ImageStyle>;
  infoStyle?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
  priceStyle?: StyleProp<TextStyle>;
  placeholderStyle: StyleProp<ViewStyle>;
  styles: CategoryStyles;
  onPress: () => void;
};

export const CategoryGridProductCard = memo(function CategoryGridProductCard({
  productId,
  productHandle,
  title,
  price,
  imageUri,
  imageWidth,
  hasImage,
  isMobile,
  meta,
  availabilityLabel,
  cardStyle,
  imageStyle,
  infoStyle,
  titleStyle,
  priceStyle,
  placeholderStyle,
  styles,
  onPress,
}: CategoryProductCardProps) {
  return (
    <TouchableOpacity activeOpacity={0.88} style={cardStyle} onPress={onPress}>
      {hasImage && imageUri ? (
        <CategoryOptimizedImage
          uri={imageUri}
          style={imageStyle}
          recyclingKey={`product-${productHandle}`}
        />
      ) : (
        <View style={placeholderStyle}>
          <Ionicons name="image-outline" size={24} color="#b8b8b8" />
        </View>
      )}
      <View style={infoStyle}>
        <Text numberOfLines={2} style={titleStyle}>
          {title}
        </Text>
        <Text numberOfLines={1} style={priceStyle}>
          {price}
        </Text>
        {availabilityLabel ? (
          <Text numberOfLines={1} style={styles.stockUnavailableText}>
            {availabilityLabel}
          </Text>
        ) : null}
        {meta ? (
          <Text numberOfLines={1} style={styles.allCategoryMeta}>
            {meta}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
});

export const CategoryTrendingCard = memo(function CategoryTrendingCard({
  productHandle,
  title,
  price,
  imageUri,
  hasImage,
  availabilityLabel,
  badgeText,
  cardStyle,
  styles,
  onPress,
}: Omit<
  CategoryProductCardProps,
  | 'productId'
  | 'imageWidth'
  | 'isMobile'
  | 'meta'
  | 'cardStyle'
  | 'imageStyle'
  | 'infoStyle'
  | 'titleStyle'
  | 'priceStyle'
  | 'placeholderStyle'
> & {
  cardStyle: StyleProp<ViewStyle>;
}) {
  return (
    <TouchableOpacity activeOpacity={0.88} style={cardStyle} onPress={onPress}>
      {hasImage && imageUri ? (
        <CategoryOptimizedImage
          uri={imageUri}
          style={styles.trendingCategoryImage}
          recyclingKey={`trending-${productHandle}`}
        />
      ) : (
        <View style={styles.trendingCategoryPlaceholder}>
          <Ionicons name="image-outline" size={24} color="#b8b8b8" />
        </View>
      )}
      <Text numberOfLines={2} style={styles.trendingCategoryTitle}>
        {title}
      </Text>
      <Text numberOfLines={1} style={styles.trendingCategoryPrice}>
        {price}
      </Text>
      {availabilityLabel ? (
        <Text numberOfLines={1} style={styles.stockUnavailableText}>
          {availabilityLabel}
        </Text>
      ) : null}
      {badgeText ? (
        <View style={styles.smallOrangeBadge}>
          <Text style={styles.smallOrangeBadgeText}>{badgeText}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

type CategoriesRailListProps = {
  groups: CategoryRailGroup[];
  activeGroupId: string;
  isDesktop: boolean;
  isMobile: boolean;
  styles: CategoryStyles;
  listRef: React.RefObject<FlatList<CategoryRailGroup> | null>;
  getIconName: (title?: string | null) => React.ComponentProps<typeof Ionicons>['name'];
  onSelectCategory: (groupId: string) => void;
  onScrollOffset: (offset: number) => void;
};

export const CategoriesRailList = memo(function CategoriesRailList({
  groups,
  activeGroupId,
  isDesktop,
  isMobile,
  styles,
  listRef,
  getIconName,
  onSelectCategory,
  onScrollOffset,
}: CategoriesRailListProps) {
  const renderRailItem: ListRenderItem<CategoryRailGroup> = useCallback(
    ({ item }) => (
      <CategoryRailItem
        group={item}
        active={item.id === activeGroupId}
        isDesktop={isDesktop}
        isMobile={isMobile}
        iconName={getIconName(item.title)}
        styles={styles}
        onPress={onSelectCategory}
      />
    ),
    [activeGroupId, getIconName, isDesktop, isMobile, onSelectCategory, styles]
  );

  const keyExtractor = useCallback((item: CategoryRailGroup) => item.id, []);

  const getItemLayout = useCallback(
    (_: ArrayLike<CategoryRailGroup> | null | undefined, index: number) => ({
      length: CATEGORY_RAIL_ITEM_HEIGHT,
      offset: CATEGORY_RAIL_ITEM_HEIGHT * index,
      index,
    }),
    []
  );

  const handleScroll = useCallback(
    (event: any) => {
      onScrollOffset(event.nativeEvent.contentOffset.y);
    },
    [onScrollOffset]
  );

  return (
    <FlatList
      ref={listRef}
      data={groups}
      style={styles.railScroll}
      contentContainerStyle={styles.railContent}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      keyExtractor={keyExtractor}
      renderItem={renderRailItem}
      getItemLayout={getItemLayout}
      onScroll={handleScroll}
      {...CATALOG_LIST_PROPS}
    />
  );
});

type CategoriesTrendingListProps<T extends { id: string; handle: string }> = {
  products: T[];
  isDesktop: boolean;
  styles: CategoryStyles;
  renderCard: (product: T, index: number) => React.ReactElement | null;
};

export function CategoriesTrendingList<T extends { id: string; handle: string }>({
  products,
  styles,
  renderCard,
}: CategoriesTrendingListProps<T>) {
  const renderItem: ListRenderItem<T> = useCallback(
    ({ item, index }) => renderCard(item, index),
    [renderCard]
  );

  const keyExtractor = useCallback((item: T) => `trending-product-${item.id}-${item.handle}`, []);

  return (
    <FlatList
      horizontal
      data={products}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.trendingCardsRow}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      initialNumToRender={4}
      maxToRenderPerBatch={4}
      windowSize={5}
      removeClippedSubviews={Platform.OS === 'android'}
    />
  );
}