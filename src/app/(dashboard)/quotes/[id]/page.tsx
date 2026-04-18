import { PagePlaceholder } from "@/components/scaffold/PagePlaceholder";

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PagePlaceholder title="Quote detail" phase="Phase 5" meta={{ id }} />;
}
