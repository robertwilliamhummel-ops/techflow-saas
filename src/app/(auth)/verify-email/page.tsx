"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { sendEmailVerification } from "firebase/auth";

import { getClientAuth } from "@/lib/firebase/client";
import { useAuth } from "@/lib/auth/useAuth";
import { authErrorMessage } from "@/lib/auth/authErrors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const POLL_INTERVAL_MS = 3000;

export default function VerifyEmailPage() {
  const router = useRouter();
  const { user, loading, signOut } = useAuth();

  const [resendError, setResendError] = useState<string | null>(null);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Bounce signed-out visitors to login.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // Poll for verification — when user clicks the link in another tab,
  // reload the user object and redirect once verified.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      const current = getClientAuth().currentUser;
      if (!current) return;
      await current.reload().catch(() => {});
      if (current.emailVerified) {
        clearInterval(interval);
        router.replace("/dashboard");
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user, router]);

  async function handleResend() {
    const current = getClientAuth().currentUser;
    if (!current) return;
    setSending(true);
    setResendError(null);
    setResendInfo(null);
    try {
      const url = `${window.location.origin}/auth/action`;
      await sendEmailVerification(current, { url });
      setResendInfo("Verification email sent. Check your inbox.");
    } catch (err) {
      setResendError(authErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  if (loading || !user) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-muted border-t-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          We sent a verification link to{" "}
          <span className="font-medium text-foreground">{user.email}</span>.
          Click the link to finish setting up your account. This page will
          continue automatically once you&apos;re verified.
        </p>
        {resendInfo ? (
          <Alert>
            <AlertDescription>{resendInfo}</AlertDescription>
          </Alert>
        ) : null}
        {resendError ? (
          <Alert variant="destructive">
            <AlertDescription>{resendError}</AlertDescription>
          </Alert>
        ) : null}
        <Button onClick={handleResend} disabled={sending}>
          {sending ? "Sending…" : "Resend verification email"}
        </Button>
        <Button onClick={() => signOut().then(() => router.replace("/login"))} variant="outline">
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}
