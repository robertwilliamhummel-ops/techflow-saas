// The customer-facing host for a business: its verified custom domain, else the
// shared portal host. The app's copy of portalOrigin in
// functions/src/shared/portalLinks.ts, which reads APP_URL where this takes the
// shared origin as an argument; a test pins the two together.

export interface CustomDomainFields {
  customDomain?: string | null;
  customDomainStatus?: { stage?: string } | null;
}

export function portalOriginFor(
  meta: CustomDomainFields | null | undefined,
  sharedOrigin: string,
): string {
  const domain = meta?.customDomain;
  if (
    typeof domain === "string" &&
    domain.length > 0 &&
    meta?.customDomainStatus?.stage === "verified"
  ) {
    // Custom domains are served over https on the default port.
    return `https://${domain.toLowerCase()}`;
  }
  return new URL(sharedOrigin).origin;
}
