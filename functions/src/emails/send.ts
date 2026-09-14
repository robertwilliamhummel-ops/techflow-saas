// Amazon SES transport (decision D5, 2026-09-13) — replaces Resend.
//
// Every outgoing email funnels through sendEmail(). It enforces:
//   - From: "<Tenant name>" <EMAIL_FROM_ADDRESS> on the verified platform domain
//     (SPF/DKIM/DMARC alignment); Reply-To: the tenant's own address
//   - Sanitization of every tenant-controlled header value (R4)
//   - Optional idempotency via emailSends/{sha256(key)} sentinels. Used by
//     automated senders (recurring processor, incident trigger, invitations)
//     whose retries could double-send. Manual "Send" clicks are deliberately
//     not deduplicated — resending an invoice is a legitimate action.
//   - Message tags (category, tenantId, documentId) so SES event publishing
//     can map bounces/complaints back to the document (see sesEvents.ts)
//
// Non-secret config (functions/.env.<project>):
//   SES_REGION              default ca-central-1
//   EMAIL_FROM_ADDRESS      default notifications@techflowsolutions.ca
//   SES_CONFIGURATION_SET   optional; required for bounce/complaint events
//   SES_TENANTS_ENABLED     "true" once SES tenants exist (TenantName = tenantId)
// Secrets: AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY — an IAM user
// limited to ses:SendEmail on the platform identity.

import { createHash } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { createElement } from "react";
import { render } from "@react-email/render";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { isValidEmail, lowerEmail } from "../shared/email";
import { sanitizeEmailField, sanitizeHeaderValue } from "./sanitize";
import { StaffInvite } from "./templates/StaffInvite";
import type { TenantSnapshotForEmail } from "./components/TenantEmailLayout";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const AWS_SES_ACCESS_KEY_ID = defineSecret("AWS_SES_ACCESS_KEY_ID");
export const AWS_SES_SECRET_ACCESS_KEY = defineSecret(
  "AWS_SES_SECRET_ACCESS_KEY",
);
// Every function that sends email must declare these in its options.
export const EMAIL_SECRETS = [AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY];

const DEFAULT_REGION = "ca-central-1";
const DEFAULT_FROM_ADDRESS = "notifications@techflowsolutions.ca";
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IN_FLIGHT_STALE_MS = 10 * 60 * 1000;

// Re-export the snapshot type so callers don't need a second import.
export type { TenantSnapshotForEmail };

// ---------------------------------------------------------------------------
// Core send
// ---------------------------------------------------------------------------

export type EmailCategory =
  | "invoice"
  | "quote"
  | "recurring-invoice"
  | "staff-invite"
  | "payment-incident"
  | "payment-receipt"
  | "portal-sign-in";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  replyTo?: string | null;
  category: EmailCategory;
  tenantId?: string | null;
  documentId?: string | null;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  messageId: string | null;
  deduplicated: boolean;
}

let cachedClient: { key: string; client: SESv2Client } | null = null;

function sesClient(): SESv2Client {
  const region = process.env.SES_REGION || DEFAULT_REGION;
  const accessKeyId = AWS_SES_ACCESS_KEY_ID.value();
  const secretAccessKey = AWS_SES_SECRET_ACCESS_KEY.value();
  const key = `${region}:${accessKeyId}`;
  if (cachedClient?.key === key) return cachedClient.client;
  const client = new SESv2Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  cachedClient = { key, client };
  return client;
}

