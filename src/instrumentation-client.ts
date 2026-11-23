// Client-side Sentry init. tenantId/uid scope tags are set in TenantContext
// once auth resolves — see src/lib/tenant/TenantContext.tsx. Errors only, with
// pay tokens and sign-in codes stripped before sending (src/lib/sentry/scrub.ts).

import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry/scrub";

Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
