// One-shot script: grants `platformAdmin: true` custom claim + writes platformAdmins/{uid}.
// Run via: `npx ts-node src/scripts/setPlatformAdmin.ts <uid> <email>`
// Requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account JSON.
//
// This is intentionally NOT a deployed callable — platform admin grants happen out-of-band,
// from a trusted operator machine, not through a live HTTP surface.

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

async function main() {
  const [uid, email] = process.argv.slice(2);
  if (!uid || !email) {
    console.error("Usage: setPlatformAdmin <uid> <email>");
    process.exit(1);
  }

  if (!getApps().length) {
    initializeApp({ credential: applicationDefault() });
  }

  const auth = getAuth();
  const db = getFirestore();

  const existing = (await auth.getUser(uid)).customClaims ?? {};
  await auth.setCustomUserClaims(uid, { ...existing, platformAdmin: true });

  await db.doc(`platformAdmins/${uid}`).set({
    uid,
    email: email.toLowerCase(),
    grantedAt: FieldValue.serverTimestamp(),
    grantedBy: "cli",
  });

  console.log(`Granted platformAdmin to ${uid} (${email}).`);
  console.log("User must sign out + sign back in for claims to refresh.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
