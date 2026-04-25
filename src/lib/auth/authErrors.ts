// Map Firebase Auth error codes to user-friendly strings.
// We intentionally collapse user-not-found / wrong-password into a single
// generic message — exposing which one is which is account enumeration.

const MESSAGES: Record<string, string> = {
  "auth/invalid-email": "That email address is not valid.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/email-already-in-use":
    "An account with that email already exists. Try signing in.",
  "auth/weak-password": "Password must be at least 8 characters.",
  "auth/too-many-requests":
    "Too many attempts. Try again in a few minutes or reset your password.",
  "auth/network-request-failed":
    "Network error. Check your connection and try again.",
  "auth/expired-action-code":
    "This link has expired. Request a new one.",
  "auth/invalid-action-code":
    "This link is invalid or has already been used.",
  "auth/missing-email": "Email is required.",
  "auth/requires-recent-login":
    "Please sign in again to complete this action.",
};

export function authErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}
