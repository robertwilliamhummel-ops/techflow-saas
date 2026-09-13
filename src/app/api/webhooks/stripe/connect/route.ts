// Connect-scope Stripe webhook. Receives every "Connected accounts" event:
// payments/refunds/disputes on direct charges AND connected-account lifecycle
// (account.updated, account.application.deauthorized). Event.account routes the
// event to a tenantId via the stripeAccounts/{accountId} reverse lookup, which
// startConnectOnboarding writes when the account is created.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeClient } from "@/lib/stripe/admin";
import {
  claimStripeEvent,
  completeStripeEvent,
  releaseStripeEvent,
} from "@/lib/stripe/idempotency";
import {
  handleAccountDeauthorized,
  handleAccountUpdated,
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
    // Unknown account — no reverse lookup exists (account created outside
    // startConnectOnboarding, or already deauthorized). 200 so Stripe stops
    // retrying; logged because a payment on an unlinkable account is a bug.
    console.error(
      `[stripe connect] event ${event.type} for unlinkable account ${event.account}`,
    );
    return NextResponse.json({ received: true, ignored: "unlinkable-account" });
  }

  const claim = await claimStripeEvent(event.id, {
    type: event.type,
    account: event.account,
    livemode: event.livemode,
  });
  if (claim === "duplicate") {
    return NextResponse.json({ received: true, duplicate: true });
  }
  if (claim === "in-progress") {
    // Another delivery of this event is still running. A non-2xx makes Stripe
    // retry later instead of counting this copy as delivered — if the running
    // copy fails, that retry is what processes the event.
    return NextResponse.json(
      { error: "Event is already being processed." },
      { status: 409 },
    );
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
      case "account.updated":
        await handleAccountUpdated(tenantId, event);
        break;
      case "account.application.deauthorized":
        await handleAccountDeauthorized(tenantId, event);
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
    try {
      // Release so Stripe's retry (triggered by the 500) runs the event again.
      await releaseStripeEvent(event.id, message);
    } catch (releaseErr) {
      // The processing lease still lapses on its own; the retry after that works.
      console.error(`[stripe connect] could not release event ${event.id}`, {
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
    return NextResponse.json({ error: "Handler failed." }, { status: 500 });
  }

  try {
    await completeStripeEvent(event.id);
  } catch (err) {
    // The handler's writes landed. If the marker can't be finished, a later copy
    // re-runs the (idempotent) handler once the lease lapses — acknowledge anyway.
    console.error(`[stripe connect] could not mark event ${event.id} done`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ received: true });
}
