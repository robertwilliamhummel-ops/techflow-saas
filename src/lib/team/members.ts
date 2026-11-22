// Settings → Team (D21): the current team from the listMembers callable, and
// who may remove whom — the same rule removeMember enforces: an owner removes
// an admin or staff member, never themselves or another owner.

import type { MembershipRole } from "@/lib/schema/tenant";

// The listMembers callable's row (functions/src/tenants/listMembers.ts).
export interface TeamMember {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: MembershipRole;
  joinedAt: number | null; // epoch ms
}

export const REMOVABLE_ROLES: readonly MembershipRole[] = ["admin", "staff"];

export function canRemoveMember(
  viewer: { uid: string | null | undefined; role: MembershipRole | undefined },
  member: Pick<TeamMember, "uid" | "role">,
): boolean {
  return (
    viewer.role === "owner" &&
    !!viewer.uid &&
    member.uid !== viewer.uid &&
    REMOVABLE_ROLES.includes(member.role)
  );
}

export function memberName(member: Pick<TeamMember, "email" | "displayName">): string {
  return member.displayName?.trim() || member.email || "Unknown member";
}
