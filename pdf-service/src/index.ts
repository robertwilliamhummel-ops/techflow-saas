import express, { type NextFunction, type Request, type Response } from "express";
import { renderInvoicePDF } from "./renderInvoice";
import { renderQuotePDF } from "./renderQuote";
import { closeBrowser } from "./browser";
import {
  validateInvoiceBody,
  validateQuoteBody,
  ValidationError,
} from "./validate";

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.PDF_SERVICE_API_KEY;

if (!API_KEY) {
  // Fail loudly at boot — Cloud Run will surface the crash in logs and stop
  // routing traffic, which is the right behaviour. A pdf-service running
  // without an API key is an open relay.
  // eslint-disable-next-line no-console
  console.error("PDF_SERVICE_API_KEY is not set — refusing to start.");
  process.exit(1);
}

export const app = express();

app.use(express.json({ limit: "2mb" }));

// X-Api-Key middleware — applied to render routes only. Health stays open so
// Cloud Run can probe liveness without the secret.
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-api-key");
  if (!provided || provided !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post(
  "/render/invoice",
  requireApiKey,
  async (req, res, next) => {
    try {
      const body = validateInvoiceBody(req.body);
      const pdf = await renderInvoicePDF(body);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${body.data.invoiceId}.pdf"`,
      );
      res.status(200).send(pdf);
    } catch (err) {
      next(err);
    }
  },
);

app.post(
  "/render/quote",
  requireApiKey,
  async (req, res, next) => {
    try {
      const body = validateQuoteBody(req.body);
      const pdf = await renderQuotePDF(body);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${body.data.quoteId}.pdf"`,
      );
      res.status(200).send(pdf);
    } catch (err) {
      next(err);
    }
  },
);

// Error handler — keep last.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("pdf-service render error", err);
  res.status(500).json({ error: "Render failed" });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`pdf-service listening on ${PORT}`);
  });
  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down.`);
    server.close();
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
