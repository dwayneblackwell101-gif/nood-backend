import React, { memo } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

type GlassPanelProps = {
  children: React.ReactNode;
  style?: ViewStyle;
  glow?: boolean;
  padding?: number;
  variant?: 'default' | 'dock';
};

function GlassPanel({
  children,
  style,
  glow = false,
  padding = 18,
  variant = 'default',
}: GlassPanelProps) {
  const isDock = variant === 'dock';

  return (
    <View
      style={[
        styles.outer,
        isDock ? styles.outerDock : null,
        glow && !isDock ? styles.outerGlow : null,
        style,
      ]}
    >
      <LinearGradient
        colors={
          isDock
            ? ['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.07)']
            : ['rgba(255,255,255,0.24)', 'rgba(255,255,255,0.08)']
        }
        style={[styles.panel, { padding }]}
      >
        <View
          pointerEvents="none"
          style={[styles.edgeHighlight, isDock && styles.edgeHighlightDock]}
        />
        {children}
      </LinearGradient>
    </View>
  );
}

export default memo(GlassPanel);

const styles = StyleSheet.create({
  outer: {
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  outerDock: {
    borderRadius: 22,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  outerGlow: {
    shadowColor: '#ffb400',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  panel: {
    borderRadius: 28,
    overflow: 'hidden',
  },
  edgeHighlight: {
    position: 'absolute',
    top: 0,
    left: 18,
    right: 18,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.42)',
  },
  edgeHighlightDock: {
    left: 14,
    right: 14,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
});