// Upload size limits for the business's logo and favicon (F-01).
//
// Invoices and quotes copy the logo and inline it into every PDF, refusing one
// over 500 KB (LOGO_MAX_BYTES in functions/src/shared/logo.ts), so uploads stop
// at the same size: a bigger logo used to save fine and then fail every new
// invoice and quote. A favicon only reaches a browser tab, so it keeps 2 MB.
// storage.rules enforces both; brandingLimits.test.ts pins the copies.

/** Largest logo accepted, inclusive — the size invoices and quotes accept. */
export const LOGO_MAX_BYTES = 500 * 1024;

/** Favicons must be smaller than this (storage.rules: `size < 2 MB`). */
export const FAVICON_MAX_BYTES = 2 * 1024 * 1024;
