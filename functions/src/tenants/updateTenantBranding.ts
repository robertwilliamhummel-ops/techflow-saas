import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { isValidHexColor, meetsWcagAA } from "../shared/contrast";

// Whitelisted branding + business-identity fields editable via the settings
// page. Stripe/payment fields live on updatePaymentSettings. Custom-domain
// setup is its own flow (Phase 5). Every color is re-validated against WCAG
// AA vs white here, independent of any client-side check.
interface Input {
  name?: unknown;
  address?: unknown;
  logoUrl?: unknown;
  faviconUrl?: unknown;
  primaryColor?: unknown;
  secondaryColor?: unknown;
  fontFamily?: unknown;
  emailFooter?: unknown;
  invoicePrefix?: unknown;
  businessNumber?: unknown;
  taxRate?: unknown;
  taxName?: unknown;
  currency?: unknown;
}

const INVOICE_PREFIX_RE = /^[A-Z0-9]{1,10}$/;

function validString(
  raw: unknown,
  opts: { field: string; min: number; max: number },
): string {
  const s = String(raw ?? "").trim();
  if (s.length < opts.min || s.length > opts.max) {
    throw new HttpsError(
      "invalid-argument",
      `${opts.field} must be ${opts.min}–${opts.max} characters.`,
    );
  }
  return s;
}

function validNullableString(
  raw: unknown,
  opts: { field: string; max: number },
): string | null {
  if (raw === null) return null;
  const s = String(raw ?? "").trim();
  if (s.length === 0) return null;
  if (s.length > opts.max) {
    throw new HttpsError(
      "invalid-argument",
      `${opts.field} must be <= ${opts.max} characters.`,
    );
  }
  return s;
}

function validHttpsUrl(raw: unknown, field: string): string | null {
  if (raw === null) return null;
  const s = String(raw ?? "").trim();
  if (s.length === 0) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") throw new Error("not https");
    if (s.length > 2048) throw new Error("too long");
    return s;
  } catch {
    throw new HttpsError(
      "invalid-argument",
      `${field} must be a valid https URL.`,
    );
  }
}

function validColor(raw: unknown, field: string): string {
  if (!isValidHexColor(raw)) {
    throw new HttpsError(
      "invalid-argument",
      `${field} must be a hex color (e.g. #0066CC).`,
    );
  }
  const s = raw.trim();
  if (!meetsWcagAA(s, "#FFFFFF")) {
    throw new HttpsError(
      "failed-precondition",
      `${field} does not meet WCAG AA contrast (4.5:1) against white. Pick a darker shade.`,
    );
  }
  return s.startsWith("#") ? s : `#${s}`;
}

function validCurrency(raw: unknown): "CAD" | "USD" {
  if (raw === "CAD" || raw === "USD") return raw;
  throw new HttpsError("invalid-argument", "currency must be CAD or USD.");
}

function validTaxRate(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new HttpsError(
      "invalid-argument",
      "taxRate must be a number between 0 and 1 (e.g. 0.13 for 13%).",
    );
  }
  return n;
}

function validInvoicePrefix(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!INVOICE_PREFIX_RE.test(s)) {
    throw new HttpsError(
      "invalid-argument",
      "invoicePrefix must be 1–10 uppercase letters/digits.",
    );
  }
  return s;
}

export async function updateTenantBrandingHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);

  const data = (request.data as Input | undefined) ?? {};
  const patch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if ("name" in data) {
    patch.name = validString(data.name, { field: "name", min: 2, max: 100 });
  }
  if ("address" in data) {
    patch.address = validNullableString(data.address, {
      field: "address",
      max: 500,
    });
  }
  if ("logoUrl" in data) {
    patch.logoUrl = validHttpsUrl(data.logoUrl, "logoUrl");
  }
  if ("faviconUrl" in data) {
    patch.faviconUrl = validHttpsUrl(data.faviconUrl, "faviconUrl");
  }
  if ("primaryColor" in data) {
    patch.primaryColor = validColor(data.primaryColor, "primaryColor");
  }
  if ("secondaryColor" in data) {
    patch.secondaryColor = validColor(data.secondaryColor, "secondaryColor");
  }
  if ("fontFamily" in data) {
    patch.fontFamily = validString(data.fontFamily, {
      field: "fontFamily",
      min: 1,
      max: 50,
    });
  }
  if ("emailFooter" in data) {
    patch.emailFooter = validNullableString(data.emailFooter, {
      field: "emailFooter",
      max: 500,
    });
  }
  if ("invoicePrefix" in data) {
    patch.invoicePrefix = validInvoicePrefix(data.invoicePrefix);
  }
  if ("businessNumber" in data) {
    patch.businessNumber = validNullableString(data.businessNumber, {
      field: "businessNumber",
      max: 50,
    });
  }
  if ("taxRate" in data) {
    patch.taxRate = validTaxRate(data.taxRate);
  }
  if ("taxName" in data) {
    patch.taxName = validString(data.taxName, {
      field: "taxName",
      min: 1,
      max: 20,
    });
  }
  if ("currency" in data) {
    patch.currency = validCurrency(data.currency);
  }

  if (Object.keys(patch).length === 1) {
    throw new HttpsError("invalid-argument", "No editable fields supplied.");
  }

  await db.doc(`tenants/${tenantId}/meta/settings`).set(patch, { merge: true });
  return { ok: true };
}

export const updateTenantBranding = onCall<Input>(updateTenantBrandingHandler);
