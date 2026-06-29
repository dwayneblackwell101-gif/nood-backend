import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

type BackendRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export const PAYMENT_BACKEND_URL = 'https://nood-backend.onrender.com';

let lastSuccessfulBackendUrl: string | null = null;

export function getLastSuccessfulBackendUrl() {
  return lastSuccessfulBackendUrl;
}

const LOCAL_PAYMENT_HOST_PATTERN =
  /localhost|127\.0\.0\.1|192\.168\.|10\.0\.2\.2|ngrok/i;
const LOCAL_BACKEND_CANDIDATE_TIMEOUT_MS = 1200;
const LOCAL_BACKEND_FAILURE_CACHE_MS = 5 * 60 * 1000;
const failedLocalBackendUntil = new Map<string, number>();
let activeBackendLogged = false;

export function isLocalBackendUrl(url: string) {
  return LOCAL_PAYMENT_HOST_PATTERN.test(String(url || ''));
}

function resolveCandidateTimeoutMs(baseUrl: string, requestedTimeoutMs: number) {
  if (isLocalBackendUrl(baseUrl)) {
    return Math.min(requestedTimeoutMs, LOCAL_BACKEND_CANDIDATE_TIMEOUT_MS);
  }
  return requestedTimeoutMs;
}
const PAYMENT_URL_FIELD_PATTERN =
  /return_url|returnUrl|payment-return|payment_url|paymentUrl|backendReturnUrl/i;

export class BackendRequestCancelledError extends Error {
  name = 'BackendRequestCancelledError';

  constructor(message = 'Backend request cancelled.') {
    super(message);
  }
}

export function isBackendAbortError(error: unknown) {
  const name = String((error as any)?.name || '');
  const message = String((error as any)?.message || error || '');
  return (
    error instanceof BackendRequestCancelledError ||
    name === 'BackendRequestCancelledError' ||
    name === 'AbortError' ||
    message.includes('Aborted') ||
    message.includes('abort')
  );
}

function normalizeBackendUrl(url: string) {
  return String(url || '').trim().replace(/\/+$/g, '');
}

export function isBlockedLocalPaymentHost(url: string) {
  return LOCAL_PAYMENT_HOST_PATTERN.test(String(url || ''));
}

export function getPaymentBackendUrl() {
  return PAYMENT_BACKEND_URL;
}

