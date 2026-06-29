let activeCheckoutSessionId = '';

export function getCheckoutSessionId() {
  if (!activeCheckoutSessionId) {
    activeCheckoutSessionId = `checkout_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return activeCheckoutSessionId;
}

export function resetCheckoutSessionId() {
  activeCheckoutSessionId = '';
}