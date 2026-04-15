# REBUILD_PLAN — Deferred Work Tracker

**Origin:** Round 3 "Zero-Mercy" audit of `Docs/REBUILD_PLAN.md`, dated 2026-04-13. Opus 4.6, acting as Principal Software Architect.
**Status (2026-04-14):** All 6 round-3 CRITICAL findings have been folded into `REBUILD_PLAN.md` (rule changes, tenantId strategy, counter init, users/{uid} write lock, webhook idempotency, lowercase-email normalization). As of round-5 (2026-04-14), **R1 (Stripe status) and R2 (auth recovery) have also been folded into the main plan as schema + route-tree entries** — the implementation-detail narratives for those items are retained below as audit-trail breadcrumbs only. Round-5 also added 5 new items directly to the main plan: `userTenantMemberships` collection (was P7), Vercel Edge Config middleware caching, `customDomainStatus` verification UI, XSS-to-PDF escape rules, and immutable logo snapshots. This file now tracks the remaining RISK (R3, R4, R5, R6, R7, R8) and POLISH items — deferred work to be picked up during their relevant phases.

**How to use:** Skim RISK before starting each phase and pull the applicable items into that phase's PR. POLISH items can be bundled opportunistically.

**Confidence convention:** `[high]`, `[medium]`, `[speculative]`.

---

## RISK — Long-term headache, will bite in production but won't crash on day 1

### R1. Stripe Connect restricted-account state — ✅ FOLDED INTO MAIN PLAN (2026-04-14)

Schema (`meta.stripeStatus`) now lives in Phase 1 with defaults in `onSignup`. Implementation (webhook persistence, `payInvoice` preflight, `/billing` banner) is Phase 4 scope and is referenced inline there. This entry is kept only as an audit-trail breadcrumb — see `REBUILD_PLAN.md` Phase 1 meta schema + Phase 4 for the live version.

---

### R2. Password reset / email verification flow — ✅ FOLDED INTO MAIN PLAN (2026-04-14)

`/forgot-password` + `/auth/action` routes now live in the Phase 3 route tree. "Auth recovery flow" subsection in Phase 3 covers the `sendPasswordResetEmail` call, action-code dispatch, email-verification gate on the dashboard layout, Firebase email-template configuration, and authorized-domains requirements. 2FA remains deferred to post-launch. This entry is kept only as an audit-trail breadcrumb — see `REBUILD_PLAN.md` Phase 3.

---

### R3. `PDF_SERVICE_URL` will drift if Cloud Run service is recreated `[medium]`

**Where:** Phase 6 architecture, env var `PDF_SERVICE_URL=https://pdf-service-prod-abc123.a.run.app`.

**The bug:** Cloud Run service URLs include a hash that's stable across deploys of the same service name BUT changes if you delete and recreate the service, change region, or rename. The first time you do this on prod (and you will — every team does eventually), Vercel still points at the dead URL. PDF generation 404s for every tenant simultaneously.

**Fix:** Map a stable custom domain to the Cloud Run service.
```bash
gcloud beta run domain-mappings create \
  --service pdf-service-prod \
  --domain pdf.techflowsolutions.ca \
  --region us-central1
```
Then `PDF_SERVICE_URL=https://pdf.techflowsolutions.ca`. Survives service recreation. Same for staging (`pdf-staging.techflowsolutions.ca`) and dev (use the auto URL — it doesn't matter for dev).

---

### R4. No rate limiting anywhere `[medium]`

**Where:** Cloud Functions section, all callables. No mention of App Check, no per-uid rate limit, no Resend send-quota guard.

**Failure modes:**
- Buggy frontend retry loop calls `sendInvoiceEmail` 1000x in a minute → blasts your Resend free tier (3k/month) in seconds, leaves you unable to send for the rest of the month.
- Compromised tenant account scripted to call `previewInvoicePDF` 10/sec → spins up 10 Cloud Run instances, $50 GCP bill in an hour.
- Customer-facing magic link request (`sendSignInLinkToEmail` is client-side Firebase but the *create-invitation* email send is server-side) — no per-IP throttle.

**Fix — three layers, increasing investment:**

**1. App Check on all callables (free, ~1 hour setup):**
```typescript
export const sendInvoiceEmail = onCall(
  { enforceAppCheck: true },
  async (request) => { /* ... */ }
);
```
Blocks calls that don't originate from your verified Vercel app. Doesn't stop a determined attacker who's signed in, but kills 99% of casual abuse.

**2. Per-uid simple rate limit (a few hours):**
```typescript
async function rateLimit(uid: string, action: string, max: number, windowSec: number) {
  const ref = db.doc(`rateLimits/${uid}_${action}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() ?? { count: 0, windowStart: now };
    if (now - data.windowStart > windowSec * 1000) {
      tx.set(ref, { count: 1, windowStart: now });
    } else if (data.count >= max) {
      throw new HttpsError('resource-exhausted', `Rate limit: ${max} per ${windowSec}s`);
    } else {
      tx.update(ref, { count: data.count + 1 });
    }
  });
}

