// Phase 4 Bundle B — Stripe Connect Express onboarding entry point.
//
// Owner/admin only, gated on `stripePayments`. Creates an Express account on
// the platform if the tenant doesn't have one yet (persisting the new id to
// meta.stripeAccountId so re-attempts reuse the same account), then issues a
// fresh AccountLink and returns its URL. The reverse-lookup doc and the
// stripeStatus mirror are written by completeConnectOnboarding once the
// tenant lands on /billing/return.

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
      type: "express",
      country: countryForCurrency(meta.currency),
      email: claims.email ?? undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: "company",
      metadata: { tenantId },
    });
    accountId = account.id;
    await metaRef.set(
      {
        stripeAccountId: accountId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
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
