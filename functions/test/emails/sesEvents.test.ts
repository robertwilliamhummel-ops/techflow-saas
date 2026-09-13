// SES event feedback webhook (D5). Signatures are produced with a locally
// generated RSA key standing in for the AWS SNS signing certificate.

import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { clearFirestore, testDb } from "../callables/_setup";
import {
  buildStringToSign,
  handleSnsRequest,
  isTrustedSnsUrl,
  statusFromSesEvent,
  verifySnsSignature,
  type SnsMessage,
} from "../../src/emails/sesEvents";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const TOPIC = "arn:aws:sns:ca-central-1:123456789012:techflow-ses-events";
const CERT_URL =
  "https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-abc123.pem";
const TENANT = "acme-plumbing";

const fetchCert = async () => publicKey;

function sign(msg: Omit<SnsMessage, "Signature">): SnsMessage {
  const unsigned = { ...msg, Signature: "" } as SnsMessage;
  const signer = createSign("RSA-SHA256");
  signer.update(buildStringToSign(unsigned), "utf8");
  return { ...unsigned, Signature: signer.sign(privateKey, "base64") };
}

function notification(event: object, overrides: Partial<SnsMessage> = {}) {
  return sign({
    Type: "Notification",
    MessageId: "sns-msg-1",
    TopicArn: TOPIC,
    Message: JSON.stringify(event),
    Timestamp: "2026-09-13T12:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
    ...overrides,
  });
}

function sesEvent(
  eventType: string,
  tags: Record<string, string[]>,
  extra: object = {},
) {
  return { eventType, mail: { messageId: "ses-msg-9", tags }, ...extra };
}

const invoiceTags = {
  category: ["invoice"],
  tenantId: [TENANT],
  documentId: ["INV-0001"],
};

beforeEach(async () => {
  await clearFirestore();
  process.env.SES_EVENTS_TOPIC_ARN = TOPIC;
});

describe("SNS signature verification", () => {
  it("builds the canonical string in spec order, omitting an absent Subject", () => {
    const msg = {
      Type: "Notification",
      MessageId: "m",
      TopicArn: "t",
      Message: "body",
      Timestamp: "ts",
    } as SnsMessage;
    expect(buildStringToSign(msg)).toBe(
      "Message\nbody\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n",
    );
  });

  it("only trusts https sns.<region>.amazonaws.com certificate URLs", () => {
    expect(isTrustedSnsUrl(CERT_URL, true)).toBe(true);
    expect(isTrustedSnsUrl(CERT_URL.replace("https:", "http:"), true)).toBe(false);
    expect(isTrustedSnsUrl("https://evil.example.com/cert.pem", true)).toBe(false);
    expect(
      isTrustedSnsUrl(
        "https://sns.ca-central-1.amazonaws.com.evil.com/cert.pem",
        true,
      ),
    ).toBe(false);
    expect(
      isTrustedSnsUrl("https://sns.ca-central-1.amazonaws.com/not-a-cert", true),
    ).toBe(false);
  });

  it("accepts a correctly signed message and rejects a tampered one", async () => {
    const msg = notification(sesEvent("Delivery", invoiceTags));
    expect(await verifySnsSignature(msg, fetchCert)).toBe(true);
    expect(
      await verifySnsSignature({ ...msg, Message: "{}" }, fetchCert),
    ).toBe(false);
  });

  it("rejects a message whose signing cert URL is not AWS", async () => {
    const msg = notification(sesEvent("Delivery", invoiceTags), {
      SigningCertURL: "https://evil.example.com/cert.pem",
    });
    expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
  });
});

describe("statusFromSesEvent", () => {
  it("maps tracked event types and ignores the rest", () => {
    expect(
      statusFromSesEvent({
        eventType: "Bounce",
        bounce: { bounceType: "Permanent", bounceSubType: "NoEmail" },
      }),
    ).toEqual({ status: "bounced", detail: "Permanent/NoEmail" });
    expect(statusFromSesEvent({ eventType: "Delivery" })).toEqual({
      status: "delivered",
      detail: null,
    });
    expect(statusFromSesEvent({ eventType: "Open" })).toBeNull();
  });
});

