/** Bypass checkout email gates while testing checkout and payment flows. */
export const PAYMENT_TESTING_MODE = true;

/** Show sign-in buttons and entry points in the UI. */
export const SIGN_IN_ENABLED = true;

/** When false, account screens and features work without signing in. */
export const SIGN_IN_REQUIRED = false;

/** Test customer email for checkout, orders, and refund flows when profile email is unset. */
export const PAYMENT_TEST_CUSTOMER_EMAIL = 'info@noodcaribbean.com';

/** @deprecated Use PAYMENT_TEST_CUSTOMER_EMAIL */
export const PAYMENT_TEST_GUEST_EMAIL = PAYMENT_TEST_CUSTOMER_EMAIL;