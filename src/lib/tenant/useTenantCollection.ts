"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  type Query,
  type QueryConstraint,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useTenantContext } from "./TenantContext";

export interface TenantCollectionState<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
}

interface CollectionSnapshot<T> {
  key: string;
  data: T[];
  error: Error | null;
}

const EMPTY: never[] = [];

/**
 * Subscribes to a tenant-scoped Firestore collection
 * (`tenants/{tenantId}/{path}`) using the active tenantId from context.
 * Automatically resubscribes when tenantId or constraints change.
 *
 * Results are tagged with `{tenantId}/{path}` and derived during render, so
 * another tenant's (or path's) documents are never returned after a switch.
 * A constraint change keeps showing the previous results until the new
 * snapshot arrives.
 */
export function useTenantCollection<T = unknown>(
  path: string,
  constraints: QueryConstraint[] = [],
): TenantCollectionState<T> {
  const { tenantId } = useTenantContext();
  const key = tenantId ? `${tenantId}/${path}` : null;
  const [snapshot, setSnapshot] = useState<CollectionSnapshot<T> | null>(null);

  useEffect(() => {
    if (!tenantId || !key) return;

    const db = getClientDb();
    const ref = collection(db, "tenants", tenantId, ...path.split("/"));
    const q: Query = constraints.length ? query(ref, ...constraints) : ref;

    const unsub = onSnapshot(
      q,
      (snap) =>
        setSnapshot({
          key,
          data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T),
          error: null,
        }),
      (err) => setSnapshot({ key, data: [], error: err as Error }),
    );

    return unsub;
    // constraints reference identity is the caller's responsibility
    // (they should memoize), matching @firebase/react patterns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, path, ...constraints]);

  if (!key) return { data: EMPTY, loading: false, error: null };
  const current = snapshot?.key === key ? snapshot : null;
  return {
    data: current?.data ?? EMPTY,
    loading: current === null,
    error: current?.error ?? null,
  };
}
