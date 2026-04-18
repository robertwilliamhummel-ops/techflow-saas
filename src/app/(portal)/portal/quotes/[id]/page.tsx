import { PagePlaceholder } from "@/components/scaffold/PagePlaceholder";

export default async function PortalQuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PagePlaceholder title="Quote" phase="Phase 5" meta={{ id }} />;
}
