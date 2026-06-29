import {
  activateKeepAwakeAsync as rawActivateKeepAwakeAsync,
  deactivateKeepAwake as rawDeactivateKeepAwake,
} from 'expo-keep-awake';

export { isKeepAwakeActivationError } from './keep-awake-errors';

export async function safeActivateKeepAwakeAsync(tag: string) {
  try {
    await rawActivateKeepAwakeAsync(tag);
  } catch (error) {
    console.warn('[KEEP_AWAKE_DISABLED]', error);
  }
}

export async function safeDeactivateKeepAwake(tag: string) {
  try {
    await rawDeactivateKeepAwake(tag);
  } catch (error) {
    console.warn('[KEEP_AWAKE_DEACTIVATE_ERROR]', error);
  }
}