import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requirePlatformAdmin } from "../shared/auth";
import { requireDocId } from "../shared/docId";
import { requireFeature } from "../shared/requireFeature";
import {
  edgeConfigDelete,
  edgeConfigUpsert,
  vercelAddDomain,
  vercelGetDomainStatus,
  vercelRemoveDomain,
  VERCEL_SECRETS,
} from "../shared/vercel";
import {
  addAuthorizedDomain,
  removeAuthorizedDomain,
} from "../shared/identityToolkit";
import {
  addRecaptchaAllowedDomain,
  removeRecaptchaAllowedDomain,
} from "../shared/recaptchaKey";
import { domainCacheKey } from "../shared/domainCacheKey";
import { withSentryCallable } from "../shared/withSentry";

// D18: custom domains are set up, removed and re-checked by the platform admin
// only, for the business named by `tenantId`. Self-serve setup let any business
// add a hostname it controls to the project-wide Firebase Auth authorized
// domains and collect other businesses' customers' sign-in codes there.
interface Input {
  tenantId?: unknown;
  domain?: unknown;
}

// The platform's own zone. Vercel treats a subdomain of a domain the team owns
// as verified at once, so no business may claim any host under it.
const PLATFORM_ZONE = "techflowsolutions.ca";

// Strict domain validation. We're going to write this string into a Firestore
// document ID and a Vercel API call — sanitize aggressively. RFC 1035-ish:
// labels ≤63 chars, total ≤253, lowercase, no leading/trailing dash, must
// contain at least one dot.
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function validateDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpsError("invalid-argument", "domain must be a string.");
  }
  const d = raw.trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) {
    throw new HttpsError(
      "invalid-argument",
      "domain is not a valid hostname.",
    );
  }
  // The platform zone (apex and every subdomain) and Vercel's own hosts.
  if (
    d === PLATFORM_ZONE ||
    d.endsWith(`.${PLATFORM_ZONE}`) ||
    d === "vercel.app" ||
    d.endsWith(".vercel.app")
  ) {
    throw new HttpsError(
      "invalid-argument",
      "This domain is reserved by the platform.",
    );
  }
  return d;
}

// The platform admin names the business; it must exist.
async function targetTenant(data: Input): Promise<{
  tenantId: string;
  metaRef: FirebaseFirestore.DocumentReference;
  meta: { customDomain?: string | null };
}> {
  const tenantId = requireDocId(data.tenantId, "tenantId");
  const metaRef = db.doc(`tenants/${tenantId}/meta/settings`);
  const metaSnap = await metaRef.get();
  if (!metaSnap.exists) {
    throw new HttpsError("not-found", "No business with that tenantId.");
  }
  return {
    tenantId,
    metaRef,
    meta: (metaSnap.data() ?? {}) as { customDomain?: string | null },
  };
}

