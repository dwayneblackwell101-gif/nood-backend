import React from 'react';
import { isKeepAwakeActivationError } from './keep-awake-errors';

function installKeepAwakeGlobalHandler() {
  const previousUnhandledRejection = (globalThis as any).onunhandledrejection;

  (globalThis as any).onunhandledrejection = (event: any) => {
    const reason = event?.reason;
    if (isKeepAwakeActivationError(reason)) {
      console.warn('[KEEP_AWAKE_DISABLED]', reason);
      event?.preventDefault?.();
      return;
    }

    if (typeof previousUnhandledRejection === 'function') {
      previousUnhandledRejection(event);
    }
  };
}

function patchKeepAwakeModule() {
  try {
    const keepAwakeModule = require('expo-keep-awake') as typeof import('expo-keep-awake');
    const originalActivate = keepAwakeModule.activateKeepAwakeAsync.bind(keepAwakeModule);

    keepAwakeModule.activateKeepAwakeAsync = async (tag?: string) => {
      try {
        await originalActivate(tag ?? keepAwakeModule.ExpoKeepAwakeTag);
      } catch (error) {
        console.warn('[KEEP_AWAKE_DISABLED]', error);
      }
    };

    if (typeof keepAwakeModule.activateKeepAwake === 'function') {
      keepAwakeModule.activateKeepAwake = (tag?: string) =>
        keepAwakeModule.activateKeepAwakeAsync(tag).catch((error) => {
          console.warn('[KEEP_AWAKE_DISABLED]', error);
        });
    }

    keepAwakeModule.useKeepAwake = (tag?: string, options?: import('expo-keep-awake').KeepAwakeOptions) => {
      const defaultTag = React.useId();
      const tagOrDefault = tag ?? defaultTag;

      React.useEffect(() => {
        void keepAwakeModule.activateKeepAwakeAsync(tagOrDefault);
        return () => {
          void keepAwakeModule.deactivateKeepAwake(tagOrDefault).catch(() => {});
        };
      }, [tagOrDefault]);
    };
  } catch (error) {
    console.warn('[KEEP_AWAKE_SHIM_UNAVAILABLE]', error);
  }
}

installKeepAwakeGlobalHandler();
patchKeepAwakeModule();