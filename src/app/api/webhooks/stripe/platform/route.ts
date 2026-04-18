// Platform-level Stripe webhook. Receives account lifecycle events for every
// tenant connected via Express onboarding:
//
//   - account.updated              → mirror capability state into meta.stripeStatus
//   - account.application.deauthorized → tenant disconnected; clear linkage
//
// Signature verification uses STRIPE_PLATFORM_WEBHOOK_SECRET (separate from
// the Connect webhook secret — R5 decision). Idempotency via stripeEvents/{id}
// so a Stripe retry can't double-apply a state change.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeClient } from "@/lib/stripe/admin";
import { claimStripeEvent } from "@/lib/stripe/idempotency";
import { buildStripeStatusFromAccount } from "@/lib/stripe/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretOrThrow(): string {
  const secret = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_PLATFORM_WEBHOOK_SECRET is not configured.");
  }
  return secret;
}

async function resolveTenantId(accountId: string): Promise<string | null> {
  const snap = await getAdminDb().doc(`stripeAccounts/${accountId}`).get();
  if (!snap.exists) return null;
  return (snap.data() as { tenantId?: string }).tenantId ?? null;
}

async function handleAccountUpdated(event: Stripe.Event): Promise<void> {
  const account = event.data.object as Stripe.Account;
  const tenantId = await resolveTenantId(account.id);
  if (!tenantId) {
    // Reverse-lookup is written at /billing/return time; if it's missing, the
    // tenant abandoned onboarding before the return URL completed. Nothing to
    // mirror — the next completeConnectOnboarding call will catch them up.
    console.warn(
      `[stripe platform] account.updated for unknown account ${account.id}`,
    );
    return;
  }

  const status = buildStripeStatusFromAccount(account);
  await getAdminDb()
    .doc(`tenants/${tenantId}/meta/settings`)
    .set(
      { stripeStatus: status, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
}

async function handleDeauthorized(event: Stripe.Event): Promise<void> {
  // `account.application.deauthorized` delivers the account object (not an
  // application object) because we registered this at the platform level.
  const account = event.data.object as Stripe.Account;
  const tenantId = await resolveTenantId(account.id);
  if (!tenantId) {
    console.warn(
      `[stripe platform] deauthorized for unknown account ${account.id}`,
    );
    return;
  }

  const db = getAdminDb();
  const batch = db.batch();
  batch.set(
    db.doc(`tenants/${tenantId}/meta/settings`),
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
  batch.delete(db.doc(`stripeAccounts/${account.id}`));
  await batch.commit();
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

  // Platform-level events MUST NOT carry event.account. If they do, Stripe
  // delivered a Connect event to the wrong endpoint — drop it with 400 so the
  // mismatched registration surfaces during setup, not silently.
  if (event.account) {
    return NextResponse.json(
      { error: "Connect event delivered to platform endpoint." },
      { status: 400 },
    );
  }

  const claimed = await claimStripeEvent(event.id, {
    type: event.type,
    account: null,
    livemode: event.livemode,
  });
  if (!claimed) {
    // Redelivery of an already-processed event — Stripe treats 2xx as success.
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "account.updated":
        await handleAccountUpdated(event);
        break;
      case "account.application.deauthorized":
        await handleDeauthorized(event);
        break;
      default:
        // Unknown platform event — acknowledge so Stripe stops retrying, but
        // log so we can add a handler if it turns out to matter.
        console.info(
          `[stripe platform] ignoring event type ${event.type}`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[stripe platform] handler failed for ${event.type}: ${message}`,
    );
    return NextResponse.json(
      { error: "Handler failed." },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
