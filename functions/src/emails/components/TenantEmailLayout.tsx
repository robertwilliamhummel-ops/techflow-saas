import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { sanitizeEmailField } from "../sanitize";

// Shared email shell. Every template composes inside this layout so header,
// footer, dark-mode suppression, and logo sizing are guaranteed consistent.
//
// Tenant strings reaching here MUST be pre-sanitized by the caller (send.ts
// enforces this). We re-sanitize defensively — tolerating a raw string in
// one call path shouldn't silently leak across all templates.

export interface TenantSnapshotForEmail {
  name: string;
  address?: string | null;
  logoUrl?: string | null;
  emailFooter?: string | null;
  primaryColor?: string | null;
}

interface Props {
  tenant: TenantSnapshotForEmail;
  preview: string;
  children: React.ReactNode;
}

export function TenantEmailLayout({ tenant, preview, children }: Props) {
  const safeName = sanitizeEmailField(tenant.name, 100) || "Your provider";
  const safeAddress = sanitizeEmailField(tenant.address, 300);
  const safeFooter = sanitizeEmailField(tenant.emailFooter, 500);
  const safePreview = sanitizeEmailField(preview, 150);

  return (
    <Html lang="en">
      <Head>
        {/* Suppress Apple Mail / Outlook dark-mode auto-inversion — the #1
            cause of unreadable transactional email. */}
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{safePreview}</Preview>
      <Body
        style={{
          backgroundColor: "#f4f4f5",
          margin: 0,
          padding: "24px 0",
          fontFamily: "Arial, Helvetica, sans-serif",
          color: "#111111",
        }}
      >
        <Container
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            backgroundColor: "#ffffff",
            padding: "32px",
            borderRadius: "8px",
          }}
        >
          {/* Header — logo or tenant name fallback. Constrained so tall logos
              can't push the header off-screen. */}
          <Section style={{ marginBottom: "24px" }}>
            {tenant.logoUrl ? (
              <Img
                src={tenant.logoUrl}
                alt={safeName}
                style={{
                  maxHeight: "60px",
                  maxWidth: "200px",
                  height: "auto",
                  width: "auto",
                }}
              />
            ) : (
              <Text
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#111111",
                  margin: 0,
                }}
              >
                {safeName}
              </Text>
            )}
          </Section>

          {children}

          <Section
            style={{
              marginTop: "32px",
              paddingTop: "16px",
              borderTop: "1px solid #e5e7eb",
              color: "#6b7280",
              fontSize: "12px",
              lineHeight: "18px",
            }}
          >
            <Text style={{ margin: "0 0 4px 0", fontWeight: 600 }}>
              {safeName}
            </Text>
            {safeAddress ? (
              <Text style={{ margin: "0 0 4px 0" }}>{safeAddress}</Text>
            ) : null}
            {safeFooter ? (
              <Text style={{ margin: "0 0 4px 0" }}>{safeFooter}</Text>
            ) : null}
            <Text style={{ margin: "8px 0 0 0" }}>
              Questions? Reply to this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
