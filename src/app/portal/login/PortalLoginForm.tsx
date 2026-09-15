"use client";

// Customer portal sign-in (S-10). Customers have no password: they ask for a
// sign-in link, which sendPortalSignInLink emails, and the link returns here,
// where Firebase finishes signing in and the customer goes on to the page they
// asked for (blueprint, "Customer magic link flow").

import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { isSignInWithEmailLink, signInWithEmailLink } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import * as Sentry from "@sentry/nextjs";

import { TextField } from "@/components/forms/fields";
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
  forgetSignInEmail,
  recallSignInEmail,
  rememberSignInEmail,
} from "@/lib/auth/emailLinkStorage";
import { useAuth } from "@/lib/auth/useAuth";
import { computeForeground } from "@/lib/design/contrast";
import { isValidEmail } from "@/lib/email";
import { getClientAuth, getClientFunctions } from "@/lib/firebase/client";
import { portalAccent } from "@/lib/portal/portalHome";
import {
  requestLinkErrorMessage,
  signInContinueUrl,
  signInLinkFailure,
  type SignInLinkFailure,
} from "@/lib/portal/portalSignIn";

interface Props {
  tenantName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  /** The portal page to open after signing in, already checked by the page. */
  next: string | null;
}

const noSubscribe = () => () => {};

export function PortalLoginForm({ tenantName, logoUrl, primaryColor, next }: Props) {
  const router = useRouter();
  const { user, claims, loading } = useAuth();
  const destination = next ?? "/portal";

  // Browser-only values, read during render rather than from an effect; both
  // are null while the page renders on the server.
  const href = useSyncExternalStore(noSubscribe, () => window.location.href, () => null);
  const remembered = useSyncExternalStore(noSubscribe, recallSignInEmail, () => null);
  const isLink = href !== null && isSignInWithEmailLink(getClientAuth(), href);

  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [typed, setTyped] = useState<{ address: string; attempt: number } | null>(null);
  const [failure, setFailure] = useState<SignInLinkFailure | null>(null);
  const attempted = useRef<string | null>(null);

  // The address to finish with: what the customer typed, else the one stored
  // when the link was requested on this browser (unless that one was wrong).
  const linkEmail = typed?.address ?? (failure?.kind === "wrong-email" ? null : remembered);
  const completing = isLink && linkEmail !== null && failure === null;
  const signedInCustomer =
    !loading && user !== null && !claims.tenantId && claims.email_verified === true;

  useEffect(() => {
    if (!completing || href === null || linkEmail === null) return;
    // A link works once, and Strict Mode runs effects twice in development.
    const key = `${href}|${linkEmail}|${typed?.attempt ?? 0}`;
    if (attempted.current === key) return;
    attempted.current = key;
    signInWithEmailLink(getClientAuth(), linkEmail, href)
      .then(() => {
        forgetSignInEmail();
        router.replace(destination);
      })
      .catch((err: unknown) => {
        const reason = signInLinkFailure(err);
        if (reason.kind === "other") Sentry.captureException(err);
        if (reason.kind === "wrong-email") forgetSignInEmail();
        setFailure(reason);
      });
  }, [completing, href, linkEmail, typed, destination, router]);

  // A customer who is already signed in goes straight on — unless this is a
  // sign-in link, which may be for someone else.
  useEffect(() => {
    if (signedInCustomer && href !== null && !isLink) router.replace(destination);
  }, [signedInCustomer, href, isLink, destination, router]);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!isValidEmail(address)) {
      setFormError("Enter a valid email address.");
      return;
    }
    setFormError(null);
    setSending(true);
    try {
      // Stored before the request, so this browser can finish without asking again.
      rememberSignInEmail(address);
      await httpsCallable<{ email: string; continueUrl: string }, { ok: true }>(
        getClientFunctions(),
        "sendPortalSignInLink",
      )({ email: address, continueUrl: signInContinueUrl(window.location.origin, next) });
      setSentTo(address);
      setFailure(null);
    } catch (err) {
      Sentry.captureException(err);
      setFormError(requestLinkErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function confirmEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!isValidEmail(address)) {
      setFormError("Enter a valid email address.");
      return;
    }
    setFormError(null);
    setFailure(null);
    setTyped((previous) => ({ address, attempt: (previous?.attempt ?? 0) + 1 }));
  }

  const accentStyle = primaryColor
    ? (() => {
        const accent = portalAccent(primaryColor);
        return { backgroundColor: accent, borderColor: accent, color: computeForeground(accent) };
      })()
    : undefined;

  let title = tenantName ? `Sign in to ${tenantName}` : "Sign in to see your invoices";
  let description: string | null = "We'll email you a link to sign in. No password needed.";
  let body: ReactNode;

  if (href === null || completing || (signedInCustomer && !isLink)) {
    description = null;
    body = (
      <p role="status" className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-muted border-t-foreground motion-reduce:animate-none"
        />
        {completing ? "Signing you in…" : "Loading…"}
      </p>
    );
  } else if (isLink && (failure === null || failure.kind === "wrong-email")) {
    title = "Confirm your email";
    description = "For your security, enter the email address this sign-in link was sent to.";
    body = (
      <form onSubmit={confirmEmail} className="grid gap-4" noValidate>
        {failure ? (
          <Alert variant="destructive">
            <AlertDescription>{failure.message}</AlertDescription>
          </Alert>
        ) : null}
        <TextField
          id="portal-signin-confirm-email"
          label="Email"
          error={formError ?? undefined}
          inputProps={{
            type: "email",
            autoComplete: "email",
            inputMode: "email",
            autoFocus: true,
            value: email,
            onChange: (event) => setEmail(event.target.value),
          }}
        />
        <Button type="submit" style={accentStyle}>
          Sign in
        </Button>
      </form>
    );
  } else if (sentTo) {
    title = "Check your email";
    description = null;
    body = (
      <div className="grid gap-3 text-sm">
        <p>
          If <span className="font-medium wrap-anywhere">{sentTo}</span> has invoices or quotes
          from a business that uses this portal, a sign-in link is on its way.
        </p>
        <p className="text-muted-foreground">
          Open it on this device to go straight in. Each link works once.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setSentTo(null);
            setEmail("");
          }}
        >
          Use a different email
        </Button>
      </div>
    );
  } else {
    body = (
      <form onSubmit={requestLink} className="grid gap-4" noValidate>
        {failure ? (
          <Alert variant="destructive">
            <AlertDescription>{failure.message}</AlertDescription>
          </Alert>
        ) : null}
        <TextField
          id="portal-signin-email"
          label="Email"
          error={formError ?? undefined}
          inputProps={{
            type: "email",
            autoComplete: "email",
            inputMode: "email",
            autoFocus: true,
            value: email,
            onChange: (event) => setEmail(event.target.value),
          }}
        />
        <Button type="submit" disabled={sending} style={accentStyle}>
          {sending ? "Sending…" : "Email me a sign-in link"}
        </Button>
      </form>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        {logoUrl ? (
          <Image
            src={logoUrl}
            alt={tenantName ?? "Logo"}
            width={64}
            height={64}
            className="mx-auto mb-2 rounded"
            unoptimized
          />
        ) : null}
        <CardTitle className="text-balance">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
