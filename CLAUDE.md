# TechFlow SaaS

## Blueprint (source of truth)
- `Docs/REBUILD_PLAN.md` is authoritative. If code diverges from it, the code is wrong.
- `Docs/REBUILD_PLAN_DEFERRED.md` is a rationale/audit log only — do not add new features there.
- Do NOT modify REBUILD_PLAN.md without the user explicitly asking. The audit cycle is closed.

## Stack
- Next.js 15 App Router on Vercel (single project, middleware host routing)
- Firebase: Firestore + Auth + Storage + Cloud Functions v2 + Emulators
- Cloud Run for Puppeteer PDF service (Google-signed ID token auth)
- Stripe Connect Express
- Resend + React Email for transactional mail
- Tailwind + shadcn/ui + Radix, semantic CSS-variable tokens (Phase 1.5)
- Vercel Edge Config for domain→tenantId cache

## Core principle
Zero-trust multi-tenancy. `tenantId` in Firebase Auth custom claims is the authoritative boundary. All mutations flow through Cloud Function callables. Firestore rules use `allow write: if false` on invoices/quotes/users — clients cannot write directly.

## Deployment safety
- Before any `firebase deploy`, run `firebase emulators:start` locally and verify against a fake tenant.
- Never deploy unverified rules to a live Firebase project.
- Never commit secrets. Use `defineSecret()` for Cloud Functions and Vercel env vars for the Next.js app.

## Workflow
- Phase-by-phase per the blueprint. No skipping ahead.
- Phase 1 (schema + security rules + emulator verification) ships before any UI work.
- User ("Solo Orchestrator") reviews every diff — keep explanations concise, show the change, not a lecture.
- User prefers full-context sessions: read ALL of `Docs/REBUILD_PLAN.md` AND `Docs/REBUILD_PLAN_DEFERRED.md` at the start of each phase before writing code. Do not skim.

## Git
- Never force-push, reset --hard, or skip hooks without explicit approval.
- Commit messages: short, imperative, reference the phase (e.g. "phase 1: add stripeStatus meta schema").