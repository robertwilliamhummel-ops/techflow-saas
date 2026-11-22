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
import {
  canRemoveMember,
  memberName,
  type TeamMember,
} from "@/lib/team/members";
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
  const { tenantId, meta } = useTenantContext();
  const { claims, user } = useAuth();
  const isOwnerOrAdmin = claims.role === "owner" || claims.role === "admin";
  const viewer = { uid: user?.uid, role: claims.role };

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [invites, setInvites] = useState<InvitationDoc[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [revokeTarget, setRevokeTarget] = useState<InvitationDoc | null>(null);

  // D21 — the current team comes from listMembers (memberships are readable
  // only by their own user), and owners can remove an admin or staff member.
  // Each load answers one attempt; bumping the attempt reloads. The last list
  // stays on screen while a reload is in flight.
  const [membersAttempt, setMembersAttempt] = useState(0);
  const [membersLoad, setMembersLoad] = useState<{
    attempt: number;
    members: TeamMember[] | null;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);
  const [removingUid, setRemovingUid] = useState<string | null>(null);
  const reloadMembers = () => setMembersAttempt((n) => n + 1);

  useEffect(() => {
    if (!tenantId) return;
    let active = true;
    const attempt = membersAttempt;
    Promise.resolve()
      .then(() =>
        httpsCallable<Record<string, never>, { members: TeamMember[] }>(
          getClientFunctions(),
          "listMembers",
        )({}),
      )
      .then(({ data }) => {
        if (active) setMembersLoad({ attempt, members: data.members });
      })
      .catch(() => {
        if (active) setMembersLoad({ attempt, members: null });
      });
    return () => {
      active = false;
    };
  }, [tenantId, membersAttempt]);

  const members = membersLoad?.members ?? [];
  const membersState: "loading" | "ready" | "error" = membersLoad?.members
    ? "ready"
    : membersLoad?.attempt === membersAttempt
      ? "error"
      : "loading";

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

  async function onRemove(target: TeamMember) {
    setRemoveTarget(null);
    setRemovingUid(target.uid);
    try {
      const fn = httpsCallable(getClientFunctions(), "removeMember");
      await fn({ targetUid: target.uid });
      toast.success(`${memberName(target)} was removed from your team.`);
      reloadMembers();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not remove this member.",
      );
    } finally {
      setRemovingUid(null);
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
          <CardTitle>Team members</CardTitle>
          <CardDescription>
            Everyone who can sign in to your business.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {membersState === "loading" ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : membersState === "error" ? (
            <Alert variant="destructive">
              <AlertDescription>
                Couldn&rsquo;t load your team.{" "}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={reloadMembers}
                >
                  Try again
                </button>
              </AlertDescription>
            </Alert>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  {claims.role === "owner" ? (
                    <TableHead className="w-24 text-right">Action</TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.uid}>
                    <TableCell>
                      <div className="font-medium">{memberName(m)}</div>
                      {m.displayName && m.email ? (
                        <div className="text-xs text-muted-foreground">
                          {m.email}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="capitalize">
                      {m.role}
                      {m.uid === user?.uid ? (
                        <span className="ml-1 normal-case text-muted-foreground">
                          (you)
                        </span>
                      ) : null}
                    </TableCell>
                    {claims.role === "owner" ? (
                      <TableCell className="text-right">
                        {canRemoveMember(viewer, m) ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={removingUid === m.uid}
                            onClick={() => setRemoveTarget(m)}
                          >
                            {removingUid === m.uid ? "Removing…" : "Remove"}
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove team member?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? `${memberName(removeTarget)} will lose access to ${meta?.name ?? "your business"} right away and be signed out on every device. Invoices, quotes, and customers they created stay. You can invite them again later.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeTarget && onRemove(removeTarget)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
