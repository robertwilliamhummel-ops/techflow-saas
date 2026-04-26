// Wire types between Next.js proxy and the Cloud Run pdf-service.
// Cloud Run never reads Firestore — every field needed to render must arrive
// in the request body. Snapshot is the frozen tenant branding. data is the
// invoice/quote payload (already validated/loaded by the proxy).

export interface TenantSnapshot {
  version: number;
  name: string;
  logo: string | null; // base64 data URL OR null
  address: string | null;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  faviconUrl: string | null;
  taxRate: number;
  taxName: string;
  businessNumber: string | null;
  emailFooter: string | null;
  currency: string;
  chargeCustomerCardFees: boolean;
  cardFeePercent: number;
  etransferEmail: string | null;
}

export interface LineItem {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
}

export interface InvoiceTotals {
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}

export interface Customer {
  name: string;
  email: string;
  phone: string | null;
}

export interface InvoiceData {
  invoiceId: string;
  issueDate: string;
  dueDate: string;
  status: string;
  customer: Customer;
  lineItems: LineItem[];
  totals: InvoiceTotals;
  notes: string | null;
  paidVia?: "card" | "etransfer" | "cash" | "manual" | "stripe" | null;
  paidAt?: string | null;
  surchargeAmountCents?: number | null;
  payUrl?: string | null;
}

export interface QuoteData {
  quoteId: string;
  issueDate: string;
  validUntil: string;
  status: string;
  customer: Customer;
  lineItems: LineItem[];
  totals: InvoiceTotals;
  notes: string | null;
}

export interface RenderInvoiceRequest {
  snapshot: TenantSnapshot;
  data: InvoiceData;
}

export interface RenderQuoteRequest {
  snapshot: TenantSnapshot;
  data: QuoteData;
}
