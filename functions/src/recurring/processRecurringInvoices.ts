// processRecurringInvoices — Phase 2 Bundle G.
//
// Scheduled function: runs daily, iterates collectionGroup('recurringInvoices')
// for docs with status == 'active' and nextRunAt <= now.
//
// For each due template:
//   1. Verify tenant entitlements (skip if feature disabled)
//   2. Check completion bounds (endDate, endAfterCount)
//   3. Build fresh tenantSnapshot + inline logo (outside transaction)
//   4. Transaction: re-verify, increment counter, create invoice, advance nextRunAt
//   5. If autoSend: send RecurringInvoiceSent email + transition invoice to "sent"
//   6. On error: increment consecutiveFailures, auto-pause after 3

import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { sign } from "jsonwebtoken";
import { createElement } from "react";
import { render } from "@react-email/render";
import { Resend } from "resend";
import * as logger from "firebase-functions/logger";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { resolveFeature } from "../shared/features";
import {
  computeInvoiceTotals,
  computeLineItems,
  buildTenantSnapshot,
  inlineLogoOrNull,
  type LineItemInput,
} from "../shared/invoice";
import { computeNextRunAt, addDaysToISODate } from "../shared/recurring";
import { sanitizeEmailField, sanitizeHeaderValue } from "../emails/sanitize";
import { isValidEmail } from "../shared/email";
import {
  RecurringInvoiceSent,
  buildRecurringInvoiceSentPreviewText,
} from "../emails/templates/RecurringInvoiceSent";
import type { TenantSnapshotForEmail } from "../emails/components/TenantEmailLayout";

const PAY_TOKEN_SECRET = defineSecret("PAY_TOKEN_SECRET");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

const MAX_CONSECUTIVE_FAILURES = 3;
const FROM_DOMAIN = "techflowsolutions.ca";
const FROM_EMAIL = `notifications@${FROM_DOMAIN}`;

// Exported for direct testing — the onSchedule wrapper just calls this.
export async function processRecurringInvoicesHandler(): Promise<void> {
  const now = Timestamp.now();

  const query = db
    .collectionGroup("recurringInvoices")
    .where("status", "==", "active")
    .where("nextRunAt", "<=", now);

  const snapshot = await query.get();

  if (snapshot.empty) {
    logger.info("processRecurringInvoices: no due templates.");
    return;
  }

  logger.info(`processRecurringInvoices: ${snapshot.size} due template(s).`);

  for (const doc of snapshot.docs) {
    try {
      await processOneTemplate(doc);
    } catch (err) {
      // Top-level safety net — individual template errors should be caught
      // inside processOneTemplate, but if something unexpected leaks, log
      // it and continue to the next template.
      logger.error("processRecurringInvoices: unhandled error", {
        docPath: doc.ref.path,
        error: String(err),
      });
    }
  }
}

