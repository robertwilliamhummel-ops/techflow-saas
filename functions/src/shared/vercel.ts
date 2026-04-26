// Vercel REST API wrapper for custom-domain provisioning.
//
// Required secrets:
//   VERCEL_API_TOKEN   — personal/team token with Domains + Edge Config scopes
//   VERCEL_PROJECT_ID  — the techflow-saas project's ID
//   VERCEL_TEAM_ID     — required if the project belongs to a team (optional)
//   EDGE_CONFIG_ID     — for the domain→tenantId cache writes
//
// All helpers throw on non-2xx so callers can convert Vercel API failures
// into Firestore rollbacks.

import { defineSecret } from "firebase-functions/params";

const VERCEL_API_TOKEN = defineSecret("VERCEL_API_TOKEN");
const VERCEL_PROJECT_ID = defineSecret("VERCEL_PROJECT_ID");
const VERCEL_TEAM_ID = defineSecret("VERCEL_TEAM_ID");
const EDGE_CONFIG_ID = defineSecret("EDGE_CONFIG_ID");

export const VERCEL_SECRETS = [
  VERCEL_API_TOKEN,
  VERCEL_PROJECT_ID,
  VERCEL_TEAM_ID,
  EDGE_CONFIG_ID,
] as const;

function teamQuery(): string {
  const t = safeSecret(VERCEL_TEAM_ID);
  return t ? `?teamId=${encodeURIComponent(t)}` : "";
}

function teamQueryAppend(existing: string): string {
  const t = safeSecret(VERCEL_TEAM_ID);
  if (!t) return existing;
  return `${existing}${existing.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(t)}`;
}

function safeSecret(s: { value: () => string }): string {
  try {
    return s.value();
  } catch {
    return "";
  }
}

async function vercelFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = safeSecret(VERCEL_API_TOKEN);
  if (!token) {
    throw new Error("VERCEL_API_TOKEN is not configured.");
  }
  const res = await fetch(`https://api.vercel.com${path}`, {
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
    throw new Error(apiMsg ?? `Vercel API error ${res.status}`);
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

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface VercelDomainStatus {
  verified: boolean;
  // DNS records the user must add — pulled from Vercel's `verification` field.
  verificationRecords: Array<{
    type: string;
    domain: string;
    value: string;
    reason: string;
  }>;
  // SSL state if Vercel exposes it; otherwise inferred from `verified`.
  misconfigured: boolean;
}

export async function vercelAddDomain(domain: string): Promise<void> {
  const projectId = safeSecret(VERCEL_PROJECT_ID);
  if (!projectId) throw new Error("VERCEL_PROJECT_ID is not configured.");
  await vercelFetch(
    `/v10/projects/${encodeURIComponent(projectId)}/domains${teamQuery()}`,
    {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    },
  );
}

export async function vercelRemoveDomain(domain: string): Promise<void> {
  const projectId = safeSecret(VERCEL_PROJECT_ID);
  if (!projectId) throw new Error("VERCEL_PROJECT_ID is not configured.");
  try {
    await vercelFetch(
      `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}${teamQuery()}`,
      { method: "DELETE" },
    );
  } catch (err) {
    // Domain not on the project anymore — treat as already removed.
    const msg = err instanceof Error ? err.message : "";
    if (!/not.*found/i.test(msg)) throw err;
  }
}

export async function vercelGetDomainStatus(
  domain: string,
): Promise<VercelDomainStatus> {
  const projectId = safeSecret(VERCEL_PROJECT_ID);
  if (!projectId) throw new Error("VERCEL_PROJECT_ID is not configured.");

  const projDomain = (await vercelFetch(
    `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}${teamQuery()}`,
  )) as {
    verified?: boolean;
    verification?: Array<{
      type: string;
      domain: string;
      value: string;
      reason: string;
    }>;
  } | null;

  const cfg = (await vercelFetch(
    `/v6/domains/${encodeURIComponent(domain)}/config${teamQuery()}`,
  )) as { misconfigured?: boolean } | null;

  return {
    verified: projDomain?.verified === true,
    verificationRecords: projDomain?.verification ?? [],
    misconfigured: cfg?.misconfigured === true,
  };
}

// ---------------------------------------------------------------------------
// Edge Config — write side. Middleware reads via the connection-string SDK.
// ---------------------------------------------------------------------------

export async function edgeConfigUpsert(
  key: string,
  value: string,
): Promise<void> {
  await edgeConfigBatch([{ operation: "upsert", key, value }]);
}

export async function edgeConfigDelete(key: string): Promise<void> {
  await edgeConfigBatch([{ operation: "delete", key }]);
}

interface EdgeOp {
  operation: "create" | "update" | "upsert" | "delete";
  key: string;
  value?: string;
}

async function edgeConfigBatch(items: EdgeOp[]): Promise<void> {
  const id = safeSecret(EDGE_CONFIG_ID);
  if (!id) throw new Error("EDGE_CONFIG_ID is not configured.");
  await vercelFetch(
    teamQueryAppend(`/v1/edge-config/${encodeURIComponent(id)}/items`),
    {
      method: "PATCH",
      body: JSON.stringify({ items }),
    },
  );
}
