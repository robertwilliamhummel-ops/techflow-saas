// reCAPTCHA Enterprise key — allowed domains (R-04).
//
// App Check on the web attests with a reCAPTCHA Enterprise website key, and
// the key only works on the domains it lists (each entry also covers its
// subdomains; at most 250 domains per key, and App Check doesn't support web
// apps on more than 250 domains). The platform domain is added once in the
// runbook; setupCustomDomain adds and removes each tenant's custom domain here,
// next to the Firebase Auth authorized domains, so customers on a custom
// domain aren't rejected once ENFORCE_APP_CHECK is on.
//
// RECAPTCHA_KEY_ID (functions/.env.<projectId>) names the key. Without it the
// sync is skipped, which is correct until App Check is set up. The functions
// service account needs recaptchaenterprise.keys.get and .update.

import { GoogleAuth } from "google-auth-library";
import * as logger from "firebase-functions/logger";

export const RECAPTCHA_MAX_DOMAINS = 250;

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

interface RecaptchaKey {
  webSettings?: { allowedDomains?: string[]; allowAllDomains?: boolean };
}

function keyPath(): string | null {
  const keyId = process.env.RECAPTCHA_KEY_ID;
  if (!keyId) return null;
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    throw new Error("GCLOUD_PROJECT not set — cannot resolve the reCAPTCHA key.");
  }
  return `projects/${encodeURIComponent(project)}/keys/${encodeURIComponent(keyId)}`;
}

async function recaptchaFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const client = await auth.getClient();
  const token = (await client.getAccessToken())?.token;
  if (!token) throw new Error("Failed to mint an access token for reCAPTCHA Enterprise.");

  const res = await fetch(`https://recaptchaenterprise.googleapis.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message ?? `reCAPTCHA Enterprise error ${res.status}`);
  }
  return data;
}

async function getKey(path: string): Promise<RecaptchaKey> {
  return ((await recaptchaFetch(path)) as RecaptchaKey | null) ?? {};
}

async function setAllowedDomains(path: string, domains: string[]): Promise<void> {
  await recaptchaFetch(`${path}?updateMask=webSettings.allowedDomains`, {
    method: "PATCH",
    body: JSON.stringify({ webSettings: { allowedDomains: domains } }),
  });
}

export async function addRecaptchaAllowedDomain(domain: string): Promise<void> {
  const path = keyPath();
  if (!path) {
    logger.info("recaptchaKey: RECAPTCHA_KEY_ID not set, domain not added", { domain });
    return;
  }
  const key = await getKey(path);
  if (key.webSettings?.allowAllDomains) return;

  const current = key.webSettings?.allowedDomains ?? [];
  if (current.includes(domain)) return;
  if (current.length >= RECAPTCHA_MAX_DOMAINS) {
    throw new Error(
      `The reCAPTCHA key already allows ${RECAPTCHA_MAX_DOMAINS} domains, the most App Check supports.`,
    );
  }
  await setAllowedDomains(path, [...current, domain]);
}

export async function removeRecaptchaAllowedDomain(domain: string): Promise<void> {
  const path = keyPath();
  if (!path) return;
  const key = await getKey(path);
  const current = key.webSettings?.allowedDomains ?? [];
  if (!current.includes(domain)) return;
  await setAllowedDomains(
    path,
    current.filter((d) => d !== domain),
  );
}
