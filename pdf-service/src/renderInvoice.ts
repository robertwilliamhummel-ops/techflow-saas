import QRCode from "qrcode";
import { getBrowser } from "./browser";
import { loadTemplate } from "./templateLoader";
import type { InvoiceData, RenderInvoiceRequest, TenantSnapshot } from "./types";

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

  const qrDataUrl = data.payUrl
    ? await QRCode.toDataURL(data.payUrl, { width: 120, margin: 1 })
    : null;

  const showEtransfer = !!snapshot.etransferEmail;
  const showCard = !!data.payUrl;
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
    sections: {
      etransfer: showEtransfer,
      card: showCard,
      surchargeNote: showSurchargeNote,
      surchargeRow: showSurchargeRow,
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
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });
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
  // these into the <style> block. Source values come from the SERVER snapshot
  // (controlled, not user-typed-at-render-time), so the {{{ }}} bypass is safe.
  const accent = sanitizeColor(snapshot.primaryColor) ?? "#667eea";
  const accent2 = sanitizeColor(snapshot.secondaryColor) ?? "#764ba2";
  const fontFamily = sanitizeFont(snapshot.fontFamily) ?? "Inter";
  return `--accent:${accent};--accent-2:${accent2};--font-body:'${fontFamily}', system-ui, sans-serif;`;
}

function sanitizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  // Accept #RGB, #RRGGBB, #RRGGBBAA only.
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
    ? value
    : null;
}

function sanitizeFont(value: string | null | undefined): string | null {
  if (!value) return null;
  // Allow alphanumerics, spaces, and hyphens — strip apostrophes/quotes/semis.
  return /^[A-Za-z0-9 \-]{1,64}$/.test(value) ? value : null;
}

// Re-export for tests.
export { CSP, cssVarsFor, sanitizeColor, sanitizeFont };
export type { InvoiceData, TenantSnapshot };
