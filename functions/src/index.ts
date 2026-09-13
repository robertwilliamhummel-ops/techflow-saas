// MUST stay the first import — sets the default region (D2) before any
// function module below is evaluated. See shared/globalOptions.ts.
import "./shared/globalOptions";

// Shared admin-app init lives in shared/admin.ts and self-guards against
// double init. Every callable imports from there, so no initialization code
// is needed here.

// Bundle A — Tenant lifecycle (Phase 2).
export { onSignup } from "./tenants/onSignup";
export { setUserRole } from "./tenants/setUserRole";
export { updateUserProfile } from "./tenants/updateUserProfile";
export { createInvitation } from "./tenants/createInvitation";
export { onAcceptInvite } from "./tenants/onAcceptInvite";
export { revokeInvitation } from "./tenants/revokeInvitation";

// Bundle B — Tenant settings (Phase 2).
export { updateTenantBranding } from "./tenants/updateTenantBranding";
export { updatePaymentSettings } from "./tenants/updatePaymentSettings";

// Bundle D — Invoice CRUD (Phase 2).
export { createInvoice } from "./invoices/createInvoice";
export { updateInvoice } from "./invoices/updateInvoice";
export { deleteInvoice } from "./invoices/deleteInvoice";
export { markInvoicePaid } from "./invoices/markInvoicePaid";

// Bundle E — Quote CRUD (Phase 2).
export { createQuote } from "./quotes/createQuote";
export { updateQuote } from "./quotes/updateQuote";
export { deleteQuote } from "./quotes/deleteQuote";
export { convertQuoteToInvoice } from "./quotes/convertQuoteToInvoice";

// Bundle G — Recurring invoices (Phase 2).
export { createRecurringInvoice } from "./recurring/createRecurringInvoice";
export { processRecurringInvoices } from "./recurring/processRecurringInvoices";

// Bundle F — Customer-facing + send callables (Phase 2).
export { getCustomerInvoices } from "./portal/getCustomerInvoices";
export { getCustomerInvoiceDetail } from "./portal/getCustomerInvoiceDetail";
export { verifyInvoicePayToken } from "./portal/verifyInvoicePayToken";
export { createPayTokenCheckoutSession } from "./portal/createPayTokenCheckoutSession";
export { regenerateInvoicePayLink } from "./invoices/regenerateInvoicePayLink";
export { sendInvoiceEmail } from "./invoices/sendInvoiceEmail";
export { sendQuoteEmail } from "./quotes/sendQuoteEmail";

// Phase 6 Bundle D — PDF preview callables (deferred from Phase 2).
export { previewInvoicePDF } from "./invoices/previewInvoicePDF";
export { previewQuotePDF } from "./quotes/previewQuotePDF";

// Bundle H — Infrastructure (Phase 2).
export { scheduledFirestoreExport } from "./scheduled/firestoreExport";

// Phase 4 Bundle B — Stripe Connect onboarding (Standard-equivalent controller, D1).
export { startConnectOnboarding } from "./stripe/startConnectOnboarding";
export { completeConnectOnboarding } from "./stripe/completeConnectOnboarding";

// D5 — Amazon SES: payment-incident owner alerts + bounce/complaint feedback.
export { onPaymentIncidentCreated } from "./stripe/onPaymentIncidentCreated";
export { sesEventsWebhook } from "./emails/sesEvents";

// Phase 5 Bundle E — Custom domains + Vercel/Edge Config provisioning.
export {
  setupCustomDomain,
  removeCustomDomain,
  recheckCustomDomain,
} from "./domain/setupCustomDomain";
export { recheckPendingDomains } from "./scheduled/recheckPendingDomains";
