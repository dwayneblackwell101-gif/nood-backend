export const WALLET_CREDIT_COLOR = '#22a06b';
export const WALLET_DEBIT_COLOR = '#d64545';

export function isWalletCredit(type: string): boolean {
  const normalized = String(type || '').toLowerCase();
  return normalized === 'credit' || normalized === 'refund' || normalized === 'topup' || normalized === 'reward';
}

export function getWalletTransactionDisplay(type: string) {
  const isPositive = isWalletCredit(type);

  return {
    isPositive,
    sign: isPositive ? '+' : '-',
    color: isPositive ? WALLET_CREDIT_COLOR : WALLET_DEBIT_COLOR,
    icon: isPositive ? 'arrow-up-circle' : 'arrow-down-circle',
  };
}