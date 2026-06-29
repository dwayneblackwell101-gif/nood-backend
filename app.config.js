const appJson = require('./app.json');

const isDevClientBuild =
  process.env.EAS_BUILD_PROFILE === 'development' ||
  process.env.EXPO_PUBLIC_DEV_CLIENT === '1';

/** @type {import('expo/config').ConfigContext} */
module.exports = ({ config }) => {
  const appName = appJson.expo.name;
  const baseAndroidPermissions = appJson.expo.android?.permissions || [];
  const androidPermissions = [
    ...baseAndroidPermissions,
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_EXTERNAL_STORAGE',
  ].filter((permission, index, list) => list.indexOf(permission) === index);

  return {
    ...appJson.expo,
    ...config,
    // Expo Go shows `name` as a black label under the splash logo while bundling.
    // Dev builds keep the real app name; Expo Go uses an invisible manifest label.
    name: isDevClientBuild ? appName : '\u200B',
    android: {
      ...appJson.expo.android,
      ...config.android,
      permissions: androidPermissions,
    },
    plugins: [
      ...(appJson.expo.plugins || []),
      ...(config.plugins || []),
      [
        './plugins/withAndroidManifestFixes',
        {
          enableCleartextTraffic: isDevClientBuild,
          enableLargeHeap: isDevClientBuild,
        },
      ],
    ],
    ios: {
      ...appJson.expo.ios,
      ...config.ios,
      infoPlist: {
        ...appJson.expo.ios?.infoPlist,
        ...config.ios?.infoPlist,
        CFBundleDisplayName: appName,
      },
    },
    extra: {
      ...appJson.expo.extra,
      ...config.extra,
      devClient: isDevClientBuild,
    },
  };
};