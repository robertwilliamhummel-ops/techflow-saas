// Keeps secrets and customer data out of what Cloud Functions send to Sentry.
//
// Sentry's HTTP integration attaches the incoming request to an event. For a
// callable that means the Authorization header (a Firebase ID token), the App
// Check token, and the request body — which for the pay page is the pay token
// itself, and elsewhere is invoice and customer data. Sentry is in the US
// (owner's choice, 2026-11-23), so only the URL path, method and a couple of
// harmless headers are kept; pay tokens and sign-in codes in URLs are masked.
// The Next.js app does the same in src/lib/sentry/scrub.ts.

import type { Breadcrumb, ErrorEvent } from "@sentry/node";

const SECRET_QUERY_KEYS = ["oobcode", "apikey", "token", "continueurl"];
const KEPT_HEADERS = new Set(["user-agent", "content-type"]);

/** Replaces pay tokens and secret query values in a URL or path. */
export function scrubUrl(value: string): string {
  return value
    .replace(/\/pay\/[^/?#\s]+/g, "/pay/[token]")
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, sep: string, key: string) =>
      SECRET_QUERY_KEYS.includes(key.toLowerCase()) ? `${sep}${key}=[redacted]` : match,
    );
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  if (request) {
    delete request.data;
    delete request.cookies;
    if (request.url) request.url = scrubUrl(request.url);
    if (typeof request.query_string === "string") {
      request.query_string = scrubUrl(`?${request.query_string}`).slice(1);
    } else {
      delete request.query_string;
    }
    if (request.headers) {
      for (const key of Object.keys(request.headers)) {
        if (!KEPT_HEADERS.has(key.toLowerCase())) delete request.headers[key];
      }
    }
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  if (crumb.message) crumb.message = scrubUrl(crumb.message);
  if (crumb.data && typeof crumb.data.url === "string") {
    crumb.data.url = scrubUrl(crumb.data.url);
  }
  return crumb;
}
