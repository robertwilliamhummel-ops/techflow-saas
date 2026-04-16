import { FieldValue } from "firebase-admin/firestore";
import type { TenantMetaWrite } from "./schema";

// Sensible defaults applied to every newly provisioned tenant. Every field
// here MUST be initialized — the first invoice's tenantSnapshot freezes these
// values, and any `undefined` crashes PDF rendering / tax math silently. This
// is the single most expensive-to-debug bug in the whole plan.
export function defaultTenantMeta(name: string): TenantMetaWrite {
  return {
    name,
    logoUrl: null,
    address: null,

    primaryColor: "#667eea",
    secondaryColor: "#764ba2",
    fontFamily: "Inter",
    faviconUrl: null,

    customDomain: null,
    customDomainStatus: {
      stage: "unverified",
      message: null,
      checkedAt: null,
    },

    taxRate: 0.13,
    taxName: "HST",
    businessNumber: null,
    invoicePrefix: "INV",
    emailFooter: null,
    currency: "CAD",

    stripeAccountId: null,
    stripeStatus: {
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      currentlyDue: [],
      disabledReason: null,
      updatedAt: FieldValue.serverTimestamp(),
    },

    etransferEmail: null,
    chargeCustomerCardFees: false,
    cardFeePercent: 2.4,
    surchargeAcknowledgedAt: null,

    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  };
}
