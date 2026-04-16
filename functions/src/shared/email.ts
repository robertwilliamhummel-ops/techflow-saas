// Lowercase + trim at every write boundary. C2 fix from round-3 audit.
export function lowerEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(raw: unknown): boolean {
  const v = lowerEmail(raw);
  return v.length > 0 && v.length <= 254 && EMAIL_REGEX.test(v);
}
