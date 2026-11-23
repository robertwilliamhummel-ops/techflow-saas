// Strips bearer secrets out of anything the Next.js app sends to Sentry.
//
// A pay link (/pay/<token>) lets whoever holds it view and pay an invoice, and
// email sign-in links carry one-time codes (oobCode) and the API key in their
// query string. Sentry is in the US (owner's choice, 2026-11-23), so these
// never leave the app: URLs are rewritten before an event or breadcrumb is
// sent. Errors only — no performance tracing — keeps what leaves Canada small.

import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

const SECRET_QUERY_KEYS = ["oobcode", "apikey", "token", "continueurl"];

/** Replaces pay tokens and secret query values in a URL or path. */
export function scrubUrl(value: string): string {
  let out = value.replace(/\/pay\/[^/?#\s]+/g, "/pay/[token]");
  out = out.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, sep: string, key: string) =>
    SECRET_QUERY_KEYS.includes(key.toLowerCase()) ? `${sep}${key}=[redacted]` : match,
  );
  return out;
}

function scrubString(value: unknown): unknown {
  return typeof value === "string" ? scrubUrl(value) : value;
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubUrl(`?${event.request.query_string}`).slice(1);
    }
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        const lower = key.toLowerCase();
        if (lower === "referer" || lower === "referrer") {
          event.request.headers[key] = scrubUrl(event.request.headers[key]);
        }
        if (lower === "authorization" || lower === "cookie") delete event.request.headers[key];
      }
    }
    delete event.request.cookies;
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  if (crumb.message) crumb.message = scrubUrl(crumb.message);
  if (crumb.data) {
    for (const key of ["url", "from", "to"]) {
      if (key in crumb.data) crumb.data[key] = scrubString(crumb.data[key]);
    }
  }
  return crumb;
}

/** Shared Sentry.init options for every Next.js runtime. */
export function sentryOptions(dsn: string | undefined) {
  return {
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    beforeBreadcrumb: (crumb: Breadcrumb) => scrubBreadcrumb(crumb),
  };
}
