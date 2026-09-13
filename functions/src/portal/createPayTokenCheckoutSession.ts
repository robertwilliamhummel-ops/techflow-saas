// createPayTokenCheckoutSession — Phase 2 Bundle F.
//
// Token-authenticated: NO Firebase auth required. The signed JWT IS the auth.
// Re-verifies the token, enforces rate limit (10 sessions/invoice/24h),
// creates a Stripe Checkout session on the tenant's Connect account,
// applies surcharge line item if chargeCustomerCardFees === true.
// Stamps metadata.payTokenVersion for the C2 webhook guard.

import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { verifyPayToken } from "../shared/payToken";
import { loadFeatures } from "../shared/requireFeature";
import {
  computeSurchargeCents,
  effectiveCardSurcharge,
} from "../shared/surcharge";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

// Rate limit: max 10 checkout sessions per invoice per 24 hours.
const MAX_ATTEMPTS_PER_DAY = 10;
const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Statuses that accept payment — same as verifyInvoicePayToken.
const PAYABLE_STATUSES = ["sent", "unpaid", "overdue", "partial"] as const;

export async function createPayTokenCheckoutSessionHandler(
  request: CallableRequest,
): Promise<{ url: string }> {
  const { token } = (request.data ?? {}) as { token?: string };
  if (!token || typeof token !== "string") {
    throw new HttpsError("invalid-argument", "Token required.");
  }

  // 1. Verify JWT signature + expiry.
  let payload: { invoiceId: string; tenantId: string; v: number };
  try {
    payload = verifyPayToken(token, PAY_TOKEN_SECRET.value());
  } catch {
    throw new HttpsError("permission-denied", "Invalid or expired pay link.");
  }

  // 2. Read invoice doc; verify version + payable status.
  const invoiceRef = db.doc(
    `tenants/${payload.tenantId}/invoices/${payload.invoiceId}`,
  );
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) {
    throw new HttpsError("not-found", "Invoice not found.");
  }
  const invoice = invoiceSnap.data()!;

  if (invoice.payTokenVersion !== payload.v) {
    throw new HttpsError(
      "permission-denied",
      "This pay link has been invalidated. Check your email for a newer one.",
    );
  }
  if (invoice.status === "paid") {
    throw new HttpsError("failed-precondition", "Invoice already paid.");
  }
  if (
    !PAYABLE_STATUSES.includes(
      invoice.status as (typeof PAYABLE_STATUSES)[number],
    )
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Invoice is not available for payment.",
    );
  }

  // 3. Rate limit — 10 checkout sessions per invoice per 24h.
  const attemptsRef = invoiceRef.collection("payAttempts");
  const cutoff = Timestamp.fromMillis(Date.now() - ATTEMPT_WINDOW_MS);
  const recentAttempts = await attemptsRef
    .where("createdAt", ">=", cutoff)
    .count()
    .get();

  if (recentAttempts.data().count >= MAX_ATTEMPTS_PER_DAY) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many payment attempts. Try again later.",
    );
  }

  // 4. Read tenant meta for Stripe account + surcharge config.
  const metaSnap = await db
    .doc(`tenants/${payload.tenantId}/meta/settings`)
    .get();
  if (!metaSnap.exists) {
    throw new HttpsError("internal", "Tenant configuration missing.");
  }
  const meta = metaSnap.data()!;

  if (!meta.stripeAccountId) {
    throw new HttpsError(
      "failed-precondition",
      "This business has not connected Stripe yet.",
    );
  }

  // Phase 4 Bundle E — friendly preflight. stripeStatus.chargesEnabled is the
  // platform webhook's mirror of account.updated capabilities; if Stripe has
  // restricted or not-yet-approved the account, sessions.create will reject
  // with a less-helpful error. Fail early with a human-readable message.
  const stripeStatus = meta.stripeStatus as
    | { chargesEnabled?: boolean }
    | undefined;
  if (stripeStatus && stripeStatus.chargesEnabled === false) {
    throw new HttpsError(
      "failed-precondition",
      "This business cannot accept card payments right now. Ask them for an e-transfer alternative.",
    );
  }

  // 5. Build Checkout session with surcharge logic.
  const totalCents = Math.round((invoice.totals?.total ?? 0) * 100);
  const currency = String(
    invoice.tenantSnapshot?.currency ?? meta.currency ?? "CAD",
  ).toLowerCase();

  // Surcharge comes from the invoice's frozen snapshot — the same values the
  // PDF and pay page disclosed — never from current settings (A-09). The
  // platform `cardSurcharge` flag (D3) is a kill switch on top.
  const features = await loadFeatures(payload.tenantId);
  const surcharge = effectiveCardSurcharge(
    invoice.tenantSnapshot,
    features.cardSurcharge,
  );
  const surchargeCents = computeSurchargeCents(
    totalCents,
    surcharge.enabled,
    surcharge.percent,
  );

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency,
        product_data: { name: `Invoice ${invoiceSnap.id}` },
        unit_amount: totalCents,
      },
      quantity: 1,
    },
  ];

  if (surchargeCents > 0) {
    lineItems.push({
      price_data: {
        currency,
        product_data: {
          name: `Credit card processing fee (${surcharge.percent}%)`,
        },
        unit_amount: surchargeCents,
      },
      quantity: 1,
    });
  }

  // Determine base URL for success/cancel redirects.
  const appUrl =
    process.env.APP_URL || "https://portal.techflowsolutions.ca";

  const stripe = new Stripe(STRIPE_SECRET_KEY.value());

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: lineItems,
      payment_method_types: ["card"],
      payment_method_options: {
        card: {
          request_three_d_secure:
            surchargeCents > 0 ? "any" : "automatic",
        },
      },
      // Shown on the payment in the contractor's own Stripe Dashboard, where
      // refunds and disputes are handled (D1), so they can tell which invoice
      // a payment belongs to.
      payment_intent_data: {
        description: `Invoice ${invoiceSnap.id}`,
        metadata: {
          invoiceId: payload.invoiceId,
          tenantId: payload.tenantId,
        },
      },
      metadata: {
        invoiceId: payload.invoiceId,
        tenantId: payload.tenantId,
        surchargeCents: String(surchargeCents),
        basePaidCents: String(totalCents),
        payTokenVersion: String(invoice.payTokenVersion),
      },
      success_url: `${appUrl}/pay/${token}/success`,
      cancel_url: `${appUrl}/pay/${token}/cancelled`,
    },
    { stripeAccount: meta.stripeAccountId as string },
  );

  // 6. Record pay attempt for rate limiting. TTL policy on expireAt handles
  //    cleanup (R2 from deferred — Firestore TTL configured per-project).
  await attemptsRef.add({
    createdAt: FieldValue.serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000),
    sessionId: session.id,
  });

  if (!session.url) {
    throw new HttpsError("internal", "Stripe did not return a checkout URL.");
  }

  return { url: session.url };
}

export const createPayTokenCheckoutSession = onCall(
  { secrets: [PAY_TOKEN_SECRET, STRIPE_SECRET_KEY] },
  createPayTokenCheckoutSessionHandler,
);
