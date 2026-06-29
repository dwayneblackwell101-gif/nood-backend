const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Applies Android manifest flags that are not valid Expo config schema fields.
 *
 * @param {import('@expo/config-plugins').ExpoConfig} config
 * @param {{ enableCleartextTraffic?: boolean; enableLargeHeap?: boolean }} props
 */
function withAndroidManifestFixes(config, props = {}) {
  const enableCleartextTraffic = Boolean(props.enableCleartextTraffic);
  const enableLargeHeap = Boolean(props.enableLargeHeap);

  if (!enableCleartextTraffic && !enableLargeHeap) {
    return config;
  }

  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest?.application?.[0];
    if (!application) {
      return modConfig;
    }

    application.$ = application.$ || {};

    if (enableCleartextTraffic) {
      application.$['android:usesCleartextTraffic'] = 'true';
    }

    if (enableLargeHeap) {
      application.$['android:largeHeap'] = 'true';
    }

    return modConfig;
  });
}

module.exports = withAndroidManifestFixes;