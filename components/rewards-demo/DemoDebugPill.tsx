import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

type DemoDebugPillProps = {
  label?: string;
  inline?: boolean;
};

function DemoDebugPill({
  label = 'Reward unlocks after the challenge is completed.',
  inline = false,
}: DemoDebugPillProps) {
  return (
    <View style={[styles.wrap, inline && styles.wrapInline]}>
      <Text style={[styles.text, inline && styles.textInline]}>{label}</Text>
    </View>
  );
}

export default memo(DemoDebugPill);

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.14)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  wrapInline: {
    alignSelf: 'stretch',
    marginTop: 2,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.1)',
    borderColor: 'rgba(255,255,255,0.06)',
  },
  text: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  textInline: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.38)',
  },
});