describe("handleSnsRequest", () => {
  it("rejects a message from an unexpected topic", async () => {
    const msg = notification(sesEvent("Delivery", invoiceTags), {
      TopicArn: "arn:aws:sns:ca-central-1:999999999999:someone-else",
    });
    const res = await handleSnsRequest(JSON.stringify(msg), { fetchCert });
    expect(res.status).toBe(403);
  });

  it("rejects a bad signature", async () => {
    const msg = notification(sesEvent("Delivery", invoiceTags));
    const res = await handleSnsRequest(
      JSON.stringify({ ...msg, Signature: "AAAA" }),
      { fetchCert },
    );
    expect(res.status).toBe(403);
  });

  it("confirms a subscription only for an AWS SubscribeURL", async () => {
    const confirmSubscription = vi.fn(async () => undefined);
    const subscribeUrl =
      "https://sns.ca-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc";
    const msg = sign({
      Type: "SubscriptionConfirmation",
      MessageId: "sub-1",
      TopicArn: TOPIC,
      Message: "You have chosen to subscribe",
      Timestamp: "2026-09-13T12:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: CERT_URL,
      SubscribeURL: subscribeUrl,
      Token: "abc",
    });
    const res = await handleSnsRequest(JSON.stringify(msg), {
      fetchCert,
      confirmSubscription,
    });
    expect(res.status).toBe(200);
    expect(confirmSubscription).toHaveBeenCalledWith(subscribeUrl);

    const evil = sign({
      Type: "SubscriptionConfirmation",
      MessageId: "sub-2",
      TopicArn: TOPIC,
      Message: "x",
      Timestamp: "2026-09-13T12:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: CERT_URL,
      SubscribeURL: "https://evil.example.com/confirm",
      Token: "abc",
    });
    const evilRes = await handleSnsRequest(JSON.stringify(evil), {
      fetchCert,
      confirmSubscription,
    });
    expect(evilRes.status).toBe(400);
    expect(confirmSubscription).toHaveBeenCalledTimes(1);
  });

  it("records a bounce on the invoice it was sent for", async () => {
    await testDb
      .doc(`tenants/${TENANT}/invoices/INV-0001`)
      .set({ status: "sent" });

    const msg = notification(
      sesEvent("Bounce", invoiceTags, {
        bounce: { bounceType: "Permanent", bounceSubType: "NoEmail" },
      }),
    );
    const res = await handleSnsRequest(JSON.stringify(msg), { fetchCert });
    expect(res).toEqual({ status: 200, body: "Recorded" });

    const inv = (
      await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).get()
    ).data()!;
    expect(inv.lastEmailStatus).toBe("bounced");
    expect(inv.lastEmailStatusDetail).toBe("Permanent/NoEmail");
    expect(inv.lastEmailMessageId).toBe("ses-msg-9");
    expect(inv.status).toBe("sent");
  });

  it("records delivery on a quote", async () => {
    await testDb.doc(`tenants/${TENANT}/quotes/QT-0001`).set({ status: "sent" });
    const msg = notification(
      sesEvent("Delivery", {
        category: ["quote"],
        tenantId: [TENANT],
        documentId: ["QT-0001"],
      }),
    );
    await handleSnsRequest(JSON.stringify(msg), { fetchCert });
    const qt = (await testDb.doc(`tenants/${TENANT}/quotes/QT-0001`).get()).data()!;
    expect(qt.lastEmailStatus).toBe("delivered");
  });

  it("ignores events for deleted documents and untracked categories", async () => {
    const missing = notification(sesEvent("Bounce", invoiceTags));
    expect(
      await handleSnsRequest(JSON.stringify(missing), { fetchCert }),
    ).toEqual({ status: 200, body: "Ignored" });

    const incident = notification(
      sesEvent("Delivery", {
        category: ["payment-incident"],
        tenantId: [TENANT],
        documentId: ["INV-0001"],
      }),
    );
    expect(
      await handleSnsRequest(JSON.stringify(incident), { fetchCert }),
    ).toEqual({ status: 200, body: "Ignored" });
  });
});
