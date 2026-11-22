// listMembers (D21) — the business's current team for Settings → Team.
//
// Any role. Memberships and user docs are readable only by their own user in
// firestore.rules, so the team list comes from here: every active membership
// of the caller's business with the person's email and display name. Removed
// members (deletedAt set) are left out.

import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "../shared/admin";
import {
  readClaims,
  requireTenant,
  type MembershipRole,
} from "../shared/auth";
import { withSentryCallable } from "../shared/withSentry";

export interface TeamMember {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: MembershipRole;
  joinedAt: number | null; // epoch ms
}

// A business has a handful of people; this only bounds a runaway read.
const MAX_MEMBERS = 200;
const ROLE_ORDER: Record<MembershipRole, number> = { owner: 0, admin: 1, staff: 2 };

function isRole(v: unknown): v is MembershipRole {
  return v === "owner" || v === "admin" || v === "staff";
}

export async function listMembersHandler(
  request: CallableRequest,
): Promise<{ members: TeamMember[] }> {
  const { tenantId } = await requireTenant(readClaims(request));

  const snap = await db
    .collection("userTenantMemberships")
    .where("tenantId", "==", tenantId)
    .limit(MAX_MEMBERS)
    .get();
  const active = snap.docs
    .map((d) => d.data() as {
      uid?: unknown;
      role?: unknown;
      createdAt?: { toMillis?: () => number } | null;
      deletedAt?: unknown;
    })
    .filter(
      (m): m is typeof m & { uid: string; role: MembershipRole } =>
        !m.deletedAt && typeof m.uid === "string" && isRole(m.role),
    );
  if (active.length === 0) return { members: [] };

  const users = await db.getAll(...active.map((m) => db.doc(`users/${m.uid}`)));
  const byUid = new Map(users.map((u) => [u.id, u.data()]));

  const members = active.map((m): TeamMember => {
    const user = byUid.get(m.uid) as
      | { email?: unknown; displayName?: unknown }
      | undefined;
    return {
      uid: m.uid,
      email: typeof user?.email === "string" ? user.email : null,
      displayName:
        typeof user?.displayName === "string" ? user.displayName : null,
      role: m.role,
      joinedAt: m.createdAt?.toMillis?.() ?? null,
    };
  });
  members.sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      (a.email ?? "").localeCompare(b.email ?? ""),
  );
  return { members };
}

export const listMembers = onCall(
  withSentryCallable("listMembers", listMembersHandler),
);
