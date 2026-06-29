import React from 'react';
import {
  Image,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

const NOOD_LOGO_SOURCE = require('../assets/images/nood-brand-logo.png');

const webShadow = (value: string) => (Platform.OS === 'web' ? { boxShadow: value } : {});
const platformShadow = (webValue: string, nativeValue: object) =>
  Platform.OS === 'web' ? webShadow(webValue) : nativeValue;

type NoodDialogShellProps = {
  children: React.ReactNode;
  onBackdropPress?: () => void;
  cardStyle?: StyleProp<ViewStyle>;
  overlayStyle?: StyleProp<ViewStyle>;
  placement?: 'center' | 'bottom';
  showAccentBar?: boolean;
  showWatermark?: boolean;
};

export function NoodDialogOverlay({
  children,
  onBackdropPress,
  style,
  placement = 'center',
}: {
  children: React.ReactNode;
  onBackdropPress?: () => void;
  style?: StyleProp<ViewStyle>;
  placement?: 'center' | 'bottom';
}) {
  return (
    <View
      style={[
        styles.overlay,
        placement === 'bottom' && styles.overlayBottom,
        style,
      ]}
    >
      {onBackdropPress ? <Pressable style={styles.backdrop} onPress={onBackdropPress} /> : null}
      {children}
    </View>
  );
}

export default function NoodDialogShell({
  children,
  onBackdropPress,
  cardStyle,
  overlayStyle,
  placement = 'center',
  showAccentBar = true,
  showWatermark = true,
}: NoodDialogShellProps) {
  return (
    <NoodDialogOverlay
      onBackdropPress={onBackdropPress}
      style={overlayStyle}
      placement={placement}
    >
      <View
        style={[
          styles.card,
          placement === 'bottom' && styles.cardBottom,
          cardStyle,
        ]}
      >
        {showAccentBar ? <View style={styles.accentBar} /> : null}

        {showWatermark ? (
          <View style={styles.watermarkWrap} pointerEvents="none">
            <Image source={NOOD_LOGO_SOURCE} style={styles.watermark} resizeMode="contain" />
          </View>
        ) : null}

        <View style={[styles.content, placement === 'bottom' && styles.contentBottom]}>
          {children}
        </View>
      </View>
    </NoodDialogOverlay>
  );
}

export const noodDialogStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'rgba(18, 14, 12, 0.48)',
  },
  overlayBottom: {
    justifyContent: 'flex-end',
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    width: '100%',
    maxWidth: 372,
    backgroundColor: '#fff9f3',
    borderRadius: 26,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    overflow: 'hidden',
    ...platformShadow('0 14px 36px rgba(255, 106, 0, 0.14), 0 8px 24px rgba(0, 0, 0, 0.14)', {
      shadowColor: '#ff6a00',
      shadowOpacity: 0.14,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 10 },
      elevation: 12,
    }),
  },
  cardBottom: {
    maxWidth: '100%',
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '72%',
    flexShrink: 1,
  },
  contentBottom: {
    flexShrink: 1,
    minHeight: 0,
  },
  accentBar: {
    height: 4,
    backgroundColor: '#ff6a00',
    opacity: 0.92,
  },
  watermarkWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
  },
  watermark: {
    width: 168,
    height: 112,
    opacity: 0.055,
  },
  content: {
    position: 'relative',
    zIndex: 2,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 20,
  },
});

const styles = noodDialogStyles;