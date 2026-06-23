import React, { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getPromoAsset } from '../assets';
import { PromoWheel } from '../PromoWheel';
import type { PromoStepComponentProps, PromoWheelHandle, PromoWheelSegment } from '../types';

export function SpinWheelStep({
  config,
  forcedWheelIndex,
  onClaim,
  onComplete,
  onSpinComplete,
}: PromoStepComponentProps) {
  const wheelRef = useRef<PromoWheelHandle>(null);
  const [isSpinning, setIsSpinning] = useState(false);
  const [winningSegment, setWinningSegment] = useState<PromoWheelSegment | null>(null);
  const centerAsset = getPromoAsset(config.assets, 'wheelCenter');

  const spinResultText = useMemo(() => {
    if (!winningSegment) {
      return config.copy.spinSubheader;
    }

    return typeof winningSegment.value === 'number'
      ? `You landed on ${config.currencySymbol}${winningSegment.value}.`
      : `You landed on ${winningSegment.label}.`;
  }, [config.copy.spinSubheader, config.currencySymbol, winningSegment]);

  const handleSpinPress = () => {
    if (isSpinning) {
      wheelRef.current?.stop();
      return;
    }

    if (winningSegment) {
      return;
    }
    wheelRef.current?.spin(forcedWheelIndex);
  };

  const handleClaim = () => {
    if (!winningSegment) {
      return;
    }

    onClaim?.({
      step: 'spinWheel',
      reward: winningSegment.value,
      segment: winningSegment,
    });
    onComplete?.();
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>{config.copy.spinHeader}</Text>
      <Text style={styles.subheader}>{spinResultText}</Text>

      <View style={styles.wheelShell}>
        <PromoWheel
          ref={wheelRef}
          segments={config.wheelSegments}
          forcedWinningIndex={forcedWheelIndex}
          centerAsset={centerAsset}
          durationMs={config.autoSpinDurationMs}
          onSpinStart={() => {
            setWinningSegment(null);
            setIsSpinning(true);
          }}
          onSpinEnd={(segment, index) => {
            setIsSpinning(false);
            setWinningSegment(segment);
            onSpinComplete?.(segment, index);
          }}
        />

        <Pressable
          accessibilityRole="button"
          onPress={handleSpinPress}
          disabled={isSpinning || !!winningSegment}
          style={({ pressed }) => [
            styles.centerSpinButton,
            (isSpinning || winningSegment) && styles.centerSpinButtonDisabled,
            pressed && !(isSpinning || winningSegment) ? styles.centerSpinButtonPressed : null,
          ]}
        >
          <Text style={styles.centerSpinText}>{config.copy.spinCtaIdle}</Text>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={winningSegment ? handleClaim : handleSpinPress}
        style={({ pressed }) => [
          styles.ctaButton,
          winningSegment ? styles.claimButton : null,
          isSpinning ? styles.stopButton : null,
          pressed ? styles.ctaPressed : null,
        ]}
      >
        <Text style={styles.ctaButtonText}>
          {winningSegment
            ? config.copy.spinCtaClaim
            : isSpinning
              ? config.copy.spinCtaStop
              : config.copy.spinCtaIdle}
        </Text>
      </Pressable>

      <Text style={styles.disclaimer}>{config.disclaimers.spin}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(8,8,12,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  header: {
    textAlign: 'center',
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '900',
    color: '#fff9dc',
    maxWidth: 320,
  },
  subheader: {
    marginTop: 10,
    textAlign: 'center',
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '700',
    color: '#fff1b5',
    maxWidth: 320,
  },
  wheelShell: {
    marginTop: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerSpinButton: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#2a1600',
    borderWidth: 7,
    borderColor: '#ffe59d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerSpinButtonDisabled: {
    opacity: 0.9,
  },
  centerSpinButtonPressed: {
    transform: [{ scale: 0.98 }],
  },
  centerSpinText: {
    fontSize: 26,
    fontWeight: '900',
    color: '#fff',
  },
  ctaButton: {
    minWidth: 240,
    borderRadius: 999,
    backgroundColor: '#ff8d19',
    paddingHorizontal: 28,
    paddingVertical: 18,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: {
    backgroundColor: '#7e4a00',
  },
  claimButton: {
    backgroundColor: '#ff5f1f',
  },
  ctaPressed: {
    transform: [{ scale: 0.98 }],
  },
  ctaButtonText: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '900',
    color: '#fff',
  },
  disclaimer: {
    marginTop: 16,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: '#fff1ba',
    maxWidth: 320,
  },
});
