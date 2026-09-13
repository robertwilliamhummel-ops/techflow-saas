// Stripe Connect onboarding entry point (decision D1, 2026-09-13).
//
// Owner/admin only, gated on `stripePayments`. Creates a connected account on
// the platform if the tenant doesn't have one yet, then issues a fresh
// AccountLink and returns its URL.
//
// Account configuration uses controller properties equivalent to a Standard
// account (the legacy `type` parameter is deprecated by Stripe):
//   - losses.payments = stripe        → Stripe, not TechFlow, carries negative-
//                                        balance liability on direct charges
//   - fees.payer = account             → the contractor pays their own Stripe fees
//   - requirement_collection = stripe  → Stripe collects KYC; no business_type
//                                        or capabilities needed up front
//   - stripe_dashboard.type = full     → contractor handles refunds/disputes in
//                                        the full Stripe Dashboard
// Dashboard type is immutable per account — never change these without
// planning a re-onboarding of every tenant.
//
// The stripeAccounts/{accountId} reverse lookup is written in the same batch
// as meta.stripeAccountId, so Connect webhooks (account.updated) route even if
// the tenant never returns through /billing/return.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import { getStripe, STRIPE_SECRET_KEY } from "../shared/stripe";

interface Result {
  url: string;
  accountId: string;
}

function defaultAppUrl(): string {
  return process.env.APP_URL || "https://portal.techflowsolutions.ca";
}

function countryForCurrency(currency: unknown): "CA" | "US" {
  return currency === "USD" ? "US" : "CA";
}

export async function startConnectOnboardingHandler(
  request: CallableRequest,
): Promise<Result> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "stripePayments");

  const metaRef = db.doc(`tenants/${tenantId}/meta/settings`);
  const metaSnap = await metaRef.get();
  if (!metaSnap.exists) {
    throw new HttpsError("internal", "Tenant configuration missing.");
  }
  const meta = metaSnap.data() as Record<string, unknown>;

  const stripe = getStripe();

  // Reuse an existing account if onboarding was previously started. Stripe
  // returns the account on retrieve even if the tenant abandoned mid-flow,
  // so a fresh AccountLink resumes from where they left off.
  let accountId = (meta.stripeAccountId as string | null) ?? null;
  if (accountId) {
    try {
      await stripe.accounts.retrieve(accountId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "resource_missing" || code === "account_invalid") {
        // The account was deleted from Stripe out-of-band. Drop the stale id
        // and create a new one below.
        accountId = null;
      } else {
        throw err;
      }
    }
  }

  if (!accountId) {
    const account = await stripe.accounts.create({
      country: countryForCurrency(meta.currency),
      email: claims.email ?? undefined,
      controller: {
        losses: { payments: "stripe" },
        fees: { payer: "account" },
        requirement_collection: "stripe",
        stripe_dashboard: { type: "full" },
      },
      metadata: { tenantId },
    });
    accountId = account.id;

    const batch = db.batch();
    batch.set(
      metaRef,
      {
        stripeAccountId: accountId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.set(db.doc(`stripeAccounts/${accountId}`), {
      tenantId,
      linkedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
  }

  const appUrl = defaultAppUrl();
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl}/billing?stripe=refresh`,
    return_url: `${appUrl}/billing/return`,
    type: "account_onboarding",
  });

  return { url: link.url, accountId };
}

export const startConnectOnboarding = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  startConnectOnboardingHandler,
);
