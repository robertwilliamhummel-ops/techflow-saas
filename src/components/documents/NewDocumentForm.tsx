"use client";

// New invoice (S-03) and new quote (S-06) share one form: a quote is an invoice
// without a pay link, valid until a date instead of due on one. Cloud Functions
// validate everything again and compute the saved totals; the checks and the
// totals preview here mirror them (src/lib/isoDate.ts, src/lib/email.ts,
// src/lib/invoices/draftTotals.ts).

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { limit, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import * as Sentry from "@sentry/nextjs";

import { invoiceHref } from "@/components/invoices/InvoiceTable";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FieldError, TextField } from "@/components/forms/fields";
import { isValidEmail } from "@/lib/email";
import type { FeatureKey } from "@/lib/features";
import { getClientFunctions } from "@/lib/firebase/client";
import { dollarsToCents, formatMoneyCents } from "@/lib/format";
import { localIsoDate } from "@/lib/invoices/dueStatus";
import { computeDraftTotals, draftLineAmount } from "@/lib/invoices/draftTotals";
import { addDaysIso, isIsoCalendarDate } from "@/lib/isoDate";
import { quoteHref } from "@/lib/quotes/quoteStatus";
import type { Customer, TenantMeta } from "@/lib/schema/tenant";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { useTenantCollection } from "@/lib/tenant/useTenantCollection";

export type DocumentKind = "invoice" | "quote";

interface KindConfig {
  title: string;
  noun: string;
  nounCapitalized: string;
  listHref: string;
  listLabel: string;
  feature: FeatureKey;
  planName: string;
  endLabel: string;
  endHint: string;
  endOrderMessage: string;
  createCallable: string;
  sendCallable: string;
  idField: "invoiceId" | "quoteId";
  endPayloadField: "dueDate" | "validUntil";
  detailHref: (id: string) => string;
  /** sendInvoiceEmail refuses to send until the tenant can get paid. */
  needsPaymentSetup: boolean;
  endFieldId: string;
}

const KINDS: Record<DocumentKind, KindConfig> = {
  invoice: {
    title: "New invoice",
    noun: "invoice",
    nounCapitalized: "Invoice",
    listHref: "/invoices",
    listLabel: "Invoices",
    feature: "invoices",
    planName: "Invoicing isn't",
    endLabel: "Due date",
    endHint: "New invoices default to 30 days after today.",
    endOrderMessage: "The due date can't be before the issue date.",
    createCallable: "createInvoice",
    sendCallable: "sendInvoiceEmail",
    idField: "invoiceId",
    endPayloadField: "dueDate",
    detailHref: invoiceHref,
    needsPaymentSetup: true,
    endFieldId: "invoice-due-date",
  },
  quote: {
    title: "New quote",
    noun: "quote",
    nounCapitalized: "Quote",
    listHref: "/quotes",
    listLabel: "Quotes",
    feature: "quotes",
    planName: "Quotes aren't",
    endLabel: "Valid until",
    endHint: "New quotes stay valid for 30 days by default.",
    endOrderMessage: "The valid-until date can't be before the issue date.",
    createCallable: "createQuote",
    sendCallable: "sendQuoteEmail",
    idField: "quoteId",
    endPayloadField: "validUntil",
    detailHref: quoteHref,
    needsPaymentSetup: false,
    endFieldId: "quote-valid-until",
  },
};

type CustomerWithId = Customer & { id: string };

const CUSTOMERS_QUERY = [orderBy("name"), limit(500)];
const NEW_CUSTOMER = "__new__";
const DEFAULT_TERMS_DAYS = 30;
const MAX_LINES = 100; // validateLineItems in Cloud Functions

function asNumber(text: string): number {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? value : Number.NaN;
}

const lineSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, "Describe this line.")
    .max(500, "Keep the description under 500 characters."),
  quantity: z
    .string()
    .refine((v) => asNumber(v) > 0, "Enter a quantity greater than 0."),
  rate: z
    .string()
    .refine((v) => asNumber(v) >= 0, "Enter a rate of 0 or more."),
  taxable: z.boolean(),
});

