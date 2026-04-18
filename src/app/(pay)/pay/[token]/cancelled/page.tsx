import { PagePlaceholder } from "@/components/scaffold/PagePlaceholder";

export default async function PayCancelledPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <PagePlaceholder
      title="Payment cancelled"
      phase="Phase 4"
      meta={{ token }}
    />
  );
}
