import type { ImageSourcePropType } from 'react-native';

export type PromoMode = 'auto' | 'manual';

export type PromoStep =
  | 'introBanner'
  | 'floatingIcons'
  | 'welcomeBack'
  | 'missedGift'
  | 'todayGift'
  | 'creditPopup'
  | 'upgradedGift'
  | 'spinWheel';

export type PromoAssetKey =
  | 'coolxLogoPill'
  | 'coolxAppIcon'
  | 'giftBox'
  | 'cashCard'
  | 'couponTicket'
  | 'walletIcon'
  | 'scissorsIcon'
  | 'rewardCardGlow'
  | 'arrowGlow'
  | 'confetti'
  | 'thumbBadge'
  | 'wheelCenter'
  | 'productBg1'
  | 'productBg2'
  | 'productBg3'
  | 'coinBurst';

export type PromoAssetMap = Record<PromoAssetKey, ImageSourcePropType | null>;

export interface PromoWheelSegment {
  id: string;
  label: string;
  value: number | string;
  color: string;
  textColor?: string;
  badge?: string;
  weight?: number;
}

export interface PromoFlowCallbacks {
  onClose?: () => void;
  onComplete?: () => void;
  onSpinComplete?: (segment: PromoWheelSegment, index: number) => void;
  onClaim?: (payload: { step: PromoStep; reward: number | string; segment?: PromoWheelSegment }) => void;
}

export interface PromoTimingConfig {
  introBanner: number;
  floatingIcons: number;
  welcomeBack: number;
  missedGift: number;
  todayGift: number;
  creditPopup: number;
  upgradedGift: number;
}

export interface PromoCopyConfig {
  headlineIntroSmall: string;
  headlineIntroBig: string;
  floatingHeadline: string;
  welcomeLineOne: string;
  welcomeLineTwo: string;
  visitLineOne: string;
  visitLineTwo: string;
  previousGiftLabel: string;
  todayGiftLabel: string;
  creditLineOne: string;
  creditLineTwo: string;
  creditSpeechBubble: string;
  badgeText: string;
  upgradeHeadline: string;
  upgradeSubtitle: string;
  spinHeader: string;
  spinSubheader: string;
  spinCtaIdle: string;
  spinCtaStop: string;
  spinCtaClaim: string;
}

export interface PromoDateConfig {
  previous: string;
  today: string;
}

export interface PromoDisclaimerConfig {
  bottomSmallPrint: string;
  missedGift: string;
  todayGift: string;
  creditPopup: string;
  upgrade: string;
  spin: string;
}

export interface PromoConfig {
  brandName: string;
  username: string;
  avatarInitials: string;
  previousGiftAmount: number;
  todayGiftAmount: number;
  upgradedGiftAmount: number;
  currencySymbol: string;
  creditLabel: string;
  copy: PromoCopyConfig;
  dates: PromoDateConfig;
  disclaimers: PromoDisclaimerConfig;
  wheelSegments: PromoWheelSegment[];
  timing: PromoTimingConfig;
  assets: Partial<PromoAssetMap>;
  devModeEnabled: boolean;
  backgroundSymbol: string;
  forcedWinningIndex?: number;
  autoSpinDurationMs: number;
}

export interface PromoStepComponentProps extends Partial<PromoFlowCallbacks> {
  config: PromoConfig;
  mode: PromoMode;
  onContinue?: () => void;
  forcedWheelIndex?: number | null;
}

export interface UsePromoFlowParams extends PromoFlowCallbacks {
  config: PromoConfig;
  mode?: PromoMode;
}

export interface UsePromoFlowReturn extends PromoFlowCallbacks {
  currentStep: PromoStep;
  currentIndex: number;
  mode: PromoMode;
  forcedWheelIndex: number | null;
  setMode: (mode: PromoMode) => void;
  setForcedWheelIndex: (index: number | null) => void;
  goToStep: (step: PromoStep) => void;
  nextStep: () => void;
  prevStep: () => void;
  resetFlow: () => void;
  completeFlow: () => void;
}

export interface PromoWheelHandle {
  spin: (forcedIndex?: number | null) => void;
  stop: () => void;
}

export interface PromoWheelProps {
  segments: PromoWheelSegment[];
  size?: number;
  forcedWinningIndex?: number | null;
  disabled?: boolean;
  durationMs?: number;
  centerAsset?: ImageSourcePropType | null;
  onSpinStart?: () => void;
  onSpinEnd?: (segment: PromoWheelSegment, index: number) => void;
}
