// sendPortalSignInLink — E-01.
//
// Public callable (no sign-in required): emails a customer a branded sign-in
// link for the customer portal. Firebase's own email-link emails come from one
// project-wide template with limited customization, so the link is generated
// with the Admin SDK (generateSignInWithEmailLink — Firebase sends nothing) and
// sent through SES like every other email (D5). The portal completes sign-in
// with isSignInWithEmailLink / signInWithEmailLink as usual.
//
// Abuse limits, until App Check lands (R-04):
//   - The answer is always { ok: true } for a valid request, whether or not an
//     email went out, so the endpoint can't be used to learn who is a customer.
//     Link-generation and send failures are logged, not returned, for the same
//     reason.
//   - An email only goes to an address with at least one customer-visible
//     invoice or quote — the portal would show nothing to anyone else.
//   - Each address gets at most 5 requests an hour and one a minute, counted in
//     a transaction on signInLinkLimits/{sha256(email)} (TTL-cleaned via
//     expireAt). Over the limit the call still answers ok and sends nothing.
//
// The continue URL must be a /portal path on the shared portal host (APP_URL)
// or on a tenant's verified custom domain, so a link can never lead a customer
// to another site. On a custom domain the email carries that business's name,
// colour, and reply-to; on the shared host it carries the platform name.

import { createHash } from "node:crypto";
import { createElement } from "react";
import { render } from "@react-email/render";
import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { adminAuth, db, Timestamp } from "../shared/admin";
import { isValidEmail, lowerEmail } from "../shared/email";
import { EMAIL_SECRETS, pickReplyTo, sendEmail } from "../emails/send";
import { sanitizeEmailField } from "../emails/sanitize";
import { MagicLinkSignIn } from "../emails/templates/MagicLinkSignIn";
import { listCustomerInvoices } from "./getCustomerInvoices";
import { listCustomerQuotes } from "./getCustomerQuotes";
import { withSentryCallable } from "../shared/withSentry";

export const SIGN_IN_LINKS_PER_HOUR = 5;
export const SIGN_IN_LINK_MIN_INTERVAL_MS = 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
// Counter docs are removed by the TTL policy a day after the last request.
const LIMIT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONTINUE_URL_LENGTH = 2000;
const PLATFORM_NAME = "TechFlow";

interface PortalTarget {
  continueUrl: string;
  tenantId: string | null;
  meta: FirebaseFirestore.DocumentData | null;
}

export async function sendPortalSignInLinkHandler(
  request: CallableRequest,
): Promise<{ ok: true }> {
  const data = request.data as Record<string, unknown> | undefined;

  if (!isValidEmail(data?.email)) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }
  const email = lowerEmail(data!.email);
  const target = await resolvePortalTarget(data?.continueUrl);

  if (!(await takeSignInLinkSlot(email))) {
    logger.info("portalSignInLink: rate limited", { tenantId: target.tenantId });
    return { ok: true };
  }

  if (!(await hasVisibleDocuments(email))) {
    logger.info("portalSignInLink: no customer-visible documents", {
      tenantId: target.tenantId,
    });
    return { ok: true };
  }

  try {
    const signInUrl = await adminAuth.generateSignInWithEmailLink(email, {
      url: target.continueUrl,
      handleCodeInApp: true,
    });

    const meta = target.meta;
    const brandName =
      sanitizeEmailField(meta?.name, 100) || PLATFORM_NAME;
    const props = {
      tenant: {
        name: brandName,
        address: meta ? ((meta.address as string | null | undefined) ?? null) : null,
        logoUrl: null,
        emailFooter: meta
          ? ((meta.emailFooter as string | null | undefined) ?? null)
          : null,
        primaryColor: meta
          ? ((meta.primaryColor as string | null | undefined) ?? null)
          : null,
      },
      signInUrl,
    };
    const html = await render(createElement(MagicLinkSignIn, props));
    const text = await render(createElement(MagicLinkSignIn, props), {
      plainText: true,
    });

    await sendEmail({
      to: email,
      subject: `Sign in to ${brandName}`,
      html,
      text,
      fromName: brandName,
      replyTo: meta ? pickReplyTo(meta.contactEmail, meta.etransferEmail) : null,
      category: "portal-sign-in",
      tenantId: target.tenantId,
    });
  } catch (err) {
    logger.error("portalSignInLink: link or send failed", {
      tenantId: target.tenantId,
      code: (err as { code?: unknown }).code ?? null,
      error: String(err),
    });
  }

  return { ok: true };
}

// A /portal URL on the shared portal host, or on a tenant's verified custom
// domain. Anything else is refused before any lookup that depends on the email.
async function resolvePortalTarget(raw: unknown): Promise<PortalTarget> {
  const invalid = () =>
    new HttpsError(
      "invalid-argument",
      "continueUrl must be a customer portal page.",
    );

  if (typeof raw !== "string" || raw.length > MAX_CONTINUE_URL_LENGTH) {
    throw invalid();
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (
    url.username ||
    url.password ||
    !(url.pathname === "/portal" || url.pathname.startsWith("/portal/"))
  ) {
    throw invalid();
  }

  const portalBase = new URL(
    process.env.APP_URL || "https://portal.techflowsolutions.ca",
  );
  if (url.protocol === portalBase.protocol && url.host === portalBase.host) {
    return { continueUrl: url.toString(), tenantId: null, meta: null };
  }

  // Custom domains are always https on the default port.
  if (url.protocol !== "https:" || url.port !== "") throw invalid();
  const domain = url.hostname.toLowerCase();
  const domainSnap = await db.doc(`customDomains/${domain}`).get();
  const tenantId = domainSnap.data()?.tenantId;
  if (typeof tenantId !== "string" || !tenantId) throw invalid();

  const metaSnap = await db.doc(`tenants/${tenantId}/meta/settings`).get();
  const meta = metaSnap.data();
  if (
    !meta ||
    meta.customDomain !== domain ||
    meta.customDomainStatus?.stage !== "verified"
  ) {
    throw invalid();
  }
  return { continueUrl: url.toString(), tenantId, meta };
}

async function takeSignInLinkSlot(email: string): Promise<boolean> {
  const key = createHash("sha256").update(email).digest("hex");
  const ref = db.doc(`signInLinkLimits/${key}`);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const d = snap.data() as
      | { windowStartedAt?: Timestamp; count?: number; lastAt?: Timestamp }
      | undefined;

    const windowStartMs = d?.windowStartedAt?.toMillis() ?? 0;
    const inWindow = now - windowStartMs < WINDOW_MS;
    const count = inWindow ? (d?.count ?? 0) : 0;
    const lastAtMs = d?.lastAt?.toMillis() ?? 0;
    if (count >= SIGN_IN_LINKS_PER_HOUR || now - lastAtMs < SIGN_IN_LINK_MIN_INTERVAL_MS) {
      return false;
    }

    tx.set(ref, {
      windowStartedAt:
        inWindow && d?.windowStartedAt ? d.windowStartedAt : Timestamp.fromMillis(now),
      count: count + 1,
      lastAt: Timestamp.fromMillis(now),
      expireAt: Timestamp.fromMillis(now + LIMIT_TTL_MS),
    });
    return true;
  });
}

async function hasVisibleDocuments(email: string): Promise<boolean> {
  if ((await listCustomerInvoices(email, { limit: 1 })).length > 0) return true;
  return (await listCustomerQuotes(email, { limit: 1 })).length > 0;
}

export const sendPortalSignInLink = onCall(
  { secrets: EMAIL_SECRETS },
  withSentryCallable("sendPortalSignInLink", sendPortalSignInLinkHandler),
);
