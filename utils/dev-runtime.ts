import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  getConfiguredBackendUrl,
  getLastSuccessfulBackendUrl,
  isLocalBackendModeEnabled,
} from './backend';
import { getAppOwnership } from './push-notifications';
import './catalog-cache';

export function isDevClientRuntime() {
  if (process.env.EXPO_PUBLIC_DEV_CLIENT === '1') return true;
  if (process.env.EAS_BUILD_PROFILE === 'development') return true;
  const ownership = getAppOwnership();
  return ownership !== 'expo' && __DEV__;
}

export function logDevRuntimeParity(context: string, detail?: Record<string, unknown>) {
  if (!__DEV__) return;

  console.log(`[NOOD dev-parity] ${context}`, {
    platform: Platform.OS,
    appOwnership: getAppOwnership(),
    devClientFlag: isDevClientRuntime(),
    executionEnvironment: String((Constants as any)?.executionEnvironment || 'unknown'),
    configuredBackendUrl: getConfiguredBackendUrl(),
    localBackendEnabled: isLocalBackendModeEnabled(),
    lastSuccessfulBackendUrl: getLastSuccessfulBackendUrl(),
    easBuildProfile: process.env.EAS_BUILD_PROFILE || '(none)',
    clearCatalogCacheCommand: 'clearNoodCatalogCache()',
    ...(detail || {}),
  });
}