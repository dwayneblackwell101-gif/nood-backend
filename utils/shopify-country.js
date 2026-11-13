const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
let countryNames;
function countryCode(value) {
  const raw = String(value || '').trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return new Intl.Locale(`und-${raw.toUpperCase()}`).region;
  if (!countryNames) {
    countryNames = new Map();
    const display = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = new Intl.Locale(`und-${String.fromCharCode(a, b)}`).region;
      const name = display.of(code);
      if (name) countryNames.set(normalize(name), code);
    }
    countryNames.set('unitedstatesofamerica', 'US');
    countryNames.set('uk', 'GB');
  }
  const code = countryNames.get(normalize(raw));
  if (!code) throw new Error('Shipping country is not recognized. Please update the saved address.');
  return code;
}
module.exports = { countryCode };
