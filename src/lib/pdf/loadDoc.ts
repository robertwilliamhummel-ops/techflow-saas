// Server-side loaders that pull an invoice or quote out of Firestore and shape
// it into the wire format the Cloud Run pdf-service expects.
//
// Reads the invoice's frozen `tenantSnapshot` — never the tenant's current
// branding — to preserve the legal-document contract.

import { getAdminDb } from "@/lib/firebase/admin";
import { resolveFeature, type FeatureKey } from "@/lib/features";

export class PdfLoadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PdfLoadError";
    this.status = status;
  }
}

export interface LoadedInvoice {
  customerEmail: string;
  /** The stored status, "" when missing — the routes hide drafts from customers (S-08). */
  status: string;
  body: {
    snapshot: Record<string, unknown>;
    data: Record<string, unknown>;
  };
}

export async function loadInvoiceForPdf(
  tenantId: string,
  invoiceId: string,
  platformBaseUrl: string,
): Promise<LoadedInvoice> {
  const overrides = await requireFeatureEnabled(tenantId, "invoices");
  const snap = await getAdminDb()
    .doc(`tenants/${tenantId}/invoices/${invoiceId}`)
    .get();
  if (!snap.exists) {
    throw new PdfLoadError(404, "Invoice not found.");
  }
  const data = snap.data() as Record<string, unknown>;
  const customer = (data.customer as { email?: unknown } | undefined) ?? {};
  const customerEmail = typeof customer.email === "string" ? customer.email : "";
  if (!customerEmail) {
    throw new PdfLoadError(409, "Invoice has no customer email.");
  }

  const frozenSnapshot = data.tenantSnapshot as
    | Record<string, unknown>
    | undefined;
  if (!frozenSnapshot) {
    throw new PdfLoadError(409, "Invoice is missing tenantSnapshot.");
  }
  // D3 kill switch — never disclose a surcharge the platform won't charge.
  const snapshot = {
    ...frozenSnapshot,
    chargeCustomerCardFees:
      frozenSnapshot.chargeCustomerCardFees === true &&
      resolveFeature("cardSurcharge", overrides),
  };

  // A-12: a void invoice's PDF must not offer a way to pay it.
  const payToken =
    typeof data.payToken === "string" && data.status !== "void"
      ? data.payToken
      : null;
  const payUrl = payToken
    ? `${platformBaseUrl.replace(/\/+$/, "")}/pay/${payToken}`
    : null;

  return {
    customerEmail,
    status: typeof data.status === "string" ? data.status : "",
    body: {
      snapshot,
      data: {
        invoiceId,
        issueDate: String(data.issueDate ?? ""),
        dueDate: String(data.dueDate ?? ""),
        status: String(data.status ?? "sent"),
        customer: {
          name: String((data.customer as { name?: unknown }).name ?? ""),
          email: customerEmail,
          phone:
            (data.customer as { phone?: string | null }).phone ?? null,
        },
        lineItems: (data.lineItems as unknown[]) ?? [],
        totals: (data.totals as Record<string, unknown>) ?? {},
        notes:
          typeof data.notes === "string" || data.notes === null
            ? data.notes
            : null,
        paidVia: deriveStringOrNull(data.paymentMethod),
        paidAt: serializeTimestamp(data.paidAt),
        surchargeAmountCents:
          typeof data.surchargeAmountCents === "number"
            ? data.surchargeAmountCents
            : null,
        payUrl,
      },
    },
  };
}

export interface LoadedQuote {
  customerEmail: string;
  /** The stored status, "" when missing — the routes hide drafts from customers (S-08). */
  status: string;
  body: {
    snapshot: Record<string, unknown>;
    data: Record<string, unknown>;
  };
}

export async function loadQuoteForPdf(
  tenantId: string,
  quoteId: string,
): Promise<LoadedQuote> {
  await requireFeatureEnabled(tenantId, "quotes");
  const snap = await getAdminDb()
    .doc(`tenants/${tenantId}/quotes/${quoteId}`)
    .get();
  if (!snap.exists) {
    throw new PdfLoadError(404, "Quote not found.");
  }
  const data = snap.data() as Record<string, unknown>;
  const customer = (data.customer as { email?: unknown } | undefined) ?? {};
  const customerEmail = typeof customer.email === "string" ? customer.email : "";
  if (!customerEmail) {
    throw new PdfLoadError(409, "Quote has no customer email.");
  }

  const snapshot = data.tenantSnapshot as Record<string, unknown> | undefined;
  if (!snapshot) {
    throw new PdfLoadError(409, "Quote is missing tenantSnapshot.");
  }

  return {
    customerEmail,
    status: typeof data.status === "string" ? data.status : "",
    body: {
      snapshot,
      data: {
        quoteId,
        issueDate: String(data.issueDate ?? ""),
        validUntil: String(data.validUntil ?? ""),
        status: String(data.status ?? "sent"),
        customer: {
          name: String((data.customer as { name?: unknown }).name ?? ""),
          email: customerEmail,
          phone:
            (data.customer as { phone?: string | null }).phone ?? null,
        },
        lineItems: (data.lineItems as unknown[]) ?? [],
        totals: (data.totals as Record<string, unknown>) ?? {},
        notes:
          typeof data.notes === "string" || data.notes === null
            ? data.notes
            : null,
      },
    },
  };
}

async function requireFeatureEnabled(
  tenantId: string,
  feature: FeatureKey,
): Promise<Record<string, boolean> | null> {
  const snap = await getAdminDb()
    .doc(`tenants/${tenantId}/entitlements/current`)
    .get();
  const overrides = snap.exists
    ? ((snap.data() as { features?: Record<string, boolean> }).features ?? null)
    : null;
  if (!resolveFeature(feature, overrides)) {
    throw new PdfLoadError(403, `Feature "${feature}" is not enabled for this tenant.`);
  }
  return overrides;
}

function deriveStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function serializeTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  // Firestore Timestamp shape — { toDate(): Date }.
  if (typeof value === "object" && value !== null) {
    const maybe = value as { toDate?: () => Date; seconds?: number };
    if (typeof maybe.toDate === "function") {
      return maybe.toDate().toISOString().slice(0, 10);
    }
    if (typeof maybe.seconds === "number") {
      return new Date(maybe.seconds * 1000).toISOString().slice(0, 10);
    }
  }
  return null;
}
