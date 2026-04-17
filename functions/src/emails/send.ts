// Resend email-send layer — replaces the Phase 2 stub.
//
// Every outgoing email routes through this module. It enforces:
//   - From/Reply-To convention per blueprint (From: platform domain, Reply-To: tenant)
//   - Sanitization of every tenant-controlled string (R4)
//   - Idempotency keys to prevent duplicate sends on Cloud Function retry
//   - Structured logging so Resend failures surface in Cloud Functions logs
//
// Templates are rendered server-side via @react-email/render.

import { Resend } from "resend";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { createElement } from "react";
import { render } from "@react-email/render";
import { sanitizeEmailField, sanitizeHeaderValue } from "./sanitize";
import { isValidEmail } from "../shared/email";
import {
  StaffInvite,
  buildStaffInvitePreviewText,
} from "./templates/StaffInvite";
import type { TenantSnapshotForEmail } from "./components/TenantEmailLayout";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Platform sending domain — maintains SPF/DKIM/DMARC alignment.
// Reply-To goes to the tenant's email so customer replies land in
// the contractor's inbox, not ours.
const FROM_DOMAIN = "techflowsolutions.ca";
const FROM_EMAIL = `notifications@${FROM_DOMAIN}`;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface InvitationEmailParams {
  to: string;
  tenant: TenantSnapshotForEmail;
  inviterName: string | null;
  role: "owner" | "admin" | "staff";
  acceptUrl: string;
  replyTo?: string | null;
  idempotencyKey?: string;
}

// Re-export the snapshot type so callers don't need a second import.
export type { TenantSnapshotForEmail };

// ---------------------------------------------------------------------------
// Core send — all outgoing email funnels through here
// ---------------------------------------------------------------------------

interface SendParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  replyTo?: string | null;
  idempotencyKey?: string;
}

async function sendEmail(params: SendParams): Promise<void> {
  const resend = new Resend(RESEND_API_KEY.value());

  const from = `${params.fromName} <${FROM_EMAIL}>`;

  const payload: Parameters<typeof resend.emails.send>[0] = {
    from,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
  };

  if (params.replyTo) {
    payload.replyTo = params.replyTo;
  }

  const headers: Record<string, string> = {};
  if (params.idempotencyKey) {
    headers["Idempotency-Key"] = params.idempotencyKey;
  }

  try {
    const result = await resend.emails.send(payload, {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    } as never);
    logger.info("Email sent", {
      to: params.to,
      subject: params.subject,
      resendId: (result as { data?: { id?: string } }).data?.id,
    });
  } catch (err) {
    logger.error("Email send failed", {
      to: params.to,
      subject: params.subject,
      error: String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sendInvitationEmail — renders StaffInvite and sends via Resend
// ---------------------------------------------------------------------------

export async function sendInvitationEmail(
  params: InvitationEmailParams,
): Promise<void> {
  // Sanitize tenant-controlled strings (R4).
  const safeTenantName =
    sanitizeEmailField(params.tenant.name, 100) || "TechFlow";
  const safeInviter = sanitizeEmailField(params.inviterName, 100);

  // Validate & sanitize replyTo — reject if CRLF-injected junk remains.
  let replyTo: string | undefined;
  if (params.replyTo) {
    const cleaned = sanitizeHeaderValue(params.replyTo, 200);
    if (cleaned && isValidEmail(cleaned)) {
      replyTo = cleaned;
    }
  }

  const props = {
    tenant: params.tenant,
    inviterName: params.inviterName,
    role: params.role,
    acceptUrl: params.acceptUrl,
  };

  const subject = `${safeInviter || "Your team"} invited you to ${safeTenantName}`;
  const previewText = buildStaffInvitePreviewText(props);

  const html = await render(createElement(StaffInvite, props));
  const text = await render(createElement(StaffInvite, props), {
    plainText: true,
  });

  await sendEmail({
    to: params.to,
    subject,
    html,
    text,
    fromName: safeTenantName,
    replyTo,
    idempotencyKey: params.idempotencyKey,
  });

  logger.info("sendInvitationEmail", {
    to: params.to,
    tenant: safeTenantName,
    role: params.role,
    preview: previewText,
  });
}
