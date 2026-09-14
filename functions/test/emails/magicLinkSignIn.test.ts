// E-01 — MagicLinkSignIn template.

import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { createElement } from "react";
import {
  MagicLinkSignIn,
  buildMagicLinkSignInPreviewText,
  type MagicLinkSignInProps,
} from "../../src/emails/templates/MagicLinkSignIn";

const LINK =
  "https://portal.techflowsolutions.ca/__/auth/action?mode=signIn&oobCode=abc123&continueUrl=https%3A%2F%2Fportal.techflowsolutions.ca%2Fportal";

function baseProps(
  overrides: Partial<MagicLinkSignInProps> = {},
): MagicLinkSignInProps {
  return {
    tenant: {
      name: "Acme Plumbing",
      address: "123 Main St, Toronto ON",
      logoUrl: null,
      emailFooter: null,
      primaryColor: "#0066CC",
    },
    signInUrl: LINK,
    ...overrides,
  };
}

async function renderHtml(props: MagicLinkSignInProps): Promise<string> {
  const raw = await render(createElement(MagicLinkSignIn, props));
  return raw
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

describe("MagicLinkSignIn template (E-01)", () => {
  it("renders the sign-in button with the link and the business name", async () => {
    const html = await renderHtml(baseProps());

    expect(html).toContain("Sign in to your customer portal");
    expect(html).toContain("see your invoices and quotes from Acme Plumbing");
    expect(html).toContain(">Sign in<");
    expect(html).toContain(
      "mode=signIn&amp;oobCode=abc123&amp;continueUrl=https%3A%2F%2Fportal.techflowsolutions.ca%2Fportal",
    );
  });

  it("puts the tenant colour on the button only", async () => {
    const html = await renderHtml(baseProps());
    expect(html).toContain("#0066CC");
  });

  it("offers the raw link and a reassurance for people who didn't ask", async () => {
    const html = await renderHtml(baseProps());
    expect(html).toContain("copy this link into your browser");
    expect(html).toContain("If you didn't ask to sign in, you can safely ignore this email.");
  });

  it("includes the link in the plain-text body", async () => {
    const text = await render(createElement(MagicLinkSignIn, baseProps()), {
      plainText: true,
    });
    expect(text).toContain("oobCode=abc123");
    expect(text).toContain("safely ignore this email");
  });

  it("sanitizes the business name", async () => {
    const html = await renderHtml(
      baseProps({ tenant: { ...baseProps().tenant, name: "Acme\r\nBcc: evil@x.com" } }),
    );
    expect(html).toContain("Acme Bcc: evil@x.com");
    expect(html).not.toContain("Acme\r\n");
  });
});

describe("buildMagicLinkSignInPreviewText", () => {
  it("names the business and stays within 110 characters", () => {
    const preview = buildMagicLinkSignInPreviewText(baseProps());
    expect(preview).toBe(
      "Your sign-in link for Acme Plumbing — view and pay your invoices and quotes",
    );
    expect(
      buildMagicLinkSignInPreviewText({ tenant: { name: "x".repeat(100) } }).length,
    ).toBeLessThanOrEqual(110);
  });
});
