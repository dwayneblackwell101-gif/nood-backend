import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PromoBackground } from './PromoBackground';
import { PromoCloseButton } from './PromoCloseButton';
import { TopBrandPill } from './TopBrandPill';
import { getPromoAsset } from './assets';
import { coolxPromoConfig } from './promoConfig';
import { promoStepOrder, usePromoFlow } from './usePromoFlow';
import { CreditPopupStep } from './steps/CreditPopupStep';
import { FloatingIconsStep } from './steps/FloatingIconsStep';
import { IntroBannerStep } from './steps/IntroBannerStep';
import { MissedGiftStep } from './steps/MissedGiftStep';
import { SpinWheelStep } from './steps/SpinWheelStep';
import { TodayGiftRevealStep } from './steps/TodayGiftRevealStep';
import { UpgradeRewardStep } from './steps/UpgradeRewardStep';
import { WelcomeBackStep } from './steps/WelcomeBackStep';
import type { PromoConfig, PromoMode, PromoStep, PromoStepComponentProps } from './types';

type CoolXPromoFlowProps = {
  config?: PromoConfig;
  mode?: PromoMode;
  devMode?: boolean;
  onClose?: () => void;
  onComplete?: () => void;
  onSpinComplete?: PromoStepComponentProps['onSpinComplete'];
  onClaim?: PromoStepComponentProps['onClaim'];
};

const STEP_COMPONENTS: Record<PromoStep, React.ComponentType<PromoStepComponentProps>> = {
  introBanner: IntroBannerStep,
  floatingIcons: FloatingIconsStep,
  welcomeBack: WelcomeBackStep,
  missedGift: MissedGiftStep,
  todayGift: TodayGiftRevealStep,
  creditPopup: CreditPopupStep,
  upgradedGift: UpgradeRewardStep,
  spinWheel: SpinWheelStep,
};

const dimmedSteps: PromoStep[] = ['floatingIcons', 'creditPopup', 'spinWheel'];

export function CoolXPromoFlow({
  config = coolxPromoConfig,
  mode = 'auto',
  devMode,
  onClose,
  onComplete,
  onSpinComplete,
  onClaim,
}: CoolXPromoFlowProps) {
  const insets = useSafeAreaInsets();
  const flow = usePromoFlow({
    config,
    mode,
    onClose,
    onComplete,
    onSpinComplete,
    onClaim,
  });
  const [localMode, setLocalMode] = useState<PromoMode>(mode);

  const CurrentStep = STEP_COMPONENTS[flow.currentStep];
  const showDevPanel = devMode ?? config.devModeEnabled;
  const backgroundVariant = dimmedSteps.includes(flow.currentStep) ? 'dimmed-grid' : 'gold';
  const heroArt = getPromoAsset(config.assets, 'productBg1');

  const stepProps = useMemo<PromoStepComponentProps>(
    () => ({
      config,
      mode: localMode,
      onContinue: flow.nextStep,
      onClose,
      onClaim,
      onSpinComplete,
      forcedWheelIndex: flow.forcedWheelIndex,
      onComplete,
    }),
    [
      config,
      flow.forcedWheelIndex,
      flow.nextStep,
      localMode,
      onClaim,
      onClose,
      onComplete,
      onSpinComplete,
    ]
  );

  const handleModeChange = (value: PromoMode) => {
    setLocalMode(value);
    flow.setMode(value);
  };

  return (
    <View style={styles.container}>
      <PromoBackground
        symbol={config.backgroundSymbol}
        variant={backgroundVariant}
        showCenterGlow
        heroArt={backgroundVariant === 'gold' ? heroArt : null}
      />

      <TopBrandPill brandName={config.brandName} />
      <PromoCloseButton onPress={onClose ?? flow.completeFlow} />

      <View
        style={[
          styles.content,
          {
            paddingTop: insets.top + 76,
            paddingBottom: insets.bottom + 22,
          },
        ]}
      >
        <Animated.View
          key={flow.currentStep}
          entering={FadeIn.duration(220)}
          exiting={FadeOut.duration(180)}
          style={styles.stepHost}
        >
          <CurrentStep {...stepProps} />
        </Animated.View>
      </View>

      {localMode === 'manual' && flow.currentStep !== 'spinWheel' ? (
        <View style={[styles.manualFooter, { bottom: insets.bottom + 18 }]}>
          <Pressable style={styles.manualButton} onPress={flow.nextStep}>
            <Text style={styles.manualButtonText}>Continue</Text>
          </Pressable>
        </View>
      ) : null}

      {showDevPanel ? (
        <View style={[styles.devPanel, { bottom: insets.bottom + 14 }]}>
          <Text style={styles.devTitle}>DEV</Text>

          <View style={styles.devModeRow}>
            {(['auto', 'manual'] as PromoMode[]).map((option) => (
              <Pressable
                key={option}
                onPress={() => handleModeChange(option)}
                style={[
                  styles.devModeChip,
                  localMode === option ? styles.devModeChipActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.devModeChipText,
                    localMode === option ? styles.devModeChipTextActive : null,
                  ]}
                >
                  {option.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.devStepRow}>
            {promoStepOrder.map((step) => (
              <Pressable
                key={step}
                onPress={() => flow.goToStep(step)}
                style={[
                  styles.devStepChip,
                  flow.currentStep === step ? styles.devStepChipActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.devStepChipText,
                    flow.currentStep === step ? styles.devStepChipTextActive : null,
                  ]}
                >
                  {step}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.devStepRow}>
            {config.wheelSegments.map((segment, index) => (
              <Pressable
                key={segment.id}
                onPress={() => flow.setForcedWheelIndex(index)}
                style={[
                  styles.devStepChip,
                  flow.forcedWheelIndex === index ? styles.devStepChipActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.devStepChipText,
                    flow.forcedWheelIndex === index ? styles.devStepChipTextActive : null,
                  ]}
                >
                  {segment.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={styles.devActions}>
            <Pressable style={styles.devButton} onPress={flow.resetFlow}>
              <Text style={styles.devButtonText}>Replay</Text>
            </Pressable>

            <Pressable style={styles.devButton} onPress={() => flow.setForcedWheelIndex(null)}>
              <Text style={styles.devButtonText}>Random wheel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffcb2f',
  },
  content: {
    flex: 1,
  },
  stepHost: {
    flex: 1,
  },
  manualFooter: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 20,
  },
  manualButton: {
    borderRadius: 999,
    backgroundColor: '#ff6f11',
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manualButtonText: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '900',
    color: '#fff',
  },
  devPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 40,
    borderRadius: 24,
    backgroundColor: 'rgba(20, 20, 24, 0.86)',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
  },
  devTitle: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '900',
    letterSpacing: 1.2,
    color: '#ffd463',
  },
  devModeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  devModeChip: {
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  devModeChipActive: {
    backgroundColor: '#ff8f1d',
  },
  devModeChipText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fff1c6',
  },
  devModeChipTextActive: {
    color: '#1c1200',
  },
  devStepRow: {
    gap: 8,
    marginTop: 10,
    paddingRight: 8,
  },
  devStepChip: {
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  devStepChipActive: {
    backgroundColor: '#ffe28f',
  },
  devStepChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f6f0da',
  },
  devStepChipTextActive: {
    color: '#241600',
  },
  devActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  devButton: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  devButtonText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fff',
  },
});
