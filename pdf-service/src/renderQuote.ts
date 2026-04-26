import { getBrowser } from "./browser";
import { loadTemplate } from "./templateLoader";
import { CSP, cssVarsFor } from "./renderInvoice";
import type { RenderQuoteRequest } from "./types";

export async function renderQuotePDF(
  body: RenderQuoteRequest,
): Promise<Buffer> {
  const html = await buildQuoteHtml(body);
  return htmlToPdf(html);
}

export async function buildQuoteHtml(
  body: RenderQuoteRequest,
): Promise<string> {
  const { snapshot, data } = body;
  const template = loadTemplate("quote");
  return template({
    snapshot,
    data,
    cssVars: cssVarsFor(snapshot),
    csp: CSP,
  });
}

async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Content-Security-Policy": CSP });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", right: "16mm", bottom: "20mm", left: "16mm" },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: `
        <div style="font-size:9px;color:#888;width:100%;padding:0 16mm;display:flex;justify-content:space-between;">
          <span></span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
