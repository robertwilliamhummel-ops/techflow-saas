import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_LIMITS,
  customerWithSameEmail,
  matchesCustomerSearch,
  sortCustomersByName,
} from "@/lib/customers/customers";

const customer = {
  name: "Hélène Tremblay",
  email: "helene@example.com",
  phone: "416-555-0199",
  address: "12 Rue Principale, Montréal",
};

describe("matchesCustomerSearch", () => {
  it("matches name, email, phone, and address, ignoring case and accents", () => {
    expect(matchesCustomerSearch(customer, "helene")).toBe(true);
    expect(matchesCustomerSearch(customer, "EXAMPLE.COM")).toBe(true);
    expect(matchesCustomerSearch(customer, "555-0199")).toBe(true);
    expect(matchesCustomerSearch(customer, "montreal")).toBe(true);
    expect(matchesCustomerSearch(customer, "okafor")).toBe(false);
  });

  it("copes with missing phone and address", () => {
    expect(matchesCustomerSearch({ ...customer, phone: null, address: null }, "tremblay")).toBe(true);
  });
});

describe("sortCustomersByName", () => {
  it("sorts in reading order regardless of case and accents", () => {
    const sorted = sortCustomersByName([{ name: "zoe" }, { name: "Émile" }, { name: "adam" }, { name: "Bob" }]);
    expect(sorted.map((c) => c.name)).toEqual(["adam", "Bob", "Émile", "zoe"]);
  });
});

describe("customerWithSameEmail", () => {
  const list = [
    { id: "c1", email: "pm@harbourfront.test", name: "Harbourfront A" },
    { id: "c2", email: "jane@example.com", name: "Jane" },
  ];

  it("finds another customer with the email, ignoring case", () => {
    expect(customerWithSameEmail(list, " PM@Harbourfront.test ", null)?.id).toBe("c1");
  });

  it("ignores the customer being edited and blank emails", () => {
    expect(customerWithSameEmail(list, "pm@harbourfront.test", "c1")).toBeNull();
    expect(customerWithSameEmail(list, "  ", null)).toBeNull();
  });
});

describe("CUSTOMER_LIMITS", () => {
  it("matches validateCustomerInput in Cloud Functions", () => {
    const source = readFileSync(
      path.join(process.cwd(), "functions", "src", "customers", "upsertCustomer.ts"),
      "utf8",
    );
    expect(source).toContain(`name.length > ${CUSTOMER_LIMITS.name}`);
    expect(source).toContain(`optionalText(d.phone, "phone", ${CUSTOMER_LIMITS.phone})`);
    expect(source).toContain(`optionalText(d.address, "address", ${CUSTOMER_LIMITS.address})`);
    expect(source).toContain(`optionalText(d.notes, "notes", ${CUSTOMER_LIMITS.notes})`);
  });
});
