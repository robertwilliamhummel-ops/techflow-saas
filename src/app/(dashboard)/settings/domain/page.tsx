"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";

import { getClientFunctions } from "@/lib/firebase/client";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { useAuth } from "@/lib/auth/useAuth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { CustomDomainStage } from "@/lib/schema/tenant";

const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const schema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (v) => DOMAIN_RE.test(v),
      "Enter a valid hostname (e.g. invoices.smithplumbing.ca).",
    ),
});

type FormValues = z.infer<typeof schema>;

export default function SettingsDomainPage() {
  const { meta, hasFeature, loading } = useTenantContext();
  const { claims } = useAuth();
  const isOwnerOrAdmin = claims.role === "owner" || claims.role === "admin";
  const featureEnabled = hasFeature("customDomain");

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    values: { domain: meta?.customDomain ?? "" },
  });

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
            Send invoices from a domain you control (e.g.
            invoices.yourcompany.ca) instead of the generic portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertDescription>
              Custom domains aren&rsquo;t included on your current plan. Reply
              to your TechFlow welcome email to upgrade.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const status = meta?.customDomainStatus;
  const currentDomain = meta?.customDomain ?? null;

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      const fn = httpsCallable(getClientFunctions(), "setupCustomDomain");
      await fn({ domain: values.domain });
      toast.success("Domain saved. Add the DNS records below to complete setup.");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not save custom domain.",
      );
    }
  }

  async function onRecheck() {
    setRechecking(true);
    try {
      const fn = httpsCallable(getClientFunctions(), "recheckCustomDomain");
      const res = (await fn({})) as {
        data: { stage: CustomDomainStage; message: string | null };
      };
      if (res.data.stage === "verified") {
        toast.success("Domain verified.");
      } else {
        toast.info(res.data.message ?? "Still pending — check again shortly.");
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not re-check status.",
      );
    } finally {
      setRechecking(false);
    }
  }

  async function onRemove() {
    setRemoveOpen(false);
    setRemoving(true);
    try {
      const fn = httpsCallable(getClientFunctions(), "removeCustomDomain");
      await fn({});
      toast.success("Custom domain removed.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not remove domain.",
      );
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom domain</CardTitle>
          <CardDescription>
            Customers will sign in to view invoices at the domain you choose.
            Until DNS is verified, the generic portal continues to work and
            outgoing emails keep using it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {currentDomain && status ? (
            <StatusBanner stage={status.stage} message={status.message} />
          ) : null}

          {isOwnerOrAdmin ? (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"
              >
                <FormField
                  control={form.control}
                  name="domain"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Domain</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="invoices.yourcompany.ca"
                          autoComplete="off"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Use a subdomain you control. CNAME it to{" "}
                        <code className="rounded bg-muted px-1 text-xs">
                          cname.vercel-dns.com
                        </code>
                        .
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={form.formState.isSubmitting}
                  className="sm:mb-0.5"
                >
                  {form.formState.isSubmitting ? "Saving…" : "Save domain"}
                </Button>
              </form>
              {submitError ? (
                <Alert variant="destructive" className="mt-2">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}
            </Form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can change the custom domain.
            </p>
          )}

          {currentDomain ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={onRecheck}
                disabled={rechecking}
              >
                {rechecking ? "Checking…" : "Re-check now"}
              </Button>
              {isOwnerOrAdmin ? (
                <Button
                  variant="outline"
                  onClick={() => setRemoveOpen(true)}
                  disabled={removing}
                >
                  {removing ? "Removing…" : "Remove domain"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {currentDomain && status ? (
        <DnsRecordsCard domain={currentDomain} stage={status.stage} />
      ) : null}

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove custom domain?</AlertDialogTitle>
            <AlertDialogDescription>
              Customers will go back to using the generic portal at
              portal.techflowsolutions.ca. Outgoing invoice emails will switch
              back automatically. You can re-add the domain later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  unverified: { label: "Not configured", hint: "Add a domain to begin." },
  dns_pending: {
    label: "Waiting on DNS",
    hint: "Add the records below — propagation can take 5 min to 48 hours.",
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

// DNS records the customer must add. We don't get them back from our callable
// (they only come from Vercel's verification endpoint), so we render the
// generic CNAME instructions that work for ~all hosting providers. Tenants
// with edge cases (apex domains) can contact support.
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
        <CardTitle>DNS records to add</CardTitle>
        <CardDescription>
          Add these at your DNS provider (GoDaddy, Cloudflare, Squarespace,
          etc.). We re-check every 5 minutes — you don&rsquo;t need to do
          anything else once the records are live.
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