function schemaFor(kind: DocumentKind) {
  return z
    .object({
      customerId: z.string(),
      customerName: z
        .string()
        .trim()
        .min(1, "Enter the customer's name.")
        .max(200, "Keep the name under 200 characters."),
      customerEmail: z
        .string()
        .trim()
        .refine(isValidEmail, "Enter a valid email address."),
      customerPhone: z
        .string()
        .trim()
        .max(50, "Keep the phone number under 50 characters."),
      saveCustomer: z.boolean(),
      issueDate: z.string().refine(isIsoCalendarDate, "Enter a valid date."),
      endDate: z.string().refine(isIsoCalendarDate, "Enter a valid date."),
      applyTax: z.boolean(),
      lineItems: z
        .array(lineSchema)
        .min(1, "Add at least one line.")
        .max(MAX_LINES, `A document can have up to ${MAX_LINES} lines.`),
      notes: z.string().trim().max(2000, "Keep notes under 2,000 characters."),
    })
    .refine(
      (v) =>
        !isIsoCalendarDate(v.issueDate) ||
        !isIsoCalendarDate(v.endDate) ||
        v.endDate >= v.issueDate,
      { path: ["endDate"], message: KINDS[kind].endOrderMessage },
    );
}

type FormSchema = ReturnType<typeof schemaFor>;
type FormInput = z.input<FormSchema>;
type FormValues = z.output<FormSchema>;

function errorMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /(internal|unknown)$/.test(code)) return fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

export function NewDocumentForm({ kind }: { kind: DocumentKind }) {
  const config = KINDS[kind];
  const { meta, hasFeature, loading } = useTenantContext();

  let body: React.ReactNode;
  if (loading) {
    body = <Skeleton className="h-[32rem] rounded-xl" />;
  } else if (!hasFeature(config.feature)) {
    body = (
      <Alert>
        <AlertTitle>{config.planName} turned on for your account</AlertTitle>
        <AlertDescription>
          Contact TechFlow support to turn them on.
        </AlertDescription>
      </Alert>
    );
  } else if (!meta) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load your business settings</AlertTitle>
        <AlertDescription>Refresh the page to try again.</AlertDescription>
      </Alert>
    );
  } else {
    body = <DocumentFormBody kind={kind} meta={meta} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <Link
          href={config.listHref}
          className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {config.listLabel}
        </Link>
        <h1 className="text-2xl font-semibold">{config.title}</h1>
      </div>
      {body}
    </div>
  );
}