async function processOneTemplate(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<void> {
  const data = doc.data();
  const recurringRef = doc.ref;

  // Extract tenantId from path: tenants/{tenantId}/recurringInvoices/{id}
  const tenantId = recurringRef.parent.parent?.id;
  if (!tenantId) {
    logger.error("processRecurringInvoices: cannot extract tenantId", {
      path: recurringRef.path,
    });
    return;
  }

  // --- Check entitlements ---
  const entSnap = await db
    .doc(`tenants/${tenantId}/entitlements/current`)
    .get();
  const features = entSnap.exists ? entSnap.data()?.features : null;
  if (!resolveFeature("recurringInvoices", features)) {
    await recurringRef.update({
      lastRunAt: FieldValue.serverTimestamp(),
      lastRunStatus: "skipped",
      lastRunError: "Feature recurringInvoices is disabled for this tenant.",
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info("processRecurringInvoices: feature disabled, skipping", {
      tenantId,
      docId: doc.id,
    });
    return;
  }

  // --- Check completion bounds ---
  const nextRunDate = (data.nextRunAt as Timestamp).toDate();

  if (data.endDate) {
    const endDate = new Date(data.endDate + "T23:59:59Z");
    if (nextRunDate > endDate) {
      await recurringRef.update({
        status: "completed",
        lastRunAt: FieldValue.serverTimestamp(),
        lastRunStatus: "skipped",
        lastRunError: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.info("processRecurringInvoices: endDate reached", {
        tenantId,
        docId: doc.id,
      });
      return;
    }
  }

  if (
    data.endAfterCount != null &&
    (data.generatedCount as number) >= (data.endAfterCount as number)
  ) {
    await recurringRef.update({
      status: "completed",
      lastRunAt: FieldValue.serverTimestamp(),
      lastRunStatus: "skipped",
      lastRunError: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info("processRecurringInvoices: endAfterCount reached", {
      tenantId,
      docId: doc.id,
    });
    return;
  }

  // --- Load tenant meta (outside transaction — network I/O for logo) ---
  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  if (!metaSnap.exists) {
    await recordFailure(
      recurringRef,
      data,
      "Tenant meta not found — corrupt tenant state.",
    );
    return;
  }
  const meta = metaSnap.data()!;

  // Build fresh tenantSnapshot for the generated invoice.
  const tenantSnapshot = buildTenantSnapshot(meta);
  tenantSnapshot.logo = await inlineLogoOrNull(
    meta.logoUrl as string | null,
  );

  // Recompute totals from template line items + current meta taxRate.
  const rawLineItems = (data.lineItems as LineItemInput[]) ?? [];
  const lineItems = computeLineItems(rawLineItems);
  const totals = computeInvoiceTotals(
    rawLineItems,
    Number(meta.taxRate ?? 0),
    data.applyTax === true,
  );

  const prefix = String(meta.invoicePrefix ?? "INV");
  const issueDate = new Date().toISOString().slice(0, 10);
  const dueDate = addDaysToISODate(issueDate, data.daysUntilDue as number);

  // --- Transaction: create invoice + advance template ---
  let invoiceId: string;
  try {
    invoiceId = await db.runTransaction(async (tx) => {
      // Re-read recurring doc inside transaction to guard against races.
      const freshSnap = await tx.get(recurringRef);
      if (!freshSnap.exists) return "";
      const fresh = freshSnap.data()!;
      if (fresh.status !== "active") return "";

      // Re-verify nextRunAt — another processor instance may have advanced it.
      const freshNext = (fresh.nextRunAt as Timestamp).toDate();
      if (freshNext > Timestamp.now().toDate()) return "";

      // Invoice counter
      const counterRef = db.doc(`tenants/${tenantId}/counters/invoice`);
      const counterSnap = await tx.get(counterRef);
      const current = counterSnap.exists
        ? (counterSnap.data()!.value as number)
        : 0;
      const next = current + 1;
      tx.set(counterRef, {
        value: next,
        updatedAt: FieldValue.serverTimestamp(),
      });

      const id = `${prefix}-${String(next).padStart(4, "0")}`;
      const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${id}`);

      // Pay token for the new invoice.
      const payTokenVersion = 1;
      const payToken = sign(
        { invoiceId: id, tenantId, v: payTokenVersion },
        PAY_TOKEN_SECRET.value(),
        { expiresIn: "60d" },
      );
      const payTokenExpiresAt = Timestamp.fromMillis(
        Date.now() + 60 * 24 * 60 * 60 * 1000,
      );

      tx.set(invoiceRef, {
        customer: fresh.customer,
        lineItems,
        applyTax: fresh.applyTax === true,
        totals,
        tenantSnapshot,
        status: "draft",
        dueDate,
        issueDate,
        notes: fresh.notes ?? null,
        sourceRecurringInvoiceId: doc.id,
        payToken,
        payTokenExpiresAt,
        payTokenVersion,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: "system:recurring-processor",
      });

      // Advance template to next run.
      const nextRun = computeNextRunAt(
        freshNext,
        fresh.interval,
        fresh.anchorDay as number,
      );
      const newCount = ((fresh.generatedCount as number) || 0) + 1;

      // Check if this generation hits the endAfterCount bound.
      const hitCountLimit =
        fresh.endAfterCount != null && newCount >= fresh.endAfterCount;

      tx.update(recurringRef, {
        nextRunAt: Timestamp.fromDate(nextRun),
        generatedCount: newCount,
        lastRunAt: FieldValue.serverTimestamp(),
        lastRunStatus: "success",
        lastRunError: null,
        consecutiveFailures: 0,
        lastGeneratedInvoiceId: id,
        updatedAt: FieldValue.serverTimestamp(),
        ...(hitCountLimit ? { status: "completed" } : {}),
      });

      return id;
    });
  } catch (err) {
    await recordFailure(recurringRef, data, String(err));
    return;
  }

  // Transaction returned empty string = skipped (already processed or no longer active).
  if (!invoiceId) return;

  logger.info("processRecurringInvoices: invoice created", {
    tenantId,
    recurringId: doc.id,
    invoiceId,
  });

  // --- Auto-send email (outside transaction) ---
  if (data.autoSend === true) {
    try {
      await sendRecurringEmail(
        tenantId,
        invoiceId,
        data,
        meta,
        tenantSnapshot,
        totals,
        dueDate,
      );
    } catch (err) {
      // Email failure does NOT roll back the invoice — tenant can resend manually.
      logger.error("processRecurringInvoices: autoSend email failed", {
        tenantId,
        invoiceId,
        error: String(err),
      });
    }
  }
}

async function sendRecurringEmail(
  tenantId: string,
  invoiceId: string,
  templateData: FirebaseFirestore.DocumentData,
  meta: FirebaseFirestore.DocumentData,
  tenantSnapshot: ReturnType<typeof buildTenantSnapshot>,
  totals: { total: number },
  dueDate: string,
): Promise<void> {
  const invoiceRef = db.doc(`tenants/${tenantId}/invoices/${invoiceId}`);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) return;
  const invoice = invoiceSnap.data()!;

  const appUrl =
    process.env.APP_URL || "https://portal.techflowsolutions.ca";
  const payUrl = invoice.payToken
    ? `${appUrl}/pay/${invoice.payToken}`
    : `${appUrl}/portal/login`;

  const currency = tenantSnapshot.currency ?? "CAD";
  const totalFormatted = formatCurrency(totals.total, currency);
  const customerFirstName =
    templateData.customer?.name?.split(" ")[0] ?? "there";

  const tenant: TenantSnapshotForEmail = {
    name: tenantSnapshot.name ?? "",
    address: tenantSnapshot.address ?? null,
    logoUrl: tenantSnapshot.logo ?? null,
    emailFooter: tenantSnapshot.emailFooter ?? null,
    primaryColor: tenantSnapshot.primaryColor ?? null,
  };

  const props = {
    tenant,
    customerFirstName,
    invoiceNumber: invoiceId,
    totalFormatted,
    dueDateFormatted: dueDate,
    frequency: templateData.interval as string,
    payUrl,
  };

  const html = await render(createElement(RecurringInvoiceSent, props));
  const text = await render(createElement(RecurringInvoiceSent, props), {
    plainText: true,
  });

  const safeTenantName =
    sanitizeEmailField(tenantSnapshot.name, 100) || "TechFlow";
  const subject = `Invoice ${invoiceId} from ${safeTenantName} — ${totalFormatted}`;

  let replyTo: string | undefined;
  const metaEmail = meta.emailFrom ?? meta.etransferEmail;
  if (metaEmail) {
    const cleaned = sanitizeHeaderValue(metaEmail, 200);
    if (cleaned && isValidEmail(cleaned)) {
      replyTo = cleaned;
    }
  }

  const resend = new Resend(RESEND_API_KEY.value());
  const idempotencyKey = `recurringInvoiceEmail:${tenantId}:${invoiceId}`;

  const payload: Parameters<typeof resend.emails.send>[0] = {
    from: `${safeTenantName} <${FROM_EMAIL}>`,
    to: templateData.customer.email,
    subject,
    html,
    text,
  };
  if (replyTo) payload.replyTo = replyTo;

  const headers: Record<string, string> = {
    "Idempotency-Key": idempotencyKey,
  };

  await resend.emails.send(payload, { headers } as never);

  logger.info("processRecurringInvoices: email sent", {
    to: templateData.customer.email,
    invoiceId,
    tenantId,
    preview: buildRecurringInvoiceSentPreviewText(props),
  });

  // Transition invoice draft → sent.
  await invoiceRef.update({
    status: "sent",
    sentAt: FieldValue.serverTimestamp(),
  });
}

async function recordFailure(
  ref: FirebaseFirestore.DocumentReference,
  data: FirebaseFirestore.DocumentData,
  error: string,
): Promise<void> {
  const failures = ((data.consecutiveFailures as number) || 0) + 1;
  const update: Record<string, unknown> = {
    lastRunAt: FieldValue.serverTimestamp(),
    lastRunStatus: "failed",
    lastRunError: error.slice(0, 500),
    consecutiveFailures: failures,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    update.status = "paused";
    update.pausedAt = FieldValue.serverTimestamp();
    update.lastRunError =
      `Auto-paused after ${MAX_CONSECUTIVE_FAILURES} consecutive failures: ${error}`.slice(
        0,
        500,
      );
    logger.warn("processRecurringInvoices: auto-paused after failures", {
      docPath: ref.path,
      failures,
    });
  }
  await ref.update(update);
  logger.error("processRecurringInvoices: template failed", {
    docPath: ref.path,
    error,
    failures,
  });
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export const processRecurringInvoices = onSchedule(
  {
    schedule: "every day 06:00",
    timeZone: "UTC",
    secrets: [PAY_TOKEN_SECRET, RESEND_API_KEY],
  },
  processRecurringInvoicesHandler,
);
