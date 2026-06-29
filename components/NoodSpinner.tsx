import React, { useCallback, useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import NoodBouncingLogo from './NoodBouncingLogo';
import { isAppBootstrapComplete } from '../utils/app-bootstrap';
import { logNoodSpinnerReason } from '../utils/auth-restart-debug';

type NoodSpinnerProps = {
  size?: number;
  style?: StyleProp<ViewStyle>;
  reason?: string;
  isAuthLoading?: boolean;
};

export default function NoodSpinner({
  size = 52,
  style,
  reason = 'unspecified',
  isAuthLoading = false,
}: NoodSpinnerProps) {
  const logoWidth = size * 2.45;
  const logoHeight = size;

  useEffect(() => {
    logNoodSpinnerReason(reason, {
      isAppBootstrapping: !isAppBootstrapComplete(),
      isAuthLoading,
    });

    if (__DEV__) {
      console.log('[NOOD splash] app loading component mounted', { component: 'NoodSpinner', reason });
    }

    return () => {
      if (__DEV__) {
        console.log('[NOOD splash] loading component unmounted', { component: 'NoodSpinner', reason });
      }
    };
  }, [isAuthLoading, reason]);

  const handleAnimationStarted = useCallback(() => {
    if (__DEV__) {
      console.log('[NOOD splash] bouncing logo animation started', { component: 'NoodSpinner' });
    }
  }, []);

  return (
    <View style={[styles.wrap, style]}>
      <NoodBouncingLogo
        width={logoWidth}
        height={logoHeight}
        onAnimationStarted={handleAnimationStarted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});