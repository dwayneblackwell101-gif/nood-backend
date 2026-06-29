import { useEffect, useRef } from 'react';
import { BackHandler, StyleSheet, Text, View } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { useNavigationState } from '@react-navigation/native';
import { Tabs, usePathname, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCart } from '../../context/CartContext';
import { useWishlist } from '../../context/WishlistContext';

type TabPath = '/' | '/categories' | '/cart' | '/wishlist' | '/account';

function isHomeTabPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/(tabs)' ||
    pathname === '/index' ||
    pathname === '/(tabs)/index'
  );
}

function CartTabIcon({
  color,
  size,
  badge,
}: {
  color: string;
  size: number;
  badge?: string | number;
}) {
  return (
    <View style={styles.cartIconWrap}>
      <Ionicons name="cart" size={size} color={color} />
      {badge != null ? (
        <View style={styles.cartBadge}>
          <Text style={styles.cartBadgeText}>{badge}</Text>
        </View>
      ) : null}
    </View>
  );
}

function getTabPath(pathname: string): TabPath | null {
  if (isHomeTabPath(pathname)) return '/';
  if (pathname === '/categories') return '/categories';
  if (pathname === '/cart') return '/cart';
  if (pathname === '/wishlist') return '/wishlist';
  if (pathname === '/account') return '/account';
  return null;
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { cartCount } = useCart();
  const { wishlistCount } = useWishlist();
  const cartBadge =
    cartCount > 0 ? (cartCount > 99 ? '99+' : cartCount) : undefined;
  const wishlistBadge =
    wishlistCount > 0 ? (wishlistCount > 99 ? '99+' : wishlistCount) : undefined;
  const tabHistoryRef = useRef<TabPath[]>([]);
  const isHomeTabActive = useNavigationState(
    (state) => state.routes[state.index]?.name === 'index'
  );
  const shouldIgnoreHomeTabPress = isHomeTabActive && isHomeTabPath(pathname);

  useEffect(() => {
    const tabPath = getTabPath(pathname);
    if (!tabPath) return;

    tabHistoryRef.current = tabHistoryRef.current.filter((path) => path !== tabPath);
    tabHistoryRef.current.push(tabPath);
  }, [pathname]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const currentTab = getTabPath(pathname);
      if (!currentTab) return false;

      const nextHistory = tabHistoryRef.current.filter((path) => path !== currentTab);
      const previousTab = nextHistory[nextHistory.length - 1];

      if (!previousTab) {
        return currentTab !== '/';
      }

      tabHistoryRef.current = nextHistory;
      router.replace(previousTab === '/' ? '/(tabs)' : (`/(tabs)${previousTab}` as any));
      return true;
    });

    return () => subscription.remove();
  }, [pathname, router]);

  return (
    <Tabs
      backBehavior="none"
      detachInactiveScreens={false}
      screenOptions={{
        headerShown: false,
        lazy: true,
        freezeOnBlur: false,
        popToTopOnBlur: false,
        tabBarActiveTintColor: '#ff6a00',
        tabBarInactiveTintColor: '#777',
        tabBarStyle: {
          height: 62 + Math.max(insets.bottom, 8),
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 8),
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        listeners={{
          tabPress: (event) => {
            if (shouldIgnoreHomeTabPress) {
              event.preventDefault();
            }
          },
        }}
        options={{
          lazy: false,
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
          tabBarButton: (props) => (
            <PlatformPressable {...props} />
          ),
        }}
      />

      <Tabs.Screen
        name="categories"
        options={{
          title: 'Categories',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="cart"
        options={{
          title: 'Cart',
          tabBarIcon: ({ color, size }) => (
            <CartTabIcon color={color} size={size} badge={cartBadge} />
          ),
        }}
      />

      <Tabs.Screen
        name="wishlist"
        options={{
          title: 'Wishlist',
          tabBarBadge: wishlistBadge,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="heart" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  cartIconWrap: {
    width: 30,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cartBadge: {
    position: 'absolute',
    top: -3,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  cartBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
    lineHeight: 11,
  },
});
