import AsyncStorage from '@react-native-async-storage/async-storage';
import { postBackendJson } from './backend';

const PENDING_REFERRAL_CODE_KEY = 'NOOD_PENDING_REFERRAL_CODE_V1';

function normalizeReferralCode(code: string) {
  return String(code || '').trim().toUpperCase();
}

export function parseInviteReferralCode(url: string): string | null {
  const raw = String(url || '').trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    const hostOrPath = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    if (!hostOrPath.includes('invite')) {
      return null;
    }

    const code = parsed.searchParams.get('code');
    return code ? normalizeReferralCode(code) : null;
  } catch {
    const match = raw.match(/[?&]code=([^&]+)/i);
    return match?.[1] ? normalizeReferralCode(decodeURIComponent(match[1])) : null;
  }
}

export function isInviteDeepLink(url: string) {
  return Boolean(parseInviteReferralCode(url));
}

export async function savePendingReferralCode(code: string) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return;
  await AsyncStorage.setItem(PENDING_REFERRAL_CODE_KEY, normalized);
}

export async function getPendingReferralCode() {
  const code = await AsyncStorage.getItem(PENDING_REFERRAL_CODE_KEY);
  return code ? normalizeReferralCode(code) : '';
}

export async function clearPendingReferralCode() {
  await AsyncStorage.removeItem(PENDING_REFERRAL_CODE_KEY);
}

export async function applyPendingReferralAttribution(referredCustomerId: string) {
  const normalizedCustomerId = String(referredCustomerId || '').trim();
  const referralCode = await getPendingReferralCode();

  if (!normalizedCustomerId || !referralCode) {
    return { applied: false };
  }

  try {
    await postBackendJson('/api/rewards/referral/attributed', {
      referralCode,
      referredCustomerId: normalizedCustomerId,
    });
    await clearPendingReferralCode();
    return { applied: true };
  } catch (error) {
    console.log('[REFERRAL] attribution failed', error);
    return { applied: false, error };
  }
}