export function getPaymentCreateUrl(path: string) {
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${getPaymentBackendUrl()}${normalizedPath}`;
}

function getBackendRequestHeaders(extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  const configuredUrl = getConfiguredBackendUrl();

  if (configuredUrl.includes('ngrok')) {
    headers['ngrok-skip-browser-warning'] = 'true';
  }

  return headers;
}

/** Dev-only: enabled only when EXPO_PUBLIC_LOCAL_BACKEND is exactly "true". */
export function isLocalBackendModeEnabled() {
  if (!__DEV__) {
    return false;
  }

  return String(process.env.EXPO_PUBLIC_LOCAL_BACKEND || '').trim().toLowerCase() === 'true';
}

export function getBackendMode(): 'local' | 'render' {
  return isLocalBackendModeEnabled() ? 'local' : 'render';
}

function resolveDevLocalBackendUrl() {
  const fromEnv = normalizeBackendUrl(process.env.EXPO_PUBLIC_BACKEND_URL || '');
  if (fromEnv && isLocalBackendUrl(fromEnv)) {
    return fromEnv;
  }

  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:3000';
  }

  if (Platform.OS === 'ios') {
    return 'http://127.0.0.1:3000';
  }

  return fromEnv || 'http://127.0.0.1:3000';
}

export function getConfiguredBackendUrl() {
  if (isLocalBackendModeEnabled()) {
    return resolveDevLocalBackendUrl();
  }

  if (__DEV__) {
    return PAYMENT_BACKEND_URL;
  }

  const fromEnv = normalizeBackendUrl(process.env.EXPO_PUBLIC_BACKEND_URL || '');
  return fromEnv || PAYMENT_BACKEND_URL;
}

export function logBackendModeDebug() {
  if (!__DEV__) {
    return;
  }

  console.log('[BACKEND_MODE_DEBUG]', {
    localBackendEnv: process.env.EXPO_PUBLIC_LOCAL_BACKEND ?? '(unset)',
    configuredBackendEnv: process.env.EXPO_PUBLIC_BACKEND_URL ?? '(unset)',
    activeBackendUrl: getConfiguredBackendUrl(),
    mode: getBackendMode(),
    candidates: getBackendCandidates(),
  });
}

if (
  lastSuccessfulBackendUrl &&
  isLocalBackendUrl(lastSuccessfulBackendUrl) &&
  !isLocalBackendModeEnabled()
) {
  lastSuccessfulBackendUrl = null;
}

export function getActiveBackendUrl() {
  return lastSuccessfulBackendUrl || getConfiguredBackendUrl();
}

function isLocalBackendTemporarilyBlocked(url: string) {
  const blockedUntil = failedLocalBackendUntil.get(url);
  if (!blockedUntil) {
    return false;
  }

  if (Date.now() < blockedUntil) {
    return true;
  }

  failedLocalBackendUntil.delete(url);
  return false;
}

function markLocalBackendUnreachable(url: string) {
  if (!isLocalBackendUrl(url)) {
    return;
  }

  failedLocalBackendUntil.set(url, Date.now() + LOCAL_BACKEND_FAILURE_CACHE_MS);
}

function logActiveBackendOnce() {
  if (activeBackendLogged) {
    return;
  }

  activeBackendLogged = true;
  const mode = getBackendMode();
  console.log('[NOOD backend] active backend', {
    mode,
    primaryUrl: getConfiguredBackendUrl(),
    localBackendEnabled: mode === 'local',
    fallbackUrl: PAYMENT_BACKEND_URL,
  });
  logBackendModeDebug();
}

export function coercePaymentUrlToRender(absoluteUrl: string, fallbackPath = '/payment-return') {
  const paymentBase = getPaymentBackendUrl();
  const trimmed = String(absoluteUrl || '').trim();

  if (!trimmed) {
    return `${paymentBase}${fallbackPath.startsWith('/') ? fallbackPath : `/${fallbackPath}`}`;
  }

  if (isBlockedLocalPaymentHost(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const coerced = `${paymentBase}${parsed.pathname}${parsed.search}`;
      console.log('[PAYMENT URL BLOCKED LOCAL]', {
        original: trimmed,
        replacedWith: coerced,
      });
      return coerced;
    } catch {
      const fallback = `${paymentBase}${fallbackPath.startsWith('/') ? fallbackPath : `/${fallbackPath}`}`;
      console.log('[PAYMENT URL BLOCKED LOCAL]', {
        original: trimmed,
        replacedWith: fallback,
      });
      return fallback;
    }
  }

  try {
    const parsed = new URL(trimmed);
    return `${paymentBase}${parsed.pathname}${parsed.search}`;
  } catch {
    return `${paymentBase}${fallbackPath.startsWith('/') ? fallbackPath : `/${fallbackPath}`}`;
  }
}

export function resolveBackendAbsoluteUrl(absoluteUrl: string) {
  return coercePaymentUrlToRender(absoluteUrl);
}

export function resolvePaymentReturnUrl(absoluteUrl = '', query = '') {
  const normalizedQuery = query.startsWith('?') ? query : query ? `?${query}` : '';

  if (!absoluteUrl) {
    return `${getPaymentBackendUrl()}/payment-return${normalizedQuery}`;
  }

  return coercePaymentUrlToRender(absoluteUrl);
}

export function getPaymentReturnUrl(query = '') {
  return resolvePaymentReturnUrl('', query);
}

export function getPaymentReturnHost(paymentReturnUrl: string) {
  try {
    return new URL(paymentReturnUrl).host;
  } catch {
    return '';
  }
}

export function logPaymentBackendDiagnostics(returnUrl?: string) {
  const backendUrl = getPaymentBackendUrl();
  console.log(`[NOOD backend URL] ${backendUrl}`);

  const paymentReturnUrl = returnUrl
    ? resolvePaymentReturnUrl(returnUrl)
    : getPaymentReturnUrl();

  console.log(`[PAYMENT RETURN URL] ${paymentReturnUrl}`);
  console.log(`[PAYMENT RETURN HOST] ${getPaymentReturnHost(paymentReturnUrl) || '(invalid)'}`);

  return {
    backendUrl,
    paymentReturnUrl,
    paymentReturnHost: getPaymentReturnHost(paymentReturnUrl),
  };
}

function sanitizePaymentStorageValue(raw: string): { changed: boolean; nextValue: string | null } {
  if (!LOCAL_PAYMENT_HOST_PATTERN.test(raw)) {
    return { changed: false, nextValue: raw };
  }

  if (!PAYMENT_URL_FIELD_PATTERN.test(raw) && !raw.includes('/payment-return')) {
    return { changed: false, nextValue: raw };
  }

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      const next = parsed
        .map((entry) => sanitizePaymentStorageEntry(entry))
        .filter((entry) => entry !== null);

      const changed = JSON.stringify(next) !== JSON.stringify(parsed);
      return {
        changed,
        nextValue: changed ? JSON.stringify(next) : raw,
      };
    }

    if (parsed && typeof parsed === 'object') {
      const next = sanitizePaymentStorageEntry(parsed);
      if (!next) {
        return { changed: true, nextValue: null };
      }

      const changed = JSON.stringify(next) !== JSON.stringify(parsed);
      return {
        changed,
        nextValue: changed ? JSON.stringify(next) : raw,
      };
    }
  } catch {
    return { changed: true, nextValue: null };
  }

  return { changed: true, nextValue: null };
}

function sanitizePaymentStorageEntry(entry: any) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }

  const next = { ...entry };
  let changed = false;

  for (const key of Object.keys(next)) {
    const value = next[key];

    if (typeof value === 'string' && isBlockedLocalPaymentHost(value) && PAYMENT_URL_FIELD_PATTERN.test(key)) {
      delete next[key];
      changed = true;
      continue;
    }

    if (key === 'metadata' && value && typeof value === 'object') {
      const metadata = { ...value };
      for (const metadataKey of Object.keys(metadata)) {
        const metadataValue = metadata[metadataKey];
        if (
          typeof metadataValue === 'string' &&
          isBlockedLocalPaymentHost(metadataValue) &&
          PAYMENT_URL_FIELD_PATTERN.test(metadataKey)
        ) {
          delete metadata[metadataKey];
          changed = true;
        }
      }
      next.metadata = metadata;
    }
  }

  const serialized = JSON.stringify(next);
  if (
    LOCAL_PAYMENT_HOST_PATTERN.test(serialized) &&
    (serialized.includes('/payment-return') || PAYMENT_URL_FIELD_PATTERN.test(serialized))
  ) {
    return null;
  }

  return changed ? next : entry;
}

export async function clearStalePaymentAsyncStorage() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const paymentRelatedKeys = keys.filter((key) =>
      /order|payment|checkout|history|wallet|pending/i.test(key)
    );

    for (const key of paymentRelatedKeys) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;

      const { changed, nextValue } = sanitizePaymentStorageValue(raw);
      if (!changed) continue;

      if (!nextValue) {
        await AsyncStorage.removeItem(key);
        console.log('[PAYMENT URL BLOCKED LOCAL] removed stale AsyncStorage key', key);
        continue;
      }

      await AsyncStorage.setItem(key, nextValue);
      console.log('[PAYMENT URL BLOCKED LOCAL] sanitized AsyncStorage key', key);
    }
  } catch (error) {
    console.log('[PAYMENT URL BLOCKED LOCAL] failed to sanitize AsyncStorage', error);
  }
}

export function getBackendCandidates() {
  if (!isLocalBackendModeEnabled()) {
    return [PAYMENT_BACKEND_URL];
  }

  const configuredUrl = getConfiguredBackendUrl();
  const candidates: string[] = [];

  if (configuredUrl && !isLocalBackendTemporarilyBlocked(configuredUrl)) {
    candidates.push(configuredUrl);
  }

  if (PAYMENT_BACKEND_URL && !candidates.includes(PAYMENT_BACKEND_URL)) {
    candidates.push(PAYMENT_BACKEND_URL);
  }

  return candidates.length ? candidates : [PAYMENT_BACKEND_URL];
}

export async function logBackendStartup() {
  await clearStalePaymentAsyncStorage();
  logPaymentBackendDiagnostics();
  logActiveBackendOnce();

  if (__DEV__) {
    console.log('[NOOD dev-parity] backend-startup', {
      localBackendEnabled: isLocalBackendModeEnabled(),
      configuredBackendUrl: getConfiguredBackendUrl(),
      backendCandidates: getBackendCandidates(),
    });
  }
}

function logBackendAttempt(method: string, requestUrl: string) {
  if (__DEV__) {
    console.log(`[NOOD backend] ${method} ${requestUrl}`);
  }
}

function logBackendConnectionFailure(
  context: string,
  candidates: string[],
  path: string,
  lastError: any
) {
  const fullUrls = candidates.map((baseUrl) => `${baseUrl}${path}`);
  console.error(`[NOOD backend] ${context}: could not reach backend.`);
  console.error(
    `[NOOD backend] EXPO_PUBLIC_BACKEND_URL=${process.env.EXPO_PUBLIC_BACKEND_URL || '(not set)'}`
  );

  for (const requestUrl of fullUrls) {
    console.error(`[NOOD backend] Tried: ${requestUrl}`);
  }

  if (lastError?.message) {
    console.error(`[NOOD backend] Last error: ${lastError.message}`);
  }
}

function buildConnectionError(
  context: string,
  candidates: string[],
  path: string,
  lastError: any
) {
  const fullUrls = candidates.map((baseUrl) => `${baseUrl}${path}`);
  const tried = fullUrls.join(', ');

  return `${context}. Set EXPO_PUBLIC_BACKEND_URL for production builds. Tried: ${tried || 'none'}. ${lastError?.message || ''}`.trim();
}

export async function postPaymentBackendJson(
  path: string,
  payload: Record<string, any>,
  options: BackendRequestOptions = {}
) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const requestUrl = getPaymentCreateUrl(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  console.log(`[NOOD backend URL] ${getPaymentBackendUrl()}`);
  console.log(`[PAYMENT CREATE URL] ${requestUrl}`);

  logBackendAttempt('POST', requestUrl);

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: getBackendRequestHeaders({ 'Content-Type': 'application/json' }),
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    clearTimeout(timeout);

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.message || `Payment backend request failed with ${response.status}.`);
    }

    return data;
  } catch (error: any) {
    clearTimeout(timeout);

    console.error('[NOOD backend] Payment backend connection failed.');
    console.error(`[NOOD backend] Tried: ${requestUrl}`);
    console.error(`[NOOD backend] PAYMENT_BACKEND_URL=${getPaymentBackendUrl()}`);
    if (error?.message) {
      console.error(`[NOOD backend] Last error: ${error.message}`);
    }

    throw new Error(
      `Could not connect to the payment backend. Tried: ${requestUrl}. ${error?.message || ''}`.trim()
    );
  }
}

export async function fetchBackendJson<T = any>(path: string, options: BackendRequestOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 12000;
  const candidates = getBackendCandidates();
  let lastError: any = null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const baseUrl = candidates[candidateIndex];
    const requestUrl = `${baseUrl}${path}`;
    const controller = new AbortController();
    const candidateTimeoutMs = resolveCandidateTimeoutMs(baseUrl, timeoutMs);
    const timeout = setTimeout(() => controller.abort(), candidateTimeoutMs);

    logBackendAttempt('GET', requestUrl);

    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: getBackendRequestHeaders(),
        signal: options.signal || controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.message || `Backend request failed with ${response.status}.`);
      }

      lastSuccessfulBackendUrl = baseUrl;
      console.log('[NOOD backend] candidate used', { url: baseUrl, path });
      return data;
    } catch (error: any) {
      clearTimeout(timeout);
      lastError = error;

      const message = String(error?.message || '');
      const canTryNext =
        error?.name === 'AbortError' ||
        message.includes('Network request failed') ||
        message.includes('Failed to fetch') ||
        message.includes('Load failed');

      if (!canTryNext) {
        throw error;
      }

      markLocalBackendUnreachable(baseUrl);

      const nextCandidate = candidates[candidateIndex + 1];
      if (nextCandidate) {
        console.log('[NOOD backend] fallback used', {
          from: baseUrl,
          to: nextCandidate,
          path,
        });
      }
    }
  }

  logBackendConnectionFailure('Backend connection failed', candidates, path, lastError);
  throw new Error(
    buildConnectionError('Could not connect to the backend', candidates, path, lastError)
  );
}

export async function postBackendJson(
  path: string,
  payload: Record<string, any>,
  options: BackendRequestOptions = {}
) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const candidates = getBackendCandidates();
  let lastError: any = null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const baseUrl = candidates[candidateIndex];
    const requestUrl = `${baseUrl}${path}`;
    const controller = new AbortController();
    const candidateTimeoutMs = resolveCandidateTimeoutMs(baseUrl, timeoutMs);
    const timeout = setTimeout(() => controller.abort(), candidateTimeoutMs);

    logBackendAttempt('POST', requestUrl);

    try {
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: getBackendRequestHeaders({ 'Content-Type': 'application/json' }),
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.message || `Backend request failed with ${response.status}.`);
      }

      lastSuccessfulBackendUrl = baseUrl;
      console.log('[NOOD backend] candidate used', { url: baseUrl, path });
      return data;
    } catch (error: any) {
      clearTimeout(timeout);
      lastError = error;

      const message = String(error?.message || '');
      const canTryNext =
        error?.name === 'AbortError' ||
        message.includes('Network request failed') ||
        message.includes('Failed to fetch') ||
        message.includes('Load failed');

      if (!canTryNext) {
        throw error;
      }

      markLocalBackendUnreachable(baseUrl);

      const nextCandidate = candidates[candidateIndex + 1];
      if (nextCandidate) {
        console.log('[NOOD backend] fallback used', {
          from: baseUrl,
          to: nextCandidate,
          path,
        });
      }
    }
  }

  logBackendConnectionFailure('Payment backend connection failed', candidates, path, lastError);
  throw new Error(
    buildConnectionError('Could not connect to the payment backend', candidates, path, lastError)
  );
}

type GetBackendJsonOptions = BackendRequestOptions & {
  catalog?: boolean;
};

export async function getBackendJson(path: string, options: GetBackendJsonOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const candidates = getBackendCandidates();
  let lastError: any = null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const baseUrl = candidates[candidateIndex];
    const requestUrl = `${baseUrl}${path}`;
    const controller = new AbortController();
    let abortReason: 'timeout' | 'superseded' | null = null;
    const candidateTimeoutMs = resolveCandidateTimeoutMs(baseUrl, timeoutMs);

    const onExternalAbort = () => {
      abortReason = 'superseded';
      controller.abort();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        console.log('[NOOD backend] request cancelled');
        throw new BackendRequestCancelledError();
      }
      options.signal.addEventListener('abort', onExternalAbort);
    }

    const timeout = setTimeout(() => {
      abortReason = 'timeout';
      controller.abort();
    }, candidateTimeoutMs);

    if (options.catalog) {
      console.log(`[NOOD backend] trying GET ${requestUrl}`);
    } else {
      logBackendAttempt('GET', requestUrl);
    }

    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: getBackendRequestHeaders({ Accept: 'application/json' }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.message || `Backend request failed with ${response.status}.`);
      }

      lastSuccessfulBackendUrl = baseUrl;
      console.log('[NOOD backend] candidate used', { url: baseUrl, path });

      if (options.catalog) {
        const source = String(data?.source || response.headers?.get?.('X-NOOD-Catalog-Source') || 'cache');
        const productCount = path.includes('/api/catalog/products')
          ? (data as any)?.data?.products?.edges?.length ?? null
          : null;
        const collectionCount = path.includes('/api/catalog/collections')
          ? (data as any)?.data?.collections?.edges?.length ?? null
          : null;
        const searchCount = path.includes('/api/catalog/search')
          ? (data as any)?.data?.products?.edges?.length ?? null
          : null;

        console.log(`[NOOD app] using backend cache source=${source}`);
        if (productCount !== null) {
          console.log(`[NOOD catalog] products count=${productCount}`);
        }
        if (searchCount !== null) {
          console.log(`[NOOD catalog] search count=${searchCount}`);
        }
        if (collectionCount !== null) {
          console.log(`[NOOD app] backend collections loaded count=${collectionCount}`);
        }
        console.log(`[NOOD backend] success source=${source}`);
      }

      return data;
    } catch (error: any) {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);
      lastError = error;

      if (isBackendAbortError(error)) {
        if (abortReason === 'superseded' || options.signal?.aborted) {
          console.log('[NOOD backend] request cancelled');
          throw new BackendRequestCancelledError();
        }

        if (options.catalog) {
          console.log(`[NOOD backend] request timed out GET ${requestUrl}`);
        }
      } else if (options.catalog) {
        console.log(`[NOOD backend] failed GET ${requestUrl}: ${error?.message || String(error)}`);
      }

      const message = String(error?.message || '');
      const canTryNext =
        (error?.name === 'AbortError' && abortReason === 'timeout') ||
        message.includes('Network request failed') ||
        message.includes('Failed to fetch') ||
        message.includes('Load failed');

      if (error instanceof BackendRequestCancelledError) {
        throw error;
      }

      if (!canTryNext) {
        throw error;
      }

      markLocalBackendUnreachable(baseUrl);

      const nextCandidate = candidates[candidateIndex + 1];
      if (nextCandidate) {
        console.log('[NOOD backend] fallback used', {
          from: baseUrl,
          to: nextCandidate,
          path,
        });
      }
    }
  }

  const triedUrl = candidates.length ? `${candidates[0]}${path}` : path;
  if (options.catalog) {
    console.log(
      `[NOOD backend] failed GET ${triedUrl}: ${lastError?.message || 'No backend candidates available.'}`
    );
  } else {
    logBackendConnectionFailure('Backend connection failed', candidates, path, lastError);
  }

  throw new Error(
    buildConnectionError('Could not connect to the backend', candidates, path, lastError)
  );
}

export async function getBackendJsonFromUrl(
  absoluteUrl: string,
  options: BackendRequestOptions = {}
) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const requestUrl = resolvePaymentReturnUrl(absoluteUrl);

  if (!requestUrl) {
    throw new Error('Invalid backend return URL.');
  }

  console.log(`[NOOD backend URL] ${getPaymentBackendUrl()}`);
  console.log(`[PAYMENT RETURN URL] ${requestUrl}`);
  console.log(`[PAYMENT RETURN HOST] ${getPaymentReturnHost(requestUrl) || '(invalid)'}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  logBackendAttempt('GET', requestUrl);

  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: getBackendRequestHeaders({ Accept: 'application/json' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.message || `Backend return failed with ${response.status}.`);
    }

    return data;
  } catch (error: any) {
    clearTimeout(timeout);

    console.error('[NOOD backend] Payment return connection failed.');
    console.error(`[NOOD backend] Tried: ${requestUrl}`);
    console.error(`[NOOD backend] PAYMENT_BACKEND_URL=${getPaymentBackendUrl()}`);
    if (error?.message) {
      console.error(`[NOOD backend] Last error: ${error.message}`);
    }

    throw new Error(
      `Could not finish payment with the backend. Tried: ${requestUrl}. ${error?.message || ''}`.trim()
    );
  }
}