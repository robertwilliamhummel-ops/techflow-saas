import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db, FieldValue } from "../shared/admin";
import { readClaims, requireRole, requireTenant } from "../shared/auth";
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

interface Input {
  domain?: unknown;
}

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
  // Block apex domains we already control + Vercel preview hosts.
  if (
    d === "techflowsolutions.ca" ||
    d === "portal.techflowsolutions.ca" ||
    d.endsWith(".vercel.app")
  ) {
    throw new HttpsError(
      "invalid-argument",
      "This domain is reserved by the platform.",
    );
  }
  return d;
}

export async function setupCustomDomainHandler(
  request: CallableRequest<Input>,
): Promise<{ ok: true; domain: string }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);
  await requireFeature(tenantId, "customDomain");

  const data = (request.data as Input | undefined) ?? {};
  const domain = validateDomain(data.domain);

  // Reject if the domain already maps to a different tenant. Use the
  // top-level customDomains/{domain} doc as the uniqueness index.
  const domainRef = db.doc(`customDomains/${domain}`);
  const existing = await domainRef.get();
  if (existing.exists) {
    const owner = (existing.data() as { tenantId?: string } | undefined)
      ?.tenantId;
    if (owner && owner !== tenantId) {
      throw new HttpsError(
        "already-exists",
        "This domain is already in use.",
      );
    }
  }

  // If this tenant already had a different custom domain, swap atomically:
  // we'll detach the old one after the new one is in place.
  const metaRef = db.doc(`tenants/${tenantId}/meta/settings`);
  const metaSnap = await metaRef.get();
  if (!metaSnap.exists) {
    throw new HttpsError("not-found", "Tenant settings not found.");
  }
  const previousDomain =
    (metaSnap.data() as { customDomain?: string | null } | undefined)
      ?.customDomain ?? null;

  // Step 1: Vercel — add to project domains. If this fails we abort before
  // touching Firestore so there's nothing to clean up.
  try {
    await vercelAddDomain(domain);
  } catch (err) {
    logger.error("setupCustomDomain: vercel add failed", { domain, err });
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
    throw new HttpsError(
      "internal",
      err instanceof Error ? err.message : "Firebase Auth update failed.",
    );
  }

  // Step 3: Firestore — domain index doc + meta update in one batch.
  try {
    const batch = db.batch();
    batch.set(domainRef, {
      tenantId,
      createdAt: FieldValue.serverTimestamp(),
    });
    batch.set(
      metaRef,
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
    await batch.commit();
  } catch (err) {
    logger.error("setupCustomDomain: firestore write failed", { domain, err });
    await vercelRemoveDomain(domain).catch(() => {});
    await removeAuthorizedDomain(domain).catch(() => {});
    throw new HttpsError("internal", "Failed to record custom domain.");
  }

  // Step 4: Edge Config write. Best-effort — middleware will fall back to
  // Firestore on miss and self-heal, so a failure here isn't fatal.
  try {
    await edgeConfigUpsert(`domain:${domain}`, tenantId);
  } catch (err) {
    logger.warn("setupCustomDomain: edge config write failed (non-fatal)", {
      domain,
      err,
    });
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
  await Promise.allSettled([
    vercelRemoveDomain(domain),
    removeAuthorizedDomain(domain),
    edgeConfigDelete(`domain:${domain}`),
    db.doc(`customDomains/${domain}`).delete(),
  ]);
}

export const setupCustomDomain = onCall<Input>(
  { secrets: [...VERCEL_SECRETS] },
  setupCustomDomainHandler,
);

// ---------------------------------------------------------------------------
// removeCustomDomain — owner/admin tears down their custom domain.
// ---------------------------------------------------------------------------

export async function removeCustomDomainHandler(
  request: CallableRequest,
): Promise<{ ok: true }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);

  const metaRef = db.doc(`tenants/${tenantId}/meta/settings`);
  const metaSnap = await metaRef.get();
  if (!metaSnap.exists) {
    throw new HttpsError("not-found", "Tenant settings not found.");
  }
  const domain =
    (metaSnap.data() as { customDomain?: string | null } | undefined)
      ?.customDomain ?? null;
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

export const removeCustomDomain = onCall(
  { secrets: [...VERCEL_SECRETS] },
  removeCustomDomainHandler,
);

// ---------------------------------------------------------------------------
// recheckCustomDomain — owner/admin manual "check now" button. The
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
  request: CallableRequest,
): Promise<{ stage: string; message: string | null }> {
  const claims = readClaims(request);
  const { tenantId } = requireTenant(claims);
  requireRole(claims, ["owner", "admin"]);

  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const domain =
    (metaSnap.data() as { customDomain?: string | null } | undefined)
      ?.customDomain ?? null;
  if (!domain) {
    throw new HttpsError(
      "failed-precondition",
      "No custom domain configured for this tenant.",
    );
  }
  return checkAndUpdateDomainStatus(tenantId, domain);
}

export const recheckCustomDomain = onCall(
  { secrets: [...VERCEL_SECRETS] },
  recheckCustomDomainHandler,
);
