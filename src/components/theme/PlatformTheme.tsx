"use client";

import { useEffect } from "react";

// Platform screens currently mounted. Navigating from one to another can mount
// the next before the last unmounts, so <html> loses the attribute only when
// none is left.
let mounted = 0;

/**
 * Marks the platform's own screens — the dashboard, sign-in and account pages —
 * so they wear TechFlow's brand (D17): globals.css swaps the design tokens
 * inside `[data-theme="platform"]`, light or dark with the visitor's system
 * setting. Tenant-facing pages (portal, pay page, custom domains) never render
 * this, so they keep the neutral tokens and each business's own colours.
 *
 * The wrapper themes the page from the first server render. While mounted, the
 * attribute also goes on <html>, so menus, dialogs and toasts — rendered into
 * <body>, outside the wrapper — match. It comes off on unmount (React also runs
 * this cleanup when it hides a route), so it never reaches a tenant page.
 */
export function PlatformTheme({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const root = document.documentElement;
    mounted += 1;
    root.dataset.theme = "platform";
    return () => {
      mounted -= 1;
      if (mounted === 0) delete root.dataset.theme;
    };
  }, []);

  return (
    <div data-theme="platform" className={className}>
      {children}
    </div>
  );
}
