"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { httpsCallable } from "firebase/functions";

import { getClientFunctions } from "@/lib/firebase/client";
import { useAuth } from "@/lib/auth/useAuth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function AcceptInvitePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Suspense fallback={<LoadingCard message="Loading…" />}>
        <AcceptInviteFlow />
      </Suspense>
    </div>
  );
}

type Status =
  | { kind: "init" }
  | { kind: "needs-signin" }
  | { kind: "needs-verify" }
  | { kind: "wrong-email"; expected: string; actual: string }
  | { kind: "accepting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function AcceptInviteFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, claims, loading: authLoading, refreshClaims, signOut } = useAuth();

  const tenantId = params.get("tenantId") ?? "";
  const invitationId = params.get("invitationId") ?? "";
  const token = params.get("token") ?? "";
  const linkComplete = Boolean(tenantId && invitationId && token);

  const [status, setStatus] = useState<Status>({ kind: "init" });

  useEffect(() => {
    if (!linkComplete) {
      setStatus({
        kind: "error",
        message:
          "This invitation link is missing required information. Ask the sender to re-send it.",
      });
      return;
    }
    if (authLoading) return;
    if (!user) {
      setStatus({ kind: "needs-signin" });
      return;
    }
    if (!claims.email_verified) {
      setStatus({ kind: "needs-verify" });
      return;
    }
    if (status.kind !== "init" && status.kind !== "accepting") return;
    setStatus({ kind: "accepting" });
    (async () => {
      try {
        const fn = httpsCallable(getClientFunctions(), "onAcceptInvite");
        await fn({ tenantId, invitationId, token });
        await refreshClaims();
        setStatus({ kind: "success" });
        setTimeout(() => router.replace("/dashboard"), 800);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not accept invitation.";
        if (
          message.includes("issued to a different email") &&
          user?.email
        ) {
          setStatus({
            kind: "wrong-email",
            expected: "the invited address",
            actual: user.email,
          });
        } else {
          setStatus({ kind: "error", message });
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, claims.email_verified, linkComplete]);

  const inviteHref = `/accept-invite?tenantId=${encodeURIComponent(
    tenantId,
  )}&invitationId=${encodeURIComponent(
    invitationId,
  )}&token=${encodeURIComponent(token)}`;
  const loginHref = `/login?next=${encodeURIComponent(inviteHref)}`;
  const signupHref = `/accept-invite/signup?next=${encodeURIComponent(inviteHref)}`;

  if (authLoading || status.kind === "init") {
    return <LoadingCard message="Loading invitation…" />;
  }

  if (status.kind === "needs-signin") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Accept invitation</CardTitle>
          <CardDescription>
            Sign in or create an account to join the workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Button asChild>
            <Link href={loginHref}>Sign in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={signupHref}>Create account</Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            Use the email address the invitation was sent to.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === "needs-verify") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Verify your email first</CardTitle>
          <CardDescription>
            We sent a verification link when you signed up. Verify, then return
            to this page to finish accepting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href={`/verify-email?next=${encodeURIComponent(inviteHref)}`}>
              Continue to verification
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === "wrong-email") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Wrong account</CardTitle>
          <CardDescription>
            This invitation was sent to a different email address.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Alert>
            <AlertDescription>
              You&rsquo;re signed in as <strong>{status.actual}</strong>. Sign
              out and sign in with {status.expected}.
            </AlertDescription>
          </Alert>
          <Button
            variant="outline"
            onClick={async () => {
              await signOut();
              router.replace(loginHref);
            }}
          >
            Sign out
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === "error") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>We couldn&rsquo;t accept this invitation</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Alert variant="destructive">
            <AlertDescription>{status.message}</AlertDescription>
          </Alert>
          <Button asChild variant="outline">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === "success") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>You&rsquo;re in.</CardTitle>
          <CardDescription>Redirecting to your dashboard…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return <LoadingCard message="Joining workspace…" />;
}

function LoadingCard({ message }: { message: string }) {
  return (
    <Card className="w-full max-w-sm">
      <CardContent className="flex items-center gap-3 p-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}