export async function setupCustomDomainHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true; domain: string }> {
  requirePlatformAdmin(readClaims(request));
  const data = (request.data as Input | undefined) ?? {};
  const domain = validateDomain(data.domain);
  const { tenantId, metaRef, meta } = await targetTenant(data);
  await requireFeature(tenantId, "customDomain");

  // If this tenant already had a different custom domain, we detach the old
  // one after the new one is in place.
  const previousDomain = meta.customDomain ?? null;

  // Claim the hostname before provisioning anything. customDomains/{domain}
  // is the uniqueness index: the transaction creates it only if nobody holds
  // it, so two businesses racing for one hostname can't both win, and a
  // business re-running setup for its own domain keeps its claim.
  const domainRef = db.doc(`customDomains/${domain}`);
  const claimedNow = await db.runTransaction(async (tx) => {
    const existing = await tx.get(domainRef);
    if (existing.exists) {
      const owner = (existing.data() as { tenantId?: unknown } | undefined)
        ?.tenantId;
      if (owner !== tenantId) {
        throw new HttpsError("already-exists", "This domain is already in use.");
      }
      return false;
    }
    tx.create(domainRef, {
      tenantId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  // A provisioning failure gives back a claim this call made, never one the
  // business already held.
  const releaseClaim = async (): Promise<void> => {
    if (claimedNow) await domainRef.delete().catch(() => {});
  };

  // Step 1: Vercel — add to project domains. If this fails we abort before
  // touching Firestore so there's nothing to clean up.
  try {
    await vercelAddDomain(domain);
  } catch (err) {
    logger.error("setupCustomDomain: vercel add failed", { domain, err });
    await releaseClaim();
    throw new HttpsError(
      "internal",
      err instanceof Error ? err.message : "Vercel domain add failed.",
    );
  }

  // Step 2: Firebase Auth authorized domains.
  try {
    await addAuthorizedDomain(domain);
  } catch (err) {
    logger.error("setupCustomDomain: auth domain add failed", { domain, err });
    // Roll back Vercel.
    await vercelRemoveDomain(domain).catch(() => {});
    await releaseClaim();
    throw new HttpsError(
      "internal",
      err instanceof Error ? err.message : "Firebase Auth update failed.",
    );
  }

  // Step 2b: the reCAPTCHA Enterprise key behind App Check (R-04). Once
  // enforcement is on, customers on a domain the key doesn't list are rejected.
  // Skipped while RECAPTCHA_KEY_ID isn't configured.
  try {
    await addRecaptchaAllowedDomain(domain);
  } catch (err) {
    logger.error("setupCustomDomain: reCAPTCHA domain add failed", {
      domain,
      err,
    });
    await vercelRemoveDomain(domain).catch(() => {});
    await removeAuthorizedDomain(domain).catch(() => {});
    await releaseClaim();
    throw new HttpsError(
      "internal",
      err instanceof Error ? err.message : "reCAPTCHA key update failed.",
    );
  }

  // Step 3: Firestore — point the business's meta at the claimed domain.
  try {
    await metaRef.set(
      {
        customDomain: domain,
        customDomainStatus: {
          stage: "dns_pending",
          message: null,
          checkedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    logger.error("setupCustomDomain: firestore write failed", { domain, err });
    await vercelRemoveDomain(domain).catch(() => {});
    await removeAuthorizedDomain(domain).catch(() => {});
    await removeRecaptchaAllowedDomain(domain).catch(() => {});
    await releaseClaim();
    throw new HttpsError("internal", "Failed to record custom domain.");
  }

  // Step 4: Global Config cache write. Best-effort — the proxy falls back to
  // Firestore on a miss and self-heals, so a failure here isn't fatal. The key
  // must be a valid Global Config key (A-07); a host that can't be encoded is
  // simply served from Firestore.
  const cacheKey = domainCacheKey(domain);
  if (cacheKey) {
    try {
      await edgeConfigUpsert(cacheKey, tenantId);
    } catch (err) {
      logger.warn("setupCustomDomain: cache write failed (non-fatal)", {
        domain,
        err,
      });
    }
  }

  // Detach the previous domain (if any). Best-effort — if any sub-step fails
  // we log and continue; the new domain is already in place.
  if (previousDomain && previousDomain !== domain) {
    await detachDomain(previousDomain).catch((err) => {
      logger.warn("setupCustomDomain: previous-domain cleanup failed", {
        previousDomain,
        err,
      });
    });
  }

  return { ok: true, domain };
}

async function detachDomain(domain: string): Promise<void> {
  const cacheKey = domainCacheKey(domain);
  await Promise.allSettled([
    vercelRemoveDomain(domain),
    removeAuthorizedDomain(domain),
    removeRecaptchaAllowedDomain(domain),
    cacheKey ? edgeConfigDelete(cacheKey) : Promise.resolve(),
    db.doc(`customDomains/${domain}`).delete(),
  ]);
}

export const setupCustomDomain = onCall<Input>(
  { secrets: [...VERCEL_SECRETS] },
  withSentryCallable("setupCustomDomain", setupCustomDomainHandler),
);

// ---------------------------------------------------------------------------
// removeCustomDomain — the platform admin tears down a business's custom
// domain (D18).
// ---------------------------------------------------------------------------

export async function removeCustomDomainHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true }> {
  requirePlatformAdmin(readClaims(request));
  const { metaRef, meta } = await targetTenant(
    (request.data as Input | undefined) ?? {},
  );
  const domain = meta.customDomain ?? null;
  if (!domain) {
    return { ok: true };
  }

  await detachDomain(domain);

  await metaRef.set(
    {
      customDomain: null,
      customDomainStatus: {
        stage: "unverified",
        message: null,
        checkedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true };
}

export const removeCustomDomain = onCall<Input>(
  { secrets: [...VERCEL_SECRETS] },
  withSentryCallable("removeCustomDomain", removeCustomDomainHandler),
);

// ---------------------------------------------------------------------------
// recheckCustomDomain — the platform admin's manual "check now" (D18). The
// scheduled function runs the same logic on a 5-minute cron.
// ---------------------------------------------------------------------------

export async function checkAndUpdateDomainStatus(
  tenantId: string,
  domain: string,
): Promise<{ stage: string; message: string | null }> {
  let status;
  try {
    status = await vercelGetDomainStatus(domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vercel query failed.";
    await db.doc(`tenants/${tenantId}/meta/settings`).set(
      {
        customDomainStatus: {
          stage: "error",
          message,
          checkedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { stage: "error", message };
  }

  let stage: "dns_pending" | "ssl_pending" | "verified";
  let message: string | null;
  if (!status.verified) {
    stage = "dns_pending";
    message = "Add the DNS records below, then re-check.";
  } else if (status.misconfigured) {
    stage = "ssl_pending";
    message = "DNS verified. Waiting on SSL issuance (usually <10 min).";
  } else {
    stage = "verified";
    message = null;
  }

  await db.doc(`tenants/${tenantId}/meta/settings`).set(
    {
      customDomainStatus: {
        stage,
        message,
        checkedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { stage, message };
}

export async function recheckCustomDomainHandler(
  request: CallableRequest<Input>,
): Promise<{ stage: string; message: string | null }> {
  requirePlatformAdmin(readClaims(request));
  const { tenantId, meta } = await targetTenant(
    (request.data as Input | undefined) ?? {},
  );
  const domain = meta.customDomain ?? null;
  if (!domain) {
    throw new HttpsError(
      "failed-precondition",
      "No custom domain configured for this tenant.",
    );
  }
  return checkAndUpdateDomainStatus(tenantId, domain);
}

export const recheckCustomDomain = onCall<Input>(
  { secrets: [...VERCEL_SECRETS] },
  withSentryCallable("recheckCustomDomain", recheckCustomDomainHandler),
);
