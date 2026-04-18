"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { doc, onSnapshot } from "firebase/firestore";
import * as Sentry from "@sentry/nextjs";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/lib/auth/useAuth";
import {
  FEATURE_DEFAULTS,
  resolveFeature,
  type FeatureKey,
} from "@/lib/features";
import type { TenantMeta, TenantEntitlements } from "@/lib/schema/tenant";

export interface TenantContextValue {
  tenantId: string | null;
  meta: TenantMeta | null;
  entitlements: TenantEntitlements | null;
  plan: TenantEntitlements["plan"] | null;
  features: Record<FeatureKey, boolean>;
  hasFeature: (key: FeatureKey) => boolean;
  loading: boolean;
}

const defaultFeatures = { ...FEATURE_DEFAULTS } as Record<FeatureKey, boolean>;

const TenantContext = createContext<TenantContextValue>({
  tenantId: null,
  meta: null,
  entitlements: null,
  plan: null,
  features: defaultFeatures,
  hasFeature: (key) => FEATURE_DEFAULTS[key],
  loading: true,
});

export function TenantProvider({ children }: { children: ReactNode }) {
  const { user, claims, loading: authLoading } = useAuth();
  const tenantId = claims.tenantId ?? null;

  useEffect(() => {
    if (user) {
      Sentry.setUser({ id: user.uid, email: user.email ?? undefined });
    } else {
      Sentry.setUser(null);
    }
    Sentry.setTag("tenantId", tenantId ?? "none");
  }, [user, tenantId]);

  const [meta, setMeta] = useState<TenantMeta | null>(null);
  const [entitlements, setEntitlements] = useState<TenantEntitlements | null>(
    null,
  );
  const [metaLoading, setMetaLoading] = useState(true);
  const [entLoading, setEntLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) {
      setMeta(null);
      setEntitlements(null);
      setMetaLoading(false);
      setEntLoading(false);
      return;
    }

    setMetaLoading(true);
    setEntLoading(true);

    const db = getClientDb();
    const unsubMeta = onSnapshot(
      doc(db, "tenants", tenantId, "meta", "settings"),
      (snap) => {
        setMeta(snap.exists() ? (snap.data() as TenantMeta) : null);
        setMetaLoading(false);
      },
      () => setMetaLoading(false),
    );
    const unsubEnt = onSnapshot(
      doc(db, "tenants", tenantId, "entitlements", "current"),
      (snap) => {
        setEntitlements(
          snap.exists() ? (snap.data() as TenantEntitlements) : null,
        );
        setEntLoading(false);
      },
      () => setEntLoading(false),
    );

    return () => {
      unsubMeta();
      unsubEnt();
    };
  }, [tenantId]);

  const features = useMemo<Record<FeatureKey, boolean>>(() => {
    const overrides = (entitlements?.features ?? null) as Partial<
      Record<FeatureKey, boolean>
    > | null;
    const resolved = {} as Record<FeatureKey, boolean>;
    (Object.keys(FEATURE_DEFAULTS) as FeatureKey[]).forEach((key) => {
      resolved[key] = resolveFeature(key, overrides);
    });
    return resolved;
  }, [entitlements]);

  const value = useMemo<TenantContextValue>(
    () => ({
      tenantId,
      meta,
      entitlements,
      plan: entitlements?.plan ?? null,
      features,
      hasFeature: (key) => features[key] === true,
      loading: authLoading || metaLoading || entLoading,
    }),
    [tenantId, meta, entitlements, features, authLoading, metaLoading, entLoading],
  );

  return (
    <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
  );
}

export function useTenantContext(): TenantContextValue {
  return useContext(TenantContext);
}
