import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { createElement } from "react";
import {
  StaffInvite,
  buildStaffInvitePreviewText,
  type StaffInviteProps,
} from "../../src/emails/templates/StaffInvite";

function baseProps(
  overrides: Partial<StaffInviteProps> = {},
): StaffInviteProps {
  return {
    tenant: {
      name: "Acme Plumbing",
      address: "123 Main St, Toronto ON",
      logoUrl: null,
      emailFooter: "Licensed & insured",
      primaryColor: "#0066CC",
    },
    inviterName: "Jane Owner",
    role: "staff",
    acceptUrl:
      "https://app.techflowsolutions.ca/accept-invite?tenantId=t1&invitationId=i1&token=xyz",
    ...overrides,
  };
}

async function renderHtml(props: StaffInviteProps): Promise<string> {
  const raw = await render(createElement(StaffInvite, props));
  // React Email inserts <!-- --> between adjacent JSX expressions and
  // HTML-encodes apostrophes/ampersands. Strip those so assertions can match
  // the author's intended text without mirroring React's render quirks.
  return raw
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

async function renderText(props: StaffInviteProps): Promise<string> {
  return await render(createElement(StaffInvite, props), { plainText: true });
}

describe("StaffInvite template", () => {
  it("renders HTML with preview text, tenant name, inviter, and CTA", async () => {
    const html = await renderHtml(baseProps());

    expect(html).toContain("Jane Owner invited you to join Acme Plumbing");
    expect(html).toContain("Acme Plumbing");
    expect(html).toContain("a staff member");
    expect(html).toContain("Accept Invitation");
    expect(html).toContain(
      "accept-invite?tenantId=t1&amp;invitationId=i1&amp;token=xyz",
    );
  });

  it("uses tenant primaryColor on the CTA with WCAG-safe foreground", async () => {
    // #0066CC has low luminance → white text computed
    const html = await renderHtml(baseProps());
    expect(html).toContain("#0066CC");
    expect(html.toLowerCase()).toContain("color:#ffffff");
  });

  it("falls back to indigo when primaryColor is missing or invalid", async () => {
    const html = await renderHtml(
      baseProps({
        tenant: { ...baseProps().tenant, primaryColor: null },
      }),
    );
    expect(html).toContain("#4F46E5");
  });

  it("renders footer with tenant address and emailFooter", async () => {
    const html = await renderHtml(baseProps());
    expect(html).toContain("123 Main St, Toronto ON");
    expect(html).toContain("Licensed &amp; insured");
    expect(html).toContain("Questions? Reply to this email.");
  });

  it("sanitizes tenant name — CRLF replaced with space, no header injection", async () => {
    const html = await renderHtml(
      baseProps({
        tenant: {
          ...baseProps().tenant,
          name: "Acme Plumbing\r\nBcc: evil@x.com",
        },
      }),
    );
    expect(html).toContain("Acme Plumbing Bcc: evil@x.com");
    // Assert the raw CR/LF never reach the output between sanitized regions.
    // Normalize for whitespace-insensitive structural CR/LF detection would be
    // fragile; instead assert the attack string is defused by space insertion.
    expect(html).not.toContain("Acme Plumbing\r\n");
    expect(html).not.toContain("Plumbing\nBcc");
  });

  it("sanitizes NUL and control chars from tenant footer", async () => {
    const html = await renderHtml(
      baseProps({
        tenant: {
          ...baseProps().tenant,
          emailFooter: "Licensed\x00\x01\x1F& insured",
        },
      }),
    );
    expect(html).toContain("Licensed&amp; insured");
    expect(html).not.toContain("\x00");
    expect(html).not.toContain("\x01");
  });

  it("renders admin role copy correctly", async () => {
    const html = await renderHtml(baseProps({ role: "admin" }));
    expect(html).toContain("join Acme Plumbing on TechFlow as an admin");
  });

  it("falls back to 'A teammate' when inviterName is null", async () => {
    const html = await renderHtml(baseProps({ inviterName: null }));
    expect(html).toContain("A teammate has invited you to join");
  });

  it("falls back to tenant name 'TechFlow' when empty/missing", async () => {
    const html = await renderHtml(
      baseProps({
        tenant: { ...baseProps().tenant, name: "" },
      }),
    );
    expect(html).toContain("You've been invited to TechFlow");
  });

  it("sets color-scheme meta to prevent dark-mode auto-inversion", async () => {
    const html = await renderHtml(baseProps());
    expect(html.toLowerCase()).toContain('name="color-scheme"');
    expect(html.toLowerCase()).toContain('content="light"');
  });

  it("renders plain-text fallback with no CR/LF smuggling", async () => {
    const text = await renderText(
      baseProps({
        tenant: {
          ...baseProps().tenant,
          name: "Acme\r\nBcc: evil@x",
          emailFooter: "Footer\nline two",
        },
      }),
    );
    // Plain text is allowed to contain newlines structurally, but tenant
    // content must be flattened — no injected line that looks like a
    // separate header/paragraph smuggled by the tenant string.
    expect(text).not.toMatch(/^Bcc:/m);
    expect(text).toContain("Acme Bcc: evil@x");
  });

  it("logoUrl, when provided, renders an Img; otherwise text fallback", async () => {
    const withLogo = await renderHtml(
      baseProps({
        tenant: {
          ...baseProps().tenant,
          logoUrl: "https://cdn.example.com/acme-logo.png",
        },
      }),
    );
    expect(withLogo).toContain("https://cdn.example.com/acme-logo.png");
    expect(withLogo.toLowerCase()).toContain("<img");

    const noLogo = await renderHtml(baseProps());
    expect(noLogo.toLowerCase()).not.toContain("<img");
  });
});

describe("buildStaffInvitePreviewText", () => {
  it("produces a concise inbox preview", () => {
    const p = buildStaffInvitePreviewText({
      tenant: { name: "Acme Plumbing" },
      inviterName: "Jane Owner",
      role: "staff",
      acceptUrl: "https://x",
    });
    expect(p).toBe("Jane Owner invited you to join Acme Plumbing on TechFlow");
    expect(p.length).toBeLessThanOrEqual(110);
  });

  it("falls back when inviterName is null", () => {
    const p = buildStaffInvitePreviewText({
      tenant: { name: "Acme" },
      inviterName: null,
      role: "staff",
      acceptUrl: "https://x",
    });
    expect(p).toContain("A teammate invited you");
  });
});
