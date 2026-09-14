import type { Metadata } from "next";

import { portalDocumentMetadata } from "@/lib/tenant/portalMetadata";
import { PortalInvoice } from "./PortalInvoice";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { tenantId } = await searchParams;
  return portalDocumentMetadata("Invoice", tenantId);
}

// The invoice id alone can't locate an invoice, so links carry ?tenantId
// (blueprint, "Customer magic link flow").
export default async function PortalInvoicePage({ params, searchParams }: Props) {
  const [{ id }, { tenantId }] = await Promise.all([params, searchParams]);
  return (
    <PortalInvoice invoiceId={id} tenantId={typeof tenantId === "string" ? tenantId : null} />
  );
}
