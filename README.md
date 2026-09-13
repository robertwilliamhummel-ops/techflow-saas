# TechFlow SaaS — InvoicePro

Multi-tenant, white-label invoicing and customer portal for TechFlow Solutions clients: branded invoices, quotes, and recurring billing; Interac e-Transfer and Stripe card payments; per-tenant custom domains.

**Start with [`Docs/REBUILD_PLAN.md`](Docs/REBUILD_PLAN.md) → "Build Status, Decisions & Conventions"** for what's built, open bugs, and the path to launch. Working rules for anyone changing this repo are in [`CLAUDE.md`](CLAUDE.md).

## Repository layout

| Path | What |
|---|---|
| `src/` | Next.js App Router app — tenant dashboard, customer portal, public pay page, PDF proxy and Stripe webhook API routes |
| `functions/` | Cloud Functions v2 — callables, scheduled jobs, Firestore trigger, SES events webhook — and React Email templates |
| `pdf-service/` | Cloud Run PDF renderer (Express + Puppeteer + Handlebars) |
| `firestore.rules`, `storage.rules`, `firestore.indexes.json` | Firebase security rules and indexes |
| `scripts/seed-emulator.mjs` | Seeds a fake tenant and owner into the local emulators |
| `Docs/` | Blueprint and the deferred-work / audit log |

## Local development

Requires Node 24 (the runtime everywhere — decision D6) and Java 21+ for the Firebase emulators (firebase-tools 15).

```bash
npm install
npm run functions:install
npm --prefix pdf-service install

npm run emulators:functions   # build functions, start emulators (UI on http://localhost:4000)
npm run seed:emulator         # owner@bobs-plumbing.test / techflow-dev-12345
npm run dev                   # http://localhost:3000 — set NEXT_PUBLIC_USE_EMULATORS=1 in .env.local
```

## Tests

```bash
npm test                          # Next.js unit tests
npm --prefix pdf-service test     # PDF renderer, validation, XSS fuzz

# Functions suites run against the emulators
npx firebase emulators:exec --only auth,firestore,storage --project techflow-saas-dev \
  "npm --prefix functions run test:rules && npm --prefix functions run test:callables && npm --prefix functions run test:emails && npm --prefix functions run test:shared"
```

## Deployment

Manual and per environment — follow "Environment Strategy & Deploy Runbook" in the blueprint. Never deploy rules or functions without running the emulator suites first.
