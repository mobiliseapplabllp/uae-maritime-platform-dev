import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, getJurisdiction, type PageQuery } from '@maritime/contracts';
import { scopeWhere, scopeOfRecord, isNational, AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, forbidden, notFound, paged, parsePage, unprocessable, withTx, zod, type Principal } from '@maritime/service-kit';
import { SEAFARER_SCOPE, scopedWhere } from './scope';
import type { Env } from './env';
import { backfillVocabulary, certRules, certVocab, rankVocab } from './vocab';
import {
  SEAFARER_STATUS, certApi, certsOf, crewDashboard, documentGate, findSeafarer, iso, publishSeafarer, publishSeafarerDeleted,
  seaDays, seafarerApi, seafarerCard, serviceApi, serviceOf, type CertRow, type Row, type SeafarerRow, type ServiceRow,
} from './crew';

/* The crew desk: the register, the record with its documents and service book, the crew dashboard, and the
 * two moves that matter operationally — signing a seafarer on to a ship and signing them off again. */

/* The web's form fields send an empty string for a field the user cleared, so a blank date is read as
 * "no value" rather than refused or handed to the database as ''. */
const blank = (v: unknown) => (v === '' || v === null ? null : v);
const text = (max: number) => z.string().trim().max(max);
const date = z.preprocess(blank, z.string().min(1).nullable().optional());
const seafarerBody = z.object({
  name: text(160).min(1), cdcNo: text(60).min(1), seafarerId: text(60).default(''), nationalId: text(60).default(''),
  dob: date, nationality: text(120).default(''), rank: text(80).min(1),
  phone: text(60).default(''), email: text(200).default(''), status: z.enum(SEAFARER_STATUS).default('ACTIVE'), remarks: text(2000).default(''),
  manningAgentCode: text(20).default(''), manningAgentName: text(200).default(''),
});
const seafarerPatch = seafarerBody.partial();
const certBody = z.object({
  certType: text(160).min(1), grade: text(80).default(''), number: text(80).default(''), issuer: text(200).default(''),
  issueDate: date, expiryDate: z.string().trim().min(1), remarks: text(1000).default(''),
});
const certPatch = certBody.partial();
const endorseBody = z.object({ number: text(80).min(1), issuer: text(200).default(''), issuedOn: date, expiryDate: z.string().trim().min(1), remarks: text(500).default('') });
const serviceBody = z.object({
  vesselId: text(80).nullable().optional(), vesselName: text(160).min(1), imo: text(20).default(''), rank: text(80).min(1),
  from: z.string().min(1), to: z.string().min(1), verified: z.boolean().default(false), remarks: text(1000).default(''),
});
const signOnBody = z.object({ vesselId: text(80).min(1), rank: text(80).optional(), override: z.boolean().optional(), overrideReason: text(500).optional() });
const signOffBody = z.object({ remarks: text(1000).optional() }).partial();

const SORT: Record<string, string> = { name: 'name', rank: 'rank', cdcNo: 'cdc_no', seafarerId: 'seafarer_id', nationality: 'nationality', status: 'status', currentVesselName: 'current_vessel_name', signedOnAt: 'signed_on_at', createdAt: 'created_at', updatedAt: 'updated_at' };
const COLS: Record<string, string> = { name: 'name', cdcNo: 'cdc_no', seafarerId: 'seafarer_id', nationalId: 'national_id', dob: 'dob', nationality: 'nationality', rank: 'rank', rankCode: 'rank_code', phone: 'phone', email: 'email', status: 'status', remarks: 'remarks', manningAgentCode: 'manning_agent_code', manningAgentName: 'manning_agent_name' };
type ListQuery = PageQuery & { rank?: string; status?: string; nationality?: string; currentVesselId?: string; vesselId?: string; certAlerts?: string; onboard?: string; manningAgentCode?: string };

