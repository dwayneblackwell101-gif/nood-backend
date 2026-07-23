/**
 * Carrier registry + tracking URL builders.
 * External carrier APIs can be plugged via createCarrierClient without API changes.
 */

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

const CARRIER_REGISTRY = Object.freeze({
  dhl: {
    code: 'dhl',
    name: 'DHL',
    trackingUrlTemplate: 'https://www.dhl.com/en/express/tracking.html?AWB={trackingNumber}',
  },
  fedex: {
    code: 'fedex',
    name: 'FedEx',
    trackingUrlTemplate: 'https://www.fedex.com/fedextrack/?trknbr={trackingNumber}',
  },
  ups: {
    code: 'ups',
    name: 'UPS',
    trackingUrlTemplate: 'https://www.ups.com/track?tracknum={trackingNumber}',
  },
  usps: {
    code: 'usps',
    name: 'USPS',
    trackingUrlTemplate: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={trackingNumber}',
  },
  tnt: {
    code: 'tnt',
    name: 'TNT',
    trackingUrlTemplate: 'https://www.tnt.com/express/en_us/site/tracking.html?searchType=con&cons={trackingNumber}',
  },
  other: {
    code: 'other',
    name: 'Carrier',
    trackingUrlTemplate: '',
  },
});

function normalizeCarrierCode(input) {
  const raw = safeString(input).toLowerCase();
  if (!raw) return 'other';
  if (CARRIER_REGISTRY[raw]) return raw;
  if (raw.includes('dhl')) return 'dhl';
  if (raw.includes('fedex')) return 'fedex';
  if (raw.includes('ups')) return 'ups';
  if (raw.includes('usps') || raw.includes('postal')) return 'usps';
  if (raw.includes('tnt')) return 'tnt';
  return 'other';
}

function getCarrier(codeOrName) {
  const code = normalizeCarrierCode(codeOrName);
  return CARRIER_REGISTRY[code] || CARRIER_REGISTRY.other;
}

function buildTrackingUrl(carrierCodeOrName, trackingNumber, explicitUrl) {
  const explicit = safeString(explicitUrl);
  if (explicit) return explicit;
  const number = safeString(trackingNumber);
  if (!number) return '';
  const carrier = getCarrier(carrierCodeOrName);
  if (!carrier.trackingUrlTemplate) return '';
  return carrier.trackingUrlTemplate.replace(/\{trackingNumber\}/g, encodeURIComponent(number));
}

/**
 * Optional HTTP carrier client stub — returns null when no provider configured.
 * Wire real AfterShip/17track/etc. later without changing public APIs.
 */
function createCarrierClient({ fetchTrackingFn = null } = {}) {
  return {
    async fetchTracking({ carrier, trackingNumber }) {
      if (typeof fetchTrackingFn !== 'function') {
        return {
          ok: false,
          provider: 'none',
          message: 'No external carrier provider configured.',
          events: [],
        };
      }
      try {
        const result = await fetchTrackingFn({
          carrier: normalizeCarrierCode(carrier),
          trackingNumber: safeString(trackingNumber),
        });
        return {
          ok: true,
          provider: result?.provider || 'custom',
          events: Array.isArray(result?.events) ? result.events : [],
          estimatedDelivery: result?.estimatedDelivery || null,
          status: result?.status || null,
          raw: result?.raw,
        };
      } catch (error) {
        return {
          ok: false,
          provider: 'custom',
          message: error.message || 'Carrier lookup failed.',
          events: [],
          error: true,
        };
      }
    },
  };
}

module.exports = {
  CARRIER_REGISTRY,
  normalizeCarrierCode,
  getCarrier,
  buildTrackingUrl,
  createCarrierClient,
};
