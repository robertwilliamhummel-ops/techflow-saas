// Identity Toolkit (Firebase Auth) admin REST wrapper.
//
// firebase-admin v13's `projectConfigManager()` only exposes a narrow subset
// of project config (SMS, MFA, recaptcha, password policy, email privacy,
// mobile links). It does NOT surface `authorizedDomains`, but the underlying
// Identity Toolkit v2 REST API does. We need this for custom-domain
// provisioning — magic links and OAuth redirects fail unless the domain is
// in the authorized list.
//
// Auth via Application Default Credentials (Cloud Functions runtime mints
// the token automatically; locally, FIREBASE_ADMIN_PRIVATE_KEY is used by
// google-auth-library).

import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

interface ProjectConfig {
  authorizedDomains?: string[];
}

function projectId(): string {
  // Functions runtime always sets this.
  const id =
    process.env.GCLOUD_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.FIREBASE_PROJECT_ID;
  if (!id) {
    throw new Error("GCLOUD_PROJECT not set — cannot resolve Identity Toolkit URL.");
  }
  return id;
}

async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token;
  if (!token) throw new Error("Failed to mint access token for Identity Toolkit.");
  const res = await fetch(`https://identitytoolkit.googleapis.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const apiMsg =
      data && typeof data === "object" && "error" in data
        ? (data as { error?: { message?: string } }).error?.message
        : null;
    throw new Error(apiMsg ?? `Identity Toolkit error ${res.status}`);
  }
  return data;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function getProjectConfig(): Promise<ProjectConfig> {
  const data = (await authedFetch(
    `/admin/v2/projects/${encodeURIComponent(projectId())}/config`,
  )) as ProjectConfig | null;
  return data ?? {};
}

export async function setAuthorizedDomains(domains: string[]): Promise<void> {
  await authedFetch(
    `/admin/v2/projects/${encodeURIComponent(projectId())}/config?updateMask=authorizedDomains`,
    {
      method: "PATCH",
      body: JSON.stringify({ authorizedDomains: domains }),
    },
  );
}

export async function addAuthorizedDomain(domain: string): Promise<void> {
  const cfg = await getProjectConfig();
  const current = cfg.authorizedDomains ?? [];
  if (current.includes(domain)) return;
  await setAuthorizedDomains([...current, domain]);
}

export async function removeAuthorizedDomain(domain: string): Promise<void> {
  const cfg = await getProjectConfig();
  const current = cfg.authorizedDomains ?? [];
  if (!current.includes(domain)) return;
  await setAuthorizedDomains(current.filter((d) => d !== domain));
}
