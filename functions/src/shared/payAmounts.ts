// What a card payment on an invoice charges (S-09). The pay page shows exactly
// these amounts (verifyInvoicePayToken) and createPayTokenCheckoutSession
// charges them; the Stripe webhook refunds a payment whose base isn't the
// invoice total (A-08).

import { computeSurchargeCents, effectiveCardSurcharge } from "./surcharge";

type Data = FirebaseFirestore.DocumentData;

export interface CardCharge {
  /** The invoice total in cents. */
  baseCents: number;
  /** The fee that applies: the frozen snapshot, behind the D3 kill switch. */
  surcharge: { enabled: boolean; percent: number };
  surchargeCents: number;
  /** What the card is charged: base plus fee. */
  totalCents: number;
}

export function cardChargeFor(invoice: Data, cardSurchargeFeature: boolean): CardCharge {
  const baseCents = Math.round(Number(invoice.totals?.total ?? 0) * 100);
  const surcharge = effectiveCardSurcharge(invoice.tenantSnapshot, cardSurchargeFeature);
  const surchargeCents = computeSurchargeCents(baseCents, surcharge.enabled, surcharge.percent);
  return { baseCents, surcharge, surchargeCents, totalCents: baseCents + surchargeCents };
}

/**
 * The business can take card payments: a connected Stripe account that Stripe
 * lets take charges — the card rail sendInvoiceEmail checks.
 */
export function cardPaymentsReady(meta: Data | undefined): boolean {
  return (
    typeof meta?.stripeAccountId === "string" &&
    meta.stripeAccountId.length > 0 &&
    meta.stripeStatus?.chargesEnabled === true
  );
}