export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const to = lowerEmail(input.to);
  if (!isValidEmail(to)) {
    throw new Error("Invalid recipient address.");
  }
  const subject = sanitizeEmailField(input.subject, 250);
  const replyTo = pickReplyTo(input.replyTo);
  const fromAddress = process.env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS;

  const sentinelRef = input.idempotencyKey
    ? db.doc(`emailSends/${sha256(input.idempotencyKey)}`)
    : null;
  if (sentinelRef && !(await claimSend(sentinelRef, input))) {
    logger.info("Email send deduplicated", logContext(input));
    return { messageId: null, deduplicated: true };
  }

  const tags: Array<{ Name: string; Value: string }> = [
    { Name: "category", Value: input.category },
  ];
  if (input.tenantId) {
    tags.push({ Name: "tenantId", Value: tagValue(input.tenantId) });
  }
  if (input.documentId) {
    tags.push({ Name: "documentId", Value: tagValue(input.documentId) });
  }

  const tenantName =
    process.env.SES_TENANTS_ENABLED === "true" && input.tenantId
      ? input.tenantId
      : undefined;

  try {
    const result = await sesClient().send(
      new SendEmailCommand({
        FromEmailAddress: formatFromHeader(input.fromName, fromAddress),
        Destination: { ToAddresses: [to] },
        ReplyToAddresses: replyTo ? [replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: input.html, Charset: "UTF-8" },
              Text: { Data: input.text, Charset: "UTF-8" },
            },
          },
        },
        ConfigurationSetName: process.env.SES_CONFIGURATION_SET || undefined,
        TenantName: tenantName,
        EmailTags: tags,
      }),
    );
    const messageId = result.MessageId ?? null;
    if (sentinelRef) {
      await sentinelRef.set(
        { status: "sent", messageId, sentAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    logger.info("Email sent", { ...logContext(input), messageId });
    return { messageId, deduplicated: false };
  } catch (err) {
    // Release the claim so a retry can send.
    if (sentinelRef) await sentinelRef.delete().catch(() => undefined);
    logger.error("Email send failed", {
      ...logContext(input),
      error: String(err),
    });
    throw err;
  }
}

async function claimSend(
  ref: FirebaseFirestore.DocumentReference,
  input: SendEmailInput,
): Promise<boolean> {
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data() as {
        status?: string;
        claimedAt?: FirebaseFirestore.Timestamp;
      };
      if (data.status === "sent") return false;
      // Another invocation is mid-send; only take over a stale claim.
      const claimedMs = data.claimedAt?.toMillis?.() ?? 0;
      if (Date.now() - claimedMs < IN_FLIGHT_STALE_MS) return false;
    }
    tx.set(ref, {
      status: "sending",
      category: input.category,
      tenantId: input.tenantId ?? null,
      documentId: input.documentId ?? null,
      claimedAt: Timestamp.now(),
      expireAt: Timestamp.fromMillis(Date.now() + IDEMPOTENCY_TTL_MS),
    });
    return true;
  });
}

function logContext(input: SendEmailInput): Record<string, unknown> {
  // Recipient addresses stay out of logs (PII); the document id is enough.
  return {
    category: input.category,
    tenantId: input.tenantId ?? null,
    documentId: input.documentId ?? null,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// SES message tags allow only letters, digits, underscores, and dashes.
function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

// RFC 5322 quoted display name for printable ASCII, RFC 2047 encoded-word
// otherwise (e.g. "Plomberie Côté"). The name is sanitized first so CR/LF
// can never split the header.
export function formatFromHeader(displayName: string, address: string): string {
  const name = sanitizeEmailField(displayName, 100) || "TechFlow";
  if (/^[\x20-\x7E]*$/.test(name)) {
    return `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;
  }
  return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${address}>`;
}

// First candidate that survives header sanitization and is a valid address.
export function pickReplyTo(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const cleaned = sanitizeHeaderValue(candidate, 200);
    if (cleaned && isValidEmail(cleaned)) return lowerEmail(cleaned);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// sendInvitationEmail — renders StaffInvite
// ---------------------------------------------------------------------------

export interface InvitationEmailParams {
  to: string;
  tenant: TenantSnapshotForEmail;
  inviterName: string | null;
  role: "owner" | "admin" | "staff";
  acceptUrl: string;
  replyTo?: string | null;
  tenantId?: string | null;
  idempotencyKey?: string;
}

export async function sendInvitationEmail(
  params: InvitationEmailParams,
): Promise<SendEmailResult> {
  const safeTenantName =
    sanitizeEmailField(params.tenant.name, 100) || "TechFlow";
  const safeInviter = sanitizeEmailField(params.inviterName, 100);

  const props = {
    tenant: params.tenant,
    inviterName: params.inviterName,
    role: params.role,
    acceptUrl: params.acceptUrl,
  };

  const html = await render(createElement(StaffInvite, props));
  const text = await render(createElement(StaffInvite, props), {
    plainText: true,
  });

  return await sendEmail({
    to: params.to,
    subject: `${safeInviter || "Your team"} invited you to ${safeTenantName}`,
    html,
    text,
    fromName: safeTenantName,
    replyTo: params.replyTo,
    category: "staff-invite",
    tenantId: params.tenantId ?? null,
    idempotencyKey: params.idempotencyKey,
  });
}
