// sesEventsWebhook — decision D5 (closes blueprint P10, "email typo → invoice
// never reachable").
//
// SES configuration set → SNS topic → this HTTPS endpoint. Each delivery,
// bounce, complaint, delay, or reject event is mapped back to the invoice or
// quote through the message tags sendEmail() stamps (category, tenantId,
// documentId), and recorded as lastEmailStatus on that document so the
// contractor sees "bounced" instead of assuming "sent" reached the customer.
//
// Trust: every SNS message's signature is verified against the AWS-hosted
// signing certificate (https, sns.<region>.amazonaws.com), and the TopicArn
// must equal SES_EVENTS_TOPIC_ARN. Subscription confirmations are only
// followed for sns.<region>.amazonaws.com URLs.

import { createVerify } from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db, FieldValue } from "../shared/admin";

// ---------------------------------------------------------------------------
// SNS signature verification
// ---------------------------------------------------------------------------

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isTrustedSnsUrl(url: unknown, requirePem = false): boolean {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      SNS_HOST_RE.test(u.hostname) &&
      (!requirePem || u.pathname.endsWith(".pem"))
    );
  } catch {
    return false;
  }
}

// Canonical string per the SNS spec: "Key\nValue\n" for each signed field in
// this fixed order; Subject is included only when present.
export function buildStringToSign(msg: SnsMessage): string {
  const keys =
    msg.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  let out = "";
  for (const key of keys) {
    const value = (msg as unknown as Record<string, string | undefined>)[key];
    if (value === undefined) continue;
    out += `${key}\n${value}\n`;
  }
  return out;
}

const certCache = new Map<string, string>();

async function fetchSigningCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Signing cert fetch failed: ${res.status}`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

export async function verifySnsSignature(
  msg: SnsMessage,
  fetchCert: (url: string) => Promise<string> = fetchSigningCert,
): Promise<boolean> {
  if (!isTrustedSnsUrl(msg.SigningCertURL, true)) return false;
  const algorithm =
    msg.SignatureVersion === "2"
      ? "RSA-SHA256"
      : msg.SignatureVersion === "1"
        ? "RSA-SHA1"
        : null;
  if (!algorithm || typeof msg.Signature !== "string") return false;
  try {
    const pem = await fetchCert(msg.SigningCertURL);
    const verifier = createVerify(algorithm);
    verifier.update(buildStringToSign(msg), "utf8");
    return verifier.verify(pem, msg.Signature, "base64");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SES event → document status
// ---------------------------------------------------------------------------

export type EmailDeliveryStatus =
  | "delivered"
  | "bounced"
  | "complained"
  | "delayed"
  | "rejected";

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bounceSubType?: string };
  complaint?: { complaintFeedbackType?: string };
  deliveryDelay?: { delayType?: string };
  reject?: { reason?: string };
}

export function statusFromSesEvent(
  event: SesEvent,
): { status: EmailDeliveryStatus; detail: string | null } | null {
  switch (event.eventType ?? event.notificationType) {
    case "Delivery":
      return { status: "delivered", detail: null };
    case "Bounce":
      return {
        status: "bounced",
        detail:
          [event.bounce?.bounceType, event.bounce?.bounceSubType]
            .filter(Boolean)
            .join("/") || null,
      };
    case "Complaint":
      return {
        status: "complained",
        detail: event.complaint?.complaintFeedbackType ?? null,
      };
    case "DeliveryDelay":
      return {
        status: "delayed",
        detail: event.deliveryDelay?.delayType ?? null,
      };
    case "Reject":
      return { status: "rejected", detail: event.reject?.reason ?? null };
    default:
      return null; // Send, Open, Click, Rendering Failure — not tracked
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function applySesEvent(event: SesEvent): Promise<boolean> {
  const tags = event.mail?.tags ?? {};
  const category = tags.category?.[0];
  const tenantId = tags.tenantId?.[0];
  const documentId = tags.documentId?.[0];
  const collection =
    category === "invoice" || category === "recurring-invoice"
      ? "invoices"
      : category === "quote"
        ? "quotes"
        : null;
  if (!collection || !tenantId || !documentId) return false;
  if (!ID_RE.test(tenantId) || !ID_RE.test(documentId)) return false;

  const mapped = statusFromSesEvent(event);
  if (!mapped) return false;

  try {
    await db.doc(`tenants/${tenantId}/${collection}/${documentId}`).update({
      lastEmailStatus: mapped.status,
      lastEmailStatusDetail: mapped.detail,
      lastEmailMessageId: event.mail?.messageId ?? null,
      lastEmailStatusAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (err) {
    // NOT_FOUND (5): document deleted since the send — nothing to record.
    if ((err as { code?: number }).code === 5) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

export interface SnsDeps {
  fetchCert?: (url: string) => Promise<string>;
  confirmSubscription?: (url: string) => Promise<void>;
}

export async function handleSnsRequest(
  rawBody: string,
  deps: SnsDeps = {},
): Promise<{ status: number; body: string }> {
  let msg: SnsMessage;
  try {
    msg = JSON.parse(rawBody) as SnsMessage;
  } catch {
    return { status: 400, body: "Invalid JSON" };
  }

  const expectedTopic = process.env.SES_EVENTS_TOPIC_ARN;
  if (!expectedTopic || msg.TopicArn !== expectedTopic) {
    return { status: 403, body: "Unexpected topic" };
  }
  if (!(await verifySnsSignature(msg, deps.fetchCert))) {
    return { status: 403, body: "Invalid signature" };
  }

  if (msg.Type === "SubscriptionConfirmation") {
    if (!isTrustedSnsUrl(msg.SubscribeURL)) {
      return { status: 400, body: "Untrusted SubscribeURL" };
    }
    const confirm =
      deps.confirmSubscription ??
      (async (url: string) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Subscription confirm failed: ${res.status}`);
      });
    await confirm(msg.SubscribeURL as string);
    logger.info("sesEvents: SNS subscription confirmed", {
      topicArn: msg.TopicArn,
    });
    return { status: 200, body: "Subscription confirmed" };
  }

  if (msg.Type === "Notification") {
    let event: SesEvent;
    try {
      event = JSON.parse(msg.Message) as SesEvent;
    } catch {
      return { status: 200, body: "Ignored non-JSON message" };
    }
    const applied = await applySesEvent(event);
    return { status: 200, body: applied ? "Recorded" : "Ignored" };
  }

  return { status: 200, body: "Ignored" };
}

export const sesEventsWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }
  const rawBody =
    req.rawBody?.toString("utf8") ??
    (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
  try {
    const result = await handleSnsRequest(rawBody);
    res.status(result.status).send(result.body);
  } catch (err) {
    logger.error("sesEvents: handler failed", { error: String(err) });
    // 500 → SNS retries with backoff.
    res.status(500).send("Handler failed");
  }
});
