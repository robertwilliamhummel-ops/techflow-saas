import { initializeApp } from "firebase-admin/app";

// Single admin-app init shared by all callables/triggers in this codebase.
initializeApp();

// Phase 1 ships no callables yet. Real callables land in Phase 2.
// Scaffold deliberately empty so `firebase deploy --only functions` is a no-op.
export {};
