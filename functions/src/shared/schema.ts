// Admin-side write shapes. Mirrors src/lib/schema/tenant.ts but uses
// firebase-admin Timestamps and field-value sentinels so callables can write
// without importing client SDK types.

import type { FieldValue, Timestamp } from "firebase-admin/firestore";

export type CurrencyCode = "CAD" | "USD";
export type MembershipRole = "owner" | "admin" | "staff";

export interface CustomDomainStatus {
  stage: "unverified" | "dns_pending" | "ssl_pending" | "verified" | "error";
  message: string | null;
  checkedAt: Timestamp | FieldValue | null;
}

export interface StripeStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
  disabledReason: string | null;
  updatedAt: Timestamp | FieldValue;
}

export interface TenantMetaWrite {
  name: string;
  logoUrl: string | null;
  address: string | null;

  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  faviconUrl: string | null;

  customDomain: string | null;
  customDomainStatus: CustomDomainStatus;

  taxRate: number;
  taxName: string;
  businessNumber: string | null;
  invoicePrefix: string;
  emailFooter: string | null;
  currency: CurrencyCode;

  stripeAccountId: string | null;
  stripeStatus: StripeStatus;

  etransferEmail: string | null;
  chargeCustomerCardFees: boolean;
  cardFeePercent: number;
  surchargeAcknowledgedAt: Timestamp | FieldValue | null;

  deletedAt: Timestamp | FieldValue | null;
  createdAt: Timestamp | FieldValue;
}

export interface InvitationWrite {
  tenantId: string;
  email: string; // lowercased
  role: MembershipRole;
  tokenHash: string; // sha-256 hex of the raw token
  invitedBy: string; // uid
  createdAt: Timestamp | FieldValue;
  expiresAt: Timestamp;
  acceptedAt: Timestamp | FieldValue | null;
  revokedAt: Timestamp | FieldValue | null;
}
