"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { signInWithEmailAndPassword } from "firebase/auth";

import { getClientAuth } from "@/lib/firebase/client";
import { authErrorMessage } from "@/lib/auth/authErrors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
  password: z.string().min(1, "Password is required."),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  tenantName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
}

export function PortalLoginForm({ tenantName, logoUrl, primaryColor }: Props) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      await signInWithEmailAndPassword(
        getClientAuth(),
        values.email,
        values.password,
      );
      router.replace("/portal");
    } catch (err) {
      setSubmitError(authErrorMessage(err));
    }
  }

  const submitting = form.formState.isSubmitting;
  const accentStyle = primaryColor
    ? ({ ["--portal-accent" as const]: primaryColor } as React.CSSProperties)
    : undefined;

  return (
    <Card className="w-full max-w-sm" style={accentStyle}>
      <CardHeader className="items-center text-center">
        {logoUrl ? (
          <Image
            src={logoUrl}
            alt={tenantName ?? "Logo"}
            width={64}
            height={64}
            className="mb-2 rounded"
            unoptimized
          />
        ) : null}
        <CardTitle>{tenantName ? `Sign in to ${tenantName}` : "Sign in"}</CardTitle>
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
                    <Input
                      type="email"
                      autoComplete="email"
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
              name="password"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Password</FormLabel>
                    <Link
                      href="/forgot-password"
                      className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Forgot?
                    </Link>
                  </div>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={submitting}
              style={
                primaryColor
                  ? { backgroundColor: primaryColor, borderColor: primaryColor }
                  : undefined
              }
            >
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
