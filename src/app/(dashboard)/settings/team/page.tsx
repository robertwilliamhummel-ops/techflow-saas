"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  collection,
  onSnapshot,
  query,
  where,
  type Timestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";

import { getClientDb, getClientFunctions } from "@/lib/firebase/client";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
  role: z.enum(["admin", "staff"]),
});

type FormValues = z.infer<typeof schema>;

interface InvitationDoc {
  id: string;
  email: string;
  role: "admin" | "staff";
  createdAt: Timestamp | null;
  expiresAt: Timestamp | null;
  acceptedAt: Timestamp | null;
  revokedAt: Timestamp | null;
}

export default function SettingsTeamPage() {
  const { tenantId } = useTenantContext();
  const { claims } = useAuth();
  const isOwnerOrAdmin = claims.role === "owner" || claims.role === "admin";

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [invites, setInvites] = useState<InvitationDoc[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [revokeTarget, setRevokeTarget] = useState<InvitationDoc | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", role: "staff" },
  });

  useEffect(() => {
    if (!tenantId) return;
    const q = query(
      collection(getClientDb(), "tenants", tenantId, "invitations"),
      where("acceptedAt", "==", null),
      where("revokedAt", "==", null),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => {
          const data = d.data() as Omit<InvitationDoc, "id">;
          return { id: d.id, ...data };
        });
        rows.sort((a, b) => {
          const am = a.createdAt?.toMillis() ?? 0;
          const bm = b.createdAt?.toMillis() ?? 0;
          return bm - am;
        });
        setInvites(rows);
        setInvitesLoading(false);
      },
      () => setInvitesLoading(false),
    );
    return unsub;
  }, [tenantId]);

  async function onInvite(values: FormValues) {
    setSubmitError(null);
    try {
      const fn = httpsCallable(getClientFunctions(), "createInvitation");
      await fn({ email: values.email, role: values.role });
      toast.success(`Invitation sent to ${values.email}.`);
      form.reset({ email: "", role: values.role });
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not send invitation.",
      );
    }
  }

  async function onRevoke(invite: InvitationDoc) {
    setRevokeTarget(null);
    try {
      const fn = httpsCallable(getClientFunctions(), "revokeInvitation");
      await fn({ invitationId: invite.id });
      toast.success(`Invitation for ${invite.email} revoked.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not revoke invitation.",
      );
    }
  }

  return (
    <div className="grid gap-6">
      {isOwnerOrAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite teammate</CardTitle>
            <CardDescription>
              They&rsquo;ll receive an email with a one-time link to join your
              workspace. Links expire after 7 days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onInvite)}
                className="grid gap-4 sm:grid-cols-[1fr_160px_auto] sm:items-end"
              >
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="teammate@example.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <FormControl>
                        <Select
                          value={field.value}
                          onValueChange={(v) =>
                            field.onChange(v as "admin" | "staff")
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="staff">Staff</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={form.formState.isSubmitting}
                  className="sm:mb-0.5"
                >
                  {form.formState.isSubmitting ? "Sending…" : "Send invite"}
                </Button>
              </form>
              {submitError ? (
                <Alert variant="destructive" className="mt-4">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}
            </Form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Pending invitations</CardTitle>
          <CardDescription>
            People you&rsquo;ve invited who haven&rsquo;t accepted yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invitesLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : invites.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pending invitations.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  {isOwnerOrAdmin ? (
                    <TableHead className="w-24 text-right">Action</TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>{inv.email}</TableCell>
                    <TableCell className="capitalize">{inv.role}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatExpiry(inv.expiresAt)}
                    </TableCell>
                    {isOwnerOrAdmin ? (
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRevokeTarget(inv)}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget
                ? `${revokeTarget.email} will no longer be able to accept this invitation. You can re-invite them later.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && onRevoke(revokeTarget)}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatExpiry(ts: Timestamp | null): string {
  if (!ts) return "—";
  const ms = ts.toMillis() - Date.now();
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "<1 hour";
}
