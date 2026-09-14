import { QuoteDetail } from "@/components/quotes/QuoteDetail";

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <QuoteDetail quoteId={id} />;
}
