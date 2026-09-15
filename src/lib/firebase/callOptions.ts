// Timeouts for the callables customer-facing pages use.

/**
 * Read-only customer calls — checking a pay link, loading the portal lists, and
 * loading one invoice or quote — give up after 20 seconds, so a request stalled
 * on weak signal shows "Try again" instead of a loading screen for the Functions
 * SDK's default 70 seconds. Retrying a read is always safe.
 *
 * Calls that act — starting Stripe Checkout, sending a sign-in link — keep the
 * default: the server may still finish after the page stops waiting, and a
 * retry would start a second checkout or send a second email.
 */
export const CUSTOMER_READ_TIMEOUT_MS = 20_000;
