// Connect-level Stripe webhook. Receives payment events from every connected
// tenant account. Event.account routes the event to a tenantId via the
// stripeAccounts/{accountId} reverse-lookup written at /billing/return time.
//
// Bundle C scope: signature verification + idempotency + tenant routing +
// dispatcher skeleton. The actual payment/refund/dispute handlers — including
// the C2 pay-token version guard and automatic refund — land in Bundle D.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeClient } from "@/lib/stripe/admin";
import { claimStripeEvent } from "@/lib/stripe/idempotency";
import {
  handleChargeRefunded,
  handleCheckoutCompleted,
  handleDisputeClosed,
  handleDisputeCreated,
  handlePaymentFailed,
} from "../handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretOrThrow(): string {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_CONNECT_WEBHOOK_SECRET is not configured.");
  }
  return secret;
}

async function resolveTenantId(accountId: string): Promise<string | null> {
  const snap = await getAdminDb().doc(`stripeAccounts/${accountId}`).get();
  if (!snap.exists) return null;
  return (snap.data() as { tenantId?: string }).tenantId ?? null;
}

export async function POST(req: Request): Promise<Response> {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }

  const raw = await req.text();
  const stripe = getStripeClient();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secretOrThrow());
  } catch (err) {
    const message = err instanceof Error ? err.message : "bad signature";
    return NextResponse.json(
      { error: `Signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  // Connect events MUST carry event.account — without it we can't route to a
  // tenant. If it's absent, Stripe delivered a platform event to the wrong
  // endpoint; reject so misconfiguration surfaces during setup.
  if (!event.account) {
    return NextResponse.json(
      { error: "Platform event delivered to Connect endpoint." },
      { status: 400 },
    );
  }

  const tenantId = await resolveTenantId(event.account);
  if (!tenantId) {
    // Unknown account — likely a tenant who abandoned onboarding mid-flow or
    // whose reverse-lookup was never written. 200 so Stripe stops retrying; we
    // log it because a payment on an unlinkable account is a platform bug.
    console.error(
      `[stripe connect] event ${event.type} for unlinkable account ${event.account}`,
    );
    return NextResponse.json({ received: true, ignored: "unlinkable-account" });
  }

  const claimed = await claimStripeEvent(event.id, {
    type: event.type,
    account: event.account,
    livemode: event.livemode,
  });
  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(tenantId, event);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentFailed(tenantId, event);
        break;
      case "charge.refunded":
        await handleChargeRefunded(tenantId, event);
        break;
      case "charge.dispute.created":
        await handleDisputeCreated(tenantId, event);
        break;
      case "charge.dispute.closed":
        await handleDisputeClosed(tenantId, event);
        break;
      default:
        console.info(
          `[stripe connect] ignoring event type ${event.type} for tenant ${tenantId}`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe connect] handler failed for ${event.type} / ${tenantId}: ${message}`,
    );
    return NextResponse.json({ error: "Handler failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
