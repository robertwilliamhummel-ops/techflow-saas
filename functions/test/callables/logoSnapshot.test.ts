// A-06 — logo snapshots: base64 for PDFs, an immutable https copy for emails.
// Runs against the Firestore and Storage emulators.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "test-pay-token-secret-256bit-min!!";

vi.mock("firebase-functions/params", () => ({
  defineSecret: () => ({ value: () => TEST_SECRET }),
}));

vi.mock("firebase-functions/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockSesSend = vi.fn();
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

import { clearFirestore, fakeRequest, testDb } from "./_setup";
import { getStorage } from "firebase-admin/storage";
import {
  applyLogoToSnapshot,
  emailLogoUrl,
  snapshotLogoOrThrow,
} from "../../src/shared/logo";
import { createInvoiceHandler } from "../../src/invoices/createInvoice";
import { sendInvoiceEmailHandler } from "../../src/invoices/sendInvoiceEmail";

const TENANT = "logo-tenant";
const SOURCE = "https://tenant-uploads.example.com/logo.png";
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
]);

const realFetch = globalThis.fetch;

// Serves the tenant's "uploaded" logo; every other request (the emulators)
// goes to the network as usual.
function serveLogo(bytes: Buffer, contentType: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://tenant-uploads.example.com/")) {
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": contentType },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("snapshotLogoOrThrow (A-06)", () => {
  it("returns the base64 logo for PDFs and a working URL to an immutable copy", async () => {
    serveLogo(PNG, "image/png");

    const fields = await snapshotLogoOrThrow(TENANT, SOURCE);

    expect(fields.logo).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(fields.logoContentType).toBe("image/png");
    expect(decodeURIComponent(fields.logoUrl ?? "")).toContain(
      `tenants/${TENANT}/snapshots/logos/`,
    );
    expect(fields.logoUrl).toMatch(/[?&]token=/);

    // The URL serves the bytes with no sign-in — what an email client does.
    const res = await realFetch(fields.logoUrl!);
    expect(res.ok).toBe(true);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("stores the copy at a content-addressed path with a long cache lifetime", async () => {
    serveLogo(PNG, "image/png");

    await snapshotLogoOrThrow(TENANT, SOURCE);

    const hash = createHash("sha256").update(PNG).digest("hex");
    const [metadata] = await getStorage()
      .bucket()
      .file(`tenants/${TENANT}/snapshots/logos/${hash}.png`)
      .getMetadata();
    expect(metadata.contentType).toBe("image/png");
    expect(metadata.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("the same logo always gets the same URL, so earlier documents' links keep working", async () => {
    serveLogo(PNG, "image/png");

    const first = await snapshotLogoOrThrow(TENANT, SOURCE);
    const second = await snapshotLogoOrThrow(TENANT, SOURCE);

    expect(second.logoUrl).toBe(first.logoUrl);
    const res = await realFetch(first.logoUrl!);
    expect(res.ok).toBe(true);
  });

  it("rejects a logo URL that doesn't return an image", async () => {
    serveLogo(Buffer.from("<html></html>"), "text/html");

    await expect(snapshotLogoOrThrow(TENANT, SOURCE)).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("clears all three fields when the tenant has no logo", async () => {
    const snapshot = {
      logo: "stale",
      logoUrl: "stale",
      logoContentType: "stale",
    };

    await applyLogoToSnapshot(snapshot, TENANT, null);

    expect(snapshot).toEqual({ logo: null, logoUrl: null, logoContentType: null });
  });
});

describe("emailLogoUrl (A-06)", () => {
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "uses the hosted copy for %s logos",
    (logoContentType) => {
      expect(
        emailLogoUrl({ logoUrl: "https://cdn.example/logo", logoContentType }),
      ).toBe("https://cdn.example/logo");
    },
  );

  it("falls back to the business name for SVG logos", () => {
    expect(
      emailLogoUrl({
        logoUrl: "https://cdn.example/logo.svg",
        logoContentType: "image/svg+xml",
      }),
    ).toBeNull();
  });

  it("never returns the base64 logo", () => {
    expect(
      emailLogoUrl({ logoUrl: null, logoContentType: null }),
    ).toBeNull();
  });
});

describe("createInvoice freezes both logo forms (A-06)", () => {
  beforeEach(async () => {
    await clearFirestore();
    await testDb.doc(`tenants/${TENANT}/meta/settings`).set({
      name: "Logo Test Co",
      logoUrl: SOURCE,
      address: null,
      primaryColor: "#123456",
      secondaryColor: "#654321",
      fontFamily: "Inter",
      faviconUrl: null,
      taxRate: 0.13,
      taxName: "HST",
      businessNumber: null,
      invoicePrefix: "INV",
      emailFooter: null,
      currency: "CAD",
      etransferEmail: "pay@logo.test",
      chargeCustomerCardFees: false,
      cardFeePercent: 0,
    });
  });

  it("stores the base64 logo, the hosted copy URL, and its type on the snapshot", async () => {
    serveLogo(PNG, "image/png");

    const { invoiceId } = await createInvoiceHandler(
      fakeRequest(
        {
          customer: { name: "Jane Doe", email: "jane@example.com" },
          lineItems: [{ description: "Service call", quantity: 1, rate: 100 }],
          applyTax: true,
          dueDate: "2026-10-15",
        },
        {
          uid: "u_owner",
          claims: { email: "owner@logo.test", tenantId: TENANT, role: "owner" },
        },
      ),
    );

    const invoice = (
      await testDb.doc(`tenants/${TENANT}/invoices/${invoiceId}`).get()
    ).data()!;
    expect(invoice.tenantSnapshot.logo).toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
    expect(invoice.tenantSnapshot.logoContentType).toBe("image/png");
    expect(invoice.tenantSnapshot.logoUrl).toMatch(/[?&]token=/);
  });
});

describe("invoice emails use the hosted logo (A-06)", () => {
  const owner = {
    uid: "u_owner",
    claims: { email: "owner@logo.test", tenantId: TENANT, role: "owner" as const },
  };

  beforeEach(async () => {
    await clearFirestore();
    mockSesSend.mockReset();
    mockSesSend.mockResolvedValue({ MessageId: "ses-logo-test" });
    await testDb.doc(`tenants/${TENANT}/meta/settings`).set({
      name: "Logo Test Co",
      etransferEmail: "pay@logo.test",
    });
  });

  async function sendWithSnapshot(
    logoFields: Record<string, unknown>,
  ): Promise<string> {
    await testDb.doc(`tenants/${TENANT}/invoices/INV-0001`).set({
      customer: { name: "Jane Doe", email: "jane@example.com" },
      totals: { total: 113 },
      tenantSnapshot: {
        name: "Logo Test Co",
        currency: "CAD",
        primaryColor: "#123456",
        ...logoFields,
      },
      status: "sent",
      dueDate: "2026-10-15",
      payToken: "pay-token",
    });
    await sendInvoiceEmailHandler(fakeRequest({ invoiceId: "INV-0001" }, owner));
    return mockSesSend.mock.calls[0][0].input.Content.Simple.Body.Html
      .Data as string;
  }

  it("puts the hosted logo URL in the email and never the base64 logo", async () => {
    const html = await sendWithSnapshot({
      logo: "data:image/png;base64,iVBORw0KGgo=",
      logoUrl:
        "https://firebasestorage.googleapis.com/v0/b/bucket/o/logo.png?alt=media&token=abc",
      logoContentType: "image/png",
    });

    expect(html).toContain(
      "https://firebasestorage.googleapis.com/v0/b/bucket/o/logo.png?alt=media",
    );
    expect(html).not.toContain("data:image");
  });

  it("shows the business name instead of an SVG logo", async () => {
    const html = await sendWithSnapshot({
      logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      logoUrl: "https://firebasestorage.googleapis.com/v0/b/bucket/o/logo.svg?alt=media",
      logoContentType: "image/svg+xml",
    });

    expect(html).not.toContain("logo.svg");
    expect(html).not.toContain("data:image");
    expect(html).toContain("Logo Test Co");
  });
});
