import type { Metadata } from "next";

import { portalDocumentMetadata } from "@/lib/tenant/portalMetadata";
import { PortalQuote } from "./PortalQuote";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { tenantId } = await searchParams;
  return portalDocumentMetadata("Quote", tenantId);
}

// The quote id alone can't locate a quote, so links carry ?tenantId.
export default async function PortalQuotePage({ params, searchParams }: Props) {
  const [{ id }, { tenantId }] = await Promise.all([params, searchParams]);
  return <PortalQuote quoteId={id} tenantId={typeof tenantId === "string" ? tenantId : null} />;
}
