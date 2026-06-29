import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { postBackendJson } from './backend';

export const NOTIFICATION_PROMPT_SHOWN_KEY = 'NOOD_NOTIFICATION_PERMISSION_PROMPT_SHOWN_V1';
export const PUSH_TOKEN_KEY = 'NOOD_EXPO_PUSH_TOKEN_V1';
const DEVICE_ID_STORAGE_KEY = 'NOOD_DEVICE_ID_V1';

export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

function logNotifications(message: string, detail?: Record<string, unknown>) {
  if (!__DEV__) return;
  console.log(`[NOTIFICATIONS] ${message}`, detail ?? '');
}

function logNotificationPrompt(message: string, detail?: Record<string, unknown>) {
  if (!__DEV__) return;
  console.log(`[NOTIFICATIONS PROMPT] ${message}`, detail ?? '');
}

function logNotificationPromptError(error: unknown, context: string) {
  if (!__DEV__) return;
  console.log('[NOTIFICATIONS PROMPT] error', {
    context,
    message: String((error as any)?.message || error || ''),
  });
}

export function getAppOwnership() {
  return String((Constants as any)?.appOwnership || 'unknown').trim() || 'unknown';
}

export function isNativePushEnvironment() {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

export function isExpoGoRuntime() {
  return getAppOwnership() === 'expo';
}

function getExpoProjectId() {
  const constants = Constants as any;
  return (
    constants?.easConfig?.projectId ||
    constants?.expoConfig?.extra?.eas?.projectId ||
    constants?.manifest2?.extra?.eas?.projectId ||
    ''
  );
}

function getAppVersion() {
  const constants = Constants as any;
  return String(constants?.expoConfig?.version || constants?.manifest?.version || '').trim();
}

async function loadNotificationsModule() {
  if (!isNativePushEnvironment() || isExpoGoRuntime()) return null;

  try {
    return await import('expo-notifications');
  } catch (error) {
    logNotifications('skipped reason', {
      reason: 'notifications-module-unavailable',
      message: String((error as any)?.message || error || ''),
    });
    return null;
  }
}

async function loadDeviceModule() {
  if (!isNativePushEnvironment()) return null;

  try {
    return await import('expo-device');
  } catch {
    return null;
  }
}

async function isPhysicalDevice() {
  try {
    const Device = await loadDeviceModule();
    if (!Device) return true;
    return Device.isDevice !== false;
  } catch {
    return true;
  }
}

export async function canUseRemotePushNotifications() {
  const appOwnership = getAppOwnership();
  logNotifications('appOwnership', { value: appOwnership });

  if (!isNativePushEnvironment()) {
    logNotifications('canUseRemotePush', { value: false });
    logNotifications('skipped reason', { reason: 'unsupported-platform' });
    return false;
  }

  if (isExpoGoRuntime()) {
    logNotifications('canUseRemotePush', { value: false });
    logNotifications('skipped reason', { reason: 'expo-go' });
    logNotifications('skipped push token in Expo Go. Use development build.');
    return false;
  }

  const Notifications = await loadNotificationsModule();
  if (!Notifications) {
    logNotifications('canUseRemotePush', { value: false });
    logNotifications('skipped reason', { reason: 'notifications-unavailable' });
    return false;
  }

  const physicalDevice = await isPhysicalDevice();
  if (!physicalDevice) {
    logNotifications('canUseRemotePush', { value: false });
    logNotifications('skipped reason', { reason: 'simulator-or-emulator' });
    return false;
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    logNotifications('canUseRemotePush', { value: false });
    logNotifications('skipped reason', { reason: 'missing-project-id' });
    return false;
  }

  logNotifications('canUseRemotePush', { value: true });
  return true;
}

async function getOrCreateDeviceId() {
  try {
    const existing = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) return existing;

    const Device = await loadDeviceModule();
    const generated = [
      'nood',
      Platform.OS,
      Device?.modelId || Device?.modelName || 'device',
      Date.now().toString(36),
      Math.random().toString(36).slice(2, 10),
    ].join('-');

    await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return undefined;
  }
}

export async function hasNotificationPromptBeenShown() {
  try {
    const value = await AsyncStorage.getItem(NOTIFICATION_PROMPT_SHOWN_KEY);
    return value === 'true';
  } catch (error) {
    logNotificationPromptError(error, 'read-prompt-shown-flag');
    return false;
  }
}

export async function markNotificationPromptShown() {
  try {
    await AsyncStorage.setItem(NOTIFICATION_PROMPT_SHOWN_KEY, 'true');
  } catch (error) {
    logNotificationPromptError(error, 'save-prompt-shown-flag');
  }
}

export async function clearNotificationPromptShown() {
  try {
    await AsyncStorage.removeItem(NOTIFICATION_PROMPT_SHOWN_KEY);
  } catch (error) {
    logNotificationPromptError(error, 'clear-prompt-shown-flag');
  }
}

let notificationPresentationConfigured = false;

export async function configureNotificationPresentation() {
  if (notificationPresentationConfigured) return;
  if (!isNativePushEnvironment()) return;

  try {
    const Notifications = await loadNotificationsModule();
    if (!Notifications) return;

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });

    notificationPresentationConfigured = true;
    logNotifications('foreground presentation configured');
  } catch (error) {
    logNotifications('skipped reason', {
      reason: 'configure-presentation-error',
      message: String((error as any)?.message || error || ''),
    });
  }
}

export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
  if (!(await canUseRemotePushNotifications())) {
    return 'unavailable';
  }

  try {
    const Notifications = await loadNotificationsModule();
    if (!Notifications) return 'unavailable';

    const permission = await Notifications.getPermissionsAsync();
    logNotifications('permission status', { status: permission.status });

    if (permission.status === 'granted') return 'granted';
    if (permission.status === 'denied') return 'denied';
    return 'undetermined';
  } catch (error) {
    logNotifications('skipped reason', {
      reason: 'permission-status-error',
      message: String((error as any)?.message || error || ''),
    });
    return 'unavailable';
  }
}

