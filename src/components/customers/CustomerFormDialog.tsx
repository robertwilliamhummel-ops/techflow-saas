"use client";

// Add or edit a customer (S-05) through upsertCustomer. Invoices and quotes
// keep their own copy of the customer, so an edit never changes them.

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";
import * as Sentry from "@sentry/nextjs";

import { TextAreaField, TextField } from "@/components/forms/fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CUSTOMER_LIMITS,
  customerWithSameEmail,
  type CustomerWithId,
} from "@/lib/customers/customers";
import { isValidEmail } from "@/lib/email";
import { getClientFunctions } from "@/lib/firebase/client";

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter the customer's name.")
    .max(CUSTOMER_LIMITS.name, `Keep the name under ${CUSTOMER_LIMITS.name} characters.`),
  email: z.string().trim().refine(isValidEmail, "Enter a valid email address."),
  phone: z
    .string()
    .trim()
    .max(CUSTOMER_LIMITS.phone, `Keep the phone number under ${CUSTOMER_LIMITS.phone} characters.`),
  address: z
    .string()
    .trim()
    .max(CUSTOMER_LIMITS.address, `Keep the address under ${CUSTOMER_LIMITS.address} characters.`),
  notes: z
    .string()
    .trim()
    .max(CUSTOMER_LIMITS.notes, "Keep notes under 2,000 characters."),
});

type FormValues = z.infer<typeof schema>;

function valuesFor(customer: CustomerWithId | null): FormValues {
  return {
    name: customer?.name ?? "",
    email: customer?.email ?? "",
    phone: customer?.phone ?? "",
    address: customer?.address ?? "",
    notes: customer?.notes ?? "",
  };
}

function errorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /(internal|unknown)$/.test(code)) return fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

export function CustomerFormDialog({
  open,
  onOpenChange,
  customer,
  customers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The customer to edit, or null to add one. */
  customer: CustomerWithId | null;
  /** Loaded customers, to point out a shared email. */
  customers: readonly CustomerWithId[];
}) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: valuesFor(customer),
  });
  const { errors, isSubmitting } = form.formState;
  const email = useWatch({ control: form.control, name: "email" });
  const sameEmail = customerWithSameEmail(customers, email ?? "", customer?.id ?? null);

  // Start from the chosen customer each time the dialog opens.
  useEffect(() => {
    if (open) form.reset(valuesFor(customer));
  }, [open, customer, form]);

  async function save(values: FormValues) {
    setSubmitError(null);
    try {
      await httpsCallable(getClientFunctions(), "upsertCustomer")({
        ...(customer ? { customerId: customer.id } : {}),
        name: values.name,
        email: values.email,
        phone: values.phone || null,
        address: values.address || null,
        notes: values.notes || null,
      });
      toast.success(customer ? `${values.name} updated.` : `${values.name} added.`);
      onOpenChange(false);
    } catch (err) {
      Sentry.captureException(err);
      setSubmitError(errorMessage(err, "Couldn't save the customer. Try again."));
    }
  }

  const idPrefix = customer ? `customer-${customer.id}` : "customer-new";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSubmitError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{customer ? "Edit customer" : "Add customer"}</DialogTitle>
          <DialogDescription>
            {customer
              ? "Invoices and quotes already created keep the details they were issued with."
              : "Saved customers can be picked when you create an invoice."}
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={form.handleSubmit(save)} className="grid gap-4">
          {submitError ? (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}
          <TextField
            id={`${idPrefix}-name`}
            label="Name"
            error={errors.name?.message}
            inputProps={{ autoComplete: "off", ...form.register("name") }}
          />
          <TextField
            id={`${idPrefix}-email`}
            label="Email"
            error={errors.email?.message}
            hint={
              sameEmail
                ? `${sameEmail.name} also uses this email. That's fine if one contact pays for several customers.`
                : undefined
            }
            inputProps={{ type: "email", autoComplete: "off", ...form.register("email") }}
          />
          <TextField
            id={`${idPrefix}-phone`}
            label="Phone (optional)"
            error={errors.phone?.message}
            inputProps={{ type: "tel", autoComplete: "off", ...form.register("phone") }}
          />
          <TextAreaField
            id={`${idPrefix}-address`}
            label="Address (optional)"
            error={errors.address?.message}
            textareaProps={{ rows: 2, ...form.register("address") }}
          />
          <TextAreaField
            id={`${idPrefix}-notes`}
            label="Notes (optional)"
            hint="Only your team sees these."
            error={errors.notes?.message}
            textareaProps={{ rows: 2, ...form.register("notes") }}
          />
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : customer ? "Save changes" : "Add customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