function DocumentFormBody({ kind, meta }: { kind: DocumentKind; meta: TenantMeta }) {
  const config = KINDS[kind];
  const router = useRouter();
  const [today] = useState(() => localIsoDate(new Date()));
  const customers = useTenantCollection<CustomerWithId>("customers", CUSTOMERS_QUERY);
  const [submitting, setSubmitting] = useState<"draft" | "send" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [schema] = useState(() => schemaFor(kind));

  const hasTax = Number.isFinite(meta.taxRate) && meta.taxRate > 0;
  const taxName = meta.taxName || "Tax";
  const taxPercent = Math.round(meta.taxRate * 10000) / 100;
  const currency = meta.currency;
  const canCollect =
    Boolean(meta.etransferEmail) || meta.stripeStatus?.chargesEnabled === true;
  const canSend = !config.needsPaymentSetup || canCollect;

  const form = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      customerId: "",
      customerName: "",
      customerEmail: "",
      customerPhone: "",
      saveCustomer: true,
      issueDate: today,
      endDate: addDaysIso(today, DEFAULT_TERMS_DAYS),
      applyTax: hasTax,
      lineItems: [{ description: "", quantity: "1", rate: "", taxable: hasTax }],
      notes: "",
    },
  });
  const { errors } = form.formState;
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lineItems" });
  const lines = useWatch({ control: form.control, name: "lineItems" }) ?? [];
  const applyTax = useWatch({ control: form.control, name: "applyTax" });
  const customerId = useWatch({ control: form.control, name: "customerId" });

  const totals = computeDraftTotals(
    lines.map((line) => ({
      description: line.description,
      quantity: asNumber(line.quantity) || 0,
      rate: asNumber(line.rate) || 0,
      taxable: hasTax && line.taxable,
    })),
    { rate: meta.taxRate, name: taxName },
  );
  const mixedTax = hasTax && lines.some((line) => line.taxable !== applyTax);

  const customerItems = [
    { value: NEW_CUSTOMER, label: "New customer" },
    ...customers.data.map((c) => ({ value: c.id, label: `${c.name} · ${c.email}` })),
  ];

  function pickCustomer(value: string) {
    if (value === NEW_CUSTOMER) {
      form.setValue("customerId", "");
      return;
    }
    const customer = customers.data.find((c) => c.id === value);
    if (!customer) return;
    const options = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };
    form.setValue("customerId", customer.id);
    form.setValue("customerName", customer.name, options);
    form.setValue("customerEmail", customer.email, options);
    form.setValue("customerPhone", customer.phone ?? "", options);
  }

  // Customers → New invoice links here with ?customer=<id>; pick that customer
  // once, when the saved customers have loaded.
  const searchParams = useSearchParams();
  const preselectId = searchParams.get("customer");
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !preselectId || customers.loading) return;
    preselected.current = true;
    const customer = customers.data.find((c) => c.id === preselectId);
    if (!customer) return;
    form.setValue("customerId", customer.id);
    form.setValue("customerName", customer.name);
    form.setValue("customerEmail", customer.email);
    form.setValue("customerPhone", customer.phone ?? "");
  }, [preselectId, customers.loading, customers.data, form]);

  function setTaxOnEveryLine(value: boolean) {
    form.setValue("applyTax", value);
    lines.forEach((_, index) => form.setValue(`lineItems.${index}.taxable`, value));
  }

  async function save(values: FormValues, send: boolean) {
    setSubmitError(null);
    setSubmitting(send ? "send" : "draft");
    const functions = getClientFunctions();
    const email = values.customerEmail;

    let documentId: string;
    try {
      const create = httpsCallable<Record<string, unknown>, Record<string, string>>(
        functions,
        config.createCallable,
      );
      const { data } = await create({
        customer: {
          name: values.customerName,
          email,
          phone: values.customerPhone || null,
        },
        lineItems: values.lineItems.map((line) => ({
          description: line.description,
          quantity: asNumber(line.quantity),
          rate: asNumber(line.rate),
          taxable: hasTax && line.taxable,
        })),
        applyTax: hasTax && values.applyTax,
        issueDate: values.issueDate,
        [config.endPayloadField]: values.endDate,
        notes: values.notes || null,
      });
      documentId = data[config.idField];
    } catch (err) {
      Sentry.captureException(err);
      setSubmitError(errorMessage(err, `Couldn't save the ${config.noun}. Try again.`));
      setSubmitting(null);
      return;
    }

    // The document is saved; what follows can't undo it.
    if (values.customerId === "" && values.saveCustomer) {
      try {
        await httpsCallable(functions, "upsertCustomer")({
          name: values.customerName,
          email,
          phone: values.customerPhone || null,
        });
      } catch (err) {
        Sentry.captureException(err);
        toast.warning(
          `${config.nounCapitalized} ${documentId} was saved, but the customer wasn't added to your list: ${errorMessage(err, "try again from Customers.")}`,
        );
      }
    }

    if (send) {
      try {
        await httpsCallable(functions, config.sendCallable)({ [config.idField]: documentId });
        toast.success(`${config.nounCapitalized} ${documentId} sent to ${email}.`);
      } catch (err) {
        Sentry.captureException(err);
        toast.error(
          `${config.nounCapitalized} ${documentId} was saved as a draft but not sent: ${errorMessage(err, "try sending it again.")}`,
        );
      }
    } else {
      toast.success(`Draft ${documentId} saved.`);
    }
    router.push(config.detailHref(documentId));
  }

  const busy = submitting !== null;

  return (
    // Enter in a field saves a draft; emailing the customer is always a click.
    <form
      noValidate
      onSubmit={form.handleSubmit((values) => save(values, false))}
      className="grid items-start gap-6 lg:grid-cols-3"
    >
      <div className="flex flex-col gap-6 lg:col-span-2">
        {submitError ? (
          <Alert variant="destructive">
            <AlertTitle>The {config.noun} wasn&apos;t saved</AlertTitle>
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
            <CardDescription>
              The {config.noun} keeps its own copy — editing a saved customer
              later won&apos;t change it.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {customers.data.length > 0 ? (
              <div className="grid gap-2">
                <Label htmlFor={`${kind}-customer-pick`}>Saved customer</Label>
                <Select
                  items={customerItems}
                  value={customerId || NEW_CUSTOMER}
                  onValueChange={(value) =>
                    pickCustomer(typeof value === "string" ? value : NEW_CUSTOMER)
                  }
                >
                  <SelectTrigger id={`${kind}-customer-pick`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {customerItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`${kind}-customer-name`}
                label="Name"
                error={errors.customerName?.message}
                inputProps={{ autoComplete: "off", ...form.register("customerName") }}
              />
              <TextField
                id={`${kind}-customer-email`}
                label="Email"
                hint={`The ${config.noun}${kind === "invoice" ? " and receipts go" : " goes"} to this address.`}
                error={errors.customerEmail?.message}
                inputProps={{ type: "email", autoComplete: "off", ...form.register("customerEmail") }}
              />
              <TextField
                id={`${kind}-customer-phone`}
                label="Phone (optional)"
                error={errors.customerPhone?.message}
                inputProps={{ type: "tel", autoComplete: "off", ...form.register("customerPhone") }}
              />
            </div>

            {customerId === "" ? (
              <label className="flex w-fit items-center gap-2 text-sm">
                <Controller
                  control={form.control}
                  name="saveCustomer"
                  render={({ field }) => (
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                  )}
                />
                Save to my customers
              </label>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Items</CardTitle>
            <CardDescription>
              {hasTax
                ? `Untick ${taxName} on any line that's exempt.`
                : "Quantity times rate for each line."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {hasTax ? (
              <label className="flex w-fit items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={applyTax}
                  indeterminate={mixedTax}
                  onCheckedChange={(checked) => setTaxOnEveryLine(checked === true)}
                />
                Charge {taxName} ({taxPercent}%) on every line
              </label>
            ) : null}

            <div
              aria-hidden
              className="hidden gap-3 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[1fr_5rem_7rem_4rem_6rem_4.5rem]"
            >
              <span>Description</span>
              <span>Qty</span>
              <span>Rate</span>
              <span>{hasTax ? taxName : ""}</span>
              <span className="text-right">Amount</span>
              <span />
            </div>

            <ol className="flex flex-col gap-4 sm:gap-3">
              {fields.map((field, index) => {
                const line = lines[index];
                const lineErrors = errors.lineItems?.[index];
                const quantity = asNumber(line?.quantity ?? "");
                const rate = asNumber(line?.rate ?? "");
                const amount =
                  quantity > 0 && rate >= 0
                    ? formatMoneyCents(dollarsToCents(draftLineAmount({ quantity, rate })), currency)
                    : "—";
                return (
                  <li
                    key={field.id}
                    aria-label={`Line ${index + 1}`}
                    className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_5rem_7rem_4rem_6rem_4.5rem] sm:items-start sm:rounded-none sm:border-0 sm:p-0"
                  >
                    <LineField
                      id={`line-${index}-description`}
                      label="Description"
                      error={lineErrors?.description?.message}
                      inputProps={form.register(`lineItems.${index}.description`)}
                    />
                    <LineField
                      id={`line-${index}-quantity`}
                      label="Qty"
                      error={lineErrors?.quantity?.message}
                      inputProps={{ inputMode: "decimal", ...form.register(`lineItems.${index}.quantity`) }}
                    />
                    <LineField
                      id={`line-${index}-rate`}
                      label="Rate"
                      error={lineErrors?.rate?.message}
                      inputProps={{ inputMode: "decimal", placeholder: "0.00", ...form.register(`lineItems.${index}.rate`) }}
                    />
                    <div className="flex h-8 items-center">
                      {hasTax ? (
                        <label className="flex items-center gap-2 text-sm">
                          <Controller
                            control={form.control}
                            name={`lineItems.${index}.taxable`}
                            render={({ field: taxField }) => (
                              <Checkbox
                                checked={taxField.value}
                                onCheckedChange={(checked) => taxField.onChange(checked === true)}
                              />
                            )}
                          />
                          <span className="sm:sr-only">Charge {taxName}</span>
                        </label>
                      ) : null}
                    </div>
                    <p className="flex h-8 items-center text-sm tabular-nums sm:justify-end">
                      <span className="mr-auto text-muted-foreground sm:hidden">Amount</span>
                      {amount}
                    </p>
                    <div className="flex h-8 items-center sm:justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={fields.length === 1}
                        onClick={() => remove(index)}
                        aria-label={`Remove line ${index + 1}`}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div>
              <Button
                type="button"
                variant="outline"
                disabled={fields.length >= MAX_LINES}
                onClick={() =>
                  append({ description: "", quantity: "1", rate: "", taxable: hasTax && applyTax })
                }
              >
                <Plus data-icon="inline-start" aria-hidden />
                Add line
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <Label htmlFor={`${kind}-notes`} className="text-base">
                Notes (optional)
              </Label>
            </CardTitle>
            <CardDescription>Shown to your customer on the {config.noun}.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Textarea
              id={`${kind}-notes`}
              rows={3}
              aria-invalid={errors.notes ? true : undefined}
              aria-describedby={errors.notes ? `${kind}-notes-error` : undefined}
              {...form.register("notes")}
            />
            <FieldError id={`${kind}-notes-error`} message={errors.notes?.message} />
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-6 lg:sticky lg:top-6">
        <Card>
          <CardHeader>
            <CardTitle>Dates</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <TextField
              id={`${kind}-issue-date`}
              label="Issue date"
              error={errors.issueDate?.message}
              inputProps={{ type: "date", ...form.register("issueDate") }}
            />
            <TextField
              id={config.endFieldId}
              label={config.endLabel}
              hint={config.endHint}
              error={errors.endDate?.message}
              inputProps={{ type: "date", ...form.register("endDate") }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="flex flex-col gap-2 text-sm tabular-nums">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd>{formatMoneyCents(dollarsToCents(totals.subtotal), currency)}</dd>
              </div>
              {hasTax ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {taxName} ({taxPercent}%)
                    {totals.taxableSubtotal !== totals.subtotal
                      ? ` on ${formatMoneyCents(dollarsToCents(totals.taxableSubtotal), currency)}`
                      : ""}
                  </dt>
                  <dd>{formatMoneyCents(dollarsToCents(totals.taxAmount), currency)}</dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-4 border-t pt-2">
                <dt className="font-medium">Total</dt>
                <dd className="text-base font-semibold">
                  {formatMoneyCents(dollarsToCents(totals.total), currency)}
                </dd>
              </div>
            </dl>

            {!canSend ? (
              <Alert>
                <AlertTitle>Set up a way to get paid first</AlertTitle>
                <AlertDescription>
                  Add an e-Transfer email or connect Stripe before sending
                  invoices.{" "}
                  <Link href="/settings/payments" className="font-medium underline underline-offset-4">
                    Payment settings
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                size="lg"
                disabled={busy || !canSend}
                onClick={form.handleSubmit((values) => save(values, true))}
              >
                {submitting === "send" ? "Sending…" : "Save and send"}
              </Button>
              <Button type="submit" size="lg" variant="outline" disabled={busy}>
                {submitting === "draft" ? "Saving…" : "Save draft"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Totals are recalculated when you save.
            </p>
          </CardContent>
        </Card>
      </div>
    </form>
  );
}

// A line-item input: its label shows on phones, where the column headings are
// hidden, and stays available to screen readers everywhere.
function LineField({
  id,
  label,
  error,
  inputProps,
}: {
  id: string;
  label: string;
  error?: string;
  inputProps: React.ComponentProps<"input">;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground sm:sr-only">
        {label}
      </Label>
      <Input
        id={id}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...inputProps}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
