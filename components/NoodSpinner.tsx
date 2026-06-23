import React from 'react';
import {
  Image,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type NoodSpinnerProps = {
  size?: number;
  style?: StyleProp<ViewStyle>;
};

export default function NoodSpinner({ size = 52, style }: NoodSpinnerProps) {
  return (
    <View style={[styles.wrap, style]}>
      <View
        style={[
          styles.logoWrap,
          {
            width: size * 2.45,
            height: size,
          },
        ]}
      >
        <Image
          source={require('../assets/images/nood-brand-logo.png')}
          resizeMode="contain"
          style={styles.logo}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: '100%',
    height: '100%',
  },
});
