import type { PromoAssetMap } from './types';

// Replace any `null` with `require('../../assets/promo/your-file.png')` later.
export const promoAssets: PromoAssetMap = {
  coolxLogoPill: null,
  coolxAppIcon: null,
  giftBox: null,
  cashCard: null,
  couponTicket: null,
  walletIcon: null,
  scissorsIcon: null,
  rewardCardGlow: null,
  arrowGlow: null,
  confetti: null,
  thumbBadge: null,
  wheelCenter: null,
  productBg1: require('../../assets/promo/793292dd-f04d-4c9f-84e1-9f577d91f944.png'),
  productBg2: null,
  productBg3: null,
  coinBurst: null,
};

export const getPromoAsset = (overrides: Partial<PromoAssetMap>, key: keyof PromoAssetMap) =>
  overrides[key] ?? promoAssets[key] ?? null;