// In sendInvoiceEmail:
await rateLimit(request.auth.uid, 'sendEmail', 50, 3600); // 50/hour
```

**3. Resend has its own per-domain throttling.** Configure a sending limit alert on the Resend dashboard so you find out before you hit zero.

---

### R5. "Try both webhook secrets" is fragile — split the endpoints `[medium]`

**Where:** Phase 4 line 974: *"The handler must try both secrets or use separate endpoints."*

**The bug:** "try secret A in try/catch, then secret B" works but is ugly and slow (every wrong-secret attempt does a crypto op + throws). It also breaks Stripe's recommended pattern of "verify, then process" — you're verifying twice on every event.

**Fix:** two routes, two secrets, zero ambiguity:
```
/api/webhooks/stripe/platform  ← STRIPE_PLATFORM_WEBHOOK_SECRET
/api/webhooks/stripe/connect   ← STRIPE_CONNECT_WEBHOOK_SECRET
```
Both routes can call into a shared `routeStripeEvent(event)` after verification. Configure each in Stripe Dashboard with its own secret.

This also makes the security model explicit: a future dev grepping for "STRIPE_CONNECT_WEBHOOK_SECRET" finds exactly one route. With shared endpoints, the relationship is implicit and easy to break.

---

### R6. Node.js middleware: Admin SDK init not specified, Next version not pinned `[medium]`

**Where:** Phase 5 line 1122 — "Force Node.js runtime: add `export const config = { runtime: 'nodejs' };`"

**Two gaps:**

**(a) Firebase Admin SDK initialization in middleware.** Middleware runs on EVERY request to the portal. Naive `initializeApp()` per request leaks resources and is slow. Must be a module-level singleton:
```typescript
// middleware.ts
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = getApps()[0] ?? initializeApp({
  credential: cert({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const adminDb = getFirestore(app);

export async function middleware(req: NextRequest) { /* ... */ }
export const config = { runtime: 'nodejs' };
```
Note the `\\n` → `\n` replacement — Vercel stores private keys as escaped strings.

**(b) Next.js version pin.** Node.js runtime for middleware is stable from Next 15.2+. Earlier 15.x betas had it behind a flag. Pin in `package.json`:
```json
"next": "^15.2.0"
```
Add to Phase 5 deliverables.

---

### R7. `deletedAt` field with no rule enforcement `[medium]`

**Where:** Schema includes `deletedAt: null` on tenants/customers/invoices/quotes (lines 287, 297, 299, 301, 1042). UI is intentionally deferred. But security rules don't filter on it.

**The bug — inactive now, lit fuse for later:** when soft-delete UI is built (post-MVP), the dev will probably add `where('deletedAt', '==', null)` to client queries. That's the **client filtering data the rules already returned**. A user with the right URL/document ID can still read deleted records by going around the filter.

**Fix — pre-build the rule structure now while it's cheap:**
```
match /tenants/{tenantId}/invoices/{invoiceId} {
  allow read: if (
    // Tenant user OR matching customer — unchanged
    ...existing conditions...
  ) && resource.data.get('deletedAt', null) == null;
  // Or expose a separate path/role for "deleted invoices archive"
}
```

Actually, since soft-delete UI doesn't exist yet, the safer move is: **don't add the field until you build the feature**. It's cargo-cult prep. Remove `deletedAt: null` from the `onSignup` defaults and from the schema docs. Add it back when soft-delete is actually being implemented, with rules updated in the same PR. Less to forget about.

---

### R8. `getCustomerInvoices` query has no rate limit, no pagination contract `[low-medium]`

**Where:** Phase 2 line 624–640.

**Issue:** `db.collectionGroup('invoices').where('customer.email', '==', email).limit(100)` returns up to 100 invoices in one shot. A customer with 200 invoices across multiple tenants can never see invoices 101-200. No cursor/pagination.

Also: the function has no rate limit (covered by R4). Plus the function returns full invoice docs including `tenantSnapshot` (potentially several KB each × 100 = ~500KB response).

**Fix:**
```typescript
// Accept cursor + smaller default limit
const { cursor, limit = 25 } = request.data;
let q = db.collectionGroup('invoices')
  .where('customer.email', '==', email)
  .orderBy('createdAt', 'desc')
  .limit(Math.min(limit, 50));
if (cursor) q = q.startAfter(new Date(cursor));
const snap = await q.get();
return {
  invoices: snap.docs.map(d => ({
    id: d.id,
    path: d.ref.path,
    // Project only what the list view needs — drop tenantSnapshot here, fetch on detail
    customer: d.data().customer,
    amount: d.data().amount,
    status: d.data().status,
    createdAt: d.data().createdAt.toDate().toISOString(),
    tenantBranding: {  // minimal subset for list display
      name: d.data().tenantSnapshot.name,
      logoUrl: d.data().tenantSnapshot.logoUrl,
      primaryColor: d.data().tenantSnapshot.primaryColor,
    },
  })),
  nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].data().createdAt.toDate().toISOString() : null,
};
```

---

## POLISH — Minor, address opportunistically

### P1. PDF rendering with `logoUrl: null` will show broken-image icon `[medium]`

`onSignup` defaults `logoUrl: null`. If a tenant creates an invoice before uploading a logo, `tenantSnapshot.logoUrl` is null. PDF template should: `${snapshot.logoUrl ? `<img src="${snapshot.logoUrl}">` : `<div class="logo-placeholder">${snapshot.name}</div>`}`.

Add to Phase 6 porting checklist explicitly. Same for `faviconUrl` in the portal `<head>`.

### P2. `tenantSnapshot` should carry a version field

Add `version: 1` to every snapshot. Future-you adding a `timezone` field in 6 months will thank you when old invoices missing the field need a fallback path. Cost: 1 line in `createInvoice`.

### P3. Cloud Run `min-instances: 1` for prod from day one

Plan says "optional, costs a few dollars." It's $5-10/month and saves every customer's first-PDF-after-quiet-period from a 10s wait. For a portal whose differentiator is brand polish, the cold start is a worse experience than "it costs $10/month." Just turn it on.

### P4. Secret rotation runbook missing

Plan documents how to *set* secrets. Doesn't document how to *rotate* them. Add a one-page runbook:
- `PDF_SERVICE_API_KEY`: rotate by setting both old and new keys in Cloud Run env, redeploy Vercel with new key, remove old from Cloud Run.
- Stripe webhook secrets: handled in Stripe Dashboard, then update Vercel env, no downtime.
- Firebase Admin private key: rotate via Firebase Console, update Vercel, redeploy.
- Cadence: every 90 days for shared secrets, immediately on suspected exposure.

### P5. CSP / security headers not addressed

Next.js doesn't add a CSP by default. For a financial app embedding Stripe Checkout iframes, a `Content-Security-Policy` with `frame-src https://checkout.stripe.com` and `connect-src` for Firebase + your PDF domain is worth the hour. Add to a `next.config.ts` headers block. Not MVP-blocking.

### P6. `getCustomerQuotes` companion function not in the table

Plan lists `getCustomerInvoices`, `getCustomerInvoiceDetail`, `payInvoice`, `downloadInvoicePDF`. The portal route group includes `quotes/[id]/page.tsx`, but no `getCustomerQuotes` is listed. Either add it explicitly to the Phase 2 table or make the spec say "same pattern, mirror for quotes." Currently a TODO that's silent.

### P7. One-user-one-tenant — ✅ PROMOTED TO PHASE 1 SCHEMA (2026-04-14)

The `userTenantMemberships/{uid}_{tenantId}` collection is now part of the Phase 1 schema in `REBUILD_PLAN.md`. MVP still enforces one active tenant per user (the JWT claim only points at one), but the schema supports multi-tenant memberships from day one, so post-MVP this becomes a UI change ("switch active tenant") instead of a schema migration. `onSignup` and `onAcceptInvite` both write membership records. This entry kept as audit-trail breadcrumb only.

### P8. Multi-project secret push helper

15 secrets × 3 projects = 15 `firebase functions:secrets:set` invocations on key rotation. Write `scripts/push-secrets.sh`:
```bash
#!/usr/bin/env bash
# Usage: ./push-secrets.sh techflow-prod
set -euo pipefail
PROJECT="$1"
SECRETS_FILE=".secrets.${PROJECT}.json"  # gitignored
for key in $(jq -r 'keys[]' "$SECRETS_FILE"); do
  value=$(jq -r --arg k "$key" '.[$k]' "$SECRETS_FILE")
  echo "$value" | firebase functions:secrets:set "$key" --project "$PROJECT" --data-file -
done
```
Saves 10 minutes every rotation. Add `.secrets.*.json` to `.gitignore` immediately.

### P9. Test matrix has no concurrency / load test

Phase 7 tests happy-path single-user flows. No test for: 10 invoices created in a burst (counter race), recurring invoice processor with 50 due tenants simultaneously, two staff members editing the same invoice. Not MVP-blocking but worth adding "smoke load test" before first onboarding (e.g. `npx autocannon -c 10 -d 30 /api/...`).

### P10. Email typo by contractor → invoice never reachable

If the contractor types `alice@exampl.com` (typo), there's no feedback loop. Customer never receives, customer never logs in. Contractor sees "sent." Worth adding: `sendInvoiceEmail` could mark the invoice with `lastEmailStatus: 'sent' | 'bounced' | 'complained'` based on Resend webhook events, surfaced in the dashboard. Out of scope for MVP but trivial to add later — note in the plan as a future improvement.

### P11. Second-tab stale token after invite acceptance

Edge case: invitee accepts in tab A, has tab B open, tab B's token is stale for up to 60 min. Acceptable for MVP. Solution if it ever matters: Firestore listener on `users/{uid}` that triggers `getIdToken(true)` on change.

### P12. Magic link `email_verified` for existing password accounts — needs explicit test

If a customer happens to have an existing Firebase Auth account from a different context (signed up with password elsewhere, never verified), `signInWithEmailLink` may or may not flip `email_verified` to true depending on the auth provider state. **Add a Phase 7 test:** create a Firebase Auth user with `email_verified: false`, then run them through the magic-link flow, confirm they get portal access. If they don't, you have a known segment of users who silently can't use the portal.

### P13. Sentry free tier will burn fast at 50 tenants

5k events/month is ~3 errors per tenant per month. One noisy bug or one runaway loop blows it. Set up Sentry's quota alerting on day one (free) so you don't discover at the end of the month that you've been blind for two weeks. Budget for paid tier ($26/mo) by month 2 of real usage.

### P14. Customer portal list shows 100 docs unbounded

Covered in R8 — pagination missing. Listed here as polish because for the first year a customer probably has <10 invoices, but the bug is real.

---

## Recommended action order (RISK/POLISH only — CRITICAL already folded in, R1/R2 folded in 2026-04-14)

1. **Phase 2** — R4 (App Check) and R5 (split webhook endpoints) alongside the webhook handler. R8 (pagination) when `getCustomerInvoices` is written.
2. **Phase 3** — R7 (drop the premature `deletedAt` field) as a schema cleanup. (R2 auth recovery is now in the main plan as a Phase 3 deliverable.)
3. **Phase 4** — R1 webhook handler + preflight + banner implementation (schema already in Phase 1 meta).
4. **Phase 5** — R6 (middleware Admin SDK singleton + Next 15.2 pin — note: largely obsolete now that middleware reads from Vercel Edge Config per Phase 5 cache spec; still applicable to the Firestore fallback path).
5. **Phase 6** — R3 (PDF Cloud Run custom domain), P1 (logo null fallback — note: partially obsolete now that logo is base64-inlined at snapshot time), P2 (`tenantSnapshot.version`).
6. **Polish items** — fold into the relevant phase's PR, no separate cleanup pass.

---

## Things the round-3 audit checked and did NOT flag

For transparency, here's what was looked at hard and decided was fine:

- **TenantSnapshot frozen-document model.** Architecturally sound.
- **Custom domain middleware → branded login via RSC + Admin SDK.** Correct (only gap was R6).
- **Cloud Run vs Vercel for PDF.** Decision, microservice split, and auth model (API key + upstream Firebase verification at proxy) all correct.
- **Backup strategy.** PITR + daily exports + manual snapshots is appropriate. The "test the restore" mandate is the most important line in the section.
- **`onSignup` as callable, not Auth trigger.** Race condition correctly identified and fixed.
- **Firebase Auth claims propagation delay (`getIdToken(true)`).** Correctly handled in plan.
- **`stripeAccounts/{accountId}` reverse lookup.** Right call vs `collectionGroup('meta')`.

---

## Audit confidence summary (remaining items, post-round-5)

- **High confidence**: R5
- **Medium confidence**: R3, R4, R6, R7
- **Lower confidence / speculative**: P10 (email typo UX), P12 (magic link + existing accounts — may already work, needs test)

Remaining total: 6 RISK (R3, R4, R5, R6, R7, R8), 13 POLISH (P1–P6, P8–P14 — P7 promoted to Phase 1 schema).
(6 CRITICAL from round 3 + R1/R2 from round 3 + P7 from round 3 have all been folded into `REBUILD_PLAN.md`.)
