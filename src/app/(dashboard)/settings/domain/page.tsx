"use client";

// D18: custom domains are set up, changed and removed by TechFlow (the platform
// admin) only, so this page is read-only for every business role. It shows the
// domain, its status and, while DNS is pending, the record the business adds at
// its DNS provider. The scheduled re-check moves the status on by itself.

import { useTenantContext } from "@/lib/tenant/TenantContext";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CustomDomainStage } from "@/lib/schema/tenant";

export default function SettingsDomainPage() {
  const { meta, hasFeature, loading } = useTenantContext();
  const featureEnabled = hasFeature("customDomain");

  if (loading) {
    return (
      <Card>
        <CardContent className="py-10 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }

  if (!featureEnabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Custom domain</CardTitle>
          <CardDescription>
            Let customers view and pay invoices at a domain you own (e.g.
            invoices.yourcompany.ca) instead of the generic portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertDescription>
              Custom domains are turned off for your account. Contact TechFlow
              support to turn them on.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const status = meta?.customDomainStatus;
  const currentDomain = meta?.customDomain ?? null;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom domain</CardTitle>
          <CardDescription>
            Customers sign in to view and pay invoices at this domain. Until it
            is verified, the generic portal keeps working and outgoing emails
            keep using it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {currentDomain ? (
            <dl className="grid gap-1 text-sm">
              <dt className="text-muted-foreground">Domain</dt>
              <dd className="font-mono">{currentDomain}</dd>
            </dl>
          ) : null}

          {currentDomain && status ? (
            <StatusBanner stage={status.stage} message={status.message} />
          ) : null}

          <p className="text-sm text-muted-foreground">
            {currentDomain
              ? "Contact TechFlow to change or remove your domain."
              : "Contact TechFlow to set up your own domain."}
          </p>
        </CardContent>
      </Card>

      {currentDomain && status ? (
        <DnsRecordsCard domain={currentDomain} stage={status.stage} />
      ) : null}
    </div>
  );
}

function StatusBanner({
  stage,
  message,
}: {
  stage: CustomDomainStage;
  message: string | null;
}) {
  const copy = STAGE_COPY[stage];
  return (
    <Alert variant={stage === "error" ? "destructive" : "default"}>
      <AlertDescription>
        <span className="font-medium">{copy.label}</span>
        {message ? <span className="ml-1">— {message}</span> : null}
        {!message ? (
          <span className="ml-1 text-muted-foreground">{copy.hint}</span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

const STAGE_COPY: Record<CustomDomainStage, { label: string; hint: string }> = {
  unverified: { label: "Not configured", hint: "" },
  dns_pending: {
    label: "Waiting on DNS",
    hint: "Add the record below — propagation can take 5 min to 48 hours.",
  },
  ssl_pending: {
    label: "Issuing SSL",
    hint: "DNS is verified. Vercel is provisioning the certificate.",
  },
  verified: {
    label: "Verified",
    hint: "Your custom domain is live.",
  },
  error: { label: "Error", hint: "" },
};

// The DNS record the business adds. We don't get records back from the setup
// callable (they only come from Vercel's verification endpoint), so this shows
// the generic CNAME that works for ~all hosting providers; apex domains get
// Vercel's A record.
function DnsRecordsCard({
  domain,
  stage,
}: {
  domain: string;
  stage: CustomDomainStage;
}) {
  if (stage === "verified") return null;
  const isApex = !domain.includes(".") || domain.split(".").length === 2;
  return (
    <Card>
      <CardHeader>
        <CardTitle>DNS record to add</CardTitle>
        <CardDescription>
          Add this at your DNS provider (GoDaddy, Cloudflare, Squarespace,
          etc.). We re-check every 5 minutes — you don&rsquo;t need to do
          anything else once the record is live.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">
                {isApex ? "A" : "CNAME"}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {isApex ? "@" : domain.split(".")[0]}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {isApex ? "76.76.21.21" : "cname.vercel-dns.com"}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
