import { router } from 'expo-router';

type AuthRestartCheckPayload = {
  step: string;
  route?: string;
  isAppBootstrapping?: boolean;
  isAuthLoading?: boolean;
  signedIn?: boolean;
  detail?: Record<string, unknown>;
};

export function getCurrentAuthDebugRoute() {
  try {
    const segments = (router as any)?.state?.routes;
    if (Array.isArray(segments) && segments.length) {
      const leaf = segments[segments.length - 1];
      return String(leaf?.name || leaf?.path || '(unknown)');
    }
  } catch {
    // ignore
  }

  return '(unknown)';
}

export function logAuthRestartCheck(payload: AuthRestartCheckPayload) {
  if (!__DEV__) return;

  console.log('[AUTH_RESTART_CHECK]', {
    step: payload.step,
    route: payload.route ?? getCurrentAuthDebugRoute(),
    isAppBootstrapping: payload.isAppBootstrapping ?? false,
    isAuthLoading: payload.isAuthLoading ?? false,
    signedIn: Boolean(payload.signedIn),
    ...(payload.detail || {}),
  });
}

export function logRootLayoutMounted() {
  if (!__DEV__) return;

  console.log('[ROOT_LAYOUT_MOUNTED]', {
    time: Date.now(),
  });
}

export function logNoodSpinnerReason(
  reason: string,
  detail: {
    isAppBootstrapping?: boolean;
    isAuthLoading?: boolean;
    route?: string;
  } = {}
) {
  if (!__DEV__) return;

  console.log('[NOOD_SPINNER_REASON]', {
    reason,
    isAppBootstrapping: detail.isAppBootstrapping ?? false,
    isAuthLoading: detail.isAuthLoading ?? false,
    route: detail.route ?? getCurrentAuthDebugRoute(),
  });
}