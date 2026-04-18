import { PagePlaceholder } from "@/components/scaffold/PagePlaceholder";

export default async function PaySuccessPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <PagePlaceholder
      title="Payment received"
      phase="Phase 4"
      meta={{ token }}
    />
  );
}
