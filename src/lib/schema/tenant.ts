// Client-side read shapes for Firestore documents. Mirrors what Cloud
// Functions actually write (functions/src/shared/schema.ts, invoice.ts,
// quote.ts). Clients never write these documents — rules deny it.

import type { Timestamp } from "firebase/firestore";

export type CurrencyCode = "CAD" | "USD";

export type CustomDomainStage =
  | "unverified"
  | "dns_pending"
  | "ssl_pending"
  | "verified"
  | "error";

export interface CustomDomainStatus {
  stage: CustomDomainStage;
  message: string | null;
  checkedAt: Timestamp | null;
}

export interface StripeStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
  disabledReason: string | null;
  updatedAt: Timestamp;
}

// tenants/{tenantId}/meta/settings
export interface TenantMeta {
  name: string;
  logoUrl: string | null;
  address: string | null;

  // Branding — required from Phase 1 per blueprint.
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  faviconUrl: string | null;

  // Custom domain.
  customDomain: string | null;
  customDomainStatus: CustomDomainStatus;

  // Invoicing config.
  taxRate: number;
  taxName: string;
  businessNumber: string | null;
  invoicePrefix: string;
  emailFooter: string | null;
  currency: CurrencyCode;

  // Stripe Connect.
  stripeAccountId: string | null;
  stripeStatus: StripeStatus;

  // Payment preferences.
  etransferEmail: string | null;
  chargeCustomerCardFees: boolean;
  cardFeePercent: number;
  surchargeAcknowledgedAt: Timestamp | null;

  // Lifecycle.
  deletedAt: Timestamp | null;
  createdAt: Timestamp;
}

// tenants/{tenantId}/entitlements/current
export interface TenantEntitlements {
  plan: "starter" | "standard" | "pro";
  maxInvoicesPerMonth: number | null;
  features: Record<string, boolean>;
  updatedAt: Timestamp;
}

// tenants/{tenantId}/counters/{invoice|quote}
export interface TenantCounter {
  value: number;
  updatedAt: Timestamp;
}

// Frozen branding embedded on every invoice/quote at creation.
export interface TenantSnapshot {
  version: number;
  name: string;
  logo: string | null; // base64 data URL
  address: string | null;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  faviconUrl: string | null;
  taxRate: number;
  taxName: string;
  businessNumber: string | null;
  emailFooter: string | null;
  currency: CurrencyCode;
  chargeCustomerCardFees: boolean;
  cardFeePercent: number;
  etransferEmail: string | null;
}

export interface DocumentCustomer {
  name: string;
  email: string; // always stored lowercased
  phone: string | null;
}

// D4 — every line carries its own taxability.
export interface LineItem {
  description: string;
  quantity: number;
  rate: number;
  taxable: boolean;
  amount: number;
}

export interface TaxLine {
  name: string;
  rate: number;
  taxableAmount: number;
  amount: number;
}

// Dollar amounts, rounded to cents server-side.
export interface DocumentTotals {
  subtotal: number;
  taxableSubtotal: number;
  taxRate: number;
  taxAmount: number;
  taxes: TaxLine[];
  total: number;
}

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "unpaid"
  | "overdue"
  | "partial"
  | "paid"
  | "refunded"
  | "partially-refunded";

export type PaymentMethod = "manual" | "etransfer" | "cash" | "card";

// tenants/{tenantId}/invoices/{invoiceNumber} — doc id IS the invoice number.
export interface Invoice {
  customer: DocumentCustomer;
  lineItems: LineItem[];
  applyTax: boolean; // default taxability for new lines
  totals: DocumentTotals;
  tenantSnapshot: TenantSnapshot;
  status: InvoiceStatus;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  notes: string | null;
  payToken: string;
  payTokenExpiresAt: Timestamp; // display only — JWT exp is authoritative
  payTokenVersion: number;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  sentAt?: Timestamp;
  sourceQuoteId?: string | null;
  sourceRecurringInvoiceId?: string | null;

  paidAt?: Timestamp | null;
  paymentMethod?: PaymentMethod | null;
  paidAmountCents?: number | null;
  surchargeAmountCents?: number | null;
  stripeChargeId?: string | null;
  refundedAt?: Timestamp | null;
  refundedAmountCents?: number | null;
  disputed?: boolean;
  disputedAt?: Timestamp | null;
  disputeReason?: string | null;
  disputeOutcome?: "won" | "lost" | null;
}

export type QuoteStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "declined"
  | "expired"
  | "converted";

// tenants/{tenantId}/quotes/{quoteNumber}
export interface Quote {
  customer: DocumentCustomer;
  lineItems: LineItem[];
  applyTax: boolean;
  totals: DocumentTotals;
  tenantSnapshot: TenantSnapshot;
  status: QuoteStatus;
  issueDate: string;
  validUntil: string;
  notes: string | null;
  createdAt: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  sentAt?: Timestamp;
  convertedToInvoiceId?: string;
}

export type MembershipRole = "owner" | "admin" | "staff";

// userTenantMemberships/{uid}_{tenantId}
export interface UserTenantMembership {
  uid: string;
  tenantId: string;
  role: MembershipRole;
  invitedBy: string | null;
  createdAt: Timestamp;
  deletedAt: Timestamp | null;
}

// users/{uid}
export interface UserDoc {
  uid: string;
  email: string; // lowercased
  displayName: string | null;
  defaultTenantId: string | null;
  createdAt: Timestamp;
}

// customDomains/{domain} — admin SDK only.
export interface CustomDomain {
  tenantId: string;
  createdAt: Timestamp;
}

// stripeAccounts/{stripeAccountId} — admin SDK only.
export interface StripeAccountIndex {
  tenantId: string;
  linkedAt: Timestamp;
}
