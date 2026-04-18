import { PagePlaceholder } from "@/components/scaffold/PagePlaceholder";

export default async function PortalInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PagePlaceholder title="Invoice" phase="Phase 5" meta={{ id }} />;
}
