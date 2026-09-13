// Platform-scope ("Your account") Stripe webhook.
//
// Connected-account lifecycle events — account.updated and
// account.application.deauthorized — are "Connected accounts" scope in Stripe
// and arrive on /api/webhooks/stripe/connect with event.account set (decision
// D1, 2026-09-13). Nothing on the platform account itself needs handling today
// (TechFlow takes no platform fee and has no platform billing yet).
//
// The endpoint stays registered with its own secret (STRIPE_PLATFORM_WEBHOOK_SECRET,
// R5 split) so signature verification and misrouting detection already exist
// when platform billing is added.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretOrThrow(): string {
  const secret = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_PLATFORM_WEBHOOK_SECRET is not configured.");
  }
  return secret;
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
    const message = err instanceof Error ? err.message : "bad sig";
    return NextResponse.json(
      { error: `Signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  // Platform-scope events MUST NOT carry event.account. If they do, the
  // endpoint was registered with the wrong scope — surface it during setup.
  if (event.account) {
    return NextResponse.json(
      { error: "Connect event delivered to platform endpoint." },
      { status: 400 },
    );
  }

  console.info(`[stripe platform] acknowledged event type ${event.type}`);
  return NextResponse.json({ received: true });
}
