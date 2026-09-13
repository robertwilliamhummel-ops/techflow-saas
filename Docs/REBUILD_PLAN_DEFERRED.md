# REBUILD_PLAN — Deferred Work Tracker

**Origin:** Round 3 "Zero-Mercy" audit of `Docs/REBUILD_PLAN.md`, dated 2026-04-13 (Opus 4.6), with later folds noted per item.
**Role:** rationale and audit log only — never add new features here (CLAUDE.md). Current build status, open bugs, and decisions D1–D5 live in `REBUILD_PLAN.md` → "Build Status, Decisions & Conventions". The plan's planning history was moved to the appendix at the end of this file on 2026-09-13.

**Confidence convention:** `[high]`, `[medium]`, `[speculative]`.

## Item status (reconciled with code 2026-09-13)

| Item | Status |
|---|---|
| R1 Stripe restricted-account state | Done — `meta.stripeStatus`, written by `completeConnectOnboarding` and `account.updated` on the Connect webhook |
| R2 Password reset / email verification | Done — `/forgot-password`, `/auth/action`, `/verify-email` |
| R3 `PDF_SERVICE_URL` drift | Superseded — Cloud Run domain mappings aren't offered in `northamerica-northeast2` (D2); the deterministic `*.run.app` URL survives service recreation (REBUILD_PLAN Deploy Runbook) |
| R4 Rate limiting / App Check | Open — only the pay-attempt limit (10 per invoice per 24h) exists |
| R5 Split webhook endpoints | Done — `/api/webhooks/stripe/platform` and `/connect` with separate secrets; event scopes corrected by D1 |
| R6 Middleware Admin SDK singleton + Next version | Done — `src/proxy.ts` (module singleton; the Next 16 proxy is Node-only), Next 16.3.5; A-01 fixed 2026-09-13 |
| R7 `deletedAt` without rule enforcement | Open — `deletedAt: null` is still written on meta and memberships; rules don't filter on it |
| R8 Portal pagination / projection | Partial — list rows are projected (logo URL, never base64) and drafts are excluded (A-05); capped at 100 rows, no client-facing cursor yet |
| P1 Null logo in PDF | Done — templates show the tenant name when `logo` is null |
| P2 `tenantSnapshot.version` | Done (`version: 1`) |
| P3 Cloud Run `min-instances: 1` in prod | Deploy Runbook item |
| P4 Secret rotation runbook | Done — REBUILD_PLAN Deploy Runbook → Secret rotation |
| P5 CSP / security headers | Partial — `/pay/*` privacy headers and the PDF render CSP; no site-wide CSP |
| P6 `getCustomerQuotes` | Done 2026-09-13 — `getCustomerQuotes` + `getCustomerQuoteDetail`, same visibility rules as invoices; REBUILD_PLAN function inventory |
| P7 Multi-tenant memberships | Done — `userTenantMemberships` |
| P8 Multi-project secret push helper | Open |
| P9 Concurrency / load test | Open |
| P10 Email typo → invoice never reachable | Done — D5 `sesEventsWebhook` records `lastEmailStatus` |
| P11 Second-tab stale token | Accepted for MVP |
| P12 Magic link for unverified password accounts | Open — customer magic link isn't built yet |
| P13 Sentry quota | Deploy Runbook item; Next.js Sentry loads from `src/instrumentation*.ts` once a DSN is set |
| P14 Portal list unbounded | Same as R8 |

The per-item narratives below are the original audit text, kept for rationale. Code samples in them (Resend, Express, `us-central1`, `tenants/{id}/meta`) predate the build — see the status table and REBUILD_PLAN for what is current.

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

---

## Appendix — Planning history (moved from REBUILD_PLAN.md on 2026-09-13)

These sections record how the plan was made in April 2026 — timeline estimates, the planning session notes, and the plan revision log. They are superseded wherever they conflict with REBUILD_PLAN.md → "Build Status, Decisions & Conventions". Heading levels were demoted one step.

### Timeline Summary

