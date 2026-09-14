// Customer list helpers (S-05). The field limits mirror validateCustomerInput
// in functions/src/customers/upsertCustomer.ts; a test pins them to its source.

import { matchesSearch } from "@/lib/search";
import type { Customer } from "@/lib/schema/tenant";

export const CUSTOMER_LIMITS = {
  name: 200,
  phone: 50,
  address: 500,
  notes: 2000,
} as const;

export type CustomerWithId = Customer & { id: string };

export function matchesCustomerSearch(
  customer: Pick<Customer, "name" | "email" | "phone" | "address">,
  query: string,
): boolean {
  return matchesSearch([customer.name, customer.email, customer.phone, customer.address], query);
}

/** Names in reading order, ignoring case and accents. */
export function sortCustomersByName<T extends Pick<Customer, "name">>(customers: readonly T[]): T[] {
  return [...customers].sort((a, b) =>
    a.name.localeCompare(b.name, "en-CA", { sensitivity: "base" }),
  );
}

/**
 * Another saved customer with the same email. Emails aren't unique — one
 * property manager can front several buildings — so this only informs.
 */
export function customerWithSameEmail<T extends { id: string; email: string }>(
  customers: readonly T[],
  email: string,
  exceptId: string | null,
): T | null {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  return customers.find((c) => c.id !== exceptId && c.email === target) ?? null;
}
