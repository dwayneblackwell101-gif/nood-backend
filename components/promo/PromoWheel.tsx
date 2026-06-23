import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';

import type { PromoWheelHandle, PromoWheelProps } from './types';

const AnimatedView = Animated.View;

function polarToCartesian(cx: number, cy: number, radius: number, angleInDegrees: number) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function describeArcSlice(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
    'Z',
  ].join(' ');
}

export const PromoWheel = forwardRef<PromoWheelHandle, PromoWheelProps>(
  (
    {
      segments,
      size = 310,
      forcedWinningIndex = null,
      disabled = false,
      durationMs = 5200,
      centerAsset,
      onSpinStart,
      onSpinEnd,
    },
    ref
  ) => {
    const radius = size / 2;
    const innerRadius = size * 0.18;
    const anglePerSegment = 360 / Math.max(segments.length, 1);
    const rotation = useSharedValue(0);
    const [isSpinning, setIsSpinning] = useState(false);

    const finishSpin = (index: number) => {
      const segment = segments[index];
      setIsSpinning(false);
      onSpinEnd?.(segment, index);
    };

    const getCurrentWinningIndex = () => {
      if (segments.length === 0) {
        return 0;
      }

      const normalized = ((rotation.value % 360) + 360) % 360;
      const pointerAngle = (360 - normalized + 360) % 360;
      return (
        Math.floor(
          (((pointerAngle - anglePerSegment / 2 + 360) % 360) / anglePerSegment)
        ) % segments.length
      );
    };

    const spin = (incomingForcedIndex?: number | null) => {
      if (isSpinning || disabled || segments.length === 0) {
        return;
      }

      setIsSpinning(true);
      onSpinStart?.();

      const winningIndex = (() => {
        if (incomingForcedIndex !== undefined && incomingForcedIndex !== null) {
          return incomingForcedIndex;
        }

        if (forcedWinningIndex !== undefined && forcedWinningIndex !== null) {
          return forcedWinningIndex;
        }

        const weightedSegments = segments.map((segment) => Math.max(1, segment.weight ?? 1));
        const totalWeight = weightedSegments.reduce((sum, value) => sum + value, 0);
        let roll = Math.random() * totalWeight;

        for (let index = 0; index < weightedSegments.length; index += 1) {
          roll -= weightedSegments[index];
          if (roll <= 0) {
            return index;
          }
        }

        return 0;
      })();
      const normalized = ((rotation.value % 360) + 360) % 360;
      const desired =
        (360 - (winningIndex * anglePerSegment + anglePerSegment / 2)) % 360;
      const additional = (desired - normalized + 360) % 360;
      const target = rotation.value + additional + 360 * 6;

      rotation.value = withTiming(
        target,
        {
          duration: durationMs,
          easing: Easing.bezier(0.12, 0.9, 0.15, 1),
        },
        (finished) => {
          if (finished) {
            runOnJS(finishSpin)(winningIndex);
          }
        }
      );
    };

    const stop = () => {
      if (!isSpinning || segments.length === 0) {
        return;
      }

      cancelAnimation(rotation);
      finishSpin(getCurrentWinningIndex());
    };

    useImperativeHandle(
      ref,
      () => ({
        spin,
        stop,
      }),
      [disabled, durationMs, forcedWinningIndex, isSpinning, onSpinEnd, onSpinStart, segments]
    );

    useEffect(() => {
      if (!segments.length) {
        setIsSpinning(false);
      }
    }, [segments.length]);

    const wheelStyle = useAnimatedStyle(() => ({
      transform: [{ rotate: `${rotation.value}deg` }],
    }));

    const segmentViews = useMemo(
      () =>
        segments.map((segment, index) => {
          const startAngle = index * anglePerSegment;
          const endAngle = startAngle + anglePerSegment;
          const midAngle = startAngle + anglePerSegment / 2;
          const textPosition = polarToCartesian(radius, radius, radius * 0.68, midAngle);
          const rotationAngle = midAngle;

          return (
            <G key={segment.id}>
              <Path
                d={describeArcSlice(radius, radius, radius, startAngle, endAngle)}
                fill={segment.color}
                stroke="rgba(255,255,255,0.28)"
                strokeWidth={2}
              />
              <SvgText
                x={textPosition.x}
                y={textPosition.y}
                fill={segment.textColor ?? '#231200'}
                fontSize={16}
                fontWeight="900"
                textAnchor="middle"
                rotation={rotationAngle}
                origin={`${textPosition.x}, ${textPosition.y}`}
              >
                {segment.label}
              </SvgText>
            </G>
          );
        }),
      [anglePerSegment, radius, segments]
    );

    return (
      <View style={[styles.wrap, { width: size, height: size + 34 }]}>
        <View style={styles.pointerWrap}>
          <View style={styles.pointer} />
        </View>

        <AnimatedView style={[styles.wheelShadow, { width: size, height: size }, wheelStyle]}>
          <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Circle cx={radius} cy={radius} r={radius} fill="#ffeb99" />
            {segmentViews}
            <Circle cx={radius} cy={radius} r={innerRadius} fill="#2f1700" />
          </Svg>
        </AnimatedView>

        <View style={[styles.centerWrap, { width: size, height: size }]}>
          <View style={styles.centerDisc}>
            {centerAsset ? (
              <Image source={centerAsset} style={styles.centerImage} resizeMode="contain" />
            ) : (
              <View style={styles.centerFallback}>
                <View style={styles.centerFallbackDot} />
              </View>
            )}
          </View>
        </View>
      </View>
    );
  }
);

PromoWheel.displayName = 'PromoWheel';

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelShadow: {
    borderRadius: 999,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    elevation: 16,
  },
  pointerWrap: {
    position: 'absolute',
    top: -2,
    zIndex: 6,
  },
  pointer: {
    width: 0,
    height: 0,
    borderLeftWidth: 18,
    borderRightWidth: 18,
    borderBottomWidth: 30,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#fff7ea',
    transform: [{ rotate: '180deg' }],
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 10,
  },
  centerWrap: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  centerDisc: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#2f1700',
    borderWidth: 8,
    borderColor: '#fff2bf',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerImage: {
    width: 52,
    height: 52,
  },
  centerFallback: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ffb32c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerFallbackDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
  },
});
