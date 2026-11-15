import type { Metadata } from "next";
import { CustomersList } from "@/components/customers/CustomersList";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage() {
  return <CustomersList />;
}
