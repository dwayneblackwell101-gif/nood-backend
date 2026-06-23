import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { useNavigationState } from '@react-navigation/native';
import { Tabs, usePathname, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type TabPath = '/' | '/categories' | '/cart' | '/wishlist' | '/account';

function isHomeTabPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/(tabs)' ||
    pathname === '/index' ||
    pathname === '/(tabs)/index'
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
            <PlatformPressable
              {...props}
              onPress={(event) => {
                if (shouldIgnoreHomeTabPress) return;
                props.onPress?.(event);
              }}
            />
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
            <Ionicons name="cart" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="wishlist"
        options={{
          title: 'Wishlist',
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
