// Body shape validation for the render endpoints. The Next.js proxy is the
// authoritative gatekeeper, but Cloud Run still must not crash on a malformed
// snapshot (an attacker who somehow got the API key shouldn't be able to OOM
// Chrome with a 50MB notes string).

import type {
  RenderInvoiceRequest,
  RenderQuoteRequest,
  TenantSnapshot,
  LineItem,
} from "./types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const MAX_NOTES = 4_000;
const MAX_DESCRIPTION = 1_000;
const MAX_LINE_ITEMS = 200;
const MAX_LOGO_DATA_URL = 800_000; // base64 inflates ~33% — 500KB raw → ~670KB encoded.

export function validateInvoiceBody(input: unknown): RenderInvoiceRequest {
  const body = requireObject(input, "body");
  const snapshot = validateSnapshot(body.snapshot);
  const data = requireObject(body.data, "data");

  const invoiceId = requireString(data.invoiceId, "data.invoiceId", 64);
  const issueDate = requireString(data.issueDate, "data.issueDate", 32);
  const dueDate = requireString(data.dueDate, "data.dueDate", 32);
  const status = requireString(data.status, "data.status", 32);
  const customer = validateCustomer(data.customer);
  const lineItems = validateLineItems(data.lineItems);
  const totals = validateTotals(data.totals);
  const notes = optionalString(data.notes, "data.notes", MAX_NOTES);

  const paidVia =
    data.paidVia == null
      ? null
      : optionalEnum(
          data.paidVia,
          "data.paidVia",
          ["card", "etransfer", "cash", "manual", "stripe"],
        );
  const paidAt = optionalString(data.paidAt, "data.paidAt", 64);
  const surchargeAmountCents = optionalFiniteNumber(
    data.surchargeAmountCents,
    "data.surchargeAmountCents",
  );
  const payUrl = optionalHttpsUrl(data.payUrl, "data.payUrl");

  return {
    snapshot,
    data: {
      invoiceId,
      issueDate,
      dueDate,
      status,
      customer,
      lineItems,
      totals,
      notes,
      paidVia,
      paidAt,
      surchargeAmountCents,
      payUrl,
    },
  };
}

export function validateQuoteBody(input: unknown): RenderQuoteRequest {
  const body = requireObject(input, "body");
  const snapshot = validateSnapshot(body.snapshot);
  const data = requireObject(body.data, "data");

  return {
    snapshot,
    data: {
      quoteId: requireString(data.quoteId, "data.quoteId", 64),
      issueDate: requireString(data.issueDate, "data.issueDate", 32),
      validUntil: requireString(data.validUntil, "data.validUntil", 32),
      status: requireString(data.status, "data.status", 32),
      customer: validateCustomer(data.customer),
      lineItems: validateLineItems(data.lineItems),
      totals: validateTotals(data.totals),
      notes: optionalString(data.notes, "data.notes", MAX_NOTES),
    },
  };
}

function validateSnapshot(input: unknown): TenantSnapshot {
  const s = requireObject(input, "snapshot");
  const logo = optionalString(s.logo, "snapshot.logo", MAX_LOGO_DATA_URL);
  if (logo && !/^data:image\//i.test(logo)) {
    throw new ValidationError(
      "snapshot.logo must be a data:image/* URL or null.",
    );
  }
  return {
    version: Number(s.version ?? 1),
    name: requireString(s.name, "snapshot.name", 200),
    logo,
    address: optionalString(s.address, "snapshot.address", 500),
    primaryColor: requireString(s.primaryColor, "snapshot.primaryColor", 32),
    secondaryColor: requireString(s.secondaryColor, "snapshot.secondaryColor", 32),
    fontFamily: requireString(s.fontFamily, "snapshot.fontFamily", 64),
    faviconUrl: optionalString(s.faviconUrl, "snapshot.faviconUrl", 1024),
    taxRate: Number(s.taxRate ?? 0),
    taxName: optionalString(s.taxName, "snapshot.taxName", 32) ?? "",
    businessNumber: optionalString(s.businessNumber, "snapshot.businessNumber", 64),
    emailFooter: optionalString(s.emailFooter, "snapshot.emailFooter", 1_000),
    currency: requireString(s.currency, "snapshot.currency", 8),
    chargeCustomerCardFees: s.chargeCustomerCardFees === true,
    cardFeePercent: Number(s.cardFeePercent ?? 0),
    etransferEmail: optionalString(s.etransferEmail, "snapshot.etransferEmail", 200),
  };
}

function validateCustomer(input: unknown): {
  name: string;
  email: string;
  phone: string | null;
} {
  const c = requireObject(input, "customer");
  return {
    name: requireString(c.name, "customer.name", 200),
    email: requireString(c.email, "customer.email", 320),
    phone: optionalString(c.phone, "customer.phone", 64),
  };
}

function validateLineItems(input: unknown): LineItem[] {
  if (!Array.isArray(input)) {
    throw new ValidationError("data.lineItems must be an array.");
  }
  if (input.length === 0) {
    throw new ValidationError("data.lineItems must not be empty.");
  }
  if (input.length > MAX_LINE_ITEMS) {
    throw new ValidationError(`data.lineItems exceeds max of ${MAX_LINE_ITEMS}.`);
  }
  return input.map((raw, i) => {
    const li = requireObject(raw, `data.lineItems[${i}]`);
    return {
      description: requireString(
        li.description,
        `data.lineItems[${i}].description`,
        MAX_DESCRIPTION,
      ),
      quantity: requireFiniteNumber(li.quantity, `data.lineItems[${i}].quantity`),
      rate: requireFiniteNumber(li.rate, `data.lineItems[${i}].rate`),
      amount: requireFiniteNumber(li.amount, `data.lineItems[${i}].amount`),
    };
  });
}

function validateTotals(input: unknown): {
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
} {
  const t = requireObject(input, "data.totals");
  return {
    subtotal: requireFiniteNumber(t.subtotal, "data.totals.subtotal"),
    taxRate: requireFiniteNumber(t.taxRate, "data.totals.taxRate"),
    taxAmount: requireFiniteNumber(t.taxAmount, "data.totals.taxAmount"),
    total: requireFiniteNumber(t.total, "data.totals.total"),
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  path: string,
  maxLen: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${path} must be a non-empty string.`);
  }
  if (value.length > maxLen) {
    throw new ValidationError(`${path} exceeds max length ${maxLen}.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  path: string,
  maxLen: number,
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${path} must be a string or null.`);
  }
  if (value.length > maxLen) {
    throw new ValidationError(`${path} exceeds max length ${maxLen}.`);
  }
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T | null {
  if (value == null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(
      `${path} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

function requireFiniteNumber(value: unknown, path: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${path} must be a finite number.`);
  }
  return n;
}

function optionalFiniteNumber(value: unknown, path: string): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${path} must be a finite number or null.`);
  }
  return n;
}

function optionalHttpsUrl(value: unknown, path: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${path} must be a string or null.`);
  }
  if (!/^https:\/\//i.test(value)) {
    throw new ValidationError(`${path} must use https://.`);
  }
  if (value.length > 2_048) {
    throw new ValidationError(`${path} exceeds max length 2048.`);
  }
  return value;
}
