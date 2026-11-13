// Brand colours for a business that hasn't chosen its own (decision D13).
//
// Neutral slate on purpose: tenant-facing surfaces never carry TechFlow's (or
// anyone's) branding, and both pass the 4.5:1 contrast rule on white (7.6:1 and
// 10.4:1) so a new business can save its settings unchanged. They replace the
// old app's purple pair (#667eea / #764ba2), which failed that rule.
//
// Identical copies: src/lib/tenant/brandDefaults.ts (app) and
// pdf-service/src/brandDefaults.ts, pinned together by
// src/lib/__tests__/brandDefaults.test.ts.
export const DEFAULT_PRIMARY_COLOR = "#475569";
export const DEFAULT_SECONDARY_COLOR = "#334155";
