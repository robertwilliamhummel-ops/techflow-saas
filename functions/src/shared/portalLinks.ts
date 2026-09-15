// Links from emails and pages to the customer-facing site: the portal (S-10)
// and the pay page. A business with a verified custom domain gets its own host,
// so its customer stays on the business's address from the email, through
// Stripe Checkout, and back; everyone else gets the shared portal host
// (APP_URL). Portal links go to the document itself, and signing in returns the
// customer to it (blueprint, "Customer magic link flow").
//
// A link carries the host the business had when it was sent: if the business
// later removes its custom domain, links in older emails stop working.

type Data = FirebaseFirestore.DocumentData;

const DEFAULT_APP_URL = "https://portal.techflowsolutions.ca";

/** The customer-facing origin for this business. */
export function portalOrigin(meta: Data | null | undefined): string {
  const domain = meta?.customDomain;
  if (
    typeof domain === "string" &&
    domain.length > 0 &&
    meta?.customDomainStatus?.stage === "verified"
  ) {
    // Custom domains are served over https on the default port.
    return `https://${domain.toLowerCase()}`;
  }
  return new URL(process.env.APP_URL || DEFAULT_APP_URL).origin;
}

/** The portal page for one invoice or quote, carrying its business. */
export function portalDocumentUrl(
  meta: Data | null | undefined,
  kind: "invoice" | "quote",
  tenantId: string,
  id: string,
): string {
  const segment = kind === "invoice" ? "invoices" : "quotes";
  const url = new URL(`/portal/${segment}/${encodeURIComponent(id)}`, portalOrigin(meta));
  url.searchParams.set("tenantId", tenantId);
  return url.toString();
}

/** The public pay page for an invoice's pay token. */
export function payPageUrl(meta: Data | null | undefined, payToken: string): string {
  return new URL(`/pay/${encodeURIComponent(payToken)}`, portalOrigin(meta)).toString();
}
