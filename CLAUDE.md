# TechFlow SaaS

## Docs map (source of truth — keep in sync)
- `Docs/REBUILD_PLAN.md` is authoritative. Its "Build Status, Decisions & Conventions" section records what is built, open bugs, post-build decisions (D1–D10), and the path to launch; it overrides older text in the plan. If code diverges from the blueprint, the code is wrong — unless the user approves a new decision, which is then recorded in that section in the same change.
- `Docs/REBUILD_PLAN_DEFERRED.md` is a rationale/audit log (R/P items with status, planning history) — do not add new features there.
- **The blueprint is binding, not beyond question.** It records decisions, and decisions can be wrong or go stale. When one looks wrong, say so — research it first and bring evidence and sources, not an opinion. Never defend a decision because it is written down; "it's in the blueprint" is not a reason.
- Do NOT modify REBUILD_PLAN.md, or write code that diverges from it, without the user explicitly asking or approving. Challenge freely, change nothing unilaterally. An approved change is recorded as a new D-numbered decision in the same commit.
- Environment variables, secrets, regions, and deploy steps live only in REBUILD_PLAN.md → "Environment Strategy & Deploy Runbook". Don't restate them here or in new docs.

## Stack
- Next.js 16 App Router on Vercel (single project, `src/proxy.ts` host routing, functions in `yul1`); Node.js 24 everywhere (D6)
- Firebase: Firestore + Auth + Storage + Cloud Functions v2 + Emulators — Firestore and functions in `northamerica-northeast2`, scheduled functions in `northamerica-northeast1`; runtime `nodejs24`
- Cloud Run `pdf-service` (Puppeteer + Handlebars), protected by `X-Api-Key` from the Next.js proxy and callables
- Stripe Connect with Standard-equivalent controller properties (full Stripe Dashboard, Stripe-liable), direct charges
- Amazon SES + React Email for transactional mail, sent only from Cloud Functions via `functions/src/emails/send.ts`
- Tailwind + shadcn/ui + Radix, semantic CSS-variable tokens (Phase 1.5)
- Vercel Global Config (formerly Edge Config) for the domain→tenantId cache — `@vercel/global-config` SDK reads, keys from `domainCacheKey`

## Core principle
Zero-trust multi-tenancy. `tenantId` in Firebase Auth custom claims is the authoritative boundary. All mutations flow through Cloud Function callables. Firestore rules use `allow write: if false` on every tenant collection — clients cannot write directly.

## Deployment safety
- Before any `firebase deploy`, run the emulator test suites (`firebase emulators:start` / `emulators:exec`) and verify against a fake tenant.
- Never deploy unverified rules to a live Firebase project.
- Never commit secrets. Use `defineSecret()` for Cloud Functions and Vercel env vars for the Next.js app.

## Workflow
- Work in the order of the blueprint's "Path to launch". No skipping ahead.
- User ("Solo Orchestrator") reviews every diff — keep explanations concise, show the change, not a lecture.
- User prefers full-context sessions: read ALL of `Docs/REBUILD_PLAN.md` AND `Docs/REBUILD_PLAN_DEFERRED.md` at the start of each phase before writing code. Do not skim.
- Commit per bundle or decision. No combining bundles.
- When a change alters behaviour the blueprint describes (or fixes a listed bug), update that part of the blueprint in the same change so docs never drift.

## Git
- Never force-push, reset --hard, or skip hooks without explicit approval.
- Commit messages: short, imperative, reference the phase or decision (e.g. "phase 1: add stripeStatus meta schema", "decision D3: gate card surcharging").

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
