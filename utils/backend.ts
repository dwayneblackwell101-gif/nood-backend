import Constants from 'expo-constants';
import { Platform } from 'react-native';

type BackendRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

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

function getExpoHostIp() {
  const constants = Constants as any;
  const hostUri =
    constants?.expoConfig?.hostUri ||
    constants?.manifest2?.extra?.expoClient?.hostUri ||
    constants?.manifest?.debuggerHost ||
    '';
  const host = String(hostUri).split(':')[0]?.trim();

  return host || '';
}

function normalizeBackendUrl(url: string) {
  return String(url || '').trim().replace(/\/+$/g, '');
}

export function getConfiguredBackendUrl() {
  return normalizeBackendUrl(process.env.EXPO_PUBLIC_BACKEND_URL || '');
}

export function getBackendCandidates() {
  const configuredUrl = getConfiguredBackendUrl();

  if (configuredUrl) {
    return [configuredUrl];
  }

  if (!__DEV__) {
    return [];
  }

  const expoHostIp = getExpoHostIp();
  const useAndroidEmulator = process.env.EXPO_PUBLIC_USE_ANDROID_EMULATOR === '1';
  const candidates = [
    useAndroidEmulator && Platform.OS === 'android' ? 'http://10.0.2.2:3000' : '',
    expoHostIp ? `http://${expoHostIp}:3000` : '',
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

export function logBackendStartup() {
  const backendUrl = getConfiguredBackendUrl();
  console.log(
    `[NOOD backend] phone mode backend URL = ${backendUrl || '(not set — set EXPO_PUBLIC_BACKEND_URL)'}`
  );
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

export async function postBackendJson(
  path: string,
  payload: Record<string, any>,
  options: BackendRequestOptions = {}
) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const candidates = getBackendCandidates();
  let lastError: any = null;

  for (const baseUrl of candidates) {
    const requestUrl = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    logBackendAttempt('POST', requestUrl);

    try {
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.message || `Backend request failed with ${response.status}.`);
      }

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

  for (const baseUrl of candidates) {
    const requestUrl = `${baseUrl}${path}`;
    const controller = new AbortController();
    let abortReason: 'timeout' | 'superseded' | null = null;

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
    }, timeoutMs);

    if (options.catalog) {
      console.log(`[NOOD backend] trying GET ${requestUrl}`);
    } else {
      logBackendAttempt('GET', requestUrl);
    }

    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.message || `Backend request failed with ${response.status}.`);
      }

      if (options.catalog) {
        const source = String(data?.source || response.headers?.get?.('X-NOOD-Catalog-Source') || 'cache');
        const productCount = path.includes('/api/catalog/products')
          ? (data as any)?.data?.products?.edges?.length ?? null
          : null;
        const collectionCount = path.includes('/api/catalog/collections')
          ? (data as any)?.data?.collections?.edges?.length ?? null
          : null;

        console.log(`[NOOD app] using backend cache source=${source}`);
        if (productCount !== null) {
          console.log(`[NOOD app] backend catalog loaded count=${productCount}`);
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
  const candidates = getBackendCandidates();
  let parsedUrl: URL;
  let lastError: any = null;

  try {
    parsedUrl = new URL(String(absoluteUrl || '').trim());
  } catch {
    throw new Error('Invalid backend return URL.');
  }

  const pathsToTry = candidates.length
    ? candidates.map((baseUrl) => `${baseUrl}${parsedUrl.pathname}${parsedUrl.search}`)
    : [absoluteUrl];

  for (const requestUrl of pathsToTry) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    logBackendAttempt('GET', requestUrl);

    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
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
    }
  }

  console.error('[NOOD backend] Payment return connection failed.');
  for (const requestUrl of pathsToTry) {
    console.error(`[NOOD backend] Tried: ${requestUrl}`);
  }
  if (lastError?.message) {
    console.error(`[NOOD backend] Last error: ${lastError.message}`);
  }

  throw new Error(
    `Could not finish payment with the backend. Tried: ${pathsToTry.join(', ')}. ${lastError?.message || ''}`.trim()
  );
}