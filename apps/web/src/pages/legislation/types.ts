/* Notices & Circulars API contract — the legal-instrument register served by the legislation service,
 * the public citable portal it publishes, and the IMO source watch it keeps. */
import type { InstrumentStatus } from '@maritime/contracts';

export type { InstrumentStatus };
/** A code of the `legalInstrumentType` master — the master, not a constant, says which types exist and which are citable. */
export type LegalInstrumentType = string;
export interface Acknowledgement { userId: string; name: string; at: string }
export interface InstrumentLink { id?: string; kind: string; direction?: 'OUT' | 'IN'; refNo: string; instrumentId?: string | null; title?: string; url?: string | null }
export interface InstrumentAttachment { name: string; kind?: string; url?: string | null; sizeBytes?: number | null }
/** What the desk sees of the public portal for one instrument: null while a draft, `citable:false` when the master keeps the type off the portal. */
export interface PortalInfo { citable: boolean; url: string | null; citation: string | null; citationAr: string | null }
/** GET /legislation/instruments — one instrument, with who drafted and who put it in force. */
export interface LegalInstrument {
  id: string; refNo: string; title: string; titleAr?: string | null; type: LegalInstrumentType; category: string; status: InstrumentStatus; issuedBy: string; issuedDate: string; effectiveDate?: string | null; expiryDate?: string | null;
  summary: string; body?: string; tags?: string[]; attachments?: InstrumentAttachment[]; supersedes?: string; supersededBy?: string; ackRequired: boolean; acknowledgedBy: Acknowledgement[];
  draftedById?: string | null; draftedBy?: string; approvedById?: string | null; approvedBy?: string; approvedAt?: string | null; sourceNote?: string;
  withdrawnAt?: string | null; withdrawalReason?: string; links?: InstrumentLink[];
  public?: boolean; publishedAt?: string | null; contentHash?: string; slug?: string; inForce?: boolean; expired?: boolean;
  portal?: PortalInfo | null;
}
/** GET /notices/pending — in-force instruments still awaiting the signed-in user's acknowledgment. */
export interface PendingNotice { id: string; refNo: string; title: string; issuedDate?: string; type?: LegalInstrumentType }

/** The standing of a published instrument as the portal states it, from its dates and status rather than from the desk's status alone. */
export type Standing = 'IN_FORCE' | 'NOT_YET_IN_FORCE' | 'EXPIRED' | 'SUPERSEDED' | 'WITHDRAWN';
/** GET /public/legislation and /public/legislation/:ref — the law as published; no governance, no acknowledgments, no internal notes. */
export interface PublicInstrument {
  refNo: string; slug: string; url: string; title: string; titleAr?: string | null; type: string; typeLabel: string; typeLabelAr?: string | null; subject: string;
  status: InstrumentStatus; standing: Standing; inForce: boolean; issuedBy: string; issuedDate: string | null; effectiveDate: string | null; expiryDate: string | null; publishedAt: string | null;
  summary: string; body?: string; tags: string[]; attachments: InstrumentAttachment[]; supersedes: string; supersededBy: string; withdrawnAt: string | null;
  links: { kind: string; direction: string; refNo: string; url: string | null }[]; contentHash: string; lastModified: string | null;
  citation?: { en: string; ar: string };
}
export interface PortalFacets { types: { code: string; label: string; labelAr?: string | null; count: number }[]; subjects: { subject: string; count: number }[]; years: { year: number; count: number }[] }
export interface PortalList { success: true; data: PublicInstrument[]; meta: { total: number; page: number; limit: number }; facets: PortalFacets; portal: { baseUrl: string; path: string; feed: string } }
export interface PortalType { code: string; label: string; labelAr?: string | null; refPrefix: string }
export interface Citation { plain: string; short: string; refNo: string; url: string; hash: string; standing: Standing; asOf: string; lang: string }

/** GET /legislation/imo/sources — one IMO body the watch reads, with the state of its last reading. */
export interface ImoSource {
  source: string; label: string; labelAr?: string | null; body: string; series: string; url: string; pollHours: number;
  lastPolledAt: string | null; lastStatus: 'OK' | 'FAILED' | 'NEVER' | string; lastError: string; lastItems: number; newItems: number; nextDueAt: string | null; polls: number; mode: string;
  items?: number; new?: number;
}
export type ImoItemStatus = 'NEW' | 'ASSESSED' | 'TRANSPOSED' | 'DISMISSED';
/** GET /legislation/imo/items — one document a source published, and where the desk's assessment of it stands. */
export interface ImoItem {
  id: string; source: string; sourceLabel: string; sourceLabelAr?: string | null; body: string; series: string; reference: string; title: string; subject: string;
  publishedOn: string | null; entryIntoForce: string | null; url: string; status: ImoItemStatus; assessment: string; assessedBy: string; assessedAt: string | null; dueOn: string | null;
  instrumentId: string | null; instrumentRef: string; firstSeenAt: string; lastSeenAt: string; seenCount: number; overdue: boolean; createdAt: string; updatedAt: string;
}
export interface ImoDashboard {
  kpis: { sources: number; polledOk: number; failed: number; neverPolled: number; items: number; new: number; assessed: number; transposed: number; dismissed: number; overdue: number; last30Days: number; withInstrument: number };
  bySource: ImoSource[]; attention: ImoItem[]; generatedAt: string;
}
export interface PollOutcome { source: string; status: 'OK' | 'FAILED' | 'SKIPPED'; items: number; newItems: number; error: string; mode: string }
