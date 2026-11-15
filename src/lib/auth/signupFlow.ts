// The business signup sequence (blueprint Phase 5), made recoverable.
//
// The Auth user is created before onSignup creates the business, so a failed
// onSignup (a transient error, a cold-start timeout, App Check blocked) used to
// leave an account with no business: retrying hit auth/email-already-in-use and
// no screen called onSignup again. Now a retry carries on from where it
// stopped: the create fails with email-already-in-use, the same email and
// password sign in to the account the first try made (whether or not it is
// still signed in here), and onSignup runs for it. The session alone is never
// trusted: a portal customer signed in by email link has an account with no
// password (Firebase lists it under the "password" provider too), and a
// business must not be attached to it without one. onSignup is safe to repeat:
// a call after a committed signup returns the same tenant and re-applies its
// claims (A-12).

export interface SignupUser {
  emailVerified: boolean;
}

export interface SignupSteps<U extends SignupUser> {
  createUser(email: string, password: string): Promise<U>;
  signIn(email: string, password: string): Promise<U>;
  /** The tenantId claim from a freshly refreshed ID token, or null. */
  tenantIdOf(user: U): Promise<string | null>;
  onSignup(businessName: string): Promise<void>;
  sendEmailVerification(user: U): Promise<void>;
}

export interface SignupValues {
  businessName: string;
  email: string;
  password: string;
}

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

/**
 * Creates the account and its business, or finishes a signup an earlier try
 * left half done. Resolves once the ID token carries the new tenantId; the
 * caller then goes to the dashboard. An account that already has a business is
 * left as it is (signed in), as logging in would.
 */
export async function completeSignup<U extends SignupUser>(
  values: SignupValues,
  steps: SignupSteps<U>,
): Promise<void> {
  let user: U;
  let created = false;
  try {
    user = await steps.createUser(values.email, values.password);
    created = true;
  } catch (err) {
    if (errorCode(err) !== "auth/email-already-in-use") throw err;
    // The account may be one an earlier try created. Only its own password
    // signs it in; anything else reports the original error, which says
    // nothing about whether the password was close.
    try {
      user = await steps.signIn(values.email, values.password);
    } catch {
      throw err;
    }
  }

  if (!created && (await steps.tenantIdOf(user))) return;

  // Await onSignup so Firestore docs + custom claims exist before redirecting.
  await steps.onSignup(values.businessName);

  // Fire-and-forget — don't block the redirect on the email send.
  if (!user.emailVerified) steps.sendEmailVerification(user).catch(() => {});

  // Force-refresh the ID token so the client sees the new tenantId claim.
  await steps.tenantIdOf(user);
}
