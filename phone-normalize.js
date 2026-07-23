function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

const TRINIDAD_E164_PATTERN = /^\+1868\d{7}$/;

function normalizeTrinidadPhoneForShopify(rawPhone, context = 'phone') {
  const raw = safeString(rawPhone);
  console.log('[PHONE RAW]', { context, value: raw || null });

  if (!raw) {
    return undefined;
  }

  const digitsOnly = raw.replace(/\D/g, '');
  let e164 = '';

  if (digitsOnly.length === 7) {
    e164 = `+1868${digitsOnly}`;
  } else if (digitsOnly.length === 10 && digitsOnly.startsWith('868')) {
    e164 = `+1${digitsOnly}`;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    e164 = `+${digitsOnly}`;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('868')) {
    e164 = `+1${digitsOnly}`;
  }

  if (TRINIDAD_E164_PATTERN.test(e164)) {
    console.log('[PHONE NORMALIZED]', { context, value: e164 });
    return e164;
  }

  console.log('[PHONE OMITTED INVALID]', {
    context,
    raw,
    digitsOnly: digitsOnly || null,
  });
  return undefined;
}

module.exports = {
  normalizeTrinidadPhoneForShopify,
  TRINIDAD_E164_PATTERN,
};