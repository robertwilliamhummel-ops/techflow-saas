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
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
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

const MAX_CARD_FEE = 2.4;
const STRIPE_RATE = 0.029;
const STRIPE_FIXED_CENTS = 30;
const SAMPLE_INVOICE_CENTS = 50000;

const schema = z.object({
  etransferEmail: z.union([
    z.literal(""),
    z.string().email("Enter a valid email address."),
  ]),
  chargeCustomerCardFees: z.boolean(),
  cardFeePercent: z.coerce
    .number()
    .min(0, "Surcharge cannot be negative.")
    .max(MAX_CARD_FEE, `Surcharge is capped at ${MAX_CARD_FEE}% (Visa/Mastercard ceiling).`),
});

type FormInput = z.input<typeof schema>;
type FormValues = z.output<typeof schema>;

export default function SettingsPaymentsPage() {
  const { meta, loading } = useTenantContext();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingEnable, setPendingEnable] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const form = useForm<FormInput, any, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      etransferEmail: "",
      chargeCustomerCardFees: false,
      cardFeePercent: MAX_CARD_FEE,
    },
  });

  useEffect(() => {
    if (!meta) return;
    form.reset({
      etransferEmail: meta.etransferEmail ?? "",
      chargeCustomerCardFees: meta.chargeCustomerCardFees,
      cardFeePercent: meta.cardFeePercent,
    });
  }, [meta, form]);

  const acknowledgedAt = meta?.surchargeAcknowledgedAt ?? null;
  const charge = form.watch("chargeCustomerCardFees");
  const feePct = Number(form.watch("cardFeePercent")) || 0;

  function handleToggleChange(next: boolean) {
    if (next && !acknowledgedAt) {
      setPendingEnable(true);
      return;
    }
    form.setValue("chargeCustomerCardFees", next, { shouldDirty: true });
  }

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      const fn = httpsCallable(getClientFunctions(), "updatePaymentSettings");
      await fn({
        etransferEmail: values.etransferEmail === "" ? null : values.etransferEmail,
        chargeCustomerCardFees: values.chargeCustomerCardFees,
        cardFeePercent: values.cardFeePercent,
      });
      toast.success("Payment settings saved.");
      form.reset(values);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not save payment settings.",
      );
    }
  }

  async function onAcknowledge() {
    setPendingEnable(false);
    setSubmitError(null);
    try {
      const fn = httpsCallable(getClientFunctions(), "updatePaymentSettings");
      await fn({
        chargeCustomerCardFees: true,
        cardFeePercent: form.getValues("cardFeePercent"),
        acknowledgeSurcharge: true,
      });
      form.setValue("chargeCustomerCardFees", true, { shouldDirty: false });
      toast.success("Surcharging enabled.");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not enable surcharging.",
      );
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const submitting = form.formState.isSubmitting;
  const dirty = form.formState.isDirty;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Payment settings</CardTitle>
          <CardDescription>
            How customers can pay you, and whether to pass card fees through.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-6">
              {submitError ? (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}

              <FormField
                control={form.control}
                name="etransferEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Interac e-Transfer email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="payments@yourbusiness.ca"
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormDescription>
                      Most contractors use the same email where they want money
                      deposited. This is shown to customers on every invoice.
                      Leave blank to hide e-Transfer.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-3 rounded-md border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">
                      Pass credit card fees to customers
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Adds a separate &ldquo;processing fee&rdquo; line on the
                      pay page when a customer chooses card. Off = you absorb
                      the Stripe fee.
                    </p>
                  </div>
                  <FormField
                    control={form.control}
                    name="chargeCustomerCardFees"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={handleToggleChange}
                      />
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="cardFeePercent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Surcharge percentage</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.1"
                          min={0}
                          max={MAX_CARD_FEE}
                          disabled={!charge}
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          onChange={field.onChange}
                          value={field.value as number | string}
                        />
                      </FormControl>
                      <FormDescription>
                        Visa and Mastercard Canada cap surcharges at{" "}
                        {MAX_CARD_FEE}%. You cannot charge more.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <SurchargePreview enabled={charge} feePct={feePct} />

              <div className="flex justify-end">
                <Button type="submit" disabled={submitting || !dirty}>
                  {submitting ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <SurchargeAcknowledgmentDialog
        open={pendingEnable}
        onOpenChange={setPendingEnable}
        onConfirm={onAcknowledge}
      />
    </div>
  );
}

function SurchargePreview({
  enabled,
  feePct,
}: {
  enabled: boolean;
  feePct: number;
}) {
  const surchargeCents = enabled
    ? Math.round((SAMPLE_INVOICE_CENTS * feePct) / 100)
    : 0;
  const customerPaysCents = SAMPLE_INVOICE_CENTS + surchargeCents;
  const stripeFeeCents =
    Math.round(customerPaysCents * STRIPE_RATE) + STRIPE_FIXED_CENTS;
  const youReceiveCents = customerPaysCents - stripeFeeCents;
  const baselineNetCents =
    SAMPLE_INVOICE_CENTS - (Math.round(SAMPLE_INVOICE_CENTS * STRIPE_RATE) + STRIPE_FIXED_CENTS);
  const savingsCents = youReceiveCents - baselineNetCents;

  return (
    <div className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm">
      <p className="font-medium">On a $500 invoice paid by credit card:</p>
      <dl className="grid gap-1 font-mono text-xs">
        <Row label="Customer pays" value={fmt(customerPaysCents)} />
        <Row label="Stripe fee (2.9% + $0.30)" value={`−${fmt(stripeFeeCents)}`} />
        <Row label="You receive (net)" value={fmt(youReceiveCents)} bold />
        {enabled ? (
          <>
            <Row
              label="Without surcharge you'd receive"
              value={fmt(baselineNetCents)}
              muted
            />
            <Row
              label="Surcharging saves you"
              value={`+${fmt(savingsCents)}`}
              muted
            />
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">
        The {MAX_CARD_FEE}% cap is set by Visa and Mastercard — you can&rsquo;t
        charge more. Stripe&rsquo;s actual cost is 2.9% + 30¢, so you&rsquo;ll
        still absorb roughly 0.5% + 30¢ per transaction. E-Transfer is fee-free:
        customer pays $500, you receive $500.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${
        bold ? "border-t pt-1 font-semibold text-foreground" : ""
      } ${muted ? "text-muted-foreground" : ""}`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function SurchargeAcknowledgmentDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) setConfirmed(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Before you enable credit card surcharging
          </AlertDialogTitle>
          <AlertDialogDescription>
            Canadian card-network rules require all of the following.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ol className="grid list-decimal gap-2 pl-5 text-sm text-foreground">
          <li>
            <strong>
              Notify Visa and Mastercard 30 days before surcharging begins.
            </strong>{" "}
            Search &ldquo;merchant surcharge notification&rdquo; on{" "}
            <a
              href="https://www.visa.ca/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              visa.ca
            </a>{" "}
            and{" "}
            <a
              href="https://www.mastercard.ca/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              mastercard.ca
            </a>
            . Required, not optional. Our platform cannot file these for you.
          </li>
          <li>
            <strong>Do not surcharge Quebec customers.</strong> Quebec&rsquo;s
            Consumer Protection Act prohibits credit card surcharges. Disable
            this setting for Quebec invoices, or leave it off entirely.
          </li>
          <li>
            <strong>Do not surcharge debit card payments.</strong> Our platform
            cannot fully distinguish debit from credit Visa/Mastercard at
            checkout. Contact support if this becomes a compliance issue.
          </li>
          <li>
            <strong>Surcharges are capped at {MAX_CARD_FEE}%</strong> — the
            Canadian network ceiling. We enforce this cap automatically.
          </li>
          <li>
            <strong>The surcharge must be disclosed before the customer pays.</strong>{" "}
            We handle this — the pay page shows the fee next to the credit-card
            option, and the PDF lists it as a separate line.
          </li>
        </ol>

        <label className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <Checkbox
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
            className="mt-0.5"
          />
          <span>
            I confirm I have notified Visa and Mastercard and understand the
            Quebec and debit-card restrictions.
          </span>
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!confirmed} onClick={onConfirm}>
            Enable surcharging
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
