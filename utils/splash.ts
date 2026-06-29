import Constants from 'expo-constants';

const SPLASH_PLUGIN_CONFIG =
  Constants.expoConfig?.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen'
  )?.[1] ?? null;

export function logNativeSplashConfigChecked() {
  if (!__DEV__) return;

  const splashImage =
    typeof SPLASH_PLUGIN_CONFIG?.image === 'string'
      ? SPLASH_PLUGIN_CONFIG.image
      : './assets/images/nood-brand-logo.png';

  console.log('[NOOD splash] native splash config checked', {
    image: splashImage,
    imageWidth: SPLASH_PLUGIN_CONFIG?.imageWidth ?? 220,
    resizeMode: SPLASH_PLUGIN_CONFIG?.resizeMode ?? 'contain',
    backgroundColor: SPLASH_PLUGIN_CONFIG?.backgroundColor ?? '#000000',
    appName: Constants.expoConfig?.name ?? 'NOOD',
    logoOnlyAsset: true,
  });

  console.log('[NOOD splash] native app-name text suppressed', {
    source: 'Expo Go bundling/loading label (manifest name field)',
    fix: 'app.config.js serves an invisible manifest label; LaunchSplash hides native splash after paint',
    note: 'No JSX Text renders under the splash logo.',
  });
}