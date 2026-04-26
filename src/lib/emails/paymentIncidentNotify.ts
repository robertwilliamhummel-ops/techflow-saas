// Tenant owner notification on payment incidents — Phase 7 carry-over from
// Phase 4 Bundle D. The Stripe webhook handlers already write
// `paymentIncidents` audit docs; this module ships the matching email so
// the owner finds out without watching Firestore.
//
// Three incident kinds covered:
//   - auto-refund-version-mismatch: C2 guard fired (regenerate-during-checkout)
//   - dispute-created: Stripe notified of a chargeback
//   - dispute-lost: chargeback resolved against the tenant (forced refund)
//
// Best-effort: email failures are logged but never throw — the audit doc is
// already written and is the load-bearing record. Resend webhook reputation
// concerns belong to a future ops phase.
//
// No SDK dependency — posts directly to the Resend REST API. Keeps the
// Vercel cold-start small and avoids forking the @react-email render path
// that lives in functions/.

import { getAdminDb } from "@/lib/firebase/admin";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM_EMAIL = "notifications@techflowsolutions.ca";

export type PaymentIncidentKind =
  | "auto-refund-version-mismatch"
  | "dispute-created"
  | "dispute-lost";

export interface PaymentIncidentNotifyInput {
  tenantId: string;
  invoiceId: string;
  kind: PaymentIncidentKind;
  details?: Record<string, unknown>;
}

interface OwnerRecipient {
  email: string;
  uid: string;
}

interface TenantContext {
  tenantName: string;
  recipients: OwnerRecipient[];
}

async function loadTenantContext(tenantId: string): Promise<TenantContext> {
  const db = getAdminDb();

  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const tenantName =
    (metaSnap.data()?.name as string | undefined)?.trim() || "your business";

  const memberships = await db
    .collection("userTenantMemberships")
    .where("tenantId", "==", tenantId)
    .where("role", "==", "owner")
    .where("deletedAt", "==", null)
    .get();

  const uids = memberships.docs.map(
    (d) => d.data().uid as string | undefined,
  ).filter((u): u is string => !!u);

  const recipients: OwnerRecipient[] = [];
  for (const uid of uids) {
    const userSnap = await db.doc(`users/${uid}`).get();
    const email = userSnap.data()?.email as string | undefined;
    if (email && typeof email === "string" && email.includes("@")) {
      recipients.push({ uid, email });
    }
  }

  return { tenantName, recipients };
}

interface EmailBody {
  subject: string;
  text: string;
  html: string;
}

