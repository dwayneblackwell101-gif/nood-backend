import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchLuckySpinStatus, recordLuckySpinOnBackend } from './rewards-api';

const LUCKY_SPIN_USED_KEY_PREFIX = 'NOOD_LUCKY_SPIN_USED_V1';
const LEGACY_DAILY_SPIN_PREFIX = 'NOOD_LUCKY_SPIN_DAILY_LIMIT_V1';
const LEGACY_DAILY_SPIN_KEY = 'NOOD_LUCKY_SPIN_DAILY_LIMIT_V1';

export type LuckySpinStatus = {
  canSpin: boolean;
  used: boolean;
  luckySpinUsedAt: string | null;
  luckySpinRewardAmountUsd: number | null;
  source: 'local' | 'backend';
};

export function getLuckySpinUsedStorageKey(customerKey: string) {
  return `${LUCKY_SPIN_USED_KEY_PREFIX}:${String(customerKey || '').trim()}`;
}

async function readLocalUsedAt(customerKey: string) {
  const key = getLuckySpinUsedStorageKey(customerKey);
  try {
    let value = await AsyncStorage.getItem(key);
    if (value) return value;

    const legacyKey = `${LEGACY_DAILY_SPIN_PREFIX}:${customerKey}`;
    value = await AsyncStorage.getItem(legacyKey);
    if (!value) {
      value = await AsyncStorage.getItem(LEGACY_DAILY_SPIN_KEY);
    }

    if (value) {
      const migratedAt = value.includes('T') ? value : new Date(`${value}T12:00:00.000Z`).toISOString();
      await AsyncStorage.setItem(key, migratedAt);
      await AsyncStorage.removeItem(legacyKey);
      await AsyncStorage.removeItem(LEGACY_DAILY_SPIN_KEY);
      return migratedAt;
    }
  } catch {
    return null;
  }

  return null;
}

export async function markLuckySpinUsedLocal(customerKey: string, usedAt = new Date().toISOString()) {
  if (!customerKey) return;
  await AsyncStorage.setItem(getLuckySpinUsedStorageKey(customerKey), usedAt);
}

export async function getLuckySpinStatus(customerId: string, customerKey: string): Promise<LuckySpinStatus> {
  if (customerId) {
    try {
      const backendStatus = await fetchLuckySpinStatus(customerId);
      if (backendStatus?.success) {
        if (backendStatus.used && customerKey && backendStatus.luckySpinUsedAt) {
          await markLuckySpinUsedLocal(customerKey, backendStatus.luckySpinUsedAt);
        }

        return {
          canSpin: Boolean(backendStatus.canSpin),
          used: Boolean(backendStatus.used),
          luckySpinUsedAt: backendStatus.luckySpinUsedAt || null,
          luckySpinRewardAmountUsd: backendStatus.luckySpinRewardAmountUsd ?? null,
          source: 'backend',
        };
      }
    } catch {
      // Fall back to local storage.
    }
  }

  const luckySpinUsedAt = customerKey ? await readLocalUsedAt(customerKey) : null;

  return {
    canSpin: !luckySpinUsedAt,
    used: Boolean(luckySpinUsedAt),
    luckySpinUsedAt,
    luckySpinRewardAmountUsd: null,
    source: 'local',
  };
}

export async function recordLuckySpinUsage(customerId: string, customerKey: string) {
  const usedAt = new Date().toISOString();
  await markLuckySpinUsedLocal(customerKey, usedAt);

  if (!customerId) {
    return { recorded: true, source: 'local' as const, prizeAmountUsd: null };
  }

  try {
    const response = await recordLuckySpinOnBackend(customerId);
    if (response?.luckySpinUsedAt) {
      await markLuckySpinUsedLocal(customerKey, response.luckySpinUsedAt);
    }
    return {
      recorded: true,
      source: 'backend' as const,
      prizeAmountUsd: response?.luckySpinRewardAmountUsd ?? response?.prize?.amountUsd ?? null,
      walletCredited: Boolean(response?.walletCredited),
    };
  } catch (error: any) {
    const message = String(error?.message || '');
    if (message.toLowerCase().includes('already used')) {
      throw error;
    }

    return { recorded: true, source: 'local' as const, prizeAmountUsd: null };
  }
}

if (__DEV__) {
  const globalScope = globalThis as typeof globalThis & {
    clearLuckySpinUsed?: (customerKey: string) => Promise<void>;
  };

  globalScope.clearLuckySpinUsed = async (customerKey: string) => {
    await AsyncStorage.removeItem(getLuckySpinUsedStorageKey(customerKey));
    await AsyncStorage.removeItem(`${LEGACY_DAILY_SPIN_PREFIX}:${customerKey}`);
    await AsyncStorage.removeItem(LEGACY_DAILY_SPIN_KEY);
  };
}