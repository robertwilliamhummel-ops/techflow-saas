// Links from emails into the customer portal (S-10). A business with a verified
// custom domain gets its own host, so the customer signs in to that business's
// branded portal; everyone else gets the shared portal host (APP_URL). Links go
// to the document itself: signing in returns the customer to it (blueprint,
// "Customer magic link flow").

type Data = FirebaseFirestore.DocumentData;

const DEFAULT_APP_URL = "https://portal.techflowsolutions.ca";

/** The portal's origin for this business. */
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
