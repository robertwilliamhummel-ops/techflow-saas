// Seed script for the local Firebase emulator.
//
// Creates a fake owner login + tenant + entitlements so you can sign in to the
// Next.js dev app and click through the /billing Stripe Connect flow.
//
// Run AFTER `firebase emulators:start` is up, with: `npm run seed:emulator`.
// Re-running wipes the previous fake user/tenant and recreates from scratch.

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PROJECT_ID = "techflow-dev";
const OWNER_EMAIL = "owner@bobs-plumbing.test";
const OWNER_PASSWORD = "techflow-dev-12345";
const OWNER_UID = "seed-owner-uid";
const BUSINESS_NAME = "Bob's Plumbing";
const TENANT_ID = "bobs-plumbing";

// Point the admin SDK at the local emulators BEFORE init.
process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;

initializeApp({ projectId: PROJECT_ID });

const auth = getAuth();
const db = getFirestore();

async function preflightEmulator() {
  try {
    const res = await fetch(
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/`,
    );
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error(
      "\n[seed] Could not reach the Auth emulator at",
      process.env.FIREBASE_AUTH_EMULATOR_HOST,
    );
    console.error(
      "[seed] Start emulators first:  npm run emulators\n",
    );
    process.exit(1);
  }
}

async function deleteIfExists() {
  try {
    await auth.deleteUser(OWNER_UID);
    console.log("[seed] Removed existing fake user.");
  } catch (err) {
    if (err?.code !== "auth/user-not-found") throw err;
  }
  // Wipe the tenant subtree (small — only meta + entitlements + counters).
  const subcols = ["meta", "entitlements", "counters"];
  for (const sub of subcols) {
    const snap = await db.collection(`tenants/${TENANT_ID}/${sub}`).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.doc(`users/${OWNER_UID}`).delete();
  await db.doc(`userTenantMemberships/${OWNER_UID}_${TENANT_ID}`).delete();
}

async function createUser() {
  await auth.createUser({
    uid: OWNER_UID,
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    emailVerified: true,
    displayName: "Bob (test owner)",
  });
}

async function seedTenantDocs() {
  const batch = db.batch();

  batch.set(db.doc(`tenants/${TENANT_ID}/meta/settings`), {
    name: BUSINESS_NAME,
    logoUrl: null,
    address: null,
    primaryColor: "#0066CC",
    secondaryColor: "#F5F5F5",
    fontFamily: "Inter",
    faviconUrl: null,
    customDomain: null,
    customDomainStatus: { stage: "unverified", message: null, checkedAt: null },
    taxRate: 0.13,
    taxName: "HST",
    businessNumber: null,
    invoicePrefix: "INV",
    emailFooter: null,
    currency: "CAD",
    stripeAccountId: null,
    stripeStatus: {
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      currentlyDue: [],
      disabledReason: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    etransferEmail: null,
    chargeCustomerCardFees: false,
    cardFeePercent: 2.4,
    surchargeAcknowledgedAt: null,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Pro plan = stripePayments enabled. The /billing page checks this feature
  // before showing the Connect CTA.
  batch.set(db.doc(`tenants/${TENANT_ID}/entitlements/current`), {
    plan: "pro",
    maxInvoicesPerMonth: null,
    features: { stripePayments: true, recurringInvoices: true },
    updatedAt: FieldValue.serverTimestamp(),
  });

  batch.set(db.doc(`tenants/${TENANT_ID}/counters/invoice`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`tenants/${TENANT_ID}/counters/quote`), {
    value: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });

  batch.set(db.doc(`users/${OWNER_UID}`), {
    uid: OWNER_UID,
    email: OWNER_EMAIL,
    displayName: "Bob (test owner)",
    defaultTenantId: TENANT_ID,
    createdAt: FieldValue.serverTimestamp(),
  });

  batch.set(db.doc(`userTenantMemberships/${OWNER_UID}_${TENANT_ID}`), {
    uid: OWNER_UID,
    tenantId: TENANT_ID,
    role: "owner",
    invitedBy: null,
    createdAt: FieldValue.serverTimestamp(),
    deletedAt: null,
  });

  await batch.commit();
}

async function setClaims() {
  await auth.setCustomUserClaims(OWNER_UID, {
    tenantId: TENANT_ID,
    role: "owner",
  });
}

async function main() {
  await preflightEmulator();
  await deleteIfExists();
  await createUser();
  await seedTenantDocs();
  await setClaims();

  console.log("\n=========================================================");
  console.log("  Emulator seed complete");
  console.log("=========================================================");
  console.log(`  Login email:    ${OWNER_EMAIL}`);
  console.log(`  Login password: ${OWNER_PASSWORD}`);
  console.log(`  Tenant ID:      ${TENANT_ID}`);
  console.log(`  Plan:           pro (stripePayments enabled)`);
  console.log("=========================================================");
  console.log(
    "  Next: start the Next.js dev server (npm run dev), then sign in",
  );
  console.log("  at http://localhost:3000/login\n");
}

main().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
