"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
} from "firebase/auth";

import { getClientAuth } from "@/lib/firebase/client";
import { authErrorMessage } from "@/lib/auth/authErrors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

type FormValues = z.infer<typeof schema>;

function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

export default function AcceptInviteSignupPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Suspense fallback={null}>
        <SignupInner />
      </Suspense>
    </div>
  );
}

function SignupInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next")) ?? "/accept-invite";
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  // Invite acceptance creates only the Firebase Auth user; the tenant already
  // exists, so onSignup must NOT run (it would bootstrap a parallel tenant).
  // After verification the invitee returns to /accept-invite which calls
  // onAcceptInvite — that callable is what sets the tenantId/role claims.
  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    const auth = getClientAuth();
    try {
      const cred = await createUserWithEmailAndPassword(
        auth,
        values.email,
        values.password,
      );
      try {
        await sendEmailVerification(cred.user, {
          url: typeof window !== "undefined"
            ? `${window.location.origin}${next}`
            : next,
          handleCodeInApp: false,
        });
      } catch {
        // Verification email failures shouldn't block the flow — the user
        // can request a resend on /verify-email.
      }
      router.replace(`/verify-email?next=${encodeURIComponent(next)}`);
    } catch (err) {
      setSubmitError(authErrorMessage(err));
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>
          Use the email address the invitation was sent to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
            {submitError ? (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="email" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
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
              {submitting ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </Form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