async function ensureAndroidNotificationChannel(Notifications: typeof import('expo-notifications')) {
  if (Platform.OS !== 'android') return;

  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'NOOD Alerts',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF7A00',
    });
  } catch (error) {
    logNotifications('skipped reason', {
      reason: 'android-channel-error',
      message: String((error as any)?.message || error || ''),
    });
  }
}

export async function requestNotificationPermissionAndToken() {
  if (!(await canUseRemotePushNotifications())) {
    return { granted: false, token: '', status: 'unavailable' as NotificationPermissionStatus };
  }

  try {
    const Notifications = await loadNotificationsModule();
    if (!Notifications) {
      return { granted: false, token: '', status: 'unavailable' as NotificationPermissionStatus };
    }

    await ensureAndroidNotificationChannel(Notifications);

    const existing = await Notifications.getPermissionsAsync();
    let finalStatus = existing.status;

    if (finalStatus !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
      finalStatus = requested.status;
    }

    logNotifications('permission status', { status: finalStatus });

    if (finalStatus !== 'granted') {
      return {
        granted: false,
        token: '',
        status: finalStatus === 'denied' ? 'denied' : 'undetermined',
      };
    }

    const projectId = getExpoProjectId();
    if (!projectId) {
      logNotifications('skipped reason', { reason: 'missing-project-id' });
      return { granted: true, token: '', status: 'granted' as NotificationPermissionStatus };
    }

    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = String(tokenResponse?.data || '').trim();
    logNotifications('expo push token', {
      token: token || null,
      projectId,
    });

    return {
      granted: true,
      token,
      status: 'granted' as NotificationPermissionStatus,
    };
  } catch (error) {
    logNotifications('skipped reason', {
      reason: 'request-permission-and-token-error',
      message: String((error as any)?.message || error || ''),
    });
    return { granted: false, token: '', status: 'unavailable' as NotificationPermissionStatus };
  }
}

export function makePushTokenStorageKey(profileId: string) {
  return `${PUSH_TOKEN_KEY}:${profileId || 'guest'}`;
}

export async function savePushTokenLocally(profileId: string, token: string) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return;

  try {
    await AsyncStorage.setItem(makePushTokenStorageKey(profileId), trimmed);
  } catch (error) {
    logNotifications('skipped reason', {
      reason: 'local-save-error',
      message: String((error as any)?.message || error || ''),
    });
  }
}

export async function registerPushTokenWithBackend(options: {
  token: string;
  platform?: string;
  deviceId?: string;
  userId?: string;
  appVersion?: string;
}) {
  const token = String(options.token || '').trim();
  if (!token) {
    logNotifications('skipped reason', { reason: 'empty-token' });
    return false;
  }

  const deviceId = options.deviceId || (await getOrCreateDeviceId());

  try {
    await postBackendJson('/api/notifications/register-token', {
      token,
      platform: options.platform || Platform.OS,
      deviceId,
      userId: options.userId || undefined,
      appVersion: options.appVersion || getAppVersion() || undefined,
      createdAt: new Date().toISOString(),
    });
    logNotifications('token registered', {
      tokenSuffix: token.slice(-12),
      platform: options.platform || Platform.OS,
    });
    return true;
  } catch (error) {
    logNotifications('skipped reason', {
      reason: 'backend-register-failed',
      message: String((error as any)?.message || error || 'backend-unavailable'),
    });
    return false;
  }
}

export async function ensurePushTokenRegistered(profileId: string) {
  if (!(await canUseRemotePushNotifications())) {
    return '';
  }

  const permissionStatus = await getNotificationPermissionStatus();
  if (permissionStatus !== 'granted') {
    return '';
  }

  const { granted, token } = await requestNotificationPermissionAndToken();
  if (!granted || !token) {
    return '';
  }

  await savePushTokenLocally(profileId, token);
  await registerPushTokenWithBackend({
    token,
    userId: profileId || undefined,
  });

  return token;
}

export async function evaluateNotificationPromptState() {
  const alreadyShown = await hasNotificationPromptBeenShown();
  logNotificationPrompt('already shown', { value: alreadyShown });

  if (!isNativePushEnvironment()) {
    return {
      alreadyShown,
      permissionStatus: 'unavailable' as NotificationPermissionStatus,
      shouldShowPrompt: false,
    };
  }

  if (alreadyShown) {
    return {
      alreadyShown,
      permissionStatus: 'unavailable' as NotificationPermissionStatus,
      shouldShowPrompt: false,
    };
  }

  const remotePushAvailable = await canUseRemotePushNotifications();
  let permissionStatus: NotificationPermissionStatus = 'undetermined';

  if (remotePushAvailable) {
    permissionStatus = await getNotificationPermissionStatus();
    if (permissionStatus === 'granted') {
      return {
        alreadyShown,
        permissionStatus,
        shouldShowPrompt: false,
      };
    }
  } else {
    logNotificationPrompt('prompt eligible without remote push', {
      appOwnership: getAppOwnership(),
    });
  }

  return {
    alreadyShown,
    permissionStatus,
    shouldShowPrompt: true,
  };
}

export async function resetNotificationPromptForTesting() {
  await clearNotificationPromptShown();
  notificationPresentationConfigured = false;
  await configureNotificationPresentation();
}

if (__DEV__) {
  const globalScope = globalThis as typeof globalThis & {
    resetNotificationPrompt?: () => Promise<void>;
  };

  globalScope.resetNotificationPrompt = resetNotificationPromptForTesting;
}