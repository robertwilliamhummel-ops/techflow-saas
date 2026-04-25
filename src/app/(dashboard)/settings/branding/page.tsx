"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";

import { getClientFunctions } from "@/lib/firebase/client";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { meetsWcagAA, contrastRatio } from "@/lib/design/contrast";
import { TENANT_FONTS } from "@/lib/design/fonts";
import { uploadBrandingAsset } from "@/lib/storage/uploadBrandingAsset";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

const schema = z.object({
  primaryColor: z
    .string()
    .trim()
    .refine((v) => HEX_RE.test(v), "Enter a hex color like #0066CC.")
    .refine(
      (v) => meetsWcagAA(v, "#FFFFFF"),
      "This color is too light — button text won't be readable. Try a darker shade.",
    ),
  secondaryColor: z
    .string()
    .trim()
    .refine((v) => HEX_RE.test(v), "Enter a hex color like #F5F5F5.")
    .refine(
      (v) => meetsWcagAA(v, "#FFFFFF"),
      "This color is too light — text won't be readable. Try a darker shade.",
    ),
  fontFamily: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

const MAX_BRANDING_BYTES = 2 * 1024 * 1024; // mirrors Storage rule.

export default function SettingsBrandingPage() {
  const { tenantId, meta, loading } = useTenantContext();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [faviconUploading, setFaviconUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: {
      primaryColor: "#0066CC",
      secondaryColor: "#374151",
      fontFamily: "Inter",
    },
  });

  useEffect(() => {
    if (!meta) return;
    form.reset({
      primaryColor: meta.primaryColor,
      secondaryColor: meta.secondaryColor,
      fontFamily: meta.fontFamily,
    });
  }, [meta, form]);

  async function onSubmit(values: FormValues) {
    setSubmitError(null);
    try {
      const fn = httpsCallable(getClientFunctions(), "updateTenantBranding");
      await fn({
        primaryColor: normalizeHex(values.primaryColor),
        secondaryColor: normalizeHex(values.secondaryColor),
        fontFamily: values.fontFamily,
      });
      toast.success("Branding saved.");
      form.reset(values);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not save branding.",
      );
    }
  }

  async function handleAssetUpload(
    kind: "logo" | "favicon",
    file: File | undefined | null,
  ) {
    if (!file || !tenantId) return;
    if (file.size > MAX_BRANDING_BYTES) {
      toast.error("File must be under 2 MB.");
      return;
    }
    const setBusy = kind === "logo" ? setLogoUploading : setFaviconUploading;
    setBusy(true);
    try {
      const url = await uploadBrandingAsset(tenantId, kind, file);
      const fn = httpsCallable(getClientFunctions(), "updateTenantBranding");
      await fn(kind === "logo" ? { logoUrl: url } : { faviconUrl: url });
      toast.success(`${kind === "logo" ? "Logo" : "Favicon"} updated.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not upload ${kind}.`);
    } finally {
      setBusy(false);
      if (kind === "logo" && logoInputRef.current)
        logoInputRef.current.value = "";
      if (kind === "favicon" && faviconInputRef.current)
        faviconInputRef.current.value = "";
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const primary = form.watch("primaryColor");
  const secondary = form.watch("secondaryColor");
  const submitting = form.formState.isSubmitting;
  const dirty = form.formState.isDirty;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Brand colors &amp; type</CardTitle>
          <CardDescription>
            These show on the customer pay page, invoice PDFs, and emails.
            Colors must meet WCAG AA contrast (4.5:1 against white) so button
            text stays legible.
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

              <div className="grid gap-5 sm:grid-cols-2">
                <ColorField
                  control={form.control}
                  name="primaryColor"
                  label="Primary color"
                  description="Buttons, links, accents."
                />
                <ColorField
                  control={form.control}
                  name="secondaryColor"
                  label="Secondary color"
                  description="Backgrounds, secondary buttons."
                />
              </div>

              <FormField
                control={form.control}
                name="fontFamily"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Font family</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="w-full sm:w-64">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TENANT_FONTS.map((font) => (
                            <SelectItem key={font} value={font}>
                              {font}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <ColorPreview primary={primary} secondary={secondary} />

              <div className="flex justify-end">
                <Button type="submit" disabled={submitting || !dirty}>
                  {submitting ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>
            Shown on invoices and the customer portal. PNG, JPG, or SVG, max 2 MB.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {meta?.logoUrl ? (
            <div className="flex h-24 w-48 items-center justify-center rounded-md border bg-muted/30 p-2">
              <Image
                src={meta.logoUrl}
                alt="Current logo"
                width={160}
                height={80}
                className="max-h-full max-w-full object-contain"
                unoptimized
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No logo uploaded.</p>
          )}
          <div>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="hidden"
              onChange={(e) =>
                handleAssetUpload("logo", e.target.files?.[0] ?? null)
              }
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => logoInputRef.current?.click()}
              disabled={logoUploading}
            >
              {logoUploading ? "Uploading…" : meta?.logoUrl ? "Replace logo" : "Upload logo"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Favicon</CardTitle>
          <CardDescription>
            Shown in browser tabs on the customer portal. ICO or PNG, max 2 MB.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {meta?.faviconUrl ? (
            <div className="flex h-12 w-12 items-center justify-center rounded-md border bg-muted/30 p-1">
              <Image
                src={meta.faviconUrl}
                alt="Current favicon"
                width={32}
                height={32}
                className="max-h-full max-w-full object-contain"
                unoptimized
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No favicon uploaded.</p>
          )}
          <div>
            <input
              ref={faviconInputRef}
              type="file"
              accept="image/x-icon,image/png,image/svg+xml"
              className="hidden"
              onChange={(e) =>
                handleAssetUpload("favicon", e.target.files?.[0] ?? null)
              }
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => faviconInputRef.current?.click()}
              disabled={faviconUploading}
            >
              {faviconUploading
                ? "Uploading…"
                : meta?.faviconUrl
                  ? "Replace favicon"
                  : "Upload favicon"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ColorField({
  control,
  name,
  label,
  description,
}: {
  control: ReturnType<typeof useForm<FormValues>>["control"];
  name: keyof FormValues;
  label: string;
  description: string;
}) {
  return (
    <FormField
      control={control}
      name={name as never}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={normalizeHexForInput(String(field.value))}
                onChange={(e) => field.onChange(e.target.value)}
                className="h-9 w-14 cursor-pointer rounded-md border border-input bg-transparent"
              />
              <Input
                value={String(field.value)}
                onChange={field.onChange}
                onBlur={field.onBlur}
                placeholder="#0066CC"
              />
            </div>
          </FormControl>
          <FormDescription>{description}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function ColorPreview({
  primary,
  secondary,
}: {
  primary: string;
  secondary: string;
}) {
  const primaryRatio = safeContrast(primary, "#FFFFFF");
  const secondaryRatio = safeContrast(secondary, "#FFFFFF");
  return (
    <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-xs">
      <p className="font-medium text-foreground">Preview</p>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
          style={{ backgroundColor: primaryOrFallback(primary) }}
        >
          Primary {primaryRatio !== null ? `(${primaryRatio.toFixed(2)}:1)` : ""}
        </span>
        <span
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
          style={{ backgroundColor: primaryOrFallback(secondary) }}
        >
          Secondary {secondaryRatio !== null ? `(${secondaryRatio.toFixed(2)}:1)` : ""}
        </span>
      </div>
    </div>
  );
}

function safeContrast(a: string, b: string): number | null {
  if (!HEX_RE.test(a) || !HEX_RE.test(b)) return null;
  try {
    return contrastRatio(a, b);
  } catch {
    return null;
  }
}

function primaryOrFallback(hex: string): string {
  return HEX_RE.test(hex) ? normalizeHex(hex) : "#888888";
}

function normalizeHex(hex: string): string {
  const v = hex.trim();
  return v.startsWith("#") ? v : `#${v}`;
}

// <input type="color"> requires a 6-char hex starting with #. Coerce so we
// don't crash the picker on user typing.
function normalizeHexForInput(hex: string): string {
  const v = hex.trim();
  if (HEX_RE.test(v)) {
    let h = v.startsWith("#") ? v.slice(1) : v;
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return `#${h}`;
  }
  return "#000000";
}
