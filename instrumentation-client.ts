// Client-side Sentry init. tenantId/uid scope tags are set in TenantContext
// once auth resolves — see src/lib/tenant/TenantContext.tsx.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  // Replays are off by default — enable per-tenant later if useful.
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
