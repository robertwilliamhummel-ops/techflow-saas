import { Section, Text } from "@react-email/components";
import {
  TenantEmailLayout,
  type TenantSnapshotForEmail,
} from "../components/TenantEmailLayout";
import { Button } from "../components/Button";
import { sanitizeEmailField } from "../sanitize";

export interface StaffInviteProps {
  tenant: TenantSnapshotForEmail;
  inviterName: string | null;
  role: "owner" | "admin" | "staff";
  acceptUrl: string;
}

export function buildStaffInvitePreviewText(props: StaffInviteProps): string {
  const inviter =
    sanitizeEmailField(props.inviterName, 80) || "A teammate";
  const tenant = sanitizeEmailField(props.tenant.name, 80) || "TechFlow";
  return `${inviter} invited you to join ${tenant} on TechFlow`.slice(0, 110);
}

const ROLE_COPY: Record<StaffInviteProps["role"], string> = {
  owner: "owner",
  admin: "an admin",
  staff: "a staff member",
};

export function StaffInvite(props: StaffInviteProps) {
  const safeTenantName =
    sanitizeEmailField(props.tenant.name, 100) || "TechFlow";
  const safeInviter =
    sanitizeEmailField(props.inviterName, 100) || "A teammate";
  const roleText = ROLE_COPY[props.role];
  const preview = buildStaffInvitePreviewText(props);

  return (
    <TenantEmailLayout tenant={props.tenant} preview={preview}>
      <Section>
        <Text
          style={{
            fontSize: "18px",
            fontWeight: 600,
            margin: "0 0 12px 0",
            color: "#111111",
          }}
        >
          You've been invited to {safeTenantName}
        </Text>
        <Text
          style={{
            fontSize: "14px",
            lineHeight: "22px",
            margin: "0 0 16px 0",
            color: "#374151",
          }}
        >
          {safeInviter} has invited you to join {safeTenantName} on TechFlow as{" "}
          {roleText}. Accept the invite to create your account.
        </Text>
      </Section>

      <Section style={{ textAlign: "center", margin: "24px 0" }}>
        <Button href={props.acceptUrl} primaryColor={props.tenant.primaryColor}>
          Accept Invitation
        </Button>
      </Section>

      <Section>
        <Text
          style={{
            fontSize: "12px",
            lineHeight: "18px",
            color: "#6b7280",
            margin: "16px 0 0 0",
          }}
        >
          This invite expires in 7 days. If you weren't expecting this email,
          you can safely ignore it.
        </Text>
      </Section>
    </TenantEmailLayout>
  );
}
