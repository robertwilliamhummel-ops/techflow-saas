import { PayInvoice } from "./PayInvoice";

// The tab title and favicon come from the layout; the page checks the link
// from the browser (D8).
export default async function PayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PayInvoice token={token} />;
}
