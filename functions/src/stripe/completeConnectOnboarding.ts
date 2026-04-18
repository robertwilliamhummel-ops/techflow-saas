// Phase 4 Bundle B — Stripe Connect return-URL handler.
//
// Called by /billing/return. Re-fetches the account from Stripe, mirrors the
// capability state into meta.stripeStatus, and (atomically with the status
// write) writes the stripeAccounts/{accountId} reverse lookup that the Connect
// webhook uses to route events to a tenant. The batch is non-negotiable: if
// stripeStatus and the reverse lookup diverge, the first checkout.session.completed
// arrives without a route home.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { requireFeature } from "../shared/requireFeature";
import {
  buildStripeStatusFromAccount,
  getStripe,
  STRIPE_SECRET_KEY,
} from "../shared/stripe";

interface Result {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
  disabledReason: string | null;
}

export async function completeConnectOnboardingHandler(
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
  const accountId = meta.stripeAccountId as string | null;
  if (!accountId) {
    throw new HttpsError(
      "failed-precondition",
      "Start Stripe onboarding before returning here.",
    );
  }

  const account = await getStripe().accounts.retrieve(accountId);
  const status = buildStripeStatusFromAccount(account);

  // Atomic: status mirror + reverse lookup must move together so the Connect
  // webhook can always resolve account → tenantId.
  const batch = db.batch();
  batch.set(
    metaRef,
    { stripeStatus: status, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  batch.set(db.doc(`stripeAccounts/${accountId}`), {
    tenantId,
    linkedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return {
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    detailsSubmitted: status.detailsSubmitted,
    currentlyDue: status.currentlyDue,
    disabledReason: status.disabledReason,
  };
}

export const completeConnectOnboarding = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  completeConnectOnboardingHandler,
);
