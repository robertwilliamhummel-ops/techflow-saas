// Public no-auth pay pages — light mode like /portal.
// JWT pay token in the URL is the authorization, not Firebase Auth.
// Intentionally no provider context here (Phase 4 wires SSR token verification).
export default function PayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">{children}</div>
  );
}
