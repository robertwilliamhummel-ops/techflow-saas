// Firestore indexes and TTL policies (A-04).
//
// The emulator never enforces indexes, so a query that needs one passes every
// emulator test and then fails in production (processRecurringInvoices did).
// Each entry below pins a query in the source to the index it needs: if the
// query changes, or the index is removed from firestore.indexes.json, this test
// fails and points at the pair to update. TTL entries do the same for every
// collection that writes an `expireAt` for automatic cleanup.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Tests run from functions/, like the rules tests.
const REPO_ROOT = path.resolve(process.cwd(), "..");

interface IndexField {
  fieldPath: string;
  order?: "ASCENDING" | "DESCENDING";
  arrayConfig?: string;
}

interface IndexSpec {
  indexes: Array<{
    collectionGroup: string;
    queryScope: "COLLECTION" | "COLLECTION_GROUP";
    fields: IndexField[];
  }>;
  fieldOverrides?: Array<{
    collectionGroup: string;
    fieldPath: string;
    ttl?: boolean;
    indexes: Array<{ order?: string; arrayConfig?: string; queryScope?: string }>;
  }>;
}

const spec = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "firestore.indexes.json"), "utf8"),
) as IndexSpec;

function source(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const COMPOSITE_INDEXES: Array<{
  query: string;
  file: string;
  mustContain: RegExp[];
  collectionGroup: string;
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
  fields: IndexField[];
}> = [
  {
    query: "processRecurringInvoices — active templates due now, across tenants",
    file: "functions/src/recurring/processRecurringInvoices.ts",
    mustContain: [
      /\.collectionGroup\("recurringInvoices"\)/,
      /\.where\("status", "==", "active"\)/,
      /\.where\("nextRunAt", "<=", now\)/,
    ],
    collectionGroup: "recurringInvoices",
    queryScope: "COLLECTION_GROUP",
    // Equality field first, then the range field.
    fields: [
      { fieldPath: "status", order: "ASCENDING" },
      { fieldPath: "nextRunAt", order: "ASCENDING" },
    ],
  },
  {
    query: "getCustomerInvoices — a customer's invoices across tenants, newest first",
    file: "functions/src/portal/getCustomerInvoices.ts",
    mustContain: [
      /\.collectionGroup\("invoices"\)/,
      /\.where\("customer\.email", "==",/,
      /\.orderBy\("createdAt", "desc"\)/,
    ],
    collectionGroup: "invoices",
    queryScope: "COLLECTION_GROUP",
    fields: [
      { fieldPath: "customer.email", order: "ASCENDING" },
      { fieldPath: "createdAt", order: "DESCENDING" },
    ],
  },
  {
    query: "getCustomerQuotes — a customer's quotes across tenants, newest first (P-06)",
    file: "functions/src/portal/getCustomerQuotes.ts",
    mustContain: [
      /\.collectionGroup\("quotes"\)/,
      /\.where\("customer\.email", "==",/,
      /\.orderBy\("createdAt", "desc"\)/,
    ],
    collectionGroup: "quotes",
    queryScope: "COLLECTION_GROUP",
    fields: [
      { fieldPath: "customer.email", order: "ASCENDING" },
      { fieldPath: "createdAt", order: "DESCENDING" },
    ],
  },
];

// Collection-group single-field indexes aren't maintained by default, so even a
// one-field collection-group query needs an override.
const COLLECTION_GROUP_FIELD_OVERRIDES = [
  {
    query: "recheckPendingDomains — tenants with a domain awaiting DNS or SSL",
    file: "functions/src/scheduled/recheckPendingDomains.ts",
    mustContain: [
      /\.collectionGroup\("meta"\)/,
      /\.where\("customDomainStatus\.stage", "in",/,
    ],
    collectionGroup: "meta",
    fieldPath: "customDomainStatus.stage",
  },
];

// Every writer of `expireAt`. TTL fields are exempt from indexing: sequential
// timestamps create write hotspots, and nothing queries them.
const TTL_POLICIES = [
  {
    collectionGroup: "stripeEvents",
    file: "src/lib/stripe/idempotency.ts",
    marker: /stripeEvents\//,
  },
  {
    collectionGroup: "payAttempts",
    file: "functions/src/portal/createPayTokenCheckoutSession.ts",
    marker: /collection\("payAttempts"\)/,
  },
  {
    collectionGroup: "emailSends",
    file: "functions/src/emails/send.ts",
    marker: /emailSends/,
  },
  {
    collectionGroup: "signInLinkLimits",
    file: "functions/src/portal/sendPortalSignInLink.ts",
    marker: /signInLinkLimits\//,
  },
  {
    collectionGroup: "rateLimits",
    file: "functions/src/shared/rateLimit.ts",
    marker: /rateLimits\//,
  },
];

describe("Firestore composite indexes (A-04)", () => {
  for (const entry of COMPOSITE_INDEXES) {
    describe(entry.query, () => {
      it("the query in the source is unchanged", () => {
        const text = source(entry.file);
        for (const pattern of entry.mustContain) {
          expect(text, `${entry.file} should match ${pattern}`).toMatch(pattern);
        }
      });

      it("has a matching index in firestore.indexes.json", () => {
        const match = spec.indexes.find(
          (index) =>
            index.collectionGroup === entry.collectionGroup &&
            index.queryScope === entry.queryScope,
        );
        expect(match, `no ${entry.queryScope} index on ${entry.collectionGroup}`).toBeDefined();
        const candidates = spec.indexes.filter(
          (index) =>
            index.collectionGroup === entry.collectionGroup &&
            index.queryScope === entry.queryScope,
        );
        expect(candidates.map((index) => index.fields)).toContainEqual(entry.fields);
      });
    });
  }
});

describe("Firestore collection-group field overrides", () => {
  for (const entry of COLLECTION_GROUP_FIELD_OVERRIDES) {
    it(entry.query, () => {
      const text = source(entry.file);
      for (const pattern of entry.mustContain) {
        expect(text).toMatch(pattern);
      }
      const override = spec.fieldOverrides?.find(
        (field) =>
          field.collectionGroup === entry.collectionGroup &&
          field.fieldPath === entry.fieldPath,
      );
      expect(override?.indexes).toContainEqual(
        expect.objectContaining({ queryScope: "COLLECTION_GROUP" }),
      );
    });
  }
});

describe("Firestore TTL policies", () => {
  for (const entry of TTL_POLICIES) {
    it(`${entry.collectionGroup}.expireAt is a TTL field with indexing disabled`, () => {
      const text = source(entry.file);
      expect(text).toMatch(entry.marker);
      expect(text).toMatch(/expireAt/);

      const override = spec.fieldOverrides?.find(
        (field) =>
          field.collectionGroup === entry.collectionGroup &&
          field.fieldPath === "expireAt",
      );
      expect(override).toMatchObject({ ttl: true, indexes: [] });
    });
  }

  it("no collection group has more than one TTL field (Firestore allows one)", () => {
    const ttlGroups = (spec.fieldOverrides ?? [])
      .filter((field) => field.ttl === true)
      .map((field) => field.collectionGroup);
    expect(new Set(ttlGroups).size).toBe(ttlGroups.length);
  });
});
