"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  onAuthStateChanged,
  signOut as firebaseSignOut,
  type User,
  type IdTokenResult,
} from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";

export interface AuthClaims {
  tenantId?: string;
  role?: "owner" | "admin" | "member" | "platform_admin";
  email_verified?: boolean;
}

export interface AuthState {
  /** The Firebase User object, null when signed out. */
  user: User | null;
  /** Decoded custom claims from the ID token. */
  claims: AuthClaims;
  /** True while the initial auth state is being resolved. */
  loading: boolean;
  /** Sign out and clear state. */
  signOut: () => Promise<void>;
  /**
   * Force-refresh the ID token and re-read claims.
   * Call after onSignup / onAcceptInvite / setUserRole so the
   * client picks up newly-set custom claims immediately.
   */
  refreshClaims: () => Promise<AuthClaims>;
}

function extractClaims(tokenResult: IdTokenResult | null): AuthClaims {
  if (!tokenResult) return {};
  const c = tokenResult.claims;
  return {
    tenantId: c.tenantId as string | undefined,
    role: c.role as AuthClaims["role"],
    email_verified: c.email_verified as boolean | undefined,
  };
}

/**
 * Determines the correct redirect path after login based on claims.
 * Returns null if the user is not authenticated.
 */
export function getPostLoginRoute(claims: AuthClaims): string {
  if (claims.tenantId) return "/dashboard";
  if (claims.email_verified) return "/portal";
  return "/verify-email";
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<AuthClaims>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getClientAuth(), async (firebaseUser) => {
      if (firebaseUser) {
        const tokenResult = await firebaseUser.getIdTokenResult();
        setUser(firebaseUser);
        setClaims(extractClaims(tokenResult));
      } else {
        setUser(null);
        setClaims({});
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(getClientAuth());
    setUser(null);
    setClaims({});
  }, []);

  const refreshClaims = useCallback(async (): Promise<AuthClaims> => {
    const current = getClientAuth().currentUser;
    if (!current) return {};
    const tokenResult = await current.getIdTokenResult(true);
    const fresh = extractClaims(tokenResult);
    setClaims(fresh);
    return fresh;
  }, []);

  return useMemo(
    () => ({ user, claims, loading, signOut, refreshClaims }),
    [user, claims, loading, signOut, refreshClaims],
  );
}
