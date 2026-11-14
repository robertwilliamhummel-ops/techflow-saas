import QRCode from "qrcode";
import { getBrowser } from "./browser";
import { loadTemplate } from "./templateLoader";
import type { InvoiceData, RenderInvoiceRequest, TenantSnapshot } from "./types";
import { DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR } from "./brandDefaults";
import { fontFaceCss, fontStack, resolveFont, sanitizeFont } from "./fonts";

const CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data: https:;";

export async function renderInvoicePDF(
  body: RenderInvoiceRequest,
): Promise<Buffer> {
  const html = await buildInvoiceHtml(body);
  return htmlToPdf(html);
}

export async function buildInvoiceHtml(
  body: RenderInvoiceRequest,
): Promise<string> {
  const { snapshot, data } = body;
  const template = loadTemplate("invoice");

  // A-12: a void invoice is marked and offers no way to pay, even if the
  // caller still sent a pay URL.
  const isVoid = data.status === "void";
  const showCard = !isVoid && !!data.payUrl;
  const qrDataUrl = showCard
    ? await QRCode.toDataURL(data.payUrl!, { width: 120, margin: 1 })
    : null;

  const showEtransfer = !isVoid && !!snapshot.etransferEmail;
  const taxMarkers = hasMixedTaxability(data.lineItems);
  const showSurchargeNote = snapshot.chargeCustomerCardFees && showCard;

  const surchargeAmount =
    typeof data.surchargeAmountCents === "number"
      ? data.surchargeAmountCents / 100
      : 0;
  const showSurchargeRow =
    data.paidVia === "card" && surchargeAmount > 0;
  const totalCharged = showSurchargeRow
    ? data.totals.total + surchargeAmount
    : null;

  // Effective surcharge percent: use the actual cents/total ratio when paid;
  // fall back to the configured cardFeePercent for the disclosure note.
  const cardFeeFraction = snapshot.cardFeePercent / 100;
  const surchargePercentEffective = showSurchargeRow
    ? data.totals.total > 0
      ? surchargeAmount / data.totals.total
      : cardFeeFraction
    : cardFeeFraction;

  return template({
    snapshot,
    data,
    qrDataUrl,
    cssVars: cssVarsFor(snapshot),
    fontFaces: fontFacesFor(snapshot),
    sections: {
      void: isVoid,
      etransfer: showEtransfer,
      card: showCard,
      surchargeNote: showSurchargeNote,
      surchargeRow: showSurchargeRow,
      taxMarkers,
    },
    surcharge: {
      amount: surchargeAmount,
      totalCharged,
      percentEffective: surchargePercentEffective,
      cardFeeFraction,
    },
    csp: CSP,
  });
}

async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // CSP enforced at the page level — defense-in-depth in case Handlebars escape misses something.
    await page.setExtraHTTPHeaders({ "Content-Security-Policy": CSP });
    // "load" (U-02): Puppeteer dropped networkidle options from setContent in
    // 24.43.1 because they never worked reliably there. Templates load nothing
    // over the network — logo, QR and the business's font are data URLs
    // (test/template.test.ts, test/fonts.test.ts) — so everything has rendered by the load event,
    // and page.pdf() waits for document.fonts.ready (its waitForFonts default).
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", right: "16mm", bottom: "20mm", left: "16mm" },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: footerTemplate(),
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function footerTemplate(): string {
  return `
    <div style="font-size:9px;color:#888;width:100%;padding:0 16mm;display:flex;justify-content:space-between;">
      <span></span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>
  `;
}

function cssVarsFor(snapshot: TenantSnapshot): string {
  // Inlined CSS custom-properties — Handlebars triple-stash {{{ cssVars }}} writes
  // these into the <style> block. Colours must pass sanitizeColor and the font
  // must be one of TENANT_FONTS (fonts.ts), else the defaults apply, so no
  // snapshot text reaches the CSS and the {{{ }}} bypass is safe.
  const accent = sanitizeColor(snapshot.primaryColor) ?? DEFAULT_PRIMARY_COLOR;
  const accent2 = sanitizeColor(snapshot.secondaryColor) ?? DEFAULT_SECONDARY_COLOR;
  const font = resolveFont(snapshot.fontFamily);
  return `--accent:${accent};--accent-2:${accent2};--font-body:${fontStack(font)};`;
}

// G-04: the @font-face rules for the snapshot's font (the platform font when it
// names none from the list), for the templates' other triple-stash,
// {{{ fontFaces }}}. Built from the curated list and the vendored files only.
function fontFacesFor(snapshot: TenantSnapshot): string {
  return fontFaceCss(resolveFont(snapshot.fontFamily));
}

// D4 — when an invoice mixes taxable and exempt lines, exempt lines are marked
// and each tax row states its base, so the document identifies which supplies
// carry GST/HST. Lines without a `taxable` flag count as taxable.
export function hasMixedTaxability(
  lineItems: Array<{ taxable?: boolean }>,
): boolean {
  const exempt = lineItems.some((li) => li.taxable === false);
  const taxable = lineItems.some((li) => li.taxable !== false);
  return exempt && taxable;
}

function sanitizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  // Accept #RGB, #RRGGBB, #RRGGBBAA only.
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
    ? value
    : null;
}

// Re-export for tests. sanitizeFont (fonts.ts) accepts only TENANT_FONTS.
export { CSP, cssVarsFor, fontFacesFor, sanitizeColor, sanitizeFont };
export type { InvoiceData, TenantSnapshot };
