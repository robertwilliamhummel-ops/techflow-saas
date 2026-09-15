// The email a portal sign-in link was sent to (S-10). Firebase needs the
// address again to finish signing in, and the link must never carry it —
// Firebase warns an email passed in the URL enables session injection. A
// different browser or device has no stored address, so the page asks for it.

const KEY = "emailForSignIn";

export function rememberSignInEmail(email: string): void {
  try {
    window.localStorage.setItem(KEY, email);
  } catch {
    // Storage blocked (private mode): the page asks for the address instead.
  }
}

export function recallSignInEmail(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetSignInEmail(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing stored to remove.
  }
}
