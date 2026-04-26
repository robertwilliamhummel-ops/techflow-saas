import { NextResponse, type NextRequest } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { edgeConfigGet, edgeConfigPut } from "@/lib/edgeConfig";

// ---------------------------------------------------------------------------
// Custom-domain middleware (Phase 5 / Bundle E)
//
// Purpose: resolve `Host` header → tenantId so the public portal renders
// branded for the right contractor. Hot path is Vercel Edge Config (sub-50ms
// globally replicated), cold path falls back to Firestore and re-populates
// Edge Config on the spot.
//
// R3: matcher excludes static assets / API routes / files with extensions —
//     without it, every image/font triggers a Firestore read.
// R6: runs on Node.js runtime (Firebase Admin SDK has no Edge equivalent).
//     Module-level singleton for adminDb so init only happens once per
//     serverless instance.
// ---------------------------------------------------------------------------

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/|.*\\..*).*)",
  ],
};

export const runtime = "nodejs";

// Hosts that bypass tenant resolution. The generic portal serves the platform
// brand and resolves tenantId from the signed-in user's claims after login.
// Any non-portal host (the marketing site, Vercel preview URLs) also bypasses.
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
// secrets) so the middleware degrades to "no Firestore fallback" cleanly
// instead of crashing the request.
let _adminDbHandle: ReturnType<typeof getFirestore> | null | undefined;

function getAdminDbForMiddleware() {
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

async function resolveTenantId(host: string): Promise<string | null> {
  // Edge Config is the authoritative hot lookup (per Phase 5 cache spec).
  const cached = await edgeConfigGet(`domain:${host}`);
  if (cached) return cached;

  // Cache miss → single Firestore read, then re-populate Edge Config so the
  // next request is hot. Stored at top-level `customDomains/{domain}`.
  const adminDb = getAdminDbForMiddleware();
  if (!adminDb) return null;
  try {
    const snap = await adminDb.doc(`customDomains/${host}`).get();
    if (!snap.exists) return null;
    const tenantId = (snap.data() as { tenantId?: string } | undefined)?.tenantId;
    if (!tenantId) return null;
    // Fire-and-forget — don't block the user response on the cache write.
    void edgeConfigPut(`domain:${host}`, tenantId);
    return tenantId;
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const host = (req.headers.get("host") ?? "").toLowerCase();

  if (isGenericHost(host)) {
    return NextResponse.next();
  }

  const tenantId = await resolveTenantId(host);

  if (!tenantId) {
    // Unrecognized custom host — render 404 rather than the generic portal.
    return new NextResponse("Not found", { status: 404 });
  }

  // Inject tenant ID for downstream layouts/RSC. Headers on the *request*
  // (via NextResponse.next({ request: { headers } })) propagate into Server
  // Components via `headers()`.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-tenant-id", tenantId);
  return NextResponse.next({ request: { headers: requestHeaders } });
}
