"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useTenantContext } from "./TenantContext";

export interface TenantDocState<T> {
  data: T | null;
  exists: boolean;
  loading: boolean;
  error: Error | null;
}

interface DocSnapshot<T> {
  key: string;
  data: T | null;
  exists: boolean;
  error: Error | null;
}

/**
 * Subscribes to one tenant-scoped document (`tenants/{tenantId}/{path}`, e.g.
 * `invoices/INV-0001`) using the active tenantId. Like useTenantCollection, the
 * result is tagged with `{tenantId}/{path}` and derived during render, so
 * another tenant's or path's document is never returned after a switch. The
 * data includes the document `id`.
 */
export function useTenantDoc<T = unknown>(path: string): TenantDocState<T> {
  const { tenantId } = useTenantContext();
  const key = tenantId ? `${tenantId}/${path}` : null;
  const [snapshot, setSnapshot] = useState<DocSnapshot<T> | null>(null);

  useEffect(() => {
    if (!tenantId || !key) return;
    const ref = doc(getClientDb(), "tenants", tenantId, ...path.split("/"));
    return onSnapshot(
      ref,
      (snap) =>
        setSnapshot({
          key,
          data: snap.exists() ? ({ id: snap.id, ...snap.data() } as T) : null,
          exists: snap.exists(),
          error: null,
        }),
      (err) => setSnapshot({ key, data: null, exists: false, error: err as Error }),
    );
  }, [tenantId, key, path]);

  if (!key) return { data: null, exists: false, loading: false, error: null };
  const current = snapshot?.key === key ? snapshot : null;
  return {
    data: current?.data ?? null,
    exists: current?.exists ?? false,
    loading: current === null,
    error: current?.error ?? null,
  };
}
