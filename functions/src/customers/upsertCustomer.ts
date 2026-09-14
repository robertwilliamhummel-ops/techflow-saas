// upsertCustomer — A-10.
//
// Tenant callable: creates a customer record, or updates one when `customerId`
// is given. Any role. Not feature-gated — customers are part of every plan.
//
// Emails aren't unique: one address can legitimately front several billing
// entities (a property manager for several buildings). Stripe doesn't enforce
// it either.
//
// Invoices, quotes, and recurring templates copy the customer at creation, so
// editing a record never rewrites an issued document.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { isValidEmail, lowerEmail } from "../shared/email";
import { withSentryCallable } from "../shared/withSentry";

export interface CustomerFields {
  name: string;
  email: string; // lowercased
  phone: string | null;
  address: string | null;
  notes: string | null;
}

export function validateCustomerInput(data: unknown): CustomerFields {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") {
    throw new HttpsError("invalid-argument", "Customer data required.");
  }

  const name = String(d.name ?? "").trim();
  if (!name || name.length > 200) {
    throw new HttpsError("invalid-argument", "name must be 1–200 characters.");
  }

  // C2 fix — lowercase email at the write boundary, ALWAYS.
  if (!isValidEmail(d.email)) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }

  return {
    name,
    email: lowerEmail(d.email),
    phone: optionalText(d.phone, "phone", 50),
    address: optionalText(d.address, "address", 500),
    notes: optionalText(d.notes, "notes", 2000),
  };
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  const text = value != null ? String(value).trim() || null : null;
  if (text && text.length > max) {
    throw new HttpsError(
      "invalid-argument",
      `${field} must be ≤${max} characters.`,
    );
  }
  return text;
}

export async function upsertCustomerHandler(
  request: CallableRequest,
): Promise<{ customerId: string; created: boolean }> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);

  const data = request.data as Record<string, unknown> | undefined;
  const fields = validateCustomerInput(data);
  const customers = db.collection(`tenants/${tenantId}/customers`);

  if (data?.customerId == null) {
    const ref = customers.doc();
    await ref.create({
      ...fields,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
      updatedAt: null,
      updatedBy: null,
    });
    return { customerId: ref.id, created: true };
  }

  const customerId = requireDocId(data.customerId, "customerId");
  const ref = customers.doc(customerId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Customer not found.");
    }
    tx.update(ref, {
      ...fields,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    });
  });
  return { customerId, created: false };
}

export const upsertCustomer = onCall(
  withSentryCallable("upsertCustomer", upsertCustomerHandler),
);
