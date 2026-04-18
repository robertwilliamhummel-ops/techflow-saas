// Shared admin-app init lives in shared/admin.ts and self-guards against
// double init. Every callable imports from there, so no initialization code
// is needed here.

// Bundle A — Tenant lifecycle (Phase 2).
export { onSignup } from "./tenants/onSignup";
export { setUserRole } from "./tenants/setUserRole";
export { updateUserProfile } from "./tenants/updateUserProfile";
export { createInvitation } from "./tenants/createInvitation";
export { onAcceptInvite } from "./tenants/onAcceptInvite";

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
