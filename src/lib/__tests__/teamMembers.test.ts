import { describe, expect, it } from "vitest";
import { canRemoveMember, memberName, REMOVABLE_ROLES } from "@/lib/team/members";
import type { TeamMember } from "../../../functions/src/tenants/listMembers";
import type { TeamMember as AppTeamMember } from "@/lib/team/members";

describe("canRemoveMember (D21)", () => {
  const owner = { uid: "u_owner", role: "owner" as const };

  it("lets an owner remove an admin or staff member", () => {
    expect(canRemoveMember(owner, { uid: "u_admin", role: "admin" })).toBe(true);
    expect(canRemoveMember(owner, { uid: "u_staff", role: "staff" })).toBe(true);
  });

  it("never offers removing yourself or another owner", () => {
    expect(canRemoveMember(owner, { uid: "u_owner", role: "owner" })).toBe(false);
    expect(canRemoveMember(owner, { uid: "u_owner2", role: "owner" })).toBe(false);
  });

  it("offers nothing to admins, staff, or a viewer without a uid", () => {
    for (const role of ["admin", "staff"] as const) {
      expect(canRemoveMember({ uid: "u_x", role }, { uid: "u_staff", role: "staff" })).toBe(false);
    }
    expect(canRemoveMember({ uid: null, role: "owner" }, { uid: "u_staff", role: "staff" })).toBe(
      false,
    );
  });

  it("matches the roles removeMember accepts", () => {
    expect([...REMOVABLE_ROLES].sort()).toEqual(["admin", "staff"]);
  });
});

describe("memberName", () => {
  it("prefers the display name, then the email", () => {
    expect(memberName({ displayName: " Ada ", email: "ada@x.test" })).toBe("Ada");
    expect(memberName({ displayName: null, email: "ada@x.test" })).toBe("ada@x.test");
    expect(memberName({ displayName: "  ", email: null })).toBe("Unknown member");
  });
});

// The page reads the callable's rows as the app's TeamMember type.
describe("TeamMember matches listMembers", () => {
  it("has the same shape both ways", () => {
    const fromFunctions: TeamMember = {
      uid: "u",
      email: null,
      displayName: null,
      role: "staff",
      joinedAt: null,
    };
    const inApp: AppTeamMember = fromFunctions;
    const back: TeamMember = inApp;
    expect(back).toEqual(fromFunctions);
  });
});
