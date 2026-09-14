// Mirrors isValidEmail in functions/src/shared/email.ts (a test pins the two),
// so forms refuse the addresses Cloud Functions would.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value.length > 0 && value.length <= 254 && EMAIL_REGEX.test(value);
}
