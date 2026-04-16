import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { isValidEmail, lowerEmail } from "../shared/email";

// Payment-related tenant meta. Stripe Connect onboarding writes are handled by
// the Stripe callables in Phase 4. This callable only lets owners/admins edit:
//   - etransferEmail
//   - chargeCustomerCardFees (boolean switch)
//   - cardFeePercent (hard-capped at 2.4, server-side regardless of input)
//   - surchargeAcknowledgedAt (set via `acknowledgeSurcharge: true`; immutable
//     once stamped — audit trail for Visa/Mastercard compliance).
// Rule: if the final doc state would have chargeCustomerCardFees=true AND
// surchargeAcknowledgedAt still null, the update is refused — this is what
// makes the one-time acknowledgment modal non-bypassable via direct API.
interface Input {
  etransferEmail?: unknown;
  chargeCustomerCardFees?: unknown;
  cardFeePercent?: unknown;
  acknowledgeSurcharge?: unknown;
}

const MAX_CARD_FEE_PERCENT = 2.4;

function validNullableEmail(raw: unknown): string | null {
  if (raw === null) return null;
  const s = lowerEmail(raw);
  if (s.length === 0) return null;
  if (!isValidEmail(s)) {
    throw new HttpsError(
      "invalid-argument",
      "etransferEmail is not a valid address.",
    );
  }
  return s;
}

function validCardFeePercent(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpsError(
      "invalid-argument",
      "cardFeePercent must be a non-negative number.",
    );
  }
  if (n > MAX_CARD_FEE_PERCENT) {
    throw new HttpsError(
      "invalid-argument",
      `cardFeePercent is hard-capped at ${MAX_CARD_FEE_PERCENT}% (Visa/Mastercard Canada ceiling).`,
    );
  }
  return n;
}

export async function updatePaymentSettingsHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);

  const data = (request.data as Input | undefined) ?? {};

  // Pre-validate fields so we fail fast before opening the transaction.
  let nextEtransferEmail: string | null | undefined;
  if ("etransferEmail" in data) {
    nextEtransferEmail = validNullableEmail(data.etransferEmail);
  }
  let nextCharge: boolean | undefined;
  if ("chargeCustomerCardFees" in data) {
    if (typeof data.chargeCustomerCardFees !== "boolean") {
      throw new HttpsError(
        "invalid-argument",
        "chargeCustomerCardFees must be a boolean.",
      );
    }
    nextCharge = data.chargeCustomerCardFees;
  }
  let nextFee: number | undefined;
  if ("cardFeePercent" in data) {
    nextFee = validCardFeePercent(data.cardFeePercent);
  }
  let ackNow = false;
  if ("acknowledgeSurcharge" in data) {
    if (typeof data.acknowledgeSurcharge !== "boolean") {
      throw new HttpsError(
        "invalid-argument",
        "acknowledgeSurcharge must be a boolean.",
      );
    }
    ackNow = data.acknowledgeSurcharge;
  }

  if (
    nextEtransferEmail === undefined &&
    nextCharge === undefined &&
    nextFee === undefined &&
    !ackNow
  ) {
    throw new HttpsError("invalid-argument", "No editable fields supplied.");
  }

  const metaRef = db.doc(`tenants/${tenantId}/meta/settings`);

  // Transaction: read current meta, compute final state, refuse if the
  // surcharge-acknowledgment invariant is violated. Atomic so two concurrent
  // updates can't race past the invariant check.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(metaRef);
    if (!snap.exists) {
      throw new HttpsError(
        "not-found",
        "Tenant settings not found.",
      );
    }
    const current = snap.data() as {
      chargeCustomerCardFees: boolean;
      cardFeePercent: number;
      etransferEmail: string | null;
      surchargeAcknowledgedAt: unknown;
    };

    const patch: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (nextEtransferEmail !== undefined) {
      patch.etransferEmail = nextEtransferEmail;
    }
    if (nextCharge !== undefined) {
      patch.chargeCustomerCardFees = nextCharge;
    }
    if (nextFee !== undefined) {
      patch.cardFeePercent = nextFee;
    }
    // Stamp acknowledgment only if not already set (audit trail is immutable).
    if (ackNow && !current.surchargeAcknowledgedAt) {
      patch.surchargeAcknowledgedAt = FieldValue.serverTimestamp();
    }

    const finalCharge =
      nextCharge !== undefined ? nextCharge : current.chargeCustomerCardFees;
    const finalAck = ackNow || Boolean(current.surchargeAcknowledgedAt);

    if (finalCharge && !finalAck) {
      throw new HttpsError(
        "failed-precondition",
        "Cannot enable card surcharging without first acknowledging the Visa/Mastercard terms.",
      );
    }

    tx.set(metaRef, patch, { merge: true });
  });

  return { ok: true };
}

export const updatePaymentSettings = onCall<Input>(
  updatePaymentSettingsHandler,
);
