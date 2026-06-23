import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { useUser } from './UserContext';

const READ_UPDATES_KEY = 'NOOD_READ_UPDATES_V1';
const NOTIFICATION_SETTINGS_KEY = 'NOOD_NOTIFICATION_SETTINGS_V1';
const PUSH_TOKEN_KEY = 'NOOD_EXPO_PUSH_TOKEN_V1';

export type UpdateType = 'deal' | 'app' | 'arrival' | 'reward' | 'shipping' | 'sale' | 'coupon';

export type NoodUpdate = {
  id: string;
  type: UpdateType;
  title: string;
  message: string;
  imageUrl?: string;
  targetRoute?: string;
  actionLabel?: string;
  createdAt: string;
  enabled: boolean;
};

export type NotificationSettings = {
  notificationsEnabled: boolean;
  dealsAlerts: boolean;
  rewardsAlerts: boolean;
  shippingAlerts: boolean;
};

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  notificationsEnabled: false,
  dealsAlerts: true,
  rewardsAlerts: true,
  shippingAlerts: true,
};

export const updates: NoodUpdate[] = [
  {
    id: 'deal-1',
    type: 'deal',
    title: 'New deals just dropped',
    message: "Check out today's best prices before they're gone.",
    imageUrl: '',
    targetRoute: '/account/deals',
    actionLabel: 'View deals',
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    enabled: true,
  },
  {
    id: 'reward-1',
    type: 'reward',
    title: 'Lucky Spin is live',
    message: 'Win small locked rewards and unlock them with qualifying spend.',
    imageUrl: '',
    targetRoute: '/account/rewards',
    actionLabel: 'View rewards',
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    enabled: true,
  },
  {
    id: 'shipping-1',
    type: 'shipping',
    title: 'Shipping updates in Orders',
    message: 'Track packages from your Orders page using your tracking number.',
    imageUrl: '',
    targetRoute: '/account/orders',
    actionLabel: 'Track order',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    enabled: true,
  },
  {
    id: 'arrival-1',
    type: 'arrival',
    title: 'New arrivals added',
    message: 'Fresh products are being added across NOOD collections.',
    imageUrl: '',
    targetRoute: '/categories',
    actionLabel: 'Shop now',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 7).toISOString(),
    enabled: true,
  },
  {
    id: 'app-1',
    type: 'app',
    title: 'Address book upgraded',
    message: 'Save multiple addresses and choose your default shipping address.',
    imageUrl: '',
    targetRoute: '/account/address',
    actionLabel: 'Open address',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
    enabled: true,
  },
  {
    id: 'coupon-1',
    type: 'coupon',
    title: 'Automatic discount reminder',
    message: 'Add 3 or more items to unlock automatic discounts when available.',
    imageUrl: '',
    targetRoute: '/(tabs)/cart',
    actionLabel: 'Open cart',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    enabled: true,
  },
];

type UpdatesContextValue = {
  updates: NoodUpdate[];
  readUpdateIds: string[];
  unreadCount: number;
  notificationSettings: NotificationSettings;
  expoPushToken: string;
  markUpdateRead: (id: string) => Promise<void>;
  markAllUpdatesRead: () => Promise<void>;
  updateNotificationSetting: (key: keyof NotificationSettings, value: boolean) => Promise<void>;
  requestPushPermission: () => Promise<string>;
  openUpdate: (update: NoodUpdate) => Promise<void>;
};

const UpdatesContext = createContext<UpdatesContextValue | null>(null);

const makeProfileKey = (baseKey: string, profileId: string) => `${baseKey}:${profileId || 'guest'}`;

