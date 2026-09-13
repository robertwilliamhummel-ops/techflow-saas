// Connect webhook handlers — payment, refund, and dispute reconciliation.
//
// All handlers receive the tenantId (resolved upstream via the stripeAccounts
// reverse-lookup doc) plus the raw Stripe event. The route marks an event done
// only after its handler succeeds and releases it on failure so Stripe's retry
// runs it again (A-03). Every handler must therefore be safe to run more than
// once: merge writes, deterministic incident ids, idempotency keys on Stripe calls.
//
// CRITICAL: checkoutCompleted enforces the C2 pay-token version guard. If
// `session.metadata.payTokenVersion` diverges from the invoice's current
// version (tenant regenerated the pay link after the customer started
// checkout), the handler does NOT mark the invoice paid, issues an
// auto-refund, and writes an audit doc. Accepting a payment on a killed link
// silently violates the tenant's intent when they regenerated.

import type Stripe from "stripe";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeClient } from "@/lib/stripe/admin";
import { buildStripeStatusFromAccount } from "@/lib/stripe/status";

// ---------------------------------------------------------------------------
// Shared lookup helpers
// ---------------------------------------------------------------------------

// Find an invoice by its stripeChargeId across all tenants is expensive —
// instead the Connect webhook already knows the tenant from event.account, so
// we scope the collectionGroup query to that tenant's invoices subcollection.
// Collection group 'invoices' returns all tenants' invoices, so we filter by
// stripeChargeId AND assert the parent tenantId matches.
async function findInvoiceByChargeId(
  tenantId: string,
  stripeChargeId: string,
): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  data: Record<string, unknown>;
} | null> {
  const db = getAdminDb();
  const query = await db
    .collection(`tenants/${tenantId}/invoices`)
    .where("stripeChargeId", "==", stripeChargeId)
    .limit(1)
    .get();
  if (query.empty) return null;
  const doc = query.docs[0];
  return { ref: doc.ref, data: doc.data() };
}

function asChargeId(pi: Stripe.Charge["payment_intent"] | string | null): string | null {
  if (!pi) return null;
  if (typeof pi === "string") return pi;
  return pi.id ?? null;
}

// ---------------------------------------------------------------------------
// checkout.session.completed — C2 version guard + paid-state reconciliation
// ---------------------------------------------------------------------------

export async function handleCheckoutCompleted(
  tenantId: string,
  event: Stripe.Event,
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;

  const invoiceId = session.metadata?.invoiceId;
  const metaTenantId = session.metadata?.tenantId;
  const metaVersion = session.metadata?.payTokenVersion;
  const basePaid = session.metadata?.basePaidCents;
  const surcharge = session.metadata?.surchargeCents;

  if (!invoiceId || !metaTenantId || metaVersion == null) {
    console.error(
      `[stripe connect] checkout.session.completed missing metadata`,
      { sessionId: session.id, metadata: session.metadata },
    );
    return;
  }

  if (metaTenantId !== tenantId) {
    // Paranoia check: session metadata claims a different tenant than the one
    // the reverse-lookup resolved. Do not reconcile — write an incident and
    // bail so a support human can investigate.
    await writeIncident(tenantId, invoiceId, `tenant-mismatch_${session.id}`, {
      kind: "tenant-mismatch",
      reason: "tenant-mismatch",
      sessionId: session.id,
      metadataTenantId: metaTenantId,
      routedTenantId: tenantId,
    });
    return;
  }

  const db = getAdminDb();
  const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) {
    console.error(
      `[stripe connect] checkout.session.completed for unknown invoice`,
      { tenantId, invoiceId, sessionId: session.id },
    );
    return;
  }
  const invoice = invoiceSnap.data() as Record<string, unknown>;

  // If already paid, this is a duplicate delivery that the idempotency layer
  // didn't catch (e.g., manual retry after we cleared the sentinel). Bail.
  if (invoice.status === "paid") {
    console.info(
      `[stripe connect] checkout.session.completed on already-paid invoice`,
      { tenantId, invoiceId, sessionId: session.id },
    );
    return;
  }

  const currentVersion = Number(invoice.payTokenVersion ?? 0);
  const sessionVersion = Number(metaVersion);

  // C2 guard — version mismatch means the tenant regenerated the pay link
  // after the session was created. Auto-refund and log the incident.
  if (currentVersion !== sessionVersion) {
    const stripeAccount = event.account;
    if (!stripeAccount) {
      console.error(
        `[stripe connect] cannot auto-refund without event.account`,
        { tenantId, invoiceId, sessionId: session.id },
      );
      return;
    }
    await autoRefundVersionMismatch({
      tenantId,
      invoiceId,
      session,
      currentVersion,
      sessionVersion,
      stripeAccount,
    });
    return;
  }

  const chargeId = asChargeId(session.payment_intent);
  const paidAmountCents = basePaid != null ? Number(basePaid) : null;
  const surchargeAmountCents = surcharge != null ? Number(surcharge) : 0;

  await invoiceRef.set(
    {
      status: "paid",
      paidAt: FieldValue.serverTimestamp(),
      paymentMethod: "card",
      paidAmountCents,
      surchargeAmountCents,
      stripeChargeId: chargeId,
    },
    { merge: true },
  );
}

