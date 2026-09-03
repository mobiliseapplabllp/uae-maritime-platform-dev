/* Notices & Circulars API contract — the legal-instrument register served by the legislation service. */
import type { InstrumentStatus } from '@maritime/contracts';

export type { InstrumentStatus };
export type LegalInstrumentType = 'ACT' | 'RULES' | 'CIRCULAR' | 'NOTICE' | 'ORDER' | 'CONVENTION';
export interface Acknowledgement { userId: string; name: string; at: string }
/** GET /legislation/instruments — one instrument, with who drafted and who put it in force. */
export interface LegalInstrument {
  id: string; refNo: string; title: string; titleAr?: string | null; type: LegalInstrumentType; category: string; status: InstrumentStatus; issuedBy: string; issuedDate: string; effectiveDate?: string | null;
  summary: string; body?: string; tags?: string[]; supersedes?: string; ackRequired: boolean; acknowledgedBy: Acknowledgement[];
  draftedById?: string | null; draftedBy?: string; approvedById?: string | null; approvedBy?: string; approvedAt?: string | null; sourceNote?: string;
}
/** GET /notices/pending — in-force instruments still awaiting the signed-in user's acknowledgment. */
export interface PendingNotice { id: string; refNo: string; title: string; issuedDate?: string; type?: LegalInstrumentType }
