import { getValidAccessToken } from './shopify-auth-tokens';

type AuthFlowDebugPayload = {
  step: string;
  signedIn?: boolean;
  hasAccessToken?: boolean;
  route?: string;
  detail?: Record<string, unknown>;
};

export function logAuthFlowDebug(
  step: string,
  payload: Omit<AuthFlowDebugPayload, 'step'> = {}
) {
  if (!__DEV__) {
    return;
  }

  void (async () => {
    let hasAccessToken = payload.hasAccessToken;
    if (hasAccessToken == null) {
      try {
        hasAccessToken = Boolean(await getValidAccessToken());
      } catch {
        hasAccessToken = false;
      }
    }

    console.log('[AUTH_FLOW_DEBUG]', {
      step,
      signedIn: payload.signedIn,
      hasAccessToken,
      route: payload.route,
      ...(payload.detail || {}),
    });
  })();
}

export function logAppRestartDebug(location: string, detail?: Record<string, unknown>) {
  if (!__DEV__) {
    return;
  }

  console.log('[APP_RESTART_DEBUG]', {
    location,
    timestamp: Date.now(),
    ...(detail || {}),
  });
}