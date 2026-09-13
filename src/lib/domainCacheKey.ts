// Global Config (formerly Edge Config) item key for a custom domain's
// domain → tenantId cache entry (A-07).
//
// Vercel only accepts keys made of A–Z, a–z, 0–9, "_" and "-", up to 256
// characters. Hostnames contain only letters, digits, "-" and ".", never "_",
// so replacing "." with "_" can't give two hosts the same key. Anything that
// isn't a plain hostname (a port, an underscore, a single label) or whose key
// would be too long returns null, and callers skip the cache and use Firestore.
//
// Kept identical in src/lib/domainCacheKey.ts and
// functions/src/shared/domainCacheKey.ts — the two packages don't share code.
// functions/test/shared/domainCacheKey.test.ts checks both give the same answers.

const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const MAX_KEY_LENGTH = 256;

export function domainCacheKey(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  if (!HOSTNAME.test(normalized)) return null;
  const key = `domain_${normalized.replace(/\./g, "_")}`;
  return key.length <= MAX_KEY_LENGTH ? key : null;
}
