import { PaySuccess } from "./PaySuccess";

export default async function PaySuccessPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PaySuccess token={token} />;
}
