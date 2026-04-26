import { readFileSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";

// Templates live next to the compiled JS at runtime (Dockerfile copies src/templates → dist/templates).
const TEMPLATE_DIR = join(__dirname, "templates");

const compiledCache = new Map<string, Handlebars.TemplateDelegate>();

// Register helpers ONCE at module load — Handlebars.registerHelper is idempotent
// per name but cheaper to do at import time than on every render.
registerHelpers();

export function loadTemplate(name: string): Handlebars.TemplateDelegate {
  const cached = compiledCache.get(name);
  if (cached) return cached;
  const source = readFileSync(join(TEMPLATE_DIR, `${name}.hbs`), "utf8");
  // strict + noEscape:false — `{{ x }}` always escapes, `{{{ x }}}` is in the
  // template by design when injecting trusted SVG/CSS only.
  const compiled = Handlebars.compile(source, { strict: false, noEscape: false });
  compiledCache.set(name, compiled);
  return compiled;
}

function registerHelpers(): void {
  // Currency formatting — always 2 decimals, locale-agnostic dotted.
  Handlebars.registerHelper("money", (value: unknown, currency?: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    const symbol = currencySymbol(typeof currency === "string" ? currency : "CAD");
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n).toFixed(2);
    return `${sign}${symbol}${abs}`;
  });

  // Percent formatting — `{{ percent 0.13 }}` → `13%`.
  Handlebars.registerHelper("percent", (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return `${(n * 100).toFixed(n * 100 === Math.round(n * 100) ? 0 : 2)}%`;
  });

  // Cents → dollars.
  Handlebars.registerHelper("centsToDollars", (cents: unknown) => {
    const n = Number(cents);
    if (!Number.isFinite(n)) return "0.00";
    return (n / 100).toFixed(2);
  });

  // Conditional equality — `{{#if (eq a b)}}`.
  Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);

  // Logical AND with truthy semantics for use in `{{#if (and a b)}}`.
  Handlebars.registerHelper("and", (...args: unknown[]) => {
    const real = args.slice(0, -1);
    return real.every(Boolean);
  });

  // Logical OR — `{{#if (or a b)}}`.
  Handlebars.registerHelper("or", (...args: unknown[]) => {
    const real = args.slice(0, -1);
    return real.some(Boolean);
  });
}

function currencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "CAD":
    default:
      return "$";
  }
}
