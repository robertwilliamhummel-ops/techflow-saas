import "server-only";
import { createClient } from "@vercel/global-config";

// Global Config wrapper — the domain → tenantId cache the proxy reads (A-07).
//
// Vercel renamed Edge Config to Global Config in 2026. The store is the same,
// and the legacy EDGE_CONFIG variable, edge-config.vercel.com connection
// strings and /v1/edge-config API keep working, but a store connected to a
// project now creates a GLOBAL_CONFIG variable instead.
//
// Reads use the SDK (Vercel applies its read optimizations only to SDK reads)
// with GLOBAL_CONFIG, falling back to EDGE_CONFIG. Writes use the REST API and
// need EDGE_CONFIG_ID + VERCEL_API_TOKEN (+ VERCEL_TEAM_ID for team-owned
// stores). Every helper tolerates missing configuration and failures and
// returns null/false, so the proxy falls back to Firestore.

type GlobalConfigClient = ReturnType<typeof createClient>;

let cachedClient: {
  connectionString: string;
  client: GlobalConfigClient;
} | null = null;

function readClient(): GlobalConfigClient | null {
  const connectionString =
    process.env.GLOBAL_CONFIG || process.env.EDGE_CONFIG;
  if (!connectionString) return null;
  if (cachedClient?.connectionString !== connectionString) {
    cachedClient = { connectionString, client: createClient(connectionString) };
  }
  return cachedClient.client;
}

interface EdgeConfigItem {
  key: string;
  value: string;
}

/** Read a single key. Null when missing, not a string, unconfigured, or on error. */
export async function edgeConfigGet(key: string): Promise<string | null> {
  const client = readClient();
  if (!client) return null;
  try {
    const value: unknown = await client.get(key);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Upsert a single key. Used by the proxy's self-heal on a cache miss.
 * No-ops (returns false) if write credentials are missing.
 */
export async function edgeConfigPut(
  key: string,
  value: string,
): Promise<boolean> {
  return edgeConfigBatch([{ operation: "upsert", key, value }]);
}

/** Delete a single key. */
export async function edgeConfigDelete(key: string): Promise<boolean> {
  return edgeConfigBatch([{ operation: "delete", key }]);
}

interface BatchOp {
  operation: "create" | "update" | "upsert" | "delete";
  key: string;
  value?: string;
}

async function edgeConfigBatch(items: BatchOp[]): Promise<boolean> {
  const storeId = process.env.EDGE_CONFIG_ID;
  const apiToken = process.env.VERCEL_API_TOKEN;
  if (!storeId || !apiToken) return false;
  const teamId = process.env.VERCEL_TEAM_ID;
  const team = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const url = `https://api.vercel.com/v1/global-config/${encodeURIComponent(storeId)}/items${team}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Used in dev/diagnostics. Lists everything in the store. */
export async function edgeConfigList(): Promise<EdgeConfigItem[]> {
  const client = readClient();
  if (!client) return [];
  try {
    const all = (await client.getAll()) as Record<string, unknown> | undefined;
    return Object.entries(all ?? {}).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
  } catch {
    return [];
  }
}
