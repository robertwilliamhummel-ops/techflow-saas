"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/settings", label: "Business" },
  { href: "/settings/branding", label: "Branding" },
  { href: "/settings/payments", label: "Payments" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/domain", label: "Domain" },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6 md:flex-row md:gap-10">
      <aside className="md:w-48 md:shrink-0">
        <h1 className="mb-3 text-lg font-semibold">Settings</h1>
        <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col">
          {NAV.map((item) => {
            const active =
              item.href === "/settings"
                ? pathname === "/settings"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
