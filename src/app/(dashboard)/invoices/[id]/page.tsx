import { PagePlaceholder } from "@/components/scaffold/PagePlaceholder";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PagePlaceholder title="Invoice detail" phase="Phase 5" meta={{ id }} />;
}
