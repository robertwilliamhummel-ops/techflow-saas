// updateRecurringInvoice — A-10.
//
// Tenant callable: pauses, resumes, or cancels a recurring invoice template.
// Rules block client writes, so this is the only way to stop or restart one.
//
//   pause   active → paused             any role
//   resume  paused → active             any role; needs `recurringInvoices`
//   cancel  active | paused → cancelled owner/admin; final
//
// Pause and cancel work even with the feature switched off, so a tenant can
// always stop billing. Repeating an action that already holds (pausing a
// paused template) writes nothing and returns `changed: false`.
//
// Resume never backfills: the schedule advances from its stored slot, on the
// same anchor, to the first run strictly after now — missed periods are
// skipped, as with a paused Stripe subscription. A template whose schedule ran
// out while paused (endDate or endAfterCount) becomes `completed`.
//
// Runs in a transaction; the processor re-reads status inside its own
// transaction, so a template paused mid-run doesn't generate.

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { requireFeature } from "../shared/requireFeature";
import { withSentryCallable } from "../shared/withSentry";
import {
  computeResumeRunAt,
  VALID_INTERVALS,
  type RecurringInterval,
} from "../shared/recurring";

export const RECURRING_ACTIONS = ["pause", "resume", "cancel"] as const;
export type RecurringAction = (typeof RECURRING_ACTIONS)[number];

export interface UpdateRecurringInvoiceResult {
  recurringInvoiceId: string;
  status: string;
  nextRunAt: string | null; // ISO; null once the template won't run again
  changed: boolean;
}

export async function updateRecurringInvoiceHandler(
  request: CallableRequest,
): Promise<UpdateRecurringInvoiceResult> {
  const claims = readClaims(request);
  const { uid, tenantId } = requireTenant(claims);

  const data = request.data as Record<string, unknown> | undefined;
  const recurringInvoiceId = requireDocId(
    data?.recurringInvoiceId,
    "recurringInvoiceId",
  );
  const action = String(data?.action ?? "").trim() as RecurringAction;
  if (!RECURRING_ACTIONS.includes(action)) {
    throw new HttpsError(
      "invalid-argument",
      `action must be one of: ${RECURRING_ACTIONS.join(", ")}.`,
    );
  }
  if (action === "cancel") requireRole(claims, ["owner", "admin"]);
  if (action === "resume") await requireFeature(tenantId, "recurringInvoices");

  const ref = db.doc(
    `tenants/${tenantId}/recurringInvoices/${recurringInvoiceId}`,
  );

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Recurring invoice not found.");
    }
    const doc = snap.data()!;
    const status = String(doc.status ?? "");
    const scheduled =
      doc.nextRunAt instanceof Timestamp ? doc.nextRunAt.toDate() : null;
    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };

    const result = (
      nextStatus: string,
      nextRunAt: Date | null,
      changed: boolean,
    ): UpdateRecurringInvoiceResult => ({
      recurringInvoiceId,
      status: nextStatus,
      nextRunAt:
        nextRunAt && (nextStatus === "active" || nextStatus === "paused")
          ? nextRunAt.toISOString()
          : null,
      changed,
    });

    switch (action) {
      case "pause": {
        if (status === "paused") return result(status, scheduled, false);
        requireStatus(status, ["active"], action);
        tx.update(ref, {
          status: "paused",
          pausedAt: FieldValue.serverTimestamp(),
          ...stamp,
        });
        return result("paused", scheduled, true);
      }

      case "cancel": {
        if (status === "cancelled") return result(status, scheduled, false);
        requireStatus(status, ["active", "paused"], action);
        tx.update(ref, {
          status: "cancelled",
          cancelledAt: FieldValue.serverTimestamp(),
          ...stamp,
        });
        return result("cancelled", null, true);
      }

      case "resume": {
        if (status === "active") return result(status, scheduled, false);
        requireStatus(status, ["paused"], action);
        const next = resumeRunAt(doc, scheduled);
        if (scheduleExhausted(doc, next)) {
          tx.update(ref, { status: "completed", pausedAt: null, ...stamp });
          return result("completed", null, true);
        }
        tx.update(ref, {
          status: "active",
          nextRunAt: Timestamp.fromDate(next),
          pausedAt: null,
          consecutiveFailures: 0,
          ...stamp,
        });
        return result("active", next, true);
      }
    }
  });
}

function requireStatus(
  status: string,
  allowed: readonly string[],
  action: RecurringAction,
): void {
  if (!allowed.includes(status)) {
    throw new HttpsError(
      "failed-precondition",
      `Cannot ${action} a recurring invoice that is ${status || "in an unknown state"}.`,
    );
  }
}

function resumeRunAt(
  doc: FirebaseFirestore.DocumentData,
  scheduled: Date | null,
): Date {
  const interval = doc.interval as RecurringInterval;
  const anchorDay = Number(doc.anchorDay);
  if (
    !scheduled ||
    !VALID_INTERVALS.includes(interval) ||
    !Number.isInteger(anchorDay) ||
    anchorDay < 1 ||
    anchorDay > 31
  ) {
    throw new HttpsError(
      "failed-precondition",
      "This recurring invoice has an invalid schedule.",
    );
  }
  return computeResumeRunAt(scheduled, new Date(), interval, anchorDay);
}

// The same bounds processRecurringInvoices checks before generating.
function scheduleExhausted(
  doc: FirebaseFirestore.DocumentData,
  next: Date,
): boolean {
  if (doc.endDate && next > new Date(`${doc.endDate}T23:59:59Z`)) {
    return true;
  }
  return (
    doc.endAfterCount != null &&
    Number(doc.generatedCount ?? 0) >= Number(doc.endAfterCount)
  );
}

export const updateRecurringInvoice = onCall(
  withSentryCallable("updateRecurringInvoice", updateRecurringInvoiceHandler),
);
