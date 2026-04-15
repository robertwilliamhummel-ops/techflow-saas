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

export interface TenantEntitlements {
  plan: "starter" | "standard" | "pro";
  maxInvoicesPerMonth: number | null;
  features: Record<string, boolean>;
  updatedAt: Timestamp;
}

export interface TenantCounter {
  value: number;
  updatedAt: Timestamp;
}

export interface TenantSnapshot {
  name: string;
  logoDataUrl: string | null;
  address: string | null;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  taxRate: number;
  taxName: string;
  businessNumber: string | null;
  currency: CurrencyCode;
  emailFooter: string | null;
  capturedAt: Timestamp;
}

export interface CustomerRef {
  customerId: string;
  name: string;
  email: string;
  phone: string | null;
}

export interface LineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  taxable: boolean;
}

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "void"
  | "refunded";

export interface Invoice {
  tenantId: string;
  number: string;
  status: InvoiceStatus;
  customer: CustomerRef;
  lineItems: LineItem[];
  subtotal: number;
  taxTotal: number;
  total: number;
  amountPaid: number;
  amountDue: number;
  currency: CurrencyCode;
  issuedAt: Timestamp;
  dueAt: Timestamp | null;
  paidAt: Timestamp | null;
  tenantSnapshot: TenantSnapshot;
  payTokenVersion: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired"
  | "converted";

export interface Quote {
  tenantId: string;
  number: string;
  status: QuoteStatus;
  customer: CustomerRef;
  lineItems: LineItem[];
  subtotal: number;
  taxTotal: number;
  total: number;
  currency: CurrencyCode;
  validUntil: Timestamp | null;
  convertedInvoiceId: string | null;
  tenantSnapshot: TenantSnapshot;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Customer {
  tenantId: string;
  name: string;
  email: string; // always stored lowercased
  phone: string | null;
  address: string | null;
  notes: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type MembershipRole = "owner" | "admin" | "staff";

export interface UserTenantMembership {
  uid: string;
  tenantId: string;
  role: MembershipRole;
  createdAt: Timestamp;
}

export interface UserDoc {
  uid: string;
  email: string; // lowercased
  displayName: string | null;
  defaultTenantId: string | null;
  createdAt: Timestamp;
}

export interface CustomDomain {
  domain: string;
  tenantId: string;
  status: CustomDomainStage;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface StripeAccountIndex {
  stripeAccountId: string;
  tenantId: string;
  updatedAt: Timestamp;
}

export interface PlatformAdmin {
  uid: string;
  email: string;
  grantedAt: Timestamp;
  grantedBy: string | null;
}
