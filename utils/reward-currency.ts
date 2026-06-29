export function formatGameRewardUsd(amount: number) {
  const normalized = Number(amount || 0);
  const display = Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(2);
  return `$${display} USD`;
}

export const GAME_PRIZE_AMOUNTS_USD = [5, 10, 15, 20] as const;
export const SCRATCH_REVEAL_AMOUNT_USD = 10;

export const SPECIAL_REWARD_USD_AMOUNT = 10;
export const SPECIAL_REWARD_USD_LABEL = '$10 USD NOOD Balance';
export const SPECIAL_REWARD_USD_CREDIT_LABEL = '$10 USD store credit';