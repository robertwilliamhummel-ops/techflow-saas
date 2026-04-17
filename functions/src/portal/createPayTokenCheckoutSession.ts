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
import { computeSurchargeCents } from "../shared/surcharge";

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

  // 5. Build Checkout session with surcharge logic.
  const totalCents = Math.round((invoice.totals?.total ?? 0) * 100);
  const currency = String(
    invoice.tenantSnapshot?.currency ?? meta.currency ?? "CAD",
  ).toLowerCase();

  const surchargeCents = computeSurchargeCents(
    totalCents,
    Boolean(meta.chargeCustomerCardFees),
    Number(meta.cardFeePercent ?? 0),
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
          name: `Credit card processing fee (${meta.cardFeePercent ?? 2.4}%)`,
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
