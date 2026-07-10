const DEFAULT_CURRENCY = 'USD';

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeCurrency(value, fallback = DEFAULT_CURRENCY) {
  return safeString(value, fallback).toUpperCase();
}

function assertUsdCurrency(value, label = 'currency') {
  const currency = normalizeCurrency(value);
  if (currency !== DEFAULT_CURRENCY) {
    const error = new Error(`${label} must be USD.`);
    error.statusCode = 400;
    throw error;
  }
  return currency;
}

function usdToCents(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('Money values must be strings or integer cents, not floating point numbers.');
  }

  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new Error('Money value is required.');
  }

  if (/^-?\d+$/.test(raw)) {
    const cents = Number(raw);
    if (!Number.isSafeInteger(cents)) {
      throw new Error('Money value is outside the safe integer range.');
    }
    return cents;
  }

  const match = raw.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error('Money value must have at most two decimal places.');
  }

  const sign = match[1] === '-' ? -1 : 1;
  const dollars = Number(match[2]);
  const cents = Number((match[3] || '').padEnd(2, '0'));
  const total = sign * (dollars * 100 + cents);

  if (!Number.isSafeInteger(total)) {
    throw new Error('Money value is outside the safe integer range.');
  }

  return total;
}

function centsToUsd(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new Error('USD cents must be a safe integer.');
  }

  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${sign}${dollars}.${remainder}`;
}

function requirePositiveCents(cents, label = 'amount') {
  const value = Number(cents);
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error(`${label} must be a positive USD cents integer.`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

module.exports = {
  DEFAULT_CURRENCY,
  assertUsdCurrency,
  centsToUsd,
  normalizeCurrency,
  requirePositiveCents,
  usdToCents,
};
