import { InvoiceDetail } from "@/components/invoices/InvoiceDetail";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <InvoiceDetail invoiceId={id} />;
}
