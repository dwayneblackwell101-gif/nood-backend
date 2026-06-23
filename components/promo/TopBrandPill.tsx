import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type TopBrandPillProps = {
  brandName: string;
};

export function TopBrandPill({ brandName }: TopBrandPillProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrap, { top: insets.top + 10 }]}>
      <View style={styles.pill}>
        <Text style={styles.text}>{brandName}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 30,
  },
  pill: {
    minWidth: 112,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: '#fff7ef',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#d17a00',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    elevation: 4,
  },
  text: {
    fontSize: 18,
    lineHeight: 20,
    fontWeight: '900',
    letterSpacing: 1.1,
    color: '#ff7a00',
  },
});
