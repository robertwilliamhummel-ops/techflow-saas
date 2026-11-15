import type { Metadata } from "next";

import { platformMetadata } from "@/lib/platformMetadata";

export function generateMetadata(): Promise<Metadata> {
  return platformMetadata("Join your team");
}

export default function AcceptInviteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
