import { NextResponse, type NextRequest } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { edgeConfigGet, edgeConfigPut } from "@/lib/edgeConfig";
import { domainCacheKey } from "@/lib/domainCacheKey";

// ---------------------------------------------------------------------------
// Custom-domain proxy (Phase 5 / Bundle E; Next 16 renamed `middleware` to `proxy`)
//
// Purpose: resolve `Host` header → tenantId so the public portal renders
// branded for the right contractor. Hot path is Vercel Edge Config (sub-50ms
// globally replicated), cold path falls back to Firestore and re-populates
// Edge Config on the spot.
//
// R3: matcher excludes static assets / API routes / files with extensions —
//     without it, every image/font triggers a Firestore read.
// R6: proxy always runs on the Node.js runtime (not configurable in Next 16),
//     which the Firebase Admin SDK needs. Module-level singleton for adminDb
//     so init only happens once per serverless instance.
// ---------------------------------------------------------------------------

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/|.*\\..*).*)",
  ],
};

// Request header the portal layouts trust for tenant branding. Only routes the
// matcher covers may read it — excluded paths never pass through the strip below.
const TENANT_HEADER = "x-tenant-id";

// Hosts that bypass tenant resolution. The generic portal serves the platform
// brand and resolves tenantId from the signed-in user's claims after login.
// Local dev and Vercel preview URLs also bypass. The marketing site is a
// separate Vercel project and never reaches this app.
function isGenericHost(host: string): boolean {
  const generic = process.env.PORTAL_GENERIC_HOST ?? "portal.techflowsolutions.ca";
  if (host === generic) return true;
  // Local dev — both `localhost` and `127.0.0.1` always treated as generic.
  if (host === "localhost" || host.startsWith("localhost:")) return true;
  if (host.startsWith("127.0.0.1")) return true;
  // Vercel preview deploys end in .vercel.app — never custom-tenant scoped.
  if (host.endsWith(".vercel.app")) return true;
  return false;
}

// Lazy admin init — singleton at module scope so warm invocations skip it.
// Returns null when admin env vars are absent (build-time / dev without
// secrets) so the proxy degrades to "no Firestore fallback" cleanly
// instead of crashing the request.
let _adminDbHandle: ReturnType<typeof getFirestore> | null | undefined;

function getAdminDbForProxy() {
  if (_adminDbHandle !== undefined) return _adminDbHandle;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) {
    _adminDbHandle = null;
    return null;
  }
  try {
    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, "\n"),
        }),
      });
    _adminDbHandle = getFirestore(app);
    return _adminDbHandle;
  } catch {
    _adminDbHandle = null;
    return null;
  }
}

// Self-heal writes are billed and rate-limited (Global Config allows 100 writes
// an hour on Pro), and a new entry takes up to 10 seconds to propagate, so each
// instance re-populates a given host at most once per window. The map is capped
// so an unusual number of distinct hosts can't grow memory without bound.
const HEAL_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_HOSTS = 1000;
const lastHealAt = new Map<string, number>();

function shouldHeal(cacheKey: string, now: number = Date.now()): boolean {
  const last = lastHealAt.get(cacheKey);
  if (last !== undefined && now - last < HEAL_INTERVAL_MS) return false;
  lastHealAt.delete(cacheKey);
  lastHealAt.set(cacheKey, now);
  if (lastHealAt.size > MAX_TRACKED_HOSTS) {
    const oldest = lastHealAt.keys().next().value;
    if (oldest !== undefined) lastHealAt.delete(oldest);
  }
  return true;
}

async function resolveTenantId(host: string): Promise<string | null> {
  // Global Config is the hot lookup (per Phase 5 cache spec). Hosts that can't
  // be a valid cache key (A-07) go straight to Firestore.
  const cacheKey = domainCacheKey(host);
  if (cacheKey) {
    const cached = await edgeConfigGet(cacheKey);
    if (cached) return cached;
  }

  // Cache miss → single Firestore read, then re-populate the cache so the
  // next request is hot. Stored at top-level `customDomains/{domain}`.
  const adminDb = getAdminDbForProxy();
  if (!adminDb) return null;
  try {
    const snap = await adminDb.doc(`customDomains/${host}`).get();
    if (!snap.exists) return null;
    const tenantId = (snap.data() as { tenantId?: string } | undefined)?.tenantId;
    if (!tenantId) return null;
    // Fire-and-forget — don't block the user response on the cache write.
    if (cacheKey && shouldHeal(cacheKey)) {
      void edgeConfigPut(cacheKey, tenantId);
    }
    return tenantId;
  } catch {
    return null;
  }
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const host = (req.headers.get("host") ?? "").toLowerCase();

  // Never let a client-supplied tenant header through — otherwise anyone on
  // the generic host could render another tenant's branding by sending it.
  // Headers on the *request* (via NextResponse.next({ request: { headers } }))
  // replace the incoming set and propagate into Server Components via `headers()`.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete(TENANT_HEADER);

  if (isGenericHost(host)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const tenantId = await resolveTenantId(host);

  if (!tenantId) {
    // Unrecognized custom host — render 404 rather than the generic portal.
    return new NextResponse("Not found", { status: 404 });
  }

  requestHeaders.set(TENANT_HEADER, tenantId);
  return NextResponse.next({ request: { headers: requestHeaders } });
}
