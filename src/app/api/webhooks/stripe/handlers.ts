// Connect webhook handlers — payment, refund, and dispute reconciliation.
//
// All handlers receive the tenantId (resolved upstream via the stripeAccounts
// reverse-lookup doc) plus the raw Stripe event. Idempotency is already
// guaranteed by the route layer (stripeEvents/{event.id} claim), so these
// handlers focus purely on state transitions.
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
    await writeIncident(tenantId, invoiceId, {
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
      paymentMethod: "stripe",
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
      const refund = await getStripeClient().refunds.create(
        { payment_intent: paymentIntent, reason: "requested_by_customer" },
        { stripeAccount },
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

  await writeIncident(tenantId, invoiceId, {
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
// paymentIncidents audit writer
// ---------------------------------------------------------------------------

async function writeIncident(
  tenantId: string,
  invoiceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection(`tenants/${tenantId}/invoices/${invoiceId}/paymentIncidents`)
    .add({
      ...payload,
      createdAt: FieldValue.serverTimestamp(),
    });
}
