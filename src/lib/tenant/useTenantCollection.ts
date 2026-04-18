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

/**
 * Subscribes to a tenant-scoped Firestore collection
 * (`tenants/{tenantId}/{path}`) using the active tenantId from context.
 * Automatically resubscribes when tenantId or constraints change.
 */
export function useTenantCollection<T = unknown>(
  path: string,
  constraints: QueryConstraint[] = [],
): TenantCollectionState<T> {
  const { tenantId } = useTenantContext();
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tenantId) {
      setData([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const db = getClientDb();
    const ref = collection(db, "tenants", tenantId, ...path.split("/"));
    const q: Query = constraints.length ? query(ref, ...constraints) : ref;

    const unsub = onSnapshot(
      q,
      (snap) => {
        setData(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T),
        );
        setLoading(false);
      },
      (err) => {
        setError(err as Error);
        setLoading(false);
      },
    );

    return unsub;
    // constraints reference identity is the caller's responsibility
    // (they should memoize), matching @firebase/react patterns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, path, ...constraints]);

  return { data, loading, error };
}
