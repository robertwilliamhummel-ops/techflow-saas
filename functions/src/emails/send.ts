// Stub email-send layer. Bundle C replaces these implementations with real
// Resend + React Email calls. Signatures are the final contract — callers
// built against this file don't need to change when the real sender lands.

import * as logger from "firebase-functions/logger";

export interface InvitationEmailParams {
  to: string;
  tenantName: string;
  inviterName: string | null;
  role: "owner" | "admin" | "staff";
  acceptUrl: string;
}

export async function sendInvitationEmail(
  params: InvitationEmailParams,
): Promise<void> {
  logger.info("sendInvitationEmail (stub)", {
    to: params.to,
    tenantName: params.tenantName,
    role: params.role,
    acceptUrl: params.acceptUrl,
  });
}