| Phase | Work | Estimated |
|---|---|---|
| 0 | Decisions & Puppeteer test | Done (except Puppeteer test) |
| 1 | Data model, rules, auth claims, **backup setup** | 5–7 days |
| 2 | Cloud Functions (with feature gates, customer-facing, convertQuoteToInvoice) | 4–6 days |
| 3 | Frontend scaffolding + TenantProvider + gating + customer portal shell + **Sentry** | 5–7 days |
| 4 | Stripe Connect Express (tenant-initiated + customer-initiated pay) + dual webhooks + **stripeAccounts reverse lookup** | 5–7 days |
| 5 | Onboarding flow + settings + custom domains + branded login + **staff invitation flow** | 6–8 days |
| 6 | PDF generation (Cloud Run port + Next.js proxy with dual auth) | 3–4 days |
| 7 | Testing + backup restore drill + first onboarding + **customer portal e2e** | 4–6 days |
| **Total** | | **~8–10 weeks** focused solo-dev work, +30–50% buffer for life |

**Increase over prior estimate:** ~1 week added for the customer portal (routes + context + customer-facing functions + portal UI), backup setup, and convertQuoteToInvoice. Additional ~2–3 days for custom domain provisioning + branded login middleware (added 2026-04-12). Magic link flow spec, dual Stripe webhooks, claims propagation handling, customer e2e test matrix, and environment strategy added 2026-04-12 (from Sonnet audit) — no additional time since these are specifications of work already estimated, not new features.

**Revision 2026-04-12 (deep audit round 2, Sonnet 4.5 + Gemini):**
- +1 day Phase 5 for staff invitation flow (new callable functions, new routes, test coverage)
- +0.5 day Phase 3 for Sentry setup across Next.js + Cloud Functions
- No net timeline change from the critical fixes (missing meta defaults, SSR branded login, Edge-runtime middleware decision, stripeAccounts reverse lookup, getDownloadURL logo upload) — they're corrections to existing work, not new scope.
- Deferred from this revision: optimistic locking (not MVP-critical at 1–3 staff per tenant), GDPR account-deletion function (not blocking launch), platform billing for Reggie (zero clients today, build when needed).

### Immediate Next Steps (in order)

1. **Provision new Firebase project** (`techflow-dev`) for the rebuild. Keep the old one running untouched as a reference.
2. **Create new Next.js repo** — scaffold with App Router, Tailwind, TypeScript, Firebase client + admin SDKs, base folder structure from the Phase 3 tree above.
3. **Deploy "hello world" to Vercel** on a fresh project to confirm the deploy pipeline before writing real code.
4. **Port the Cloud Run `pdf-service`** from the old repo to a new Cloud Run service (`pdf-service-dev`). Add API key auth. Verify it renders a test invoice end-to-end. This can run in parallel with Phase 1.
5. **Start Phase 1** — schema docs, rules, auth claim helpers, platform admin user.

Execution on Phase 1 can start immediately — the Puppeteer/Vercel evaluation has been resolved (Cloud Run is locked).

### Open Questions (answer before Phase 1)

