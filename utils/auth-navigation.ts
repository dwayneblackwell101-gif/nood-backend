import { router } from 'expo-router';
import { logAuthFlowDebug } from './auth-flow-debug';
import { logAuthRestartCheck } from './auth-restart-debug';
import { isAppBootstrapComplete } from './app-bootstrap';

const ACCOUNT_TAB_ROUTE = '/(tabs)/account';

export function navigateAfterAuthSignIn(route: string = ACCOUNT_TAB_ROUTE) {
  logAuthFlowDebug('navigate-after-sign-in-start', {
    route,
    detail: { canGoBack: router.canGoBack() },
  });
  logAuthRestartCheck({
    step: 'navigate-after-sign-in-start',
    route,
    isAppBootstrapping: !isAppBootstrapComplete(),
    isAuthLoading: false,
    signedIn: true,
    detail: { canGoBack: router.canGoBack() },
  });

  // Navigate instead of replace to avoid remounting the tab shell and losing tab state.
  router.navigate(route as any);

  logAuthFlowDebug('navigate-after-sign-in-done', { route });
  logAuthRestartCheck({
    step: 'navigate-after-sign-in-done',
    route,
    isAppBootstrapping: !isAppBootstrapComplete(),
    signedIn: true,
  });
}