async function autoRefundVersionMismatch(args: {
  tenantId: string;
  invoiceId: string;
  session: Stripe.Checkout.Session;
  currentVersion: number;
  sessionVersion: number;
  stripeAccount: string;
}): Promise<void> {
  const {
    tenantId,
    invoiceId,
    session,
    currentVersion,
    sessionVersion,
    stripeAccount,
  } = args;

  const paymentIntent = asChargeId(session.payment_intent);
  let refundId: string | null = null;
  let refundError: string | null = null;

  if (paymentIntent) {
    try {
      // stripeAccount context required — the payment lives on the connected
      // account, not the platform. Without it the refund call fails with
      // "no such payment_intent."
      // Idempotency key per session: a re-run of this event (A-03) gets the
      // original refund back from Stripe instead of creating a second one.
      const refund = await getStripeClient().refunds.create(
        { payment_intent: paymentIntent, reason: "requested_by_customer" },
        { stripeAccount, idempotencyKey: `auto-refund:${session.id}` },
      );
      refundId = refund.id;
    } catch (err) {
      refundError = err instanceof Error ? err.message : String(err);
      console.error(
        `[stripe connect] auto-refund failed for invoice ${invoiceId}`,
        { tenantId, sessionId: session.id, error: refundError },
      );
    }
  } else {
    refundError = "missing-payment-intent";
  }

  await writeIncident(tenantId, invoiceId, `auto-refund_${session.id}`, {
    kind: "auto-refund-version-mismatch",
    reason: "version-mismatch",
    sessionId: session.id,
    metadataVersion: sessionVersion,
    currentVersion,
    refundId,
    refundError,
  });
}

// ---------------------------------------------------------------------------
// charge.refunded — tenant-initiated dashboard refund OR our own auto-refund
// ---------------------------------------------------------------------------

export async function handleChargeRefunded(
  tenantId: string,
  event: Stripe.Event,
): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const match = await findInvoiceByChargeId(tenantId, charge.id);
  if (!match) {
    console.warn(
      `[stripe connect] charge.refunded for unknown chargeId`,
      { tenantId, chargeId: charge.id },
    );
    return;
  }

  const amount = charge.amount ?? 0;
  const amountRefunded = charge.amount_refunded ?? 0;
  const fullRefund = amountRefunded >= amount;

  await match.ref.set(
    {
      status: fullRefund ? "refunded" : "partially-refunded",
      refundedAt: FieldValue.serverTimestamp(),
      refundedAmountCents: amountRefunded,
    },
    { merge: true },
  );
}

// ---------------------------------------------------------------------------
// charge.dispute.created — customer filed a chargeback
// ---------------------------------------------------------------------------

export async function handleDisputeCreated(
  tenantId: string,
  event: Stripe.Event,
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!chargeId) {
    console.error(`[stripe connect] dispute.created without charge`, {
      tenantId,
      disputeId: dispute.id,
    });
    return;
  }
  const match = await findInvoiceByChargeId(tenantId, chargeId);
  if (!match) {
    console.warn(`[stripe connect] dispute.created for unknown chargeId`, {
      tenantId,
      chargeId,
      disputeId: dispute.id,
    });
    return;
  }

  await match.ref.set(
    {
      disputed: true,
      disputedAt: FieldValue.serverTimestamp(),
      disputeReason: dispute.reason ?? null,
      disputeOutcome: null,
    },
    { merge: true },
  );

  const evidenceDueBy =
    typeof dispute.evidence_details?.due_by === "number"
      ? new Date(dispute.evidence_details.due_by * 1000)
          .toISOString()
          .slice(0, 10)
      : undefined;

  await writeIncident(tenantId, match.ref.id, `dispute-created_${dispute.id}`, {
    kind: "dispute-created",
    disputeId: dispute.id,
    disputeReason: dispute.reason ?? "unspecified",
    evidenceDueBy: evidenceDueBy ?? null,
    amountCents: dispute.amount ?? null,
  });
}

