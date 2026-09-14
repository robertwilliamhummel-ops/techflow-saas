"use client";

// Form fields whose label, hint and error are tied to the input itself. The
// shared ui/form FormControl puts the label's target and aria-invalid on a
// wrapper div, so new forms use these instead.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function TextField({
  id,
  label,
  hint,
  error,
  inputProps,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string;
  inputProps: React.ComponentProps<"input">;
}) {
  // content-start: a taller neighbour in the same grid row mustn't spread this
  // field's label and input apart.
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint ? "hint" : undefined, error)}
        {...inputProps}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

export function TextAreaField({
  id,
  label,
  hint,
  error,
  textareaProps,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string;
  textareaProps: React.ComponentProps<"textarea">;
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint ? "hint" : undefined, error)}
        {...textareaProps}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
