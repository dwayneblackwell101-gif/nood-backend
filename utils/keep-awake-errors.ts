const KEEP_AWAKE_ERROR_PATTERN = /unable to activate keep awake/i;

export function isKeepAwakeActivationError(error: unknown) {
  const message = String((error as any)?.message || error || '');
  return KEEP_AWAKE_ERROR_PATTERN.test(message);
}