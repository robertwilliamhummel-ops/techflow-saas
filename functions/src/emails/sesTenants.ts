// SES tenants (D22) — one per business, so each business gets its own
// reputation metrics, can be paused on its own, and keeps its own suppression
// list: without it a bounce for one business silently blocks that address for
// every other business (Deploy Runbook, step 5).
//
// With SES_TENANTS_ENABLED=true, send.ts passes TenantName on every send, and
// SES accepts the send only if the tenant exists and has the identity and the
// configuration set associated. So the tenant is created:
//   - by onSignup for every new business,
//   - by scripts/backfillSesTenants.ts for businesses that existed before,
//   - and by send.ts itself, once, if a send finds it missing.
//
// ensureSesTenant is idempotent: CreateTenant (with suppression scope TENANT
// for BOUNCE and COMPLAINT), or — when the tenant already exists — the same
// suppression settings via PutTenantSuppressionAttributes; then one
// CreateTenantResourceAssociation each for the domain identity and the
// environment's configuration set. "Already exists" answers count as done.
//
// IAM: the per-environment sending user carries a second, separate policy
// statement for these three actions (Deploy Runbook, step 5).

import {
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  PutTenantSuppressionAttributesCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2";
import * as logger from "firebase-functions/logger";

// The AWS account holding the platform's SES identity and configuration sets
// (D10, D12). Staging and production share it.
export const SES_ACCOUNT_ID = "358982197909";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_FROM_ADDRESS = "notifications@techflowsolutions.ca";

const TENANT_SUPPRESSION = {
  SuppressionScope: "TENANT",
  SuppressedReasons: ["BOUNCE", "COMPLAINT"],
} as const;

export function sesTenantsEnabled(): boolean {
  return process.env.SES_TENANTS_ENABLED === "true";
}

// The SES tenant for a business. SES names allow 64 letters, digits, "-" and
// "_"; tenant ids are lowercase slugs of at most ~44 characters.
export function sesTenantName(tenantId: string): string {
  return tenantId;
}

function sesRegion(): string {
  return process.env.SES_REGION || DEFAULT_REGION;
}

// The verified domain identity the From address belongs to.
export function sesIdentityArn(): string {
  const from = process.env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS;
  const domain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  return `arn:aws:ses:${sesRegion()}:${SES_ACCOUNT_ID}:identity/${domain}`;
}

export function sesConfigurationSetArn(): string | null {
  const name = process.env.SES_CONFIGURATION_SET;
  if (!name) return null;
  return `arn:aws:ses:${sesRegion()}:${SES_ACCOUNT_ID}:configuration-set/${name}`;
}

function isAlreadyExists(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AlreadyExistsException";
}

export async function ensureSesTenant(
  tenantId: string,
  client: SESv2Client,
): Promise<void> {
  const TenantName = sesTenantName(tenantId);
  try {
    await client.send(
      new CreateTenantCommand({
        TenantName,
        SuppressionAttributes: {
          SuppressionScope: TENANT_SUPPRESSION.SuppressionScope,
          SuppressedReasons: [...TENANT_SUPPRESSION.SuppressedReasons],
        },
      }),
    );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // Created earlier (a previous call, or by hand): converge its suppression
    // settings anyway, so its list is its own.
    await client.send(
      new PutTenantSuppressionAttributesCommand({
        TenantName,
        SuppressionScope: TENANT_SUPPRESSION.SuppressionScope,
        SuppressedReasons: [...TENANT_SUPPRESSION.SuppressedReasons],
      }),
    );
  }

  const configurationSetArn = sesConfigurationSetArn();
  if (!configurationSetArn) {
    // send.ts logs this on every send too; here it means the tenant can't be
    // used with a configuration set until one is configured and this reruns.
    logger.error(
      "ensureSesTenant: SES_CONFIGURATION_SET is not set — the tenant gets the identity only",
      { tenantId },
    );
  }
  for (const ResourceArn of [sesIdentityArn(), configurationSetArn]) {
    if (!ResourceArn) continue;
    try {
      await client.send(
        new CreateTenantResourceAssociationCommand({ TenantName, ResourceArn }),
      );
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
  logger.info("ensureSesTenant: tenant ready", { tenantId });
}
