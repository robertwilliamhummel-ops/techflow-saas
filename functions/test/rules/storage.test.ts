import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  deleteObject,
  getMetadata,
  ref,
  uploadBytes,
} from "firebase/storage";

const PROJECT_ID = "techflow-rules-test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const OWNER_T1 = { tenantId: "t1", role: "owner" };
const ADMIN_T1 = { tenantId: "t1", role: "admin" };
const STAFF_T1 = { tenantId: "t1", role: "staff" };
const OWNER_T2 = { tenantId: "t2", role: "owner" };

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: {
      host: "127.0.0.1",
      port: 9199,
      rules: readFileSync("../storage.rules", "utf8"),
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearStorage();
});

function authed(uid: string, claims: Record<string, unknown>) {
  return env.authenticatedContext(uid, claims).storage();
}

function upload(
  storage: ReturnType<typeof authed>,
  path: string,
  contentType = "image/png",
  bytes: Uint8Array = PNG,
) {
  return uploadBytes(ref(storage, path), bytes, { contentType });
}

async function seed(path: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), PNG, {
      contentType: "image/png",
    });
  });
}

describe("tenants/{tenantId}/{logo|favicon}.{ext} — uploads", () => {
  it("owner uploads logo.png", async () => {
    await assertSucceeds(upload(authed("alice", OWNER_T1), "tenants/t1/logo.png"));
  });

  it("admin uploads favicon.ico", async () => {
    await assertSucceeds(
      upload(authed("adam", ADMIN_T1), "tenants/t1/favicon.ico", "image/x-icon"),
    );
  });

  it("owner uploads every extension the client produces", async () => {
    const storage = authed("alice", OWNER_T1);
    const cases: Array<[string, string]> = [
      ["logo.jpg", "image/jpeg"],
      ["logo.webp", "image/webp"],
      ["logo.svg", "image/svg+xml"],
      ["favicon.png", "image/png"],
      ["favicon.ico", "image/vnd.microsoft.icon"],
    ];
    for (const [name, type] of cases) {
      await assertSucceeds(upload(storage, `tenants/t1/${name}`, type));
    }
  });

  it("owner can replace an existing logo", async () => {
    await seed("tenants/t1/logo.png");
    await assertSucceeds(upload(authed("alice", OWNER_T1), "tenants/t1/logo.png"));
  });

  it("staff cannot upload", async () => {
    await assertFails(upload(authed("sam", STAFF_T1), "tenants/t1/logo.png"));
  });

  it("owner of another tenant cannot upload", async () => {
    await assertFails(upload(authed("bob", OWNER_T2), "tenants/t1/logo.png"));
  });

  it("user without a tenant claim cannot upload", async () => {
    await assertFails(upload(authed("carol", { role: "owner" }), "tenants/t1/logo.png"));
  });

  it("unauthenticated cannot upload", async () => {
    const storage = env.unauthenticatedContext().storage();
    await assertFails(upload(storage, "tenants/t1/logo.png"));
  });

  it("rejects non-image content types", async () => {
    await assertFails(
      upload(authed("alice", OWNER_T1), "tenants/t1/logo.png", "text/html"),
    );
  });

  it("rejects image types outside the allowlist", async () => {
    await assertFails(
      upload(authed("alice", OWNER_T1), "tenants/t1/logo.png", "image/gif"),
    );
  });

  it("rejects files of 2 MB or more", async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    await assertFails(
      upload(authed("alice", OWNER_T1), "tenants/t1/logo.png", "image/png", big),
    );
  });

  it("rejects other file names", async () => {
    const storage = authed("alice", OWNER_T1);
    for (const name of ["banner.png", "logo.gif", "logo.png.html", "logo", "xlogo.png"]) {
      await assertFails(upload(storage, `tenants/t1/${name}`));
    }
  });

  it("rejects nested paths (snapshots are Admin SDK only)", async () => {
    await assertFails(
      upload(
        authed("alice", OWNER_T1),
        "tenants/t1/snapshots/invoices/INV-0001/logo.png",
      ),
    );
  });

  it("owner cannot delete a logo", async () => {
    await seed("tenants/t1/logo.png");
    await assertFails(deleteObject(ref(authed("alice", OWNER_T1), "tenants/t1/logo.png")));
  });
});

describe("tenants/{tenantId}/** — reads", () => {
  it("any member of the tenant reads branding and snapshots", async () => {
    await seed("tenants/t1/logo.png");
    await seed("tenants/t1/snapshots/invoices/INV-0001/logo.png");
    const storage = authed("sam", STAFF_T1);
    await assertSucceeds(getMetadata(ref(storage, "tenants/t1/logo.png")));
    await assertSucceeds(
      getMetadata(ref(storage, "tenants/t1/snapshots/invoices/INV-0001/logo.png")),
    );
  });

  it("another tenant cannot read", async () => {
    await seed("tenants/t1/logo.png");
    await assertFails(getMetadata(ref(authed("bob", OWNER_T2), "tenants/t1/logo.png")));
  });

  it("unauthenticated cannot read", async () => {
    await seed("tenants/t1/logo.png");
    const storage = env.unauthenticatedContext().storage();
    await assertFails(getMetadata(ref(storage, "tenants/t1/logo.png")));
  });
});

describe("default deny", () => {
  it("paths outside tenants/ are closed", async () => {
    await assertFails(upload(authed("alice", OWNER_T1), "public/logo.png"));
    await assertFails(getMetadata(ref(authed("alice", OWNER_T1), "public/logo.png")));
  });
});