function buildEmail(
  kind: PaymentIncidentKind,
  ctx: { tenantName: string; invoiceId: string; details?: Record<string, unknown> },
): EmailBody {
  const { tenantName, invoiceId, details = {} } = ctx;

  switch (kind) {
    case "auto-refund-version-mismatch": {
      const refundId = (details.refundId as string | null) ?? null;
      const refundLine = refundId
        ? `Stripe refund ID: ${refundId}.`
        : `Refund could not be issued automatically — please refund manually in your Stripe dashboard.`;
      return {
        subject: `Payment auto-refunded on ${invoiceId} (link was regenerated mid-checkout)`,
        text:
          `Heads up — a customer paid invoice ${invoiceId} after you regenerated its pay link.\n\n` +
          `Because the link they used was no longer current, the payment was automatically refunded to protect them from being charged on a stale link.\n\n` +
          `${refundLine}\n\n` +
          `If you intended to accept this payment, send a fresh invoice with the new pay link.\n\n` +
          `— TechFlow`,
        html:
          `<p>Heads up — a customer paid invoice <strong>${invoiceId}</strong> after you regenerated its pay link.</p>` +
          `<p>Because the link they used was no longer current, the payment was automatically refunded to protect them from being charged on a stale link.</p>` +
          `<p>${refundLine}</p>` +
          `<p>If you intended to accept this payment, send a fresh invoice with the new pay link.</p>` +
          `<p style="color:#666;font-size:12px">— TechFlow</p>`,
      };
    }
    case "dispute-created": {
      const reason = (details.reason as string | undefined) ?? "unspecified";
      const dueDate = details.evidenceDueBy as string | undefined;
      const dueLine = dueDate
        ? `Stripe needs evidence by ${dueDate}.`
        : `Check your Stripe dashboard for the evidence deadline.`;
      return {
        subject: `Chargeback opened on ${invoiceId} for ${tenantName}`,
        text:
          `A customer disputed the payment on invoice ${invoiceId}.\n\n` +
          `Reason reported by their card issuer: ${reason}.\n\n` +
          `${dueLine} Missing the deadline means an automatic loss.\n\n` +
          `Sign in to Stripe → Disputes to upload your evidence (invoice PDF, communication trail, proof of service).\n\n` +
          `— TechFlow`,
        html:
          `<p>A customer disputed the payment on invoice <strong>${invoiceId}</strong>.</p>` +
          `<p>Reason reported by their card issuer: <strong>${reason}</strong>.</p>` +
          `<p>${dueLine} Missing the deadline means an automatic loss.</p>` +
          `<p>Sign in to Stripe → Disputes to upload your evidence (invoice PDF, communication trail, proof of service).</p>` +
          `<p style="color:#666;font-size:12px">— TechFlow</p>`,
      };
    }
    case "dispute-lost": {
      const amount = details.amountCents as number | undefined;
      const amountLine =
        typeof amount === "number"
          ? `Amount returned to the customer: $${(amount / 100).toFixed(2)}.`
          : "";
      return {
        subject: `Chargeback lost on ${invoiceId} — payment refunded`,
        text:
          `The chargeback on invoice ${invoiceId} closed against you. The payment has been forcibly refunded to the customer.\n\n` +
          `${amountLine}\n\n` +
          `The invoice has been marked refunded in your dashboard. If you believe this was decided incorrectly, contact Stripe support — TechFlow cannot reverse a closed dispute.\n\n` +
          `— TechFlow`,
        html:
          `<p>The chargeback on invoice <strong>${invoiceId}</strong> closed against you. The payment has been forcibly refunded to the customer.</p>` +
          `<p>${amountLine}</p>` +
          `<p>The invoice has been marked refunded in your dashboard. If you believe this was decided incorrectly, contact Stripe support — TechFlow cannot reverse a closed dispute.</p>` +
          `<p style="color:#666;font-size:12px">— TechFlow</p>`,
      };
    }
  }
}

async function postToResend(args: {
  apiKey: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  fromName: string;
}): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      from: `${args.fromName} <${FROM_EMAIL}>`,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

export async function notifyTenantOfIncident(
  input: PaymentIncidentNotifyInput,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[paymentIncidentNotify] RESEND_API_KEY not set — skipping owner notification",
      { tenantId: input.tenantId, invoiceId: input.invoiceId, kind: input.kind },
    );
    return;
  }

  let ctx: TenantContext;
  try {
    ctx = await loadTenantContext(input.tenantId);
  } catch (err) {
    console.error(
      "[paymentIncidentNotify] failed to load tenant context",
      {
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        kind: input.kind,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return;
  }

  if (ctx.recipients.length === 0) {
    console.warn(
      "[paymentIncidentNotify] no owner recipients for tenant — skipping",
      { tenantId: input.tenantId, invoiceId: input.invoiceId, kind: input.kind },
    );
    return;
  }

  const body = buildEmail(input.kind, {
    tenantName: ctx.tenantName,
    invoiceId: input.invoiceId,
    details: input.details,
  });

  for (const recipient of ctx.recipients) {
    try {
      await postToResend({
        apiKey,
        to: recipient.email,
        subject: body.subject,
        text: body.text,
        html: body.html,
        fromName: "TechFlow",
      });
    } catch (err) {
      console.error("[paymentIncidentNotify] resend send failed", {
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        kind: input.kind,
        recipient: recipient.uid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
