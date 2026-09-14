// Which actions the invoice detail page offers (S-04). Mirrors the status and
// role checks in the Cloud Functions callables, so the page never offers an
// action the server refuses. The voidable list is pinned to
// functions/src/shared/invoiceStatus.ts by a test, as dueStatus.ts pins the
// payable one.

import { PAYABLE_INVOICE_STATUSES } from "./dueStatus";
import type { InvoiceStatus, MembershipRole } from "@/lib/schema/tenant";

export const VOIDABLE_INVOICE_STATUSES = [
  "sent",
  "unpaid",
  "overdue",
] as const satisfies readonly InvoiceStatus[];

export interface InvoiceActions {
  /** Email the invoice for the first time (draft → sent). */
  send: boolean;
  /** Email it again; only while there's something to pay. */
  resend: boolean;
  previewPdf: boolean;
  copyPayLink: boolean;
  /** Issue a fresh pay link, e.g. after the old one expired (owner/admin). */
  reissuePayLink: boolean;
  markPaid: boolean;
  void: boolean;
  deleteDraft: boolean;
}

export function isOwnerOrAdminRole(role: MembershipRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function invoiceActionsFor(
  status: InvoiceStatus,
  role: MembershipRole | undefined,
): InvoiceActions {
  const manager = isOwnerOrAdminRole(role);
  const payable = (PAYABLE_INVOICE_STATUSES as readonly InvoiceStatus[]).includes(status);
  const voidable = (VOIDABLE_INVOICE_STATUSES as readonly InvoiceStatus[]).includes(status);
  const draft = status === "draft";
  return {
    send: draft,
    resend: payable,
    previewPdf: true,
    copyPayLink: payable,
    reissuePayLink: manager && (draft || payable),
    markPaid: manager && payable,
    void: manager && voidable,
    deleteDraft: manager && draft,
  };
}

/** The public pay page for a pay token, on the shared portal host. */
export function payLinkFor(payToken: string, appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/pay/${payToken}`;
}
