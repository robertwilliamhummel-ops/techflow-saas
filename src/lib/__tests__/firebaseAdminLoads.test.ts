import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Vercel's functions can't require() ES modules. firebase-admin 14 -> jwks-rsa 4
// pulls in jose 6, which is ES-module only, so the pay page and portal crashed
// with ERR_REQUIRE_ESM (firebase/firebase-admin-node#3181). package.json
// overrides jwks-rsa's jose to 4.15.9, which ships CommonJS. This runs Node
// with require(esm) turned off, the way Vercel fails, so removing the override
// or a firebase-admin upgrade that brings jose 6 back fails here, not in prod.
describe("firebase-admin on Vercel", () => {
  it("loads without requiring an ES module", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--no-experimental-require-module",
        "-e",
        "require('firebase-admin/auth'); require('jwks-rsa'); process.stdout.write('ok')",
      ],
      { encoding: "utf8" },
    );
    expect(out).toBe("ok");
  });
});