1. **(RESOLVED — see "Decisions Required Before Phase 1" above)** Domain strategy for generic portal URL.
2. **(MOVED to "Decisions Required Before Phase 1" — item #3)** Transactional email provider (Zoho vs Resend/Postmark). Blocks Phase 2, not a "later" question.
3. **Invoice number format.** Currently `TF-2026-0001` branded to TechFlow. Per-tenant, should it default to generic `INV-0001` with a configurable prefix in tenant meta? (Leaning: yes, `meta.invoicePrefix` defaults to first 3 letters of business name.)
4. **Logo storage.** Firebase Storage or Vercel Blob? Firebase Storage fits the existing stack. Vercel Blob would centralize assets on Vercel. (Leaning: Firebase Storage for now — one less moving part.)
5. **Font loading for custom fontFamily.** If a tenant sets `fontFamily: "DM Sans"`, need to decide: Google Fonts at runtime (easy, external dependency) vs self-hosted font files in Firebase Storage (slower setup, no external call). Leaning: Google Fonts for MVP.

### Context — what we built and decided today

#### What was completed
- **Phase 3 Bundle 2 (form spacing + CSS cleanup)** on the current Vite codebase. Commits `e49068a`, `5d3566b`, `8ef2002`. Intended to be the last commits on the old repo — but see "what was NOT completed" below.
- Root-caused and fixed the `.form-group { margin: 0 }` leak from ServiceCalculator that had been silently breaking CustomerSection spacing across both Invoice and Quote routes.
- Collapsed triple-duplicated form primitives (`.form-card`, `.card-title`, `.form-label`, `.form-input`, `.form-select`) into a single source of truth in CustomerSection.css. Net −97 lines, −170 bytes shipped CSS.
- Reviewed the architectural options and decided: rebuild once, into the final stack, multi-tenant from day one. No intermediate Vite multi-tenant step.
- Locked all Phase 0 decisions (nested schema, implicit routing, Stripe Connect, feature flags).
- Added feature flags / entitlements to the plan as a Phase 0 decision before starting any code.
- Produced the Puppeteer + Vercel definitive answer with test harness, ready to run on the existing marketing site.
- Wrote this document so none of it gets lost when the session compacts.

#### What was NOT completed (important)
- **Bundle 3 Cloud Functions auth-check fixes (issues 5.1–5.6) were NOT done.** They were referenced multiple times as "next up" but the conversation pivoted to the rebuild planning before any Cloud Functions code was touched. See the "Outstanding Security Debt" section near the top of this document for full details and the Path A / Path B decision that needs to be made.
- **Puppeteer test on Vercel was cancelled** (2026-04-12). Cloud Run is now the locked PDF path. See "PDF Generation Strategy" section for rationale. No longer a blocking item.
- **No code was written on the rebuild itself.** This session produced decisions and a plan document only. Phase 1 execution has not started.

#### Commits produced this session (old Vite repo)
| SHA | Scope |
|---|---|
| `5d3566b` | refactor: scope .form-group margin rule, remove ServiceCalculator leak |
| `8ef2002` | refactor: collapse duplicated form primitives into CustomerSection.css |

Both commits are CSS-only. No backend, no security, no functional changes.

#### Plan revisions after initial draft
1. **Path A decision locked** — skip security patch on old repo, shut down at rebuild launch.
2. **Customer portal added as a cross-cutting requirement** — homeowners being invoiced authenticate via magic link, have no `tenantId` claim, read via email-match rule pattern. Denormalized `tenantSnapshot` on each invoice/quote so customers never read `meta`. New `/portal` route group, new `CustomerPortalContext`, new customer-facing Cloud Functions (`getCustomerInvoices`, `getCustomerInvoiceDetail`, `payInvoice`, `downloadInvoicePDF`). Affects Phase 1, 2, 3, 4, and 6.
3. **Tenant meta schema expanded** — added `primaryColor`, `secondaryColor`, `taxRate`, `taxName`, `businessNumber`, `invoicePrefix`, `emailFooter`, `currency`. These fields are also what gets denormalized into `tenantSnapshot`.
4. **`convertQuoteToInvoice` added to Phase 2** — transactional quote → invoice conversion, gated on both `quotes` and `invoices` features, carries fresh `tenantSnapshot` and source-quote backreference.
5. **Firestore backup strategy added as its own section** — PITR + daily managed exports (30-day retention) + manual-snapshot-before-risky-deploy convention. Mandatory restore drill before first client onboarding. Estimated ~$10/month total cost.
6. **Timeline updated** — ~7–9 weeks (was ~6–8 weeks) to absorb customer portal and backup setup.
7. **PDF strategy locked to Cloud Run 2026-04-12.** The previously-planned Puppeteer-on-Vercel evaluation is cancelled. Cloud Run is now the canonical PDF path — dedicated microservice, full Chrome in Docker, API key auth, called from thin Next.js proxy routes that do the Firebase dual-auth check. Rationale: the old repo's Cloud Run PDF service already works and can be ported; full Chrome avoids the `@sparticuz/chromium` version-pinning fragility; 2–32 GB RAM headroom vs Vercel's ~3 GB; clean microservice separation keeps Vercel function concurrency available for user-facing routes. The "Puppeteer + Vercel — Definitive Answer" section was removed; replaced with a short "PDF Generation Strategy" section documenting the Cloud Run service shape, Dockerfile, env vars, and proxy auth model. Phase 6 rewritten around the porting checklist. Immediate Next Steps no longer gates Phase 1 on a Puppeteer test.
8. **Deep audit round 2 applied 2026-04-12** (Sonnet 4.5 + Gemini). Critical fixes: six missing meta defaults (`taxRate`, `taxName`, `currency`, `invoicePrefix`, `businessNumber`, `emailFooter`) added to `onSignup` batch write — prevents first-invoice tenantSnapshot corruption. Branded login page mandated to be server-side via Admin SDK (Firestore rules block unauthenticated reads of `meta`). Edge-runtime vs Node-runtime decision documented for the custom-domain middleware (Firebase Admin SDK requires Node — default recommendation `runtime: 'nodejs'`). `stripeAccounts/{stripeAccountId} → {tenantId}` reverse lookup collection added — replaces fragile `collectionGroup('meta')` query in Stripe webhook. Logo upload MUST use `getDownloadURL()` and store the token-bearing public URL in `meta.logoUrl`, never the Storage path. Medium/minor: `logo` → `logoUrl` standardized throughout, Cloud Functions env var / secrets subsection added (parallel to Vercel env vars, not replaced by them), Cloud Functions per-project deploy process documented, `customDomain` added to canonical feature flag table, customer auth path cases added to PDF test matrix, `/portal/view` shorthand resolved to canonical `/portal/invoices/[id]` route. New scope: staff invitation flow in Phase 5 (`invitations` subcollection, `createInvitation` + `onAcceptInvite` callables, `/settings/team` + `/accept-invite` routes, 7-day token expiry, one-time use, email-match verification). Transactional email provider moved from Open Questions to Decisions Required Before Phase 1 — recommendation Resend over Zoho to avoid multi-tenant reputation risk. Sentry added to Phase 3 with per-environment projects and `tenantId`/`uid` tagging. `deletedAt: null` field added to tenant meta and invoices/quotes/customers schemas so future soft-delete work is non-breaking (UI intentionally deferred). Explicitly deferred: optimistic locking, GDPR deletion function, platform billing for Reggie.
9. **Deep audit round 3 applied 2026-04-13** (Opus 4.6 zero-mercy pass — see `REBUILD_PLAN_DEFERRED.md` for full findings). Five pre-Phase-1 CRITICAL fixes applied directly to this plan: **C1** — invoice/quote/users writes locked to admin SDK only (`allow write: if false`); all mutations now flow through `createInvoice`/`updateInvoice`/`deleteInvoice`/`markInvoicePaid` callables (and quote equivalents) that snapshot branding server-side and recompute totals, eliminating client-side `tenantSnapshot`/tax/total tampering. **C2** — customer email case-sensitivity bug fixed: emails lowercased at every write boundary in Cloud Functions, security rules call `request.auth.token.email.lower()` before comparing, `getCustomerInvoices` lowercases auth email before query. **C4** — `tenantId` generation strategy specified: slug-with-collision-suffix inside a transaction, produces stable human-readable IDs and prevents simultaneous-signup races. **C5** — counter docs (`invoiceCounter`, `quoteCounter`) initialized in the `onSignup` batch so first-invoice transactions don't crash on a missing doc. **C6** — `users/{uid}` write rule locked to admin SDK only (was `if request.auth.uid == uid`); all profile mutations go through callables to prevent self-spoofing of `tenantId`/`role` fields. Also added: `markInvoicePaid` and `updateUserProfile` callables to Phase 2 inventory; `tenantSnapshot.version: 1` field in invoice creation (P2 polish); concrete invoice CRUD pattern documented in Phase 2. RISK and POLISH items from the audit are tracked in `REBUILD_PLAN_DEFERRED.md` and will be applied during their relevant phases (R1 Stripe restricted-account state in Phase 4; R2 password reset / email verification in Phase 5; R3 Cloud Run custom domain in Phase 6 deploy; R4 App Check + rate limits and R5 split webhook endpoints in Phase 2/4; etc.).

10. **Phase 1.5 — Design System added 2026-04-13** (Opus 4.6 + Sonnet 4.6 + Gemini joint review). New phase inserted between Phase 1 and Phase 2 to lock the visual foundation before any UI work begins. Decisions: shadcn/ui as the platform component library (Radix + Tailwind, copy-paste ownership in `src/components/ui/`); scoped scaffold of 14 components covering Phase 2/3 needs (Button, Input, Label, Textarea, Form, Card, Dialog, AlertDialog, Select, Checkbox, RadioGroup, Badge, Alert, Sonner, Table, DropdownMenu, Tabs, Skeleton, Separator); semantic CSS-variable token system with `--success` and `--warning` added beyond stock shadcn; tenant override scope **locked to `--primary` and `--secondary` only** (every other token platform-controlled to prevent semantic colors getting overridden into wrong meanings); two-layer contrast guard (WCAG AA validation at signup/settings + computed `--primary-foreground` fallback at render); dark/light mode strategy decided as no-toggle (dashboard=dark, portal=light, PDFs=light); Inter as platform font with curated Google-fonts list for tenant `fontFamily` override on customer-facing surfaces only; Sonner as the single platform-wide toast (eliminates current Vite app's dual `cs-toast`/`inv-toast` pattern); canonical status→Badge-variant mapping centralized in `src/lib/invoices/statusBadge.ts`; composition rule that domain components compose ui primitives and never reach for raw HTML form elements or hex color utilities. Why this was missed in rounds 1–3: every prior audit focused on security, architecture, and data integrity — visual design system isn't a "bug" but is critical for the premium bundled-website + portal pitch to contractors. Estimated effort 2 days.

13. **Deep audit round 4 applied 2026-04-13** (Opus 4.6 delta audit + Gemini joint synthesis — scoped to revisions 10, 11, 12 per the "Round 4 Delta" prompt). Three CRITICAL fixes: **C1** — zombie `payInvoice` callable removed from the function inventory and replaced with a note that `createPayTokenCheckoutSession` is the single canonical payment path for email link, portal "Pay Now," and manual-link flows alike; customer-path description updated to reflect the portal discovers the `payToken` via `getCustomerInvoiceDetail` and redirects to `/pay/{token}` rather than creating a parallel Stripe session. **C2** — regenerate-during-checkout race condition closed: `session.metadata.payTokenVersion` now stamped at Checkout creation; webhook handler for `checkout.session.completed` re-verifies version against current invoice and, on mismatch, refuses to mark paid, issues an automatic full refund via `stripe.refunds.create`, writes a `paymentIncidents` audit doc, and notifies the tenant owner. Rationale: `regenerateInvoicePayLink` intent is "kill old link" — silently accepting a payment on a killed link violates that intent. Handling the guard in the webhook (not `regenerate`) correctly covers the customer-mid-checkout case. **C3** — pay-route privacy headers mandated: `Referrer-Policy: no-referrer` (prevents token leak via outbound-link Referer headers), `X-Robots-Tag: noindex, nofollow` (prevents accidental search indexing of shared tokens), `X-Frame-Options: DENY` (prevents iframe-overlay phishing). Five RISK mitigations: **R1** — webhook routing gains `charge.refunded` (sets `status: 'refunded'` or `'partially-refunded'`, records `refundedAmountCents`), `charge.dispute.created` (sets `disputed: true`, `disputeReason`, notifies tenant with evidence deadline), and `charge.dispute.closed` (routes to `refunded` on loss, clears `disputed` flag on win). Invoice schema gains `stripeChargeId`, `refundedAt`, `refundedAmountCents`, `disputed`, `disputedAt`, `disputeReason`, `disputeOutcome` fields; `status` enum gains `'refunded'` and `'partially-refunded'`. **R2** — `payAttempts` subcollection gets an `expireAt` field and a Firestore TTL policy (48h) for auto-cleanup; prevents orphan-doc accumulation at scale. **R3** — `middleware.ts` gains a `config.matcher` that excludes `_next/static`, `_next/image`, `favicon.ico`, `robots.txt`, `sitemap.xml`, `/api/*`, and any path with a file extension; without the matcher, custom-domain requests trigger a Firestore read per static asset (≈20× amplification per page view at 50+ tenants). **R4** — `functions/emails/sanitize.ts` utility strips control characters (CR/LF for header injection, NUL, other non-tab C0 bytes), collapses whitespace, and length-caps tenant-controlled strings (`name` 100, `address` 300, `emailFooter` 500, `replyTo` 200 with separate email-format validation); enforced at `emails/send.ts` boundary; hard convention of no `dangerouslySetInnerHTML` anywhere in `functions/emails/`. **R5** — Payment Settings "live preview" row rewritten to show the honest 3-line breakdown (customer pays / Stripe fee / tenant net) so tenants aren't surprised by the residual 0.5% + 30¢ that surcharging can't recover; e-transfer shown alongside for comparison. Three POLISH refinements: **P1+P4** — `verifyInvoicePayToken` now returns a discriminated-union `VerifyResult` (`ok | paid | refunded | regenerated | not-available`) instead of throwing `HttpsError` on legitimate render states; pay page branches on `outcome`; success-page polling no longer string-matches on error messages; a `PAYABLE_STATUSES` allow-list (`sent | unpaid | overdue | partial`) blocks draft or archived invoices from being payable even if a tenant accidentally shared a pay link for one. **P2** — each email template now exports a `buildPreviewText(props)` function returning 80–110 char inbox-scanning copy (spec'd for InvoiceSent, PaymentReceipt, MagicLinkSignIn, StaffInvite, QuoteSent, RecurringInvoiceSent); passed to `<TenantEmailLayout>` as the `preview` prop. **P3** — formally documented that JWT `exp` claim is the **authoritative** expiry for pay tokens; the Firestore `payTokenExpiresAt` field is display-only (used for dashboard "expires in N days" copy and `regenerateInvoicePayLink` CTAs). **Total impact:** ~340 lines added across Phase 1 (schema), Phase 2 (callables + webhook), Phase 3 (pay-route layout), Phase 4 (Stripe webhook + surcharge metadata), Phase 5 (payment settings preview + middleware config). No existing decisions reversed. Round 4 findings treated as one comprehensive pass rather than split across phases because the items are tightly interlocking (C2 stamps metadata that the webhook R1 extension reads; P1 return shape is consumed by C3-protected pay route). **Audit cycle now closed** — future audits should wait for actual Phase 1 code, not more plan revisions.

12. **Pre-Phase-1 decisions locked 2026-04-13** (Opus 4.6 + Gemini joint). **Decision #1 — Vercel project layout:** Option A, single project for marketing + portal + pay pages with middleware-based host routing. Rejected the plan's original Option B recommendation (separate projects) — middleware cost is small, single project keeps CI/CD and shared utilities (brand contrast, tenant resolver) in one place, early-return in middleware for known marketing hostnames mitigates per-request overhead. **Decision #2 — Transactional email provider:** Resend. Chosen over Zoho to avoid multi-tenant reputation risk, and chosen over Postmark for the native React Email pairing — templates become JSX components sharing the Phase 1.5 design tokens, so visual parity between emails and the portal is enforced at the component level. Free tier (3k/month) covers MVP. Phase 1 execution is now unblocked.

11. **Payment flow, email system, and portal metadata added 2026-04-13** (Opus 4.6 + Sonnet 4.6 + Gemini joint review — batch edit after Phase 1.5 landed). Five cross-phase additions touching Phase 1, 2, 3, 4, 5, and 6: **(a) Invoice pay-link flow** — signed JWT `payToken` + `payTokenExpiresAt` + `payTokenVersion` fields added to invoice docs (Phase 1); `verifyInvoicePayToken` and `createPayTokenCheckoutSession` callables added to function inventory (Phase 2); public `(pay)/pay/[token]/page.tsx` route added with success/cancelled redirect targets (Phase 3); token-authenticated Checkout with rate limit (10 sessions/invoice/24h) and `PAY_TOKEN_SECRET` via `defineSecret()` (Phase 4); `regenerateInvoicePayLink` callable for owner/admin invalidation. Kills the 4-click magic-link-to-pay friction — customers now go email → pay page → done. **(b) React Email + Resend transactional email system** — `functions/emails/` package with `<TenantEmailLayout>` shared shell (max-logo 200×60px, color-scheme meta tags for dark-mode inversion prevention), 6 templates (InvoiceSent, PaymentReceipt, MagicLinkSignIn, StaffInvite, QuoteSent, RecurringInvoiceSent), 9 design principles enforced (single-column 600px, one CTA, system fonts only, tenant primaryColor on CTA button only with `computeForeground()` contrast guard from Phase 1.5, platform-domain From + tenant-email Reply-To, plain-text fallback, no unsubscribe on transactional, no multi-column, no web fonts). Eliminates the email-side equivalent of the old Vite app's dual `cs-toast`/`inv-toast` pattern. **(c) Portal + pay-page metadata injection** — `generateMetadata()` in `(portal)/layout.tsx` and `(pay)/pay/[token]/layout.tsx` reads `meta.faviconUrl` and `meta.name` via Admin SDK (Firestore rules block unauthenticated meta reads, same pattern as branded login page) so browser tab shows tenant favicon + name on custom domains; Open Graph images for social-share rendering of pay links; explicit `runtime: 'nodejs'` to prevent Vercel Edge auto-optimization breaking Admin SDK. **(d) E-Transfer as primary payment method** — `meta.etransferEmail` field added (Phase 1); pay page lists e-transfer first with copy-details button and $3k bank-limit tooltip, credit card second with surcharge disclosure; PDF includes both methods with QR code for credit card (self-contained via `qrcode` npm package — no external image fetch at render); dashboard warns tenant if sending without e-transfer configured; `createInvoice` blocks send if BOTH e-transfer AND Stripe Connect are unconfigured. **(e) Credit card surcharge toggle with Canadian compliance** — `chargeCustomerCardFees` boolean + `cardFeePercent` (default 2.4, HARD-CAPPED server-side at 2.4 — the Visa/Mastercard Canadian ceiling) + `surchargeAcknowledgedAt` timestamp added to meta (Phase 1); `updatePaymentSettings` callable refuses to enable surcharging without acknowledgment (defensive — can't bypass UI by calling API directly); `/settings/payments` sub-page with toggle + percentage input + live preview + one-time acknowledgment modal covering 30-day Visa/Mastercard notification requirement, Quebec exclusion (Consumer Protection Act), debit-card exclusion, 2.4% cap, and automatic disclosure; Checkout line-item pattern that adds the surcharge as a separate item (not rolled into invoice total — preserves accounting clarity); webhook reconciliation stores `paidAmountCents` + `surchargeAmountCents` split on the invoice doc; PDF receipt shows surcharge as separate line when paid by card. MVP limitations documented: Quebec geo-exclusion is contractual (tenant acknowledgment) not auto-enforced; debit-vs-credit distinction limited by Stripe Checkout — acceptable MVP risk. **Total added:** ~520 lines across 6 phases, one shared secret (`PAY_TOKEN_SECRET`), 5 new callables, 1 new route group, 6 new email templates, 1 new settings sub-page. No existing content modified except field additions to tenant meta and invoice doc schemas. Estimated incremental effort 2–2.5 days across the phases.

14. **Deep audit round 5 applied 2026-04-14** (Gemini + Opus 4.6 joint synthesis — final logical-gap pass before Phase 1 code begins, plus doc-boundary cleanup between `REBUILD_PLAN.md` and `REBUILD_PLAN_DEFERRED.md`). Seven fixes applied directly to the main plan, all landing in the phases they affect rather than being parked in the deferred audit trail: **(1) Stripe account state schema** — `meta.stripeStatus` object added to Phase 1 (`chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`, `currentlyDue[]`, `disabledReason`, `updatedAt`); `onSignup` batch seeds all-`false` defaults; Phase 4 `account.updated` webhook is the sole writer; `createInvoice` refuses to send if `stripeStatus.chargesEnabled === false` AND no `etransferEmail` configured. Closes the "Stripe Express restricted-account silent failure" risk — tenants can no longer send pay-enabled invoices that Stripe will reject at checkout. Replaces R1 breadcrumb in DEFERRED. **(2) `userTenantMemberships/{uid}_{tenantId}` collection promoted from deferred P7 to Phase 1 schema** — `users/{uid}` narrowed to `{primaryTenantId, email}`; new membership docs (`{uid, tenantId, role, invitedBy, createdAt, deletedAt}`) written in both `onSignup` batch and `onAcceptInvite` callable so multi-tenant membership is a UI problem post-MVP, not a migration. MVP still rejects second-tenant joins at the rule layer; schema just stops fighting the inevitable. **(3) Auth recovery flow** — `/forgot-password/page.tsx` and `/auth/action/page.tsx` added to the Phase 3 route tree under `(auth)/`; dedicated "Auth recovery flow" subsection covers `sendPasswordResetEmail`, Firebase action-code dispatch by `mode` (`resetPassword` → `confirmPasswordReset`, `verifyEmail` → `applyActionCode`, `recoverEmail` → `checkActionCode`+`applyActionCode`), email-verification gate on dashboard layout, Firebase console email-template configuration (branded sender name, custom action URL pointing at `/auth/action`), authorized-domains list including every custom domain, and explicit MVP deferral of 2FA. Replaces R2 breadcrumb in DEFERRED. **(4) Vercel Edge Config caching for custom-domain lookups** — Phase 5 middleware gains a "Cache the domain lookup" subsection: the domain-verification Cloud Function writes `{[domain]: tenantId}` to Edge Config as the 4th atomic step (alongside `meta.customDomain`, `customDomains/{domain}`, and DNS verification marker); middleware reads via `@vercel/edge-config` for sub-50ms edge lookups; miss path falls back to Firestore and repopulates the cache. Promoted from the deferred R6 "middleware init pattern" fix because Edge Config solves both the cold-start cost AND the cross-request caching problem in one mechanism. **(5) Custom-domain verification state surfaced in `/settings/domain`** — `meta.customDomainStatus` object (`stage: 'pending-dns' | 'pending-ssl' | 'verified' | 'error'`, `message`, `checkedAt`) added to Phase 1; Phase 5 gains a state-machine walkthrough, scheduled re-check Cloud Function, and UI banner showing the current stage so tenants aren't staring at a silent failure for hours. **(6) XSS-to-PDF escape rules in Phase 6** — highest-severity finding of the round. New "⚠️ XSS-to-PDF" subsection mandates: auto-escaping template engine (Handlebars `{{}}` not `{{{}}}`, or React Email–style JSX); every user-controlled string (invoice line items, customer name/address, tenant name/address/emailFooter, notes) escaped at render; `logoUrl` validated as `https://` before template interpolation; CSP header `default-src 'none'; img-src data: https:;` on the render HTML; Phase 7 fuzz test feeding `<script>`, `javascript:`, `<img onerror>`, and `"><svg>` payloads into every field and asserting the rendered PDF contains no executed script and no broken layout. Puppeteer is a full Chromium — an unescaped `</style><script>` in a customer name means arbitrary JS runs in the render context. Not theoretical. **(7) Immutable logo snapshot via base64 data URL** — Phase 6 gains "Immutable logo snapshot" subsection with Option A (recommended: base64-encode `meta.logoUrl` at invoice creation, store on the invoice doc as `logo` data URL, 500KB cap, frozen legal document semantics) vs Option B (immutable Storage path, e.g. `tenants/{id}/logos/{invoiceId}.png` copied at create time). `createInvoice` helper `inlineLogoOrThrow(meta.logoUrl)` enforces the cap and throws a user-visible error if exceeded. Fixes the "tenant changes logo → old PDFs now show new logo" timeline-mutation bug. Replaces P1 breadcrumb in DEFERRED. **(8) Doc-boundary cleanup** — `REBUILD_PLAN_DEFERRED.md` was drifting toward re-documenting schemas and routes (duplication = drift). R1, R2, and P7 narratives replaced with ~3-line breadcrumbs pointing to the phases where they now live; "Recommended action order" updated to reflect R1/R2 folded, R6 "largely obsolete" (Edge Config subsumed the concern), P1 "partially obsolete" (base64 logo inlining subsumed the render-time null check); "Audit confidence summary" remaining totals recounted to 6 RISK (R3–R8) + 13 POLISH (P1–P6, P8–P14). DEFERRED is now strictly rationale/audit-trail; implementation details live in `REBUILD_PLAN.md` alone. **Total impact:** ~200 lines added to the main plan; ~180 lines trimmed from DEFERRED. No existing decisions reversed. Highest-severity single finding was #6 (XSS-to-PDF); highest structural finding was #8 (doc boundary). **Audit cycle is now definitively closed — next stop is Phase 1 code, no more plan revisions.**
