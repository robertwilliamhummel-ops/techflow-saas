import type { Metadata } from "next";

// The page is a client component, so its tab title lives here (G-03).
export const metadata: Metadata = { title: "Sign in" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
