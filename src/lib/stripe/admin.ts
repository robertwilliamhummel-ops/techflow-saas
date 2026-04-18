// Lazy Stripe client for Next.js server-side routes (webhooks, future server
// actions). Functions side has its own client in `functions/src/shared/stripe.ts`
// — they don't share code because the Next.js app reads secrets from
// `process.env` (Vercel env vars) while Functions uses `defineSecret()`.

import Stripe from "stripe";

let cachedClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (cachedClient) return cachedClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY env var is not configured.");
  }
  cachedClient = new Stripe(key);
  return cachedClient;
}

// Test seam — swap in a fake Stripe during vitest without touching env vars.
export function __setStripeClientForTest(client: Stripe | null): void {
  cachedClient = client;
}