// ---------------------------------------------------------------------------
// charge.dispute.closed — dispute resolved (won or lost)
// ---------------------------------------------------------------------------

export async function handleDisputeClosed(
  tenantId: string,
  event: Stripe.Event,
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId =
    typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!chargeId) return;
  const match = await findInvoiceByChargeId(tenantId, chargeId);
  if (!match) return;

  // charge.dispute.closed only fires for terminal states. 'won' means the
  // tenant kept the money; anything else (lost, charge_refunded) means the
  // chargeback went through, which is effectively a forced refund.
  if (dispute.status === "won") {
    await match.ref.set(
      { disputed: false, disputeOutcome: "won" },
      { merge: true },
    );
  } else {
    await match.ref.set(
      {
        disputed: false,
        disputeOutcome: "lost",
        status: "refunded",
        refundedAt: FieldValue.serverTimestamp(),
        refundedAmountCents: dispute.amount ?? null,
      },
      { merge: true },
    );

    await writeIncident(tenantId, match.ref.id, `dispute-lost_${dispute.id}`, {
      kind: "dispute-lost",
      disputeId: dispute.id,
      amountCents: dispute.amount ?? null,
      outcomeStatus: dispute.status,
    });
  }
}

// ---------------------------------------------------------------------------
// payment_intent.payment_failed — customer can retry; no state change
// ---------------------------------------------------------------------------

export async function handlePaymentFailed(
  tenantId: string,
  event: Stripe.Event,
): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  console.info(`[stripe connect] payment_intent.payment_failed`, {
    tenantId,
    paymentIntentId: pi.id,
    failureCode: pi.last_payment_error?.code,
    failureMessage: pi.last_payment_error?.message,
  });
  // No state mutation by design — customer may retry with a different card.
}

// ---------------------------------------------------------------------------
// account.updated — mirror connected-account capability state (D1)
// ---------------------------------------------------------------------------

// Connected-accounts scope: delivered to the Connect endpoint with
// event.account set. Sole webhook writer of meta.stripeStatus.
export async function handleAccountUpdated(
  tenantId: string,
  event: Stripe.Event,
): Promise<void> {
  const account = event.data.object as Stripe.Account;
  const db = getAdminDb();
  const metaRef = db.doc(`tenants/${tenantId}/meta/settings`);
  const metaSnap = await metaRef.get();
  const currentAccountId =
    (metaSnap.data() as { stripeAccountId?: string | null } | undefined)
      ?.stripeAccountId ?? null;

  // A tenant whose Stripe account was recreated still has a reverse lookup for
  // the old account. Its events must not overwrite the live account's status.
  if (currentAccountId !== account.id) {
    console.warn(
      `[stripe connect] account.updated for non-current account ${account.id}`,
      { tenantId, currentAccountId },
    );
    return;
  }

  await metaRef.set(
    {
      stripeStatus: buildStripeStatusFromAccount(account),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ---------------------------------------------------------------------------
// account.application.deauthorized — contractor disconnected TechFlow (D1)
// ---------------------------------------------------------------------------

// With full-dashboard (Standard-equivalent) accounts the contractor can revoke
// the platform from their own Stripe Dashboard. data.object is the Application;
// the disconnected account id is event.account.
export async function handleAccountDeauthorized(
  tenantId: string,
  event: Stripe.Event,
): Promise<void> {
  const accountId = event.account;
  if (!accountId) return;

  const db = getAdminDb();
  const metaRef = db.doc(`tenants/${tenantId}/meta/settings`);
  const metaSnap = await metaRef.get();
  const currentAccountId =
    (metaSnap.data() as { stripeAccountId?: string | null } | undefined)
      ?.stripeAccountId ?? null;

  const batch = db.batch();
  if (currentAccountId === accountId) {
    batch.set(
      metaRef,
      {
        stripeAccountId: null,
        stripeStatus: {
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
          currentlyDue: [],
          disabledReason: null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  batch.delete(db.doc(`stripeAccounts/${accountId}`));
  await batch.commit();
}

// ---------------------------------------------------------------------------
// paymentIncidents audit writer
// ---------------------------------------------------------------------------

// Deterministic ids (kind + Stripe object id): a redelivered event rewrites the
// same doc. The Cloud Functions trigger onPaymentIncidentCreated emails tenant
// owners on CREATE only (D5), so redelivery never double-emails.
async function writeIncident(
  tenantId: string,
  invoiceId: string,
  incidentId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = getAdminDb();
  await db
    .doc(`tenants/${tenantId}/invoices/${invoiceId}/paymentIncidents/${incidentId}`)
    .set(
      {
        ...payload,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}
