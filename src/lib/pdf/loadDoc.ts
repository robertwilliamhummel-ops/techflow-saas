// Server-side loaders that pull an invoice or quote out of Firestore and shape
// it into the wire format the Cloud Run pdf-service expects.
//
// Reads the invoice's frozen `tenantSnapshot` — never the tenant's current
// branding — to preserve the legal-document contract.

import { getAdminDb } from "@/lib/firebase/admin";
import { resolveFeature, type FeatureKey } from "@/lib/features";
import { PDF_NOT_FOUND } from "@/lib/pdf/auth";
import { cardPaymentsReady } from "@/lib/stripe/cardPaymentsReady";
import { portalOriginFor } from "@/lib/tenant/portalOrigin";

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

/**
 * Checks the caller against the document as soon as it is read, before
 * anything else about it shows in the answer; throws to refuse.
 */
export type AuthorizeLoadedDoc = (doc: { customerEmail: string; status: string }) => void;

/**
 * `platformBaseUrl` is the shared portal host; a business's verified custom
 * domain replaces it in the PDF's pay link, as in its emails.
 */
export async function loadInvoiceForPdf(
  tenantId: string,
  invoiceId: string,
  platformBaseUrl: string,
  authorize: AuthorizeLoadedDoc,
): Promise<LoadedInvoice> {
  const db = getAdminDb();
  const [snap, metaSnap, overrides] = await Promise.all([
    db.doc(`tenants/${tenantId}/invoices/${invoiceId}`).get(),
    db.doc(`tenants/${tenantId}/meta/settings`).get(),
    readFeatureOverrides(tenantId),
  ]);
  const data = readAuthorized(snap, authorize);
  requireFeatureEnabled(overrides, "invoices");
  const customerEmail = customerEmailOf(data);
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

  const meta = metaSnap.exists
    ? (metaSnap.data() as Record<string, unknown>)
    : null;
  // A-12: a void invoice's PDF must not offer a way to pay it. The card
  // section (QR code and pay link) appears only when the pay page would offer
  // a card — stripePayments on and a Stripe account that can take charges, the
  // rule of the Cloud Functions builder (functions/src/shared/documentPdf.ts) —
  // so an e-Transfer-only business's PDF never leads to a dead end (F-08).
  const cardReady =
    resolveFeature("stripePayments", overrides) && cardPaymentsReady(meta);
  const payToken =
    typeof data.payToken === "string" && data.status !== "void" && cardReady
      ? data.payToken
      : null;
  const payOrigin = portalOriginFor(meta, platformBaseUrl);
  const payUrl = payToken
    ? `${payOrigin}/pay/${encodeURIComponent(payToken)}`
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
  authorize: AuthorizeLoadedDoc,
): Promise<LoadedQuote> {
  const [snap, overrides] = await Promise.all([
    getAdminDb().doc(`tenants/${tenantId}/quotes/${quoteId}`).get(),
    readFeatureOverrides(tenantId),
  ]);
  const data = readAuthorized(snap, authorize);
  requireFeatureEnabled(overrides, "quotes");
  const customerEmail = customerEmailOf(data);
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

// A missing document answers exactly like one the caller may not see.
function readAuthorized(
  snap: { exists: boolean; data(): unknown },
  authorize: AuthorizeLoadedDoc,
): Record<string, unknown> {
  if (!snap.exists) throw new PdfLoadError(404, PDF_NOT_FOUND);
  const data = snap.data() as Record<string, unknown>;
  authorize({
    customerEmail: customerEmailOf(data),
    status: typeof data.status === "string" ? data.status : "",
  });
  return data;
}

function customerEmailOf(data: Record<string, unknown>): string {
  const customer = (data.customer as { email?: unknown } | undefined) ?? {};
  return typeof customer.email === "string" ? customer.email : "";
}

async function readFeatureOverrides(
  tenantId: string,
): Promise<Record<string, boolean> | null> {
  const snap = await getAdminDb()
    .doc(`tenants/${tenantId}/entitlements/current`)
    .get();
  return snap.exists
    ? ((snap.data() as { features?: Record<string, boolean> }).features ?? null)
    : null;
}

function requireFeatureEnabled(
  overrides: Record<string, boolean> | null,
  feature: FeatureKey,
): void {
  if (!resolveFeature(feature, overrides)) {
    throw new PdfLoadError(403, `Feature "${feature}" is not enabled for this tenant.`);
  }
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
