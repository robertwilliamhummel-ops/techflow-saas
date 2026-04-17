import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { db, FieldValue, Timestamp } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
import type { MembershipRole } from "../shared/auth";
import { isValidEmail, lowerEmail } from "../shared/email";
import { generateOpaqueToken } from "../shared/tokens";
import { sendInvitationEmail } from "../emails/send";
import type { TenantSnapshotForEmail } from "../emails/send";

interface Input {
  email?: unknown;
  role?: unknown;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APP_URL = defineString("APP_URL", {
  default: "http://localhost:3000",
  description: "Base URL the invitee opens to accept — used in accept link.",
});

function validInviteRole(v: unknown): MembershipRole {
  if (v === "admin" || v === "staff") return v;
  throw new HttpsError(
    "invalid-argument",
    "role must be one of: admin, staff. (Only owners are created via onSignup.)",
  );
}

export async function createInvitationHandler(
  request: CallableRequest<Input>,
): Promise<{ invitationId: string }> {
  const claims = readClaims(request);
  const { tenantId, uid: inviterUid } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);

  const data = (request.data as Input | undefined) ?? {};
  const email = lowerEmail(data.email);
  if (!isValidEmail(email)) {
    throw new HttpsError("invalid-argument", "email is not a valid address.");
  }
  const role = validInviteRole(data.role);

  // Block duplicate pending invites for the same email in the same tenant.
  const pending = await db
    .collection(`tenants/${tenantId}/invitations`)
    .where("email", "==", email)
    .where("acceptedAt", "==", null)
    .where("revokedAt", "==", null)
    .limit(1)
    .get();
  if (!pending.empty) {
    throw new HttpsError(
      "already-exists",
      "An unaccepted invitation already exists for this email.",
    );
  }

  const token = generateOpaqueToken(32);
  const invitationRef = db
    .collection(`tenants/${tenantId}/invitations`)
    .doc();
  const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_TTL_MS);

  await invitationRef.set({
    tenantId,
    email,
    role,
    tokenHash: token.hash,
    invitedBy: inviterUid,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
    acceptedAt: null,
    revokedAt: null,
  });

  const tenantMeta = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const metaData = tenantMeta.data() as {
    name?: string;
    address?: string | null;
    logoUrl?: string | null;
    emailFooter?: string | null;
    primaryColor?: string | null;
  } | undefined;
  const tenant: TenantSnapshotForEmail = {
    name: metaData?.name ?? tenantId,
    address: metaData?.address ?? null,
    logoUrl: metaData?.logoUrl ?? null,
    emailFooter: metaData?.emailFooter ?? null,
    primaryColor: metaData?.primaryColor ?? null,
  };

  const inviterSnap = await db.doc(`users/${inviterUid}`).get();
  const inviterName =
    (inviterSnap.data() as { displayName?: string | null } | undefined)
      ?.displayName ?? null;

  const acceptUrl = buildAcceptUrl(
    APP_URL.value(),
    tenantId,
    invitationRef.id,
    token.raw,
  );

  await sendInvitationEmail({
    to: email,
    tenant,
    inviterName,
    role,
    acceptUrl,
  });

  return { invitationId: invitationRef.id };
}

export const createInvitation = onCall<Input>(createInvitationHandler);

function buildAcceptUrl(
  baseUrl: string,
  tenantId: string,
  invitationId: string,
  rawToken: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    tenantId,
    invitationId,
    token: rawToken,
  }).toString();
  return `${base}/accept-invite?${qs}`;
}
