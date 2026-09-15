"use client";

// Where Stripe Checkout returns when the customer backs out (S-09). Nothing was
// charged, so there is nothing to check — just the way back.

import Link from "next/link";

import { PayFrame, PayMessage } from "@/components/pay/PayFrame";
import { buttonVariants } from "@/components/ui/button";

export function PayCancelled({ token }: { token: string }) {
  return (
    <PayFrame business={null}>
      <PayMessage
        title="No charge was made"
        action={
          <Link href={`/pay/${encodeURIComponent(token)}`} className={buttonVariants()}>
            Back to the invoice
          </Link>
        }
      >
        <p>You left the card checkout before paying. You can try again, or choose another way to pay.</p>
      </PayMessage>
    </PayFrame>
  );
}
