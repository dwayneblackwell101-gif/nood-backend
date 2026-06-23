import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PromoStep, UsePromoFlowParams, UsePromoFlowReturn } from './types';

const STEP_ORDER: PromoStep[] = [
  'introBanner',
  'floatingIcons',
  'welcomeBack',
  'missedGift',
  'todayGift',
  'creditPopup',
  'upgradedGift',
  'spinWheel',
];

export const promoStepOrder = STEP_ORDER;

export function usePromoFlow({
  config,
  mode: initialMode = 'auto',
  onClaim,
  onClose,
  onComplete,
  onSpinComplete,
}: UsePromoFlowParams): UsePromoFlowReturn {
  const [currentStep, setCurrentStep] = useState<PromoStep>('introBanner');
  const [mode, setMode] = useState(initialMode);
  const [forcedWheelIndex, setForcedWheelIndex] = useState<number | null>(
    config.forcedWinningIndex ?? null
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentIndex = useMemo(() => STEP_ORDER.indexOf(currentStep), [currentStep]);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const completeFlow = useCallback(() => {
    clearTimer();
    onComplete?.();
  }, [clearTimer, onComplete]);

  const goToStep = useCallback(
    (step: PromoStep) => {
      clearTimer();
      setCurrentStep(step);
    },
    [clearTimer]
  );

  const nextStep = useCallback(() => {
    clearTimer();
    const next = STEP_ORDER[currentIndex + 1];
    if (!next) {
      completeFlow();
      return;
    }
    setCurrentStep(next);
  }, [clearTimer, completeFlow, currentIndex]);

  const prevStep = useCallback(() => {
    clearTimer();
    const previous = STEP_ORDER[Math.max(0, currentIndex - 1)];
    setCurrentStep(previous);
  }, [clearTimer, currentIndex]);

  const resetFlow = useCallback(() => {
    clearTimer();
    setCurrentStep('introBanner');
  }, [clearTimer]);

  useEffect(() => {
    clearTimer();
    if (mode !== 'auto' || currentStep === 'spinWheel') {
      return;
    }

    const duration = config.timing[currentStep];
    timeoutRef.current = setTimeout(() => {
      nextStep();
    }, duration);

    return clearTimer;
  }, [clearTimer, config.timing, currentStep, mode, nextStep]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    currentStep,
    currentIndex,
    mode,
    forcedWheelIndex,
    setMode,
    setForcedWheelIndex,
    goToStep,
    nextStep,
    prevStep,
    resetFlow,
    completeFlow,
    onClaim,
    onClose,
    onComplete,
    onSpinComplete,
  };
}