@Controller('seafarers')
export class SeafarersController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private now() { return new Date(); }
  private async certsFor(ids: string[], now = new Date()) {
    const out = new Map<string, ReturnType<typeof certApi>[]>();
    if (!ids.length) return out;
    const rules = certRules(await certVocab(this.pool));
    const r = await this.pool.query<CertRow>('SELECT * FROM seafarer_certificates WHERE seafarer_id = ANY($1) ORDER BY expiry_date', [ids]);
    for (const c of r.rows) { const l = out.get(c.seafarer_id) ?? []; l.push(certApi(c, now, this.env.CERT_EXPIRING_DAYS, rules)); out.set(c.seafarer_id, l); }
    return out;
  }
  /* A rank or a document type may arrive as the master's code or its label; the row keeps both. */
  private async rankOf(c: Pool | Parameters<typeof rankVocab>[0], value: unknown, what = 'rank') { const v = await rankVocab(c); return v.resolve(value, what); }
  private async serviceFor(ids: string[]) {
    const out = new Map<string, ReturnType<typeof serviceApi>[]>();
    if (!ids.length) return out;
    const r = await this.pool.query<ServiceRow>('SELECT * FROM sea_service WHERE seafarer_id = ANY($1) ORDER BY from_at DESC', [ids]);
    for (const s of r.rows) { const l = out.get(s.seafarer_id) ?? []; l.push(serviceApi(s)); out.set(s.seafarer_id, l); }
    return out;
  }

  /** The register: filterable, searchable, paged, with the document summary and the sea-day total computed. */
  @RequirePerm('seafarers.view') @Get()
  async list(@Query() query: ListQuery, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    if (query.rank) { args.push(query.rank); where.push(`(rank = $${args.length} OR rank_code = $${args.length})`); }
    eq('status', query.status); eq('nationality', query.nationality); eq('current_vessel_id', query.currentVesselId ?? query.vesselId);
    eq('manning_agent_code', query.manningAgentCode);
    if (String(query.onboard) === 'true') where.push('current_vessel_id IS NOT NULL');
    if (String(query.onboard) === 'false') where.push('current_vessel_id IS NULL');
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(name ILIKE $${args.length} OR cdc_no ILIKE $${args.length} OR seafarer_id ILIKE $${args.length} OR national_id ILIKE $${args.length} OR current_vessel_name ILIKE $${args.length})`); }
    scopeWhere(user.scope, where, args, SEAFARER_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM seafarers ${w}`, args);
    const rows = await this.pool.query<SeafarerRow>(`SELECT * FROM seafarers ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, name LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const now = this.now();
    const ids = rows.rows.map((s) => s.id);
    const [certs, service] = await Promise.all([this.certsFor(ids, now), this.serviceFor(ids)]);
    let out = rows.rows.map((s) => seafarerApi(s, { certificates: certs.get(s.id) ?? [], seaService: service.get(s.id) ?? [] }));
    // "has a document to review" is derived from the expiry states, so it filters after the page is assembled
    if (String(query.certAlerts) === 'true') { out = out.filter((s) => s.certAlerts > 0); return paged(out, { total: out.length, page: p.page, limit: p.limit }); }
    return paged(out, { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The vocabularies the crew screens draw their dropdowns from — the masters as this service mirrors them. Declared before `:id`. */
  @RequirePerm('seafarers.view') @Get('reference')
  async reference() {
    const [ranks, certTypes] = await Promise.all([rankVocab(this.pool), certVocab(this.pool)]);
    return {
      ranks: ranks.options.map((o) => ({ code: o.code, label: o.label, labelAr: o.labelAr, department: o.meta.department ?? '', officer: o.meta.officer === true, cocGrade: o.meta.cocGrade ?? '' })),
      certTypes: certRules(certTypes),
      statuses: SEAFARER_STATUS,
      signOn: { marginDays: this.env.SIGN_ON_MARGIN_DAYS, cocVerified: this.env.COC_VERIFY_ON_SIGN_ON, medicalWindowDays: this.env.MEDICAL_EXPIRING_DAYS, expiringDays: this.env.CERT_EXPIRING_DAYS },
      mandatory: certRules(certTypes).filter((r) => r.mandatory).map((r) => r.code),
    };
  }

  /** Re-derives the codes on rows written under labels only — what the consumer does on a lookup event, offered to an operator too. */
  @RequirePerm('seafarers.edit') @Post('reference/backfill')
  async backfill() { return withTx(this.pool, (c) => backfillVocabulary(c)); }

  /** The crew module's landing analytics. Declared before `:id` so the word is not read as an id. */
  @RequirePerm('seafarers.view', 'dashboard.view') @Get('dashboard')
  async dashboard(@CurrentUser() user: Principal) {
    const now = this.now();
    const sc = scopedWhere(user.scope, SEAFARER_SCOPE);
    const rows = (await this.pool.query<SeafarerRow>(`SELECT * FROM seafarers ${sc.sql}`, sc.args)).rows;
    const ids = rows.map((s) => s.id);
    const [certs, service] = await Promise.all([this.certsFor(ids, now), this.serviceFor(ids)]);
    return crewDashboard(rows.map((s) => ({
      id: s.id, name: s.name, rank: s.rank, status: s.status, currentVesselName: s.current_vessel_name,
      certExpiries: (certs.get(s.id) ?? []).map((c) => ({ certType: c.certType, expiryDate: c.expiryDate, kind: c.kind })),
      days: (service.get(s.id) ?? []).reduce((t, x) => t + x.days, 0),
    })), this.env, now);
  }

  @RequirePerm('seafarers.view') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const s = await findSeafarer(this.pool, id, user.scope);
    if (!s) throw notFound('Seafarer not found');
    const now = this.now();
    return seafarerApi(s, { certificates: await certsOf(this.pool, s.id, now, this.env.CERT_EXPIRING_DAYS), seaService: await serviceOf(this.pool, s.id) });
  }

  /** What the hover card shows: rank, where they are, and whether their papers are current. */
  @RequirePerm('seafarers.view') @Get(':id/card')
  async card(@Param('id') id: string, @CurrentUser() user: Principal) {
    const s = await findSeafarer(this.pool, id, user.scope);
    if (!s) throw notFound('Seafarer not found');
    const service = await serviceOf(this.pool, s.id);
    return seafarerCard(s, await certsOf(this.pool, s.id, this.now(), this.env.CERT_EXPIRING_DAYS), service.reduce((t, x) => t + x.days, 0));
  }

  @RequirePerm('seafarers.create') @Post()
  async create(@Body(zod(seafarerBody)) body: z.infer<typeof seafarerBody>, @CurrentUser() user: Principal) {
    const j = getJurisdiction(this.env.JURISDICTION);
    // An agency places seafarers under its own licence and nobody else's, so the agent on a record it
    // creates is its own — stamped from the author's scope, not taken from the request.
    const own = scopeOfRecord(user.scope).company;
    if (own) body.manningAgentCode = own;
    else if (body.manningAgentCode && !isNational(user.scope)) throw forbidden('Only the administration may place a seafarer with another agency');
    return withTx(this.pool, async (c) => {
      const dupe = await c.query('SELECT id FROM seafarers WHERE cdc_no = $1', [body.cdcNo]);
      if (dupe.rowCount) throw conflict(`CDC ${body.cdcNo} is already on the register`);
      const rank = await this.rankOf(c, body.rank);
      const values: Row = { ...body, rank: rank.label, rankCode: rank.code };
      const keys = Object.keys(COLS).filter((k) => values[k] !== undefined);
      const r = await c.query<SeafarerRow>(
        `INSERT INTO seafarers(${keys.map((k) => COLS[k]).concat('seafarer_id_label', 'national_id_label').join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, $${keys.length + 2}) RETURNING *`,
        [...keys.map((k) => values[k] === '' && k === 'dob' ? null : values[k]), j.identity.seafarerIdLabel, body.nationality && body.nationality !== j.name ? 'Passport' : j.identity.nationalIdLabel]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'Seafarer', entityId: row.id, entityLabel: row.name, after: seafarerApi(row) });
      return publishSeafarer(c, this.env, row, { event: EVENTS.seafarers.created });
    });
  }

  @RequirePerm('seafarers.edit') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(seafarerPatch)) body: z.infer<typeof seafarerPatch>) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<SeafarerRow>('SELECT * FROM seafarers WHERE id::text = $1 FOR UPDATE', [id]);
      const before = found.rows[0];
      if (!before) throw notFound('Seafarer not found');
      if (body.cdcNo && body.cdcNo !== before.cdc_no) {
        const dupe = await c.query('SELECT id FROM seafarers WHERE cdc_no = $1 AND id <> $2', [body.cdcNo, before.id]);
        if (dupe.rowCount) throw conflict(`CDC ${body.cdcNo} is already on the register`);
      }
      const values: Row = { ...body };
      if (body.rank !== undefined) { const rank = await this.rankOf(c, body.rank); values.rank = rank.label; values.rankCode = rank.code; }
      const keys = Object.keys(COLS).filter((k) => values[k] !== undefined);
      const row = keys.length
        ? (await c.query<SeafarerRow>(`UPDATE seafarers SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (values[k] === '' && k === 'dob' ? null : values[k]))])).rows[0]
        : before;
      await this.audit.record(c, { action: 'UPDATE', entity: 'Seafarer', entityId: row.id, entityLabel: row.name, before: seafarerApi(before), after: seafarerApi(row) });
      return publishSeafarer(c, this.env, row, { event: EVENTS.seafarers.updated });
    });
  }

  @RequirePerm('seafarers.delete') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<SeafarerRow>('SELECT * FROM seafarers WHERE id::text = $1 FOR UPDATE', [id]);
      const s = found.rows[0];
      if (!s) throw notFound('Seafarer not found');
      if (s.current_vessel_id) throw conflict(`${s.name} is signed on ${s.current_vessel_name ?? 'a vessel'} — sign them off before removing the record`);
      await this.audit.record(c, { action: 'DELETE', entity: 'Seafarer', entityId: s.id, entityLabel: s.name, before: seafarerApi(s) });
      await c.query('DELETE FROM seafarers WHERE id = $1', [s.id]);
      await publishSeafarerDeleted(c, this.env, s);
      return { deleted: true, id: s.id };
    });
  }

  /* ------------------------------------------------------------------ certificates --- */

  @RequirePerm('seafarers.edit', 'certificates.manage') @Post(':id/certificates')
  async addCert(@Param('id') id: string, @Body(zod(certBody)) body: z.infer<typeof certBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const s = await findSeafarer(c, id, user.scope);
      if (!s) throw notFound('Seafarer not found');
      // a document the instrument register issued is refused before the words are even checked against the master: the register owns it, whatever it is called
      const held = await c.query('SELECT id FROM seafarer_certificates WHERE seafarer_id = $1 AND cert_type = $2 AND instrument_id IS NOT NULL', [s.id, body.certType]);
      if (held.rowCount) throw conflict(`${body.certType} for ${s.name} is issued on the instrument register — amend it there, not on the record`);
      const type = (await certVocab(c)).resolve(body.certType, 'certificateType');
      const clash = await c.query('SELECT id FROM seafarer_certificates WHERE seafarer_id = $1 AND (cert_type = $2 OR cert_code = $3) AND instrument_id IS NOT NULL', [s.id, type.label, type.code]);
      if (clash.rowCount) throw conflict(`${type.label} for ${s.name} is issued on the instrument register — amend it there, not on the record`);
      const r = await c.query<CertRow>('INSERT INTO seafarer_certificates(seafarer_id, cert_type, cert_code, grade, number, issuer, issue_date, expiry_date, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [s.id, type.label, type.code, body.grade ?? '', body.number ?? '', body.issuer ?? '', body.issueDate || null, body.expiryDate, body.remarks ?? '']);
      const cert = r.rows[0];
      await this.audit.record(c, { action: 'CERT_ADD', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} — ${cert.cert_type}`, after: certApi(cert, this.now(), this.env.CERT_EXPIRING_DAYS) });
      return publishSeafarer(c, this.env, s, { event: EVENTS.seafarers.certificateIssued, data: { certificateId: cert.id, certType: cert.cert_type, number: cert.number, expiryDate: iso(cert.expiry_date) } });
    });
  }

  @RequirePerm('seafarers.edit', 'certificates.manage') @Put(':id/certificates/:certId')
  async updateCert(@Param('id') id: string, @Param('certId') certId: string, @Body(zod(certPatch)) body: z.infer<typeof certPatch>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const s = await findSeafarer(c, id, user.scope);
      if (!s) throw notFound('Seafarer not found');
      const found = await c.query<CertRow>('SELECT * FROM seafarer_certificates WHERE id::text = $1 AND seafarer_id = $2 FOR UPDATE', [certId, s.id]);
      const before = found.rows[0];
      if (!before) throw notFound('Certificate not found');
      if (before.instrument_id) throw conflict(`${before.cert_type} was issued on the instrument register — it is read-only on the record`);
      const map: Record<string, string> = { certType: 'cert_type', certCode: 'cert_code', grade: 'grade', number: 'number', issuer: 'issuer', issueDate: 'issue_date', expiryDate: 'expiry_date', remarks: 'remarks' };
      const values: Row = { ...body };
      if (body.certType !== undefined) { const type = (await certVocab(c)).resolve(body.certType, 'certificateType'); values.certType = type.label; values.certCode = type.code; }
      const keys = Object.keys(map).filter((k) => values[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to update');
      const cert = (await c.query<CertRow>(`UPDATE seafarer_certificates SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => values[k])])).rows[0];
      await this.audit.record(c, { action: 'CERT_UPDATE', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} — ${cert.cert_type}`, before: certApi(before, this.now(), this.env.CERT_EXPIRING_DAYS), after: certApi(cert, this.now(), this.env.CERT_EXPIRING_DAYS) });
      return publishSeafarer(c, this.env, s, { event: EVENTS.seafarers.certificateUpdated, data: { certificateId: cert.id, certType: cert.cert_type } });
    });
  }

  @RequirePerm('seafarers.edit', 'certificates.manage') @Delete(':id/certificates/:certId')
  async removeCert(@Param('id') id: string, @Param('certId') certId: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const s = await findSeafarer(c, id, user.scope);
      if (!s) throw notFound('Seafarer not found');
      const found = await c.query<CertRow>('SELECT * FROM seafarer_certificates WHERE id::text = $1 AND seafarer_id = $2 FOR UPDATE', [certId, s.id]);
      const cert = found.rows[0];
      if (!cert) throw notFound('Certificate not found');
      if (cert.instrument_id) throw conflict(`${cert.cert_type} was issued on the instrument register — withdraw it there, not on the record`);
      await this.audit.record(c, { action: 'CERT_DELETE', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} — ${cert.cert_type}`, before: certApi(cert, this.now(), this.env.CERT_EXPIRING_DAYS) });
      await c.query('DELETE FROM seafarer_certificates WHERE id = $1', [cert.id]);
      return publishSeafarer(c, this.env, s, { event: EVENTS.seafarers.certificateDeleted, data: { certificateId: cert.id, certType: cert.cert_type } });
    });
  }

  /** This administration's endorsement of a certificate issued by another — the flag's recognition, recorded against the document. */
  @RequirePerm('seafarers.edit', 'certificates.manage') @Post(':id/certificates/:certId/endorse')
  async endorse(@Param('id') id: string, @Param('certId') certId: string, @Body(zod(endorseBody)) body: z.infer<typeof endorseBody>, @CurrentUser() user: Principal) {
    const j = getJurisdiction(this.env.JURISDICTION);
    return withTx(this.pool, async (c) => {
      const s = await findSeafarer(c, id, user.scope);
      if (!s) throw notFound('Seafarer not found');
      const found = await c.query<CertRow>('SELECT * FROM seafarer_certificates WHERE id::text = $1 AND seafarer_id = $2 FOR UPDATE', [certId, s.id]);
      const cert = found.rows[0];
      if (!cert) throw notFound('Certificate not found');
      if (new Date(body.expiryDate) > new Date(cert.expiry_date)) throw badRequest('An endorsement cannot outlast the certificate it recognises');
      const endorsement = { number: body.number, issuer: body.issuer || j.authority, issuedOn: body.issuedOn ?? new Date().toISOString(), expiryDate: body.expiryDate, remarks: body.remarks ?? '', by: user?.name ?? 'Registry' };
      const next = (await c.query<CertRow>('UPDATE seafarer_certificates SET endorsement = $2, updated_at = now() WHERE id = $1 RETURNING *', [cert.id, JSON.stringify(endorsement)])).rows[0];
      await this.audit.record(c, { action: 'ENDORSE', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} — ${cert.cert_type}`, before: cert.endorsement, after: endorsement });
      return publishSeafarer(c, this.env, s, { event: EVENTS.seafarers.endorsed, data: { certificateId: next.id, certType: next.cert_type, endorsement } });
    });
  }

  /* -------------------------------------------------------------------- sea service --- */

  @RequirePerm('seafarers.edit') @Post(':id/service')
  async addService(@Param('id') id: string, @Body(zod(serviceBody)) body: z.infer<typeof serviceBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const s = await findSeafarer(c, id, user.scope);
      if (!s) throw notFound('Seafarer not found');
      if (new Date(body.to) <= new Date(body.from)) throw badRequest('Sign-off date must be after sign-on date');
      const vessel = body.vesselId ? (await c.query<{ id: string; name: string; imo: string }>('SELECT id, name, imo FROM vessels WHERE id = $1', [body.vesselId])).rows[0] : undefined;
      const rank = await this.rankOf(c, body.rank);
      const r = await c.query<ServiceRow>('INSERT INTO sea_service(seafarer_id, vessel_id, vessel_name, imo, rank, rank_code, from_at, to_at, verified, verified_by, verified_at, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [s.id, vessel?.id ?? body.vesselId ?? null, vessel?.name ?? body.vesselName, vessel?.imo ?? body.imo ?? '', rank.label, rank.code, body.from, body.to,
          body.verified, body.verified ? user?.name ?? 'Crew desk' : '', body.verified ? new Date() : null, body.remarks ?? '']);
      const svc = r.rows[0];
      await this.audit.record(c, { action: 'SERVICE_ADD', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} — ${svc.vessel_name}`, after: serviceApi(svc) });
      return publishSeafarer(c, this.env, s, { event: EVENTS.seafarers.seaServiceAdded, data: { serviceId: svc.id, vesselName: svc.vessel_name, days: seaDays(svc.from_at, svc.to_at), verified: svc.verified } });
    });
  }

  /** Verifying a tour is a statement of fact by the desk — checked against the crew list and the movement record. */
  @RequirePerm('seafarers.edit') @Put(':id/service/:serviceId')
  async verifyService(@Param('id') id: string, @Param('serviceId') serviceId: string, @Body(zod(z.object({ verified: z.boolean().optional(), remarks: text(1000).optional() }))) body: { verified?: boolean; remarks?: string }, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const s = await findSeafarer(c, id, user.scope);
      if (!s) throw notFound('Seafarer not found');
      const found = await c.query<ServiceRow>('SELECT * FROM sea_service WHERE id::text = $1 AND seafarer_id = $2 FOR UPDATE', [serviceId, s.id]);
      const before = found.rows[0];
      if (!before) throw notFound('Sea-service record not found');
      const verified = body.verified !== false;
      const svc = (await c.query<ServiceRow>('UPDATE sea_service SET verified = $2, verified_by = $3, verified_at = $4, remarks = COALESCE($5, remarks), updated_at = now() WHERE id = $1 RETURNING *',
        [before.id, verified, verified ? user?.name ?? 'Crew desk' : '', verified ? new Date() : null, body.remarks ?? null])).rows[0];
      await this.audit.record(c, { action: verified ? 'SERVICE_VERIFY' : 'SERVICE_UNVERIFY', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} — ${svc.vessel_name}`, before: serviceApi(before), after: serviceApi(svc) });
      return publishSeafarer(c, this.env, s, {
        event: verified ? EVENTS.seafarers.seaServiceVerified : EVENTS.seafarers.seaServiceAdded,
        data: { serviceId: svc.id, vesselId: svc.vessel_id, vesselName: svc.vessel_name, rank: svc.rank, from: iso(svc.from_at), to: iso(svc.to_at), days: seaDays(svc.from_at, svc.to_at), verifiedBy: svc.verified_by },
      });
    });
  }

  @RequirePerm('seafarers.edit') @Post(':id/service/:serviceId/verify')
  verifyServicePost(@Param('id') id: string, @Param('serviceId') serviceId: string, @Body(zod(z.object({ remarks: text(1000).optional() }))) body: { remarks?: string }, @CurrentUser() user: Principal) {
    return this.verifyService(id, serviceId, { verified: true, remarks: body.remarks }, user);
  }

  @RequirePerm('seafarers.edit') @Delete(':id/service/:serviceId')
  async removeService(@Param('id') id: string, @Param('serviceId') serviceId: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const s = await findSeafarer(c, id, user.scope);
      if (!s) throw notFound('Seafarer not found');
      const found = await c.query<ServiceRow>('SELECT * FROM sea_service WHERE id::text = $1 AND seafarer_id = $2 FOR UPDATE', [serviceId, s.id]);
      const svc = found.rows[0];
      if (!svc) throw notFound('Sea-service record not found');
      await this.audit.record(c, { action: 'SERVICE_DELETE', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} — ${svc.vessel_name}`, before: serviceApi(svc) });
      await c.query('DELETE FROM sea_service WHERE id = $1', [svc.id]);
      return publishSeafarer(c, this.env, s, { event: EVENTS.seafarers.seaServiceDeleted, data: { serviceId: svc.id, vesselName: svc.vessel_name } });
    });
  }

  /* ------------------------------------------------------------ sign-on and sign-off --- */

  /* A sign-on is gated on the documents the tour will be sailed under, not on the documents held today:
   * a medical that lapses next month is a medical that lapses at sea. The gate answers 422 with the failed
   * checks so the desk can see them; an officer may override, and the override is recorded against them. */
  @RequirePerm('seafarers.edit') @Post(':id/sign-on')
  async signOn(@Param('id') id: string, @Body(zod(signOnBody)) body: z.infer<typeof signOnBody>) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<SeafarerRow>('SELECT * FROM seafarers WHERE id::text = $1 FOR UPDATE', [id]);
      const s = found.rows[0];
      if (!s) throw notFound('Seafarer not found');
      if (s.current_vessel_id) throw badRequest(`Already signed on ${s.current_vessel_name ?? 'a vessel'} — sign off first`);
      if (s.status === 'SUSPENDED') throw conflict(`${s.name} is suspended and may not be signed on`);
      const vr = await c.query<{ id: string; name: string; status: string }>('SELECT id, name, status FROM vessels WHERE id = $1', [body.vesselId]);
      const vessel = vr.rows[0];
      if (!vessel) throw badRequest('Choose the vessel to sign on to');
      if (vessel.status !== 'ACTIVE') throw conflict(`${vessel.name} is not an active ship`);
      const now = new Date();
      const rules = certRules(await certVocab(c));
      const certs = await certsOf(c, s.id, now, this.env.CERT_EXPIRING_DAYS, rules);
      const { failures } = documentGate(certs, this.env, now, rules);
      if (failures.length && !body.override) throw unprocessable('Documents block this sign-on', { data: { failures } });
      if (failures.length && body.override && !body.overrideReason) throw badRequest('An override requires a written reason');
      const rank = body.rank ? await this.rankOf(c, body.rank) : null;
      const next = (await c.query<SeafarerRow>('UPDATE seafarers SET current_vessel_id = $2, current_vessel_name = $3, status = $4, signed_on_at = $5, rank = COALESCE($6, rank), rank_code = COALESCE($7, rank_code), updated_at = now() WHERE id = $1 RETURNING *',
        [s.id, vessel.id, vessel.name, 'ACTIVE', now, rank?.label ?? null, rank?.code ?? null])).rows[0];
      await this.audit.record(c, {
        action: 'SIGN_ON', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} signed on ${vessel.name}`,
        before: { currentVesselId: s.current_vessel_id, status: s.status }, after: { currentVesselId: vessel.id, status: next.status },
        note: failures.length ? `OVERRIDE: ${body.overrideReason} — ${failures.join('; ')}` : '',
      });
      const entity = await publishSeafarer(c, this.env, next, { event: EVENTS.seafarers.signedOn, data: { vesselId: vessel.id, vesselName: vessel.name, rank: next.rank, overridden: failures.length > 0, failures } });
      return { signedOn: true, overridden: failures.length > 0, failures, seafarer: entity };
    });
  }

  /* Signing off closes the tour and writes the sea-service record for it — already verified, because the
   * desk is the one that knows when the seafarer went aboard and when they came off. */
  @RequirePerm('seafarers.edit') @Post(':id/sign-off')
  async signOff(@Param('id') id: string, @Body(zod(signOffBody)) body: z.infer<typeof signOffBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<SeafarerRow>('SELECT * FROM seafarers WHERE id::text = $1 FOR UPDATE', [id]);
      const s = found.rows[0];
      if (!s) throw notFound('Seafarer not found');
      if (!s.current_vessel_id) throw badRequest('Not currently signed on to any vessel');
      const vessel = (await c.query<{ id: string; name: string; imo: string }>('SELECT id, name, imo FROM vessels WHERE id = $1', [s.current_vessel_id])).rows[0];
      const to = new Date();
      const last = await c.query<{ to_at: Date }>('SELECT to_at FROM sea_service WHERE seafarer_id = $1 ORDER BY to_at DESC LIMIT 1', [s.id]);
      const from = s.signed_on_at ?? last.rows[0]?.to_at ?? new Date(to.getTime() - 90 * 86_400_000);
      const by = user?.name ?? 'Crew desk';
      const remarks = body.remarks ?? 'Sign-off recorded by the crewing desk';
      /* The tour is already in the service book as an open record from the day the seafarer went aboard;
       * signing off closes and verifies that record rather than writing a second one over the same days. */
      const open = await c.query<ServiceRow>('SELECT * FROM sea_service WHERE seafarer_id = $1 AND vessel_id = $2 AND from_at = $3 ORDER BY to_at DESC LIMIT 1', [s.id, s.current_vessel_id, s.signed_on_at]);
      const svc = open.rows[0]
        ? (await c.query<ServiceRow>('UPDATE sea_service SET to_at = $2, verified = true, verified_by = $3, verified_at = $2, remarks = $4, rank = $5, rank_code = $6, updated_at = now() WHERE id = $1 RETURNING *', [open.rows[0].id, to, by, remarks, s.rank, s.rank_code])).rows[0]
        : (await c.query<ServiceRow>('INSERT INTO sea_service(seafarer_id, vessel_id, vessel_name, imo, rank, rank_code, from_at, to_at, verified, verified_by, verified_at, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11) RETURNING *',
            [s.id, s.current_vessel_id, vessel?.name ?? s.current_vessel_name ?? 'Unknown vessel', vessel?.imo ?? '', s.rank, s.rank_code, from, to, by, to, remarks])).rows[0];
      const next = (await c.query<SeafarerRow>(`UPDATE seafarers SET current_vessel_id = NULL, current_vessel_name = NULL, signed_on_at = NULL, status = 'SIGNED_OFF', updated_at = now() WHERE id = $1 RETURNING *`, [s.id])).rows[0];
      const days = Math.max(1, seaDays(from, to));
      await this.audit.record(c, {
        action: 'SIGN_OFF', entity: 'Seafarer', entityId: s.id, entityLabel: `${s.name} signed off ${vessel?.name ?? ''} — ${days} days verified sea service`,
        before: { currentVesselId: s.current_vessel_id, status: s.status }, after: { currentVesselId: null, status: next.status }, note: remarks,
      });
      const entity = await publishSeafarer(c, this.env, next, { event: EVENTS.seafarers.signedOff, data: { vesselId: s.current_vessel_id, vesselName: vessel?.name ?? '', seaServiceDays: days, serviceId: svc.id } });
      // the tour it closes is verified service, so it is announced as such
      await publishSeafarer(c, this.env, next, { event: EVENTS.seafarers.seaServiceVerified, data: { serviceId: svc.id, vesselId: svc.vessel_id, vesselName: svc.vessel_name, rank: svc.rank, from: iso(svc.from_at), to: iso(svc.to_at), days, verifiedBy: svc.verified_by } });
      return { signedOff: true, seaServiceDays: days, seafarer: entity };
    });
  }
}
