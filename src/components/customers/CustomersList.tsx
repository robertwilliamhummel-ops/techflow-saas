"use client";

// Customers (S-05): saved customers, live, with search, add, edit, delete, and
// a shortcut to invoice one. Any role can add and edit (upsertCustomer); only
// owners and admins can delete (deleteCustomer).

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { limit, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ChevronDown, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import * as Sentry from "@sentry/nextjs";

import { CustomerFormDialog } from "@/components/customers/CustomerFormDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth/useAuth";
import {
  matchesCustomerSearch,
  sortCustomersByName,
  type CustomerWithId,
} from "@/lib/customers/customers";
import { getClientFunctions } from "@/lib/firebase/client";
import { isOwnerOrAdminRole } from "@/lib/invoices/invoiceActions";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { useTenantCollection } from "@/lib/tenant/useTenantCollection";

const CUSTOMERS_LIMIT = 500;
// Ordered again on the client: Firestore orders names by code point, so "adam"
// would follow "Zoe".
const CUSTOMERS_QUERY = [orderBy("name"), limit(CUSTOMERS_LIMIT)];

function errorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /(internal|unknown)$/.test(code)) return fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

export function CustomersList() {
  const router = useRouter();
  const { claims } = useAuth();
  const { hasFeature, loading: tenantLoading } = useTenantContext();
  const canDelete = isOwnerOrAdminRole(claims.role);
  const canInvoice = !tenantLoading && hasFeature("invoices");

  const { data, loading, error } = useTenantCollection<CustomerWithId>("customers", CUSTOMERS_QUERY);
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerWithId | null>(null);
  const [deleting, setDeleting] = useState<CustomerWithId | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (error) Sentry.captureException(error);
  }, [error]);

  const customers = useMemo(() => sortCustomersByName(data), [data]);
  const rows = useMemo(
    () => customers.filter((customer) => matchesCustomerSearch(customer, query)),
    [customers, query],
  );

  function openForm(customer: CustomerWithId | null) {
    setEditing(customer);
    setFormOpen(true);
  }

  async function deleteCustomer() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await httpsCallable(getClientFunctions(), "deleteCustomer")({ customerId: deleting.id });
      toast.success(`${deleting.name} deleted.`);
      setDeleting(null);
    } catch (err) {
      Sentry.captureException(err);
      toast.error(errorMessage(err, "Couldn't delete the customer. Try again."));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <Button size="lg" onClick={() => openForm(null)}>
          <Plus data-icon="inline-start" aria-hidden />
          Add customer
        </Button>
      </div>

      <div className="relative md:w-96">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id="customer-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, email, phone or address"
          aria-label="Search customers"
          className="pl-8"
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load your customers</AlertTitle>
          <AlertDescription>Refresh the page to try again.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-4">
            {loading ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : customers.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No customers yet. Add one here, or tick &ldquo;Save to my
                  customers&rdquo; when you create an invoice.
                </p>
                <Button variant="outline" onClick={() => openForm(null)}>
                  Add your first customer
                </Button>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">No customers match your search.</p>
                <Button variant="outline" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="hidden sm:table-cell">Phone</TableHead>
                    <TableHead className="hidden lg:table-cell">Address</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((customer) => (
                    <TableRow key={customer.id}>
                      <TableCell>
                        <span className="block max-w-44 truncate font-medium sm:max-w-72">
                          {customer.name}
                        </span>
                        <span className="block max-w-44 truncate text-xs text-muted-foreground sm:max-w-72">
                          {customer.email}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{customer.phone ?? "—"}</TableCell>
                      <TableCell className="hidden max-w-64 truncate lg:table-cell">
                        {customer.address ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Actions for ${customer.name}`}
                            className={buttonVariants({ variant: "ghost", size: "sm" })}
                          >
                            Actions
                            <ChevronDown data-icon="inline-end" aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            {canInvoice ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  router.push(`/invoices/new?customer=${encodeURIComponent(customer.id)}`)
                                }
                              >
                                New invoice
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem onClick={() => openForm(customer)}>Edit</DropdownMenuItem>
                            {canDelete ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(customer)}>
                                  Delete
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {!loading && data.length >= CUSTOMERS_LIMIT ? (
              <p className="text-center text-xs text-muted-foreground">
                Showing your first {CUSTOMERS_LIMIT} customers by name.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      <CustomerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        customer={editing}
        customers={customers}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => (open ? null : setDeleting(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Invoices and quotes already created for them keep their own copy
              of these details. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep customer</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteCustomer} disabled={deleteBusy}>
              {deleteBusy ? "Deleting…" : "Delete customer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
