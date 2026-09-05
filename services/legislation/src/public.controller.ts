import { Controller, Get, Headers, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, Public, escapeLike, lookupOptions, notFound, paged, parsePage, type LookupOption } from '@maritime/service-kit';
import type { Env } from './env';
import { citableTypes, citationOf, isCitable, publicApi, slugOf } from './portal';
import { type InstrumentRow } from './instruments';
import { linksOf } from './read';

/* The public citable portal. No session, no permission: these answers are the law as published.
 *
 * Every answer here is cacheable and carries an ETag made of the content hash, so a client that cites an
 * instrument can revalidate it for free and a proxy can serve it without asking again. The list never
 * carries the body; the instrument does. */
type ListQuery = { page?: string; limit?: string; q?: string; type?: string; subject?: string; year?: string; history?: string; lang?: string; sort?: string };
const PUBLIC_SORT: Record<string, string> = { issuedDate: 'issued_date', refNo: 'ref_no', title: 'title', effectiveDate: 'effective_date', publishedAt: 'published_at' };

@Controller('public/legislation')
export class PublicPortalController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}

  private async types(): Promise<{ all: LookupOption[]; citable: Set<string> }> {
    const all = await lookupOptions(this.pool, 'legalInstrumentType', { activeOnly: false });
    return { all, citable: citableTypes(all) };
  }
  private label(all: LookupOption[], code: string) { const t = all.find((x) => x.code === code); return { typeLabel: t?.label ?? code, typeLabelAr: t?.labelAr ?? null }; }
  private cache(res: Response, etag?: string) {
    res.setHeader('Cache-Control', `public, max-age=${this.env.PORTAL_CACHE_SECONDS}`);
    res.setHeader('X-Robots-Tag', 'all');
    if (etag) res.setHeader('ETag', `"${etag}"`);
  }

  /** The published register: in force by default, the history on request. Never a draft, never a type the master keeps off the portal. */
  @Public() @Get()
  async list(@Query() query: ListQuery, @Res({ passthrough: true }) res: Response) {
    const { all, citable } = await this.types();
    const p = parsePage(query, { defaultSort: '-issuedDate', sortable: Object.keys(PUBLIC_SORT), maxLimit: 100 });
    const where: string[] = ['public', `status <> 'DRAFT'`]; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    add((i) => `type = ANY($${i}::text[])`, [...citable]);
    if (String(query.history) !== 'true') where.push(`status = 'IN_FORCE'`);
    if (query.type) add((i) => `type = $${i}`, query.type);
    if (query.subject) add((i) => `lower(category) = lower($${i})`, query.subject);
    if (query.year) add((i) => `date_part('year', issued_date) = $${i}`, Number(query.year));
    if (p.q) add((i) => `(ref_no ILIKE $${i} OR title ILIKE $${i} OR coalesce(title_ar,'') ILIKE $${i} OR summary ILIKE $${i} OR category ILIKE $${i} OR tags::text ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    const w = `WHERE ${where.join(' AND ')}`;
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM legal_instruments ${w}`, args);
    const rows = await this.pool.query<InstrumentRow>(`SELECT * FROM legal_instruments ${w} ORDER BY ${PUBLIC_SORT[p.sortField]} ${p.sortDir} NULLS LAST, ref_no LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const { types, subjects, years } = await this.facets(citable, String(query.history) === 'true');
    this.cache(res);
    const out = paged(rows.rows.map((r) => publicApi(this.env, r, { ...this.label(all, r.type), withBody: false })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
    // a plain object with `success` passes the envelope untouched, so the facets ride beside the page
    return {
      success: true, data: out.data, meta: out.meta,
      facets: {
        types: types.rows.map((t) => { const l = this.label(all, t.type); return { code: t.type, label: l.typeLabel, labelAr: l.typeLabelAr, count: Number(t.n) }; }).sort((a, b) => b.count - a.count),
        subjects: subjects.rows.map((s) => ({ subject: s.category, count: Number(s.n) })),
        years: years.rows.map((y) => ({ year: Number(y.year), count: Number(y.n) })),
      },
      portal: { baseUrl: this.env.PUBLIC_BASE_URL, path: this.env.PUBLIC_PORTAL_PATH, feed: `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/public/legislation/feed` },
    };
  }

  /** The facets describe the published register, not the page. */
  private async facets(citable: Set<string>, history: boolean) {
    const where = ['public', `status <> 'DRAFT'`, 'type = ANY($1::text[])'];
    if (!history) where.push(`status = 'IN_FORCE'`);
    const w = `WHERE ${where.join(' AND ')}`;
    const args = [[...citable]];
    const [types, subjects, years] = await Promise.all([
      this.pool.query<{ type: string; n: string }>(`SELECT type, count(*) AS n FROM legal_instruments ${w} GROUP BY type`, args),
      this.pool.query<{ category: string; n: string }>(`SELECT category, count(*) AS n FROM legal_instruments ${w} GROUP BY category ORDER BY count(*) DESC, category`, args),
      this.pool.query<{ year: string; n: string }>(`SELECT date_part('year', issued_date)::int::text AS year, count(*) AS n FROM legal_instruments ${w} GROUP BY 1 ORDER BY 1 DESC`, args),
    ]);
    return { types, subjects, years };
  }

  /** The types the portal shows, as the master labels them. */
  @Public() @Get('types')
  async listTypes(@Res({ passthrough: true }) res: Response) {
    const { all, citable } = await this.types();
    this.cache(res);
    return all.filter((t) => citable.has(t.code)).map((t) => ({ code: t.code, label: t.label, labelAr: t.labelAr, refPrefix: t.meta.refPrefix ?? '' }));
  }

  /** What changed lately — published, superseded, withdrawn — as a JSON Feed, so a subscriber can watch the register without scraping it. */
  @Public() @Get('feed')
  async feed(@Query('days') days: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { all, citable } = await this.types();
    const back = Math.min(365, Math.max(1, Number(days) || this.env.PORTAL_FEED_DAYS));
    const rows = await this.pool.query<InstrumentRow>(
      `SELECT * FROM legal_instruments WHERE public AND status <> 'DRAFT' AND type = ANY($1::text[]) AND GREATEST(coalesce(published_at, issued_date), coalesce(withdrawn_at, published_at, issued_date), updated_at) >= now() - ($2 || ' days')::interval
        ORDER BY GREATEST(coalesce(published_at, issued_date), coalesce(withdrawn_at, published_at, issued_date), updated_at) DESC LIMIT 200`, [[...citable], String(back)]);
    const base = this.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    this.cache(res);
    return {
      version: 'https://jsonfeed.org/version/1.1', title: 'Legal instruments — changes', home_page_url: `${base}${this.env.PUBLIC_PORTAL_PATH}`, feed_url: `${base}/api/public/legislation/feed`, language: 'en',
      items: rows.rows.map((r) => {
        const pub = publicApi(this.env, r, { ...this.label(all, r.type), withBody: false });
        const change = r.status === 'WITHDRAWN' ? 'withdrawn' : r.status === 'SUPERSEDED' ? 'superseded' : 'published';
        return { id: pub.url, url: pub.url, title: `${r.ref_no} — ${r.title}`, content_text: r.summary, summary: `${change}: ${r.title}`, date_published: pub.publishedAt, date_modified: pub.lastModified, tags: [r.type, r.category, ...(r.tags ?? [])], _maritime: { refNo: r.ref_no, type: r.type, status: r.status, change, supersededBy: r.superseded_by || null, contentHash: pub.contentHash } };
      }),
    };
  }

  /** Every citable address, for a crawler or a mirror. */
  @Public() @Get('sitemap')
  async sitemap(@Res({ passthrough: true }) res: Response) {
    const { citable } = await this.types();
    const rows = await this.pool.query<{ ref_no: string; public_slug: string | null; updated_at: Date }>(`SELECT ref_no, public_slug, updated_at FROM legal_instruments WHERE public AND status <> 'DRAFT' AND type = ANY($1::text[]) ORDER BY ref_no`, [[...citable]]);
    this.cache(res);
    const base = this.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    return { urls: rows.rows.map((r) => ({ refNo: r.ref_no, url: `${base}${this.env.PUBLIC_PORTAL_PATH.replace(/\/$/, '')}/${r.public_slug || slugOf(r.ref_no)}`, lastModified: r.updated_at.toISOString() })) };
  }

  /** One instrument, by reference number or by its slug. A superseded or withdrawn one still answers, and says so. */
  @Public() @Get(':ref')
  async get(@Param('ref') ref: string, @Headers('if-none-match') ifNoneMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { all, citable, row } = await this.find(ref);
    const links = (await linksOf(this.pool, row.id)).filter((l) => l.refNo);
    const etag = row.content_hash;
    this.cache(res, etag);
    if (ifNoneMatch && etag && ifNoneMatch.replace(/W\//, '').replace(/"/g, '') === etag) { res.status(304); return; }
    return { ...publicApi(this.env, row, { links, ...this.label(all, row.type) }), citation: { en: citationOf(this.env, row, { ...this.label(all, row.type), lang: 'en' }).plain, ar: citationOf(this.env, row, { ...this.label(all, row.type), lang: 'ar' }).plain }, citableTypes: [...citable].length };
  }

  @Public() @Get(':ref/citation')
  async citation(@Param('ref') ref: string, @Query('lang') lang: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { all, row } = await this.find(ref);
    this.cache(res, row.content_hash);
    return citationOf(this.env, row, { ...this.label(all, row.type), lang });
  }

  private async find(ref: string) {
    const { all, citable } = await this.types();
    const r = await this.pool.query<InstrumentRow>('SELECT * FROM legal_instruments WHERE upper(ref_no) = upper($1) OR public_slug = $2', [ref, slugOf(ref)]);
    const row = r.rows[0];
    if (!row || !isCitable(row, citable)) throw notFound('No published instrument answers to that reference');
    return { all, citable, row };
  }
}