export function UpdatesProvider({ children }: { children: React.ReactNode }) {
  const { profileId, isReady } = useUser();
  const [readUpdateIds, setReadUpdateIds] = useState<string[]>([]);
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  const [expoPushToken, setExpoPushToken] = useState('');

  const readKey = useMemo(() => makeProfileKey(READ_UPDATES_KEY, profileId), [profileId]);
  const settingsKey = useMemo(() => makeProfileKey(NOTIFICATION_SETTINGS_KEY, profileId), [profileId]);
  const tokenKey = useMemo(() => makeProfileKey(PUSH_TOKEN_KEY, profileId), [profileId]);
  const enabledUpdates = useMemo(
    () =>
      updates
        .filter((update) => update.enabled)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    []
  );

  useEffect(() => {
    if (!isReady) return;

    const load = async () => {
      try {
        const [savedRead, savedSettings, savedToken] = await Promise.all([
          AsyncStorage.getItem(readKey),
          AsyncStorage.getItem(settingsKey),
          AsyncStorage.getItem(tokenKey),
        ]);

        setReadUpdateIds(savedRead ? JSON.parse(savedRead) : []);
        setNotificationSettings(
          savedSettings
            ? { ...DEFAULT_NOTIFICATION_SETTINGS, ...JSON.parse(savedSettings) }
            : DEFAULT_NOTIFICATION_SETTINGS
        );
        setExpoPushToken(savedToken || '');
      } catch (error) {
        console.log('Updates load error:', error);
      }
    };

    void load();
  }, [isReady, readKey, settingsKey, tokenKey]);

  const markUpdateRead = useCallback(
    async (id: string) => {
      if (!id || readUpdateIds.includes(id)) return;
      const next = [id, ...readUpdateIds];
      setReadUpdateIds(next);
      await AsyncStorage.setItem(readKey, JSON.stringify(next));
    },
    [readKey, readUpdateIds]
  );

  const markAllUpdatesRead = useCallback(async () => {
    const next = enabledUpdates.map((update) => update.id);
    setReadUpdateIds(next);
    await AsyncStorage.setItem(readKey, JSON.stringify(next));
  }, [enabledUpdates, readKey]);

  const requestPushPermission = useCallback(async () => {
    if (Platform.OS === 'web') return '';

    try {
      setExpoPushToken('');
      await AsyncStorage.removeItem(tokenKey);
      return '';
    } catch (error) {
      console.log('Push notification permission error:', error);
      return '';
    }
  }, [tokenKey]);

  const updateNotificationSetting = useCallback(
    async (key: keyof NotificationSettings, value: boolean) => {
      const next = { ...notificationSettings, [key]: value };

      if (key === 'notificationsEnabled' && !value) {
        setNotificationSettings(next);
        await AsyncStorage.setItem(settingsKey, JSON.stringify(next));
        return;
      }

      setNotificationSettings(next);
      await AsyncStorage.setItem(settingsKey, JSON.stringify(next));

      if (key === 'notificationsEnabled' && value) {
        await requestPushPermission();
      }
    },
    [notificationSettings, requestPushPermission, settingsKey]
  );

  const openUpdate = useCallback(
    async (update: NoodUpdate) => {
      await markUpdateRead(update.id);
      if (update.targetRoute) {
        router.push(update.targetRoute as any);
      }
    },
    [markUpdateRead]
  );

  const unreadCount = useMemo(
    () => enabledUpdates.filter((update) => !readUpdateIds.includes(update.id)).length,
    [enabledUpdates, readUpdateIds]
  );

  const value = useMemo(
    () => ({
      updates: enabledUpdates,
      readUpdateIds,
      unreadCount,
      notificationSettings,
      expoPushToken,
      markUpdateRead,
      markAllUpdatesRead,
      updateNotificationSetting,
      requestPushPermission,
      openUpdate,
    }),
    [
      enabledUpdates,
      expoPushToken,
      markAllUpdatesRead,
      markUpdateRead,
      notificationSettings,
      openUpdate,
      readUpdateIds,
      requestPushPermission,
      unreadCount,
      updateNotificationSetting,
    ]
  );

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useUpdates() {
  const context = useContext(UpdatesContext);

  if (!context) {
    throw new Error('useUpdates must be used inside UpdatesProvider');
  }

  return context;
}
