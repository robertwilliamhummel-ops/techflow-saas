"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";

import { getClientFunctions } from "@/lib/firebase/client";
import { useTenantContext } from "@/lib/tenant/TenantContext";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const schema = z.object({
  name: z.string().trim().min(2, "Business name must be at least 2 characters.").max(100),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  businessNumber: z.string().trim().max(50).optional().or(z.literal("")),
  invoicePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{1,10}$/i, "1–10 letters or digits only.")
    .transform((v) => v.toUpperCase()),
  taxName: z.string().trim().min(1).max(20),
  taxRate: z.coerce
    .number()
    .min(0, "Tax rate cannot be negative.")
    .max(100, "Tax rate cannot exceed 100%."),
  currency: z.enum(["CAD", "USD"]),
  emailFooter: z.string().trim().max(500).optional().or(z.literal("")),
});

type FormInput = z.input<typeof schema>;
type FormValues = z.output<typeof schema>;

function nullToEmpty(v: string | null | undefined): string {
  return v ?? "";
}

export default function SettingsBusinessPage() {
  const { meta, loading } = useTenantContext();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      address: "",
      businessNumber: "",
      invoicePrefix: "INV",
      taxName: "HST",
      taxRate: 13,
      currency: "CAD",
      emailFooter: "",
    },
  });

  // Hydrate the form once meta is loaded (or when it changes from a remote
  // update). The taxRate stored in Firestore is a fraction (0.13); the form
  // edits it as a percent (13).
  useEffect(() => {
    if (!meta) return;
    form.reset({
      name: meta.name,
      address: nullToEmpty(meta.address),
      businessNumber: nullToEmpty(meta.businessNumber),
      invoicePrefix: meta.invoicePrefix,
      taxName: meta.taxName,
      taxRate: Math.round(meta.taxRate * 10000) / 100,
      currency: meta.currency,
      emailFooter: nullToEmpty(meta.emailFooter),
    });
  }, [meta, form]);

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      const fn = httpsCallable(getClientFunctions(), "updateTenantBranding");
      await fn({
        name: values.name,
        address: values.address || null,
        businessNumber: values.businessNumber || null,
        invoicePrefix: values.invoicePrefix,
        taxName: values.taxName,
        taxRate: values.taxRate / 100,
        currency: values.currency,
        emailFooter: values.emailFooter || null,
      });
      toast.success("Business info saved.");
      form.reset(values);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not save business info.";
      setSubmitError(message);
    }
  }

  const submitting = form.formState.isSubmitting;
  const dirty = form.formState.isDirty;

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Business info</CardTitle>
        <CardDescription>
          Shown on invoices, quotes, and the customer portal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-5">
            {submitError ? (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Business name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormDescription>
                    Appears on invoice headers and the customer portal footer.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="businessNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Business number</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 123456789RT0001" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="invoicePrefix"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Invoice prefix</FormLabel>
                    <FormControl>
                      <Input maxLength={10} {...field} />
                    </FormControl>
                    <FormDescription>e.g. INV → INV-0001.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="taxName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tax name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormDescription>e.g. HST, GST, VAT.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="taxRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tax rate (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        max={100}
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        onChange={field.onChange}
                        value={field.value as number | string}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={(v) =>
                          field.onChange(v as "CAD" | "USD")
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="CAD">CAD</SelectItem>
                          <SelectItem value="USD">USD</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="emailFooter"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email footer</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="Thanks for your business!"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Appended to the bottom of every invoice email.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting || !dirty}>
                {submitting ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
