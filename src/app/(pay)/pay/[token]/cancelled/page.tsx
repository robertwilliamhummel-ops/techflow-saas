import { PayCancelled } from "./PayCancelled";

export default async function PayCancelledPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PayCancelled token={token} />;
}
