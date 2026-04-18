import { PagePlaceholder } from "@/components/scaffold/PagePlaceholder";

export default async function PayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <PagePlaceholder title="Pay invoice" phase="Phase 4" meta={{ token }} />
  );
}
