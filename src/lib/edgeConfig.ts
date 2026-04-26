import "server-only";

// Edge Config wrapper. Used by middleware for hot-path domain→tenantId lookup
// and by Cloud Functions for write-side cache population. Reads use the
// connection string in EDGE_CONFIG (Vercel-managed). Writes go through the
// Vercel REST API and require both EDGE_CONFIG_ID + VERCEL_API_TOKEN.
//
// All helpers tolerate missing env vars and return null/false so local dev
// without Vercel creds still boots (middleware falls back to Firestore).

const EDGE_CONFIG = process.env.EDGE_CONFIG;
const EDGE_CONFIG_ID = process.env.EDGE_CONFIG_ID;
const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID; // optional

interface EdgeConfigItem {
  key: string;
  value: string;
}

/**
 * Read a single key. Returns the value or null if not found or if Edge Config
 * is not configured. Connection string format:
 *   https://edge-config.vercel.com/<id>?token=<read-token>
 */
export async function edgeConfigGet(key: string): Promise<string | null> {
  if (!EDGE_CONFIG) return null;
  const safeKey = encodeURIComponent(key);
  // Append item path before the query string.
  const url = EDGE_CONFIG.includes("?")
    ? EDGE_CONFIG.replace("?", `/item/${safeKey}?`)
    : `${EDGE_CONFIG}/item/${safeKey}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Upsert a single key. Used by setupCustomDomain. Returns true on success.
 * No-ops (returns false) if write credentials are missing.
 */
export async function edgeConfigPut(
  key: string,
  value: string,
): Promise<boolean> {
  return edgeConfigBatch([{ operation: "upsert", key, value }]);
}

/**
 * Delete a single key. Used when a custom domain is removed.
 */
export async function edgeConfigDelete(key: string): Promise<boolean> {
  return edgeConfigBatch([{ operation: "delete", key }]);
}

interface BatchOp {
  operation: "create" | "update" | "upsert" | "delete";
  key: string;
  value?: string;
}

async function edgeConfigBatch(items: BatchOp[]): Promise<boolean> {
  if (!EDGE_CONFIG_ID || !VERCEL_API_TOKEN) return false;
  const team = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "";
  const url = `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items${team}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${VERCEL_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Used in dev/diagnostics. Lists everything in the config. */
export async function edgeConfigList(): Promise<EdgeConfigItem[]> {
  if (!EDGE_CONFIG) return [];
  const url = EDGE_CONFIG.includes("?")
    ? EDGE_CONFIG.replace("?", "/items?")
    : `${EDGE_CONFIG}/items`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as EdgeConfigItem[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
