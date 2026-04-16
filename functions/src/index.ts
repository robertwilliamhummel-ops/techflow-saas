// Shared admin-app init lives in shared/admin.ts and self-guards against
// double init. Every callable imports from there, so no initialization code
// is needed here.

// Bundle A — Tenant lifecycle (Phase 2).
export { onSignup } from "./tenants/onSignup";
export { setUserRole } from "./tenants/setUserRole";
export { updateUserProfile } from "./tenants/updateUserProfile";
export { createInvitation } from "./tenants/createInvitation";
export { onAcceptInvite } from "./tenants/onAcceptInvite";
