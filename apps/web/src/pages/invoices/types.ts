/* Billing API contract — the shapes the revenue service returns for the invoice screens. Money is in the jurisdiction's currency; tax heads are jurisdiction-neutral. */
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAID' | 'CANCELLED';
export interface InvoiceLine { code: string; description: string; unit: string; qty: number; rate: number; amount: number }
export interface BillTo { companyId?: string | null; name: string; address?: string; taxId?: string; taxIdLabel?: string }
/** GET /invoices — one register row. */
export interface InvoiceRow {
  id: string; number: string; portCallId?: string | null; vcn?: string; vesselId?: string | null; vesselName?: string; billTo: BillTo;
  subtotal: number; taxName?: string; taxRatePct: number; taxAmount: number; total: number; currency?: string; status: InvoiceStatus;
  issuedAt?: string | null; dueAt?: string | null; paidAt?: string | null; paymentRef?: string; paidAmount?: number; balance?: number; notes?: string; createdAt?: string;
}
/** GET /invoices/:id — the row with its lines and, where the service joins them, the vessel and call particulars. */
export interface Invoice extends InvoiceRow {
  paymentIntent?: PaymentIntent | null;
  lines: InvoiceLine[];
  vessel?: { id: string; name: string; imo?: string; flag?: string; grt?: number } | null;
  portCall?: { id: string; vcn: string; eta?: string | null; atd?: string | null; agentName?: string } | null;
}
/** POST /invoices/:id/pay */
export interface PayPayload { paymentRef: string }
export interface PaymentIntent { reference: string; status: string; redirectUrl?: string | null; amountMinor: number; currency: string; mode: string; settledAt?: string | null; method?: string | null; updatedAt?: string }
/** The billing organisation, from the org settings section where the role can read it. */
export interface OrgSettings { portName?: string; operator?: string; address?: string; taxId?: string; taxIdLabel?: string; unlocode?: string }
