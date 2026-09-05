import { createHash } from 'node:crypto';
import { getJurisdiction } from '@maritime/contracts';
import type { LookupOption } from '@maritime/service-kit';
import type { Env } from './env';
import { dateOnly, expired, iso, type InstrumentRow, type LinkApi } from './instruments';

/* The public portal: what a citation needs, and nothing the register keeps for itself.
 *
 * An instrument in force is citable by its reference number at an address that never changes and never
 * disappears. The address is the reference normalised for a URL; the content hash names the exact text
 * that was cited, so a citation made today still says what it cited after an amendment. A circular that is
 * later superseded or withdrawn still answers at its address — saying so, and pointing at its successor —
 * because a citation that turns into a 404 is worse than one that turns into a notice.
 *
 * What never leaves through this file: the acknowledgement roll, who drafted, reviewed, cleared or approved
 * an instrument, the notes they wrote, the source note, and any attachment that is only a document id in the
 * repository rather than a published address. Drafts do not exist here at all, and neither does any type the
 * legalInstrumentType master marks as not citable. */

export const slugOf = (refNo: string) => refNo.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** Which fields a citation binds to: the text and the dates. A change to any of them is a new version of the citation's object. */
export function contentHash(i: InstrumentRow): string {
  const attachments = (i.attachments ?? []).filter((a) => a.url).map((a) => `${a.name}|${a.url}`);
  const payload = JSON.stringify([i.ref_no, i.title, i.title_ar ?? '', i.type, i.category, i.status, dateOnly(i.issued_date), dateOnly(i.effective_date), dateOnly(i.expiry_date), i.summary, i.body, i.supersedes, i.superseded_by, attachments]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}
export const portalPath = (env: Env, slug: string) => `${env.PUBLIC_PORTAL_PATH.replace(/\/$/, '')}/${slug}`;
export const portalUrl = (env: Env, i: Pick<InstrumentRow, 'ref_no' | 'public_slug'>) => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${portalPath(env, i.public_slug || slugOf(i.ref_no))}`;
/** The types the portal shows: the master's citable ones. */
export const citableTypes = (types: LookupOption[]) => new Set(types.filter((t) => t.active && (t.meta.citable === true || t.meta.citable === 'true')).map((t) => t.code));
export const isCitable = (i: Pick<InstrumentRow, 'status' | 'public' | 'type'>, types: Set<string>) => i.status !== 'DRAFT' && i.public !== false && types.has(i.type);

const fmt = (d: Date | string | null | undefined, lang: string) => (d ? new Date(d).toLocaleDateString(lang === 'ar' ? 'ar-AE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

/** The standing an instrument has on the day it is read, in the words the portal uses. */
export function standingOf(i: InstrumentRow, now = new Date()): { code: 'IN_FORCE' | 'EXPIRED' | 'SUPERSEDED' | 'WITHDRAWN' | 'NOT_YET_IN_FORCE'; since: string | null; until: string | null; successor: string } {
  if (i.status === 'SUPERSEDED') return { code: 'SUPERSEDED', since: dateOnly(i.effective_date ?? i.issued_date), until: dateOnly(i.updated_at), successor: i.superseded_by };
  if (i.status === 'WITHDRAWN') return { code: 'WITHDRAWN', since: dateOnly(i.effective_date ?? i.issued_date), until: dateOnly(i.withdrawn_at), successor: '' };
  if (i.effective_date && new Date(i.effective_date).getTime() > now.getTime()) return { code: 'NOT_YET_IN_FORCE', since: dateOnly(i.effective_date), until: dateOnly(i.expiry_date), successor: '' };
  if (expired(i, now)) return { code: 'EXPIRED', since: dateOnly(i.effective_date ?? i.issued_date), until: dateOnly(i.expiry_date), successor: '' };
  return { code: 'IN_FORCE', since: dateOnly(i.effective_date ?? i.issued_date), until: dateOnly(i.expiry_date), successor: '' };
}

export interface CitationCtx { typeLabel: string; typeLabelAr: string | null; lang?: string; now?: Date }
/** How to cite the instrument, in one line, in the language asked for, with the address and the content version. */
export function citationOf(env: Env, i: InstrumentRow, ctx: CitationCtx) {
  const lang = ctx.lang === 'ar' ? 'ar' : 'en';
  const j = getJurisdiction(env.JURISDICTION);
  const standing = standingOf(i, ctx.now);
  const url = portalUrl(env, i);
  const hash = i.content_hash || contentHash(i);
  const title = lang === 'ar' && i.title_ar ? i.title_ar : i.title;
  const type = lang === 'ar' && ctx.typeLabelAr ? ctx.typeLabelAr : ctx.typeLabel;
  const when = standing.code === 'IN_FORCE' ? (lang === 'ar' ? `ساري من ${fmt(standing.since, lang)}` : `in force from ${fmt(standing.since, lang)}`)
    : standing.code === 'SUPERSEDED' ? (lang === 'ar' ? `حلّ محله ${standing.successor}` : `superseded by ${standing.successor}`)
      : standing.code === 'WITHDRAWN' ? (lang === 'ar' ? `سُحب في ${fmt(standing.until, lang)}` : `withdrawn on ${fmt(standing.until, lang)}`)
        : standing.code === 'EXPIRED' ? (lang === 'ar' ? `انتهى في ${fmt(standing.until, lang)}` : `expired on ${fmt(standing.until, lang)}`)
          : (lang === 'ar' ? `يسري من ${fmt(standing.since, lang)}` : `in force from ${fmt(standing.since, lang)}`);
  const authority = i.issued_by || j.authority.split(' (')[0];
  const plain = lang === 'ar'
    ? `${authority}، ${type} ${i.ref_no}، «${title}» (${when}). ${url} [النسخة ${hash}]`
    : `${authority}, ${type} ${i.ref_no}, "${title}" (${when}). ${url} [version ${hash}]`;
  return { plain, short: `${i.ref_no} — ${title}`, refNo: i.ref_no, url, hash, standing: standing.code, asOf: (ctx.now ?? new Date()).toISOString(), lang };
}

/** The public shape of an instrument. Nothing here names a person inside the administration. */
export function publicApi(env: Env, i: InstrumentRow, opts: { links?: LinkApi[]; typeLabel: string; typeLabelAr: string | null; withBody?: boolean; now?: Date }) {
  const standing = standingOf(i, opts.now);
  const links = (opts.links ?? []).map((l) => ({ kind: l.kind, direction: l.direction, refNo: l.refNo, url: l.refNo ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${portalPath(env, slugOf(l.refNo))}` : null }));
  return {
    refNo: i.ref_no, slug: i.public_slug || slugOf(i.ref_no), url: portalUrl(env, i), title: i.title, titleAr: i.title_ar,
    type: i.type, typeLabel: opts.typeLabel, typeLabelAr: opts.typeLabelAr, subject: i.category, status: i.status, standing: standing.code, inForce: standing.code === 'IN_FORCE',
    issuedBy: i.issued_by, issuedDate: dateOnly(i.issued_date), effectiveDate: dateOnly(i.effective_date), expiryDate: dateOnly(i.expiry_date), publishedAt: iso(i.published_at ?? i.approved_at ?? i.issued_date),
    summary: i.summary, ...(opts.withBody === false ? {} : { body: i.body }), tags: i.tags ?? [],
    attachments: (i.attachments ?? []).filter((a) => a.url).map((a) => ({ name: a.name, kind: a.kind, url: a.url, sizeBytes: a.sizeBytes ?? null })),
    supersedes: i.supersedes, supersededBy: i.superseded_by, withdrawnAt: dateOnly(i.withdrawn_at), links,
    contentHash: i.content_hash || contentHash(i), lastModified: iso(i.updated_at),
  };
}
export type PublicInstrument = ReturnType<typeof publicApi>;
