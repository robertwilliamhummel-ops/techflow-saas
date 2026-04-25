"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  type ActionCodeInfo,
} from "firebase/auth";

import { getClientAuth } from "@/lib/firebase/client";
import { authErrorMessage } from "@/lib/auth/authErrors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "verify-success" }
  | { kind: "reset-form"; email: string }
  | { kind: "reset-success" };

const resetSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Passwords do not match.",
  });

type ResetValues = z.infer<typeof resetSchema>;

function ActionPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const mode = params.get("mode");
  const oobCode = params.get("oobCode");

  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const auth = getClientAuth();
      if (!mode || !oobCode) {
        if (!cancelled)
          setStatus({ kind: "error", message: "Missing action code." });
        return;
      }
      try {
        // Validate the code first so expired/used codes show a clear message
        // instead of a downstream confusing failure.
        const info: ActionCodeInfo = await checkActionCode(auth, oobCode);
        if (cancelled) return;

        if (mode === "verifyEmail") {
          await applyActionCode(auth, oobCode);
          if (!cancelled) setStatus({ kind: "verify-success" });
          // Reload the current user so emailVerified is fresh on the next page.
          await auth.currentUser?.reload().catch(() => {});
          // Soft auto-redirect after a short pause so the user sees the success.
          setTimeout(() => {
            if (auth.currentUser) router.replace("/dashboard");
            else router.replace("/login");
          }, 1500);
          return;
        }

        if (mode === "resetPassword") {
          const email = info.data.email ?? "";
          if (!cancelled) setStatus({ kind: "reset-form", email });
          return;
        }

        if (mode === "recoverEmail") {
          await applyActionCode(auth, oobCode);
          if (!cancelled) setStatus({ kind: "verify-success" });
          return;
        }

        if (!cancelled)
          setStatus({
            kind: "error",
            message: `Unsupported action: ${mode}.`,
          });
      } catch (err) {
        if (!cancelled)
          setStatus({ kind: "error", message: authErrorMessage(err) });
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode, router]);

  if (status.kind === "loading") {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-muted border-t-primary" />
        </CardContent>
      </Card>
    );
  }

  if (status.kind === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Link error</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert variant="destructive">
            <AlertDescription>{status.message}</AlertDescription>
          </Alert>
          <Button render={<Link href="/login" />} variant="outline">
            Back to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === "verify-success") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Email verified</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert>
            <AlertDescription>
              Your email is verified. Redirecting…
            </AlertDescription>
          </Alert>
          <Button render={<Link href="/dashboard" />}>
            Go to dashboard
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === "reset-success") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password updated</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert>
            <AlertDescription>
              Your password has been changed. Sign in with your new password.
            </AlertDescription>
          </Alert>
          <Button render={<Link href="/login" />}>Sign in</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <ResetPasswordForm
      email={status.email}
      oobCode={oobCode!}
      onSuccess={() => setStatus({ kind: "reset-success" })}
    />
  );
}

function ResetPasswordForm({
  email,
  oobCode,
  onSuccess,
}: {
  email: string;
  oobCode: string;
  onSuccess: () => void;
}) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirm: "" },
  });

  async function onSubmit(values: ResetValues) {
    setSubmitError(null);
    try {
      await confirmPasswordReset(getClientAuth(), oobCode, values.password);
      onSuccess();
    } catch (err) {
      setSubmitError(authErrorMessage(err));
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
            {email ? (
              <p className="text-sm text-muted-foreground">
                Resetting password for <span className="font-medium text-foreground">{email}</span>.
              </p>
            ) : null}
            {submitError ? (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      autoFocus
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm new password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={submitting}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

export default function AuthActionPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardContent className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-muted border-t-primary" />
          </CardContent>
        </Card>
      }
    >
      <ActionPageInner />
    </Suspense>
  );
}
