import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { AuditClient, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod } from '@maritime/service-kit';
import type { Env } from './env';
import {
  VESSEL_STATUS, agentNameOf, certApi, certsOf, fleetDashboard, findVessel, iso, movementEventsOf, publishCertificate, publishCertificateDeleted,
  publishVessel, publishVesselDeleted, surveyEvents, surveyWindow, vesselApi, vesselCard, voyagesOf,
  type CallRow, type CertApi, type CertRow, type Row, type VesselRow,
} from './vessels';
import { registrationApi, transcriptOf, type RegistrationRow } from './registrations';
import { computeScores } from './risk';

/* The fleet record: the register list, the eight-tab ship record, the certificate list on the ship and the
 * fleet-wide certificate register, plus the module's landing analytics and the class survey planner. */

/* The web's form fields send an empty string for a field the user cleared, so a blank date or number is
 * read as "no value" rather than refused or coerced to zero. */
const blank = (v: unknown) => (v === '' || v === null ? null : v);
const text = (max: number) => z.string().trim().max(max);
const date = z.preprocess(blank, z.string().min(1).nullable().optional());
const optNum = (min: number, max: number, int = false) => z.preprocess(blank, (int ? z.coerce.number().int() : z.coerce.number()).min(min).max(max).nullable().optional());
const vesselBody = z.object({
  name: text(160).min(1), imo: z.string().trim().regex(/^\d{7}$/, 'IMO number must be 7 digits'),
  mmsi: text(20).default(''), callSign: text(20).default(''), flag: text(80).default(''),
  type: text(20).min(1), built: optNum(1900, 2100, true),
  dwt: optNum(0, 1_000_000, true), grt: z.preprocess((v) => (v === '' || v === null ? 0 : v), z.coerce.number().int().min(0).default(0)),
  loa: optNum(0, 1000), beam: optNum(0, 200), maxDraft: optNum(0, 60),
  owner: text(200).default(''), operator: text(200).default(''), manager: text(200).default(''),
  agent: text(30).default(''), classSociety: text(80).default(''), piClub: text(160).default(''), portOfRegistry: text(120).default(''), yard: text(160).default(''),
  engine: z.object({ maker: text(120).optional(), model: text(120).optional(), powerKW: z.coerce.number().min(0).optional() }).partial().optional(),
  serviceSpeedKn: optNum(0, 60), teuCapacity: optNum(0, 100_000, true),
  lastDryDock: date, nextDryDock: date, status: z.enum(VESSEL_STATUS).default('ACTIVE'), remarks: text(2000).default(''),
});
const vesselPatch = vesselBody.partial();
const certBody = z.object({
  certType: text(160).min(1), number: text(80).default(''), issuer: text(200).default(''),
  issueDate: date, expiryDate: z.string().trim().min(1), remarks: text(1000).default(''),
});
const certPatch = certBody.partial();

const SORT: Record<string, string> = { name: 'name', imo: 'imo', type: 'type', flag: 'flag', grt: 'grt', dwt: 'dwt', loa: 'loa', built: 'built', status: 'status', agent: 'agent_code', classSociety: 'class_society', registryState: 'registry_state', createdAt: 'created_at', updatedAt: 'updated_at' };
const COLS: Record<string, string> = {
  name: 'name', imo: 'imo', mmsi: 'mmsi', callSign: 'call_sign', flag: 'flag', type: 'type', built: 'built', dwt: 'dwt', grt: 'grt',
  loa: 'loa', beam: 'beam', maxDraft: 'max_draft', owner: 'owner', operator: 'operator', manager: 'manager', agent: 'agent_code',
  classSociety: 'class_society', piClub: 'pi_club', portOfRegistry: 'port_of_registry', yard: 'yard', engine: 'engine',
  serviceSpeedKn: 'service_speed_kn', teuCapacity: 'teu_capacity', lastDryDock: 'last_dry_dock', nextDryDock: 'next_dry_dock', status: 'status', remarks: 'remarks',
};
type ListQuery = PageQuery & { type?: string; flag?: string; status?: string; agent?: string; registryState?: string; riskBand?: string; classSociety?: string };

@Controller('vessels')
export class VesselsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private now() { return new Date(); }
  private async certsByVessel(ids: string[], now = new Date()): Promise<Map<string, CertApi[]>> {
    const out = new Map<string, CertApi[]>();
    if (!ids.length) return out;
    const r = await this.pool.query<CertRow>('SELECT * FROM vessel_certificates WHERE vessel_id = ANY($1) ORDER BY expiry_date', [ids]);
    for (const c of r.rows) { const l = out.get(c.vessel_id) ?? []; l.push(certApi(c, now, this.env.CERT_EXPIRING_DAYS)); out.set(c.vessel_id, l); }
    return out;
  }
  private async agents(codes: string[]): Promise<Map<string, string>> {
    const list = [...new Set(codes.filter(Boolean))];
    if (!list.length) return new Map();
    const r = await this.pool.query<{ code: string; name: string }>('SELECT code, name FROM companies WHERE code = ANY($1)', [list]);
    return new Map(r.rows.map((x) => [x.code, x.name]));
  }

  /** The register: filterable, searchable, paged, and carrying each ship's certificate list. */
  @RequirePerm('vessels.view') @Get()
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT), maxLimit: 500 });
    const now = this.now();
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('type', query.type); eq('flag', query.flag); eq('status', query.status); eq('agent_code', query.agent); eq('registry_state', query.registryState); eq('class_society', query.classSociety);
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(name ILIKE $${args.length} OR imo ILIKE $${args.length} OR call_sign ILIKE $${args.length} OR official_number ILIKE $${args.length})`); }
    /* The risk band is computed rather than stored, so filtering on it means scoring the fleet first and
     * narrowing the query to the ships that match — the page must be a page of the filtered set, not a
     * filtered page. */
    let bands: Map<string, string> | undefined;
    if (query.riskBand) {
      const scored = await computeScores(this.pool, this.env.CERT_EXPIRING_DAYS, now);
      bands = new Map(scored.rows.map((r) => [r.vesselId, r.band as string]));
      args.push(scored.rows.filter((r) => r.band === query.riskBand).map((r) => r.vesselId));
      where.push(`id = ANY($${args.length})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM vessels ${w}`, args);
    const rows = await this.pool.query<VesselRow>(`SELECT * FROM vessels ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, name LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const certs = await this.certsByVessel(rows.rows.map((v) => v.id), now);
    const agents = await this.agents(rows.rows.map((v) => v.agent_code));
    const out = rows.rows.map((v) => vesselApi(v, this.env.JURISDICTION, { certificates: certs.get(v.id) ?? [], agentName: agents.get(v.agent_code) ?? null, riskBand: bands?.get(v.id) ?? null }));
    return paged(out, { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The vessel module's landing analytics. Declared before `:id` so the word is not read as an id. */
  @RequirePerm('vessels.view', 'dashboard.view') @Get('fleet-dashboard')
  async fleetDashboard() {
    const now = this.now();
    const rows = (await this.pool.query<VesselRow>('SELECT * FROM vessels')).rows;
    const certs = await this.certsByVessel(rows.map((v) => v.id), now);
    const calls = (await this.pool.query<{ vessel_id: string; status: string }>(`SELECT vessel_id, status FROM port_calls WHERE status = ANY($1)`, [['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED']])).rows;
    return fleetDashboard(rows.map((v) => ({ ...v, certs: certs.get(v.id) ?? [] })), calls, now);
  }

  /** Class survey and dry-dock windows across the active fleet, on the cycle each ship is actually in. */
  @RequirePerm('vessels.view') @Get('survey-planner')
  async surveyPlanner(@Query('months') monthsQ?: string) {
    const months = Math.min(60, Math.max(6, Number.parseInt(String(monthsQ ?? 24), 10) || 24));
    const now = this.now().getTime();
    const rows = (await this.pool.query<VesselRow>(`SELECT * FROM vessels WHERE status = 'ACTIVE' ORDER BY name`)).rows;
    return {
      ...surveyWindow(now, months),
      lanes: rows.map((v) => ({ vessel: { id: v.id, name: v.name, imo: v.imo, type: v.type, classSociety: v.class_society, lastDryDock: iso(v.last_dry_dock) }, events: surveyEvents(v, now, months) })),
    };
  }

  /* The fleet-wide certificate register.
   *
   * A certificate this administration issued is on the instrument register as well as on the ship, and the
   * register knows two things the ship's own list cannot: whether the survey endorsements are up to date,
   * and whether the record still matches the signature taken at issue. Both are worth more than the expiry
   * date, because a certificate can be unexpired and still not in force. */
  @RequirePerm('certificates.view', 'vessels.view') @Get('certificates/all')
  async allCertificates(@Query() query: PageQuery & { status?: string; notInForce?: string }) {
    const p = parsePage(query, { defaultSort: 'expiryDate', maxLimit: 200 });
    const now = this.now();
    const r = await this.pool.query<CertRow & { vessel_name: string; vessel_imo: string; registry_state: string; reg_certificate_no: string; certificate_expires_on: Date | null }>(
      `SELECT c.*, v.name AS vessel_name, v.imo AS vessel_imo, v.registry_state, v.certificate_no AS reg_certificate_no, v.certificate_expires_on
         FROM vessel_certificates c JOIN vessels v ON v.id = c.vessel_id WHERE v.status = 'ACTIVE'`);
    let rows = r.rows.map((c) => {
      const api = certApi(c, now, this.env.CERT_EXPIRING_DAYS);
      // the certificate of registry is on this register too, but its standing is read off the ship's registry entry rather than the instrument register
      const isCoR = c.cert_type === 'Certificate of Registry';
      const corOnRegister = isCoR && !!c.number && c.reg_certificate_no === c.number;
      const corInForce = corOnRegister && c.registry_state !== 'CLOSED' && !(c.registry_state === 'PROVISIONAL' && c.certificate_expires_on && new Date(c.certificate_expires_on) < now);
      return {
        vesselId: c.vessel_id, vesselName: c.vessel_name, imo: c.vessel_imo,
        certId: c.id, certType: c.cert_type, number: c.number, issuer: c.issuer, issueDate: api.issueDate, expiryDate: api.expiryDate, status: api.status,
        instrumentId: c.instrument_id, onRegister: c.on_register || corOnRegister, signed: c.signed,
        inForce: c.instrument_id ? c.in_force : corOnRegister ? corInForce : null,
        forceReason: c.instrument_id ? c.force_reason : corOnRegister ? (corInForce ? 'Registry entry current' : c.registry_state === 'CLOSED' ? 'Registry closed' : 'Provisional certificate has expired') : '',
        endorsementsOverdue: c.endorsements_overdue,
      };
    });
    if (query.status) rows = rows.filter((x) => x.status === query.status);
    if (String(query.notInForce) === 'true') rows = rows.filter((x) => x.onRegister && !x.inForce);
    if (p.q) { const rx = new RegExp(escapeLike(p.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); rows = rows.filter((x) => rx.test(x.vesselName) || rx.test(x.certType) || rx.test(x.number || '')); }
    rows.sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));
    return paged(rows.slice(p.offset, p.offset + p.limit), { total: rows.length, page: p.page, limit: p.limit });
  }

  /** The full ship record the eight-tab screen renders from: particulars, certificates, calls, inspections, incidents, crew and her last fix. */
  @RequirePerm('vessels.view') @Get(':id')
  async get(@Param('id') id: string) {
    const v = await findVessel(this.pool, id);
    if (!v) throw notFound('Vessel not found');
    const now = this.now();
    const [certs, calls, inspections, incidents, crew, position, agentName] = await Promise.all([
      certsOf(this.pool, v.id, now, this.env.CERT_EXPIRING_DAYS),
      this.pool.query<CallRow>('SELECT * FROM port_calls WHERE vessel_id = $1 ORDER BY eta DESC NULLS LAST LIMIT 20', [v.id]),
      this.pool.query<Row>('SELECT * FROM inspections WHERE vessel_id = $1 ORDER BY planned_at DESC NULLS LAST LIMIT 12', [v.id]),
      this.pool.query<Row>('SELECT * FROM incidents WHERE vessel_id = $1 ORDER BY reported_at DESC NULLS LAST LIMIT 12', [v.id]),
      this.pool.query<Row>('SELECT * FROM crew WHERE current_vessel_id = $1 ORDER BY rank, name', [v.id]),
      this.pool.query<Row>('SELECT * FROM positions WHERE vessel_id = $1', [v.id]),
      agentNameOf(this.pool, v.agent_code),
    ]);
    const pos = position.rows[0];
    return {
      ...vesselApi(v, this.env.JURISDICTION, { certificates: certs, agentName }),
      recentCalls: calls.rows.map((c) => ({ id: c.id, vcn: c.vcn, status: c.status, eta: iso(c.eta), atd: iso(c.atd), berthCode: c.berth_code ?? '', berthName: c.berth_name ?? '', terminal: c.terminal ?? '' })),
      recentInspections: inspections.rows.map((i) => ({ id: i.id, number: i.number, type: i.type, status: i.status, result: i.result, findings: i.findings ?? [], openFindings: i.open_findings, plannedAt: iso(i.planned_at), closedAt: iso(i.closed_at), detention: i.detention })),
      recentIncidents: incidents.rows.map((i) => ({ id: i.id, number: i.number, title: i.title, type: i.type, severity: i.severity, status: i.status, reportedAt: iso(i.reported_at), closedAt: iso(i.closed_at) })),
      crewOnBoard: crew.rows.map((s) => ({ id: s.id, name: s.name, rank: s.rank, cdcNo: s.cdc_no, nationality: s.nationality, status: s.status, certAlerts: s.cert_alerts })),
      lastPosition: pos ? { lat: Number(pos.lat), lon: Number(pos.lon), speed: Number(pos.speed), course: Number(pos.course), navStatus: pos.nav_status, receivedAt: iso(pos.received_at) } : null,
    };
  }

  /** The voyage ledger and the trade lanes it adds up to. */
  @RequirePerm('vessels.view') @Get(':id/voyages')
  async voyages(@Param('id') id: string) {
    const v = await findVessel(this.pool, id);
    if (!v) throw notFound('Vessel not found');
    const calls = await this.pool.query<CallRow>(`SELECT * FROM port_calls WHERE vessel_id = $1 AND status = 'SAILED' ORDER BY atd DESC NULLS LAST LIMIT 40`, [v.id]);
    return voyagesOf(calls.rows);
  }

  /** The movement picture: her last AIS fix and the port's own event trail. */
  @RequirePerm('vessels.view') @Get(':id/movements')
  async movements(@Param('id') id: string) {
    const v = await findVessel(this.pool, id);
    if (!v) throw notFound('Vessel not found');
    const [pos, calls] = await Promise.all([
      this.pool.query<Row>('SELECT * FROM positions WHERE vessel_id = $1', [v.id]),
      this.pool.query<CallRow>('SELECT * FROM port_calls WHERE vessel_id = $1 ORDER BY eta DESC NULLS LAST LIMIT 12', [v.id]),
    ]);
    const p = pos.rows[0];
    return { position: p ? { lat: Number(p.lat), lon: Number(p.lon), speed: Number(p.speed), course: Number(p.course), navStatus: p.nav_status, receivedAt: iso(p.received_at) } : null, events: movementEventsOf(calls.rows) };
  }

  /** The transcript of registry, assembled from the granted applications so it cannot drift from the register. */
  @RequirePerm('registry.view', 'vessels.view') @Get(':id/transcript')
  async transcript(@Param('id') id: string) {
    const v = await findVessel(this.pool, id);
    if (!v) throw notFound('Vessel not found');
    const rows = await this.pool.query<RegistrationRow>('SELECT * FROM registrations WHERE vessel_id = $1', [v.id]);
    return transcriptOf(v, rows.rows, this.env.JURISDICTION);
  }

  /** Every registry transaction against one ship, newest first. */
  @RequirePerm('registry.view', 'vessels.view') @Get(':id/registrations')
  async registrations(@Param('id') id: string) {
    const v = await findVessel(this.pool, id);
    if (!v) throw notFound('Vessel not found');
    const rows = await this.pool.query<RegistrationRow>('SELECT * FROM registrations WHERE vessel_id = $1 ORDER BY created_at DESC', [v.id]);
    return paged(rows.rows.map((r) => registrationApi(r, this.env.JURISDICTION)), { total: rows.rowCount ?? 0, page: 1, limit: rows.rowCount ?? 0 });
  }

  /** The four facts that answer "which ship is this?" for a hover card. */
  @RequirePerm('vessels.view') @Get(':id/card')
  async card(@Param('id') id: string) {
    const v = await findVessel(this.pool, id);
    if (!v) throw notFound('Vessel not found');
    return vesselCard(v, await certsOf(this.pool, v.id, this.now(), this.env.CERT_EXPIRING_DAYS), this.env.JURISDICTION);
  }

  @RequirePerm('vessels.create') @Post()
  async create(@Body(zod(vesselBody)) body: z.infer<typeof vesselBody>) {
    return withTx(this.pool, async (c) => {
      const dupe = await c.query('SELECT id FROM vessels WHERE imo = $1', [body.imo]);
      if (dupe.rowCount) throw conflict(`IMO ${body.imo} is already on the fleet record`);
      const cols = Object.keys(COLS).filter((k) => (body as Row)[k] !== undefined);
      const vals = cols.map((k) => { const v = (body as Row)[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
      const r = await c.query<VesselRow>(`INSERT INTO vessels(${cols.map((k) => COLS[k]).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'Vessel', entityId: row.id, entityLabel: row.name, after: vesselApi(row, this.env.JURISDICTION) });
      return publishVessel(c, this.env, row, { event: EVENTS.ships.vesselCreated });
    });
  }

  @RequirePerm('vessels.edit') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(vesselPatch)) body: z.infer<typeof vesselPatch>) {
    return withTx(this.pool, async (c) => {
      const before = await c.query<VesselRow>('SELECT * FROM vessels WHERE id::text = $1 FOR UPDATE', [id]);
      const v = before.rows[0];
      if (!v) throw notFound('Vessel not found');
      if (body.imo && body.imo !== v.imo) {
        const dupe = await c.query('SELECT id FROM vessels WHERE imo = $1 AND id <> $2', [body.imo, v.id]);
        if (dupe.rowCount) throw conflict(`IMO ${body.imo} is already on the fleet record`);
      }
      const keys = Object.keys(COLS).filter((k) => (body as Row)[k] !== undefined);
      const vals = keys.map((k) => { const x = (body as Row)[k]; return x !== null && typeof x === 'object' ? JSON.stringify(x) : x; });
      const r = keys.length
        ? await c.query<VesselRow>(`UPDATE vessels SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [v.id, ...vals])
        : { rows: [v] };
      const row = r.rows[0];
      await this.audit.record(c, { action: 'UPDATE', entity: 'Vessel', entityId: row.id, entityLabel: row.name, before: vesselApi(v, this.env.JURISDICTION), after: vesselApi(row, this.env.JURISDICTION) });
      return publishVessel(c, this.env, row, { event: EVENTS.ships.vesselUpdated });
    });
  }

  @RequirePerm('vessels.delete') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const r = await c.query<VesselRow>('SELECT * FROM vessels WHERE id::text = $1 FOR UPDATE', [id]);
      const v = r.rows[0];
      if (!v) throw notFound('Vessel not found');
      const calls = await c.query<{ n: string }>('SELECT count(*) AS n FROM port_calls WHERE vessel_id = $1', [v.id]);
      if (Number(calls.rows[0].n) > 0) throw badRequest('This vessel has port call history — deactivate it instead of deleting');
      if (v.registry_state === 'REGISTERED' || v.registry_state === 'PROVISIONAL') throw conflict(`${v.name} is on the register — close the registry entry before deleting the fleet record`);
      await this.audit.record(c, { action: 'DELETE', entity: 'Vessel', entityId: v.id, entityLabel: v.name, before: vesselApi(v, this.env.JURISDICTION) });
      await c.query('DELETE FROM vessels WHERE id = $1', [v.id]);
      await publishVesselDeleted(c, this.env, v);
      return { deleted: true, id: v.id };
    });
  }

  /* ------------------------------------------------------------------- certificates --- */

  @RequirePerm('certificates.manage') @Post(':id/certificates')
  async addCert(@Param('id') id: string, @Body(zod(certBody)) body: z.infer<typeof certBody>) {
    return withTx(this.pool, async (c) => {
      const v = await findVessel(c, id);
      if (!v) throw notFound('Vessel not found');
      const clash = await c.query<{ id: string }>('SELECT id FROM vessel_certificates WHERE vessel_id = $1 AND cert_type = $2 AND instrument_id IS NOT NULL', [v.id, body.certType]);
      if (clash.rowCount) throw conflict(`${body.certType} for ${v.name} is issued on the instrument register — amend it there, not on the ship`);
      const r = await c.query<CertRow>('INSERT INTO vessel_certificates(vessel_id, cert_type, number, issuer, issue_date, expiry_date, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [v.id, body.certType, body.number ?? '', body.issuer ?? '', body.issueDate || null, body.expiryDate, body.remarks ?? '']);
      const cert = r.rows[0];
      await this.audit.record(c, { action: 'CERT_ADD', entity: 'Vessel', entityId: v.id, entityLabel: `${v.name} — ${cert.cert_type}`, after: certApi(cert, this.now(), this.env.CERT_EXPIRING_DAYS) });
      await publishCertificate(c, this.env, v, cert, EVENTS.ships.certIssued);
      return { ...vesselApi(v, this.env.JURISDICTION, { certificates: await certsOf(c, v.id, this.now(), this.env.CERT_EXPIRING_DAYS) }) };
    });
  }

  @RequirePerm('certificates.manage') @Put(':id/certificates/:certId')
  async updateCert(@Param('id') id: string, @Param('certId') certId: string, @Body(zod(certPatch)) body: z.infer<typeof certPatch>) {
    return withTx(this.pool, async (c) => {
      const v = await findVessel(c, id);
      if (!v) throw notFound('Vessel not found');
      const found = await c.query<CertRow>('SELECT * FROM vessel_certificates WHERE id::text = $1 AND vessel_id = $2 FOR UPDATE', [certId, v.id]);
      const before = found.rows[0];
      if (!before) throw notFound('Certificate not found');
      if (before.instrument_id) throw conflict(`${before.cert_type} was issued on the instrument register — it is read-only on the ship's list`);
      const map: Record<string, string> = { certType: 'cert_type', number: 'number', issuer: 'issuer', issueDate: 'issue_date', expiryDate: 'expiry_date', remarks: 'remarks' };
      const keys = Object.keys(map).filter((k) => (body as Row)[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to update');
      const r = await c.query<CertRow>(`UPDATE vessel_certificates SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (body as Row)[k])]);
      const cert = r.rows[0];
      await this.audit.record(c, { action: 'CERT_UPDATE', entity: 'Vessel', entityId: v.id, entityLabel: `${v.name} — ${cert.cert_type}`, before: certApi(before, this.now(), this.env.CERT_EXPIRING_DAYS), after: certApi(cert, this.now(), this.env.CERT_EXPIRING_DAYS) });
      await publishCertificate(c, this.env, v, cert, EVENTS.ships.certUpdated);
      return { ...vesselApi(v, this.env.JURISDICTION, { certificates: await certsOf(c, v.id, this.now(), this.env.CERT_EXPIRING_DAYS) }) };
    });
  }

  @RequirePerm('certificates.manage') @Delete(':id/certificates/:certId')
  async removeCert(@Param('id') id: string, @Param('certId') certId: string) {
    return withTx(this.pool, async (c) => {
      const v = await findVessel(c, id);
      if (!v) throw notFound('Vessel not found');
      const found = await c.query<CertRow>('SELECT * FROM vessel_certificates WHERE id::text = $1 AND vessel_id = $2 FOR UPDATE', [certId, v.id]);
      const cert = found.rows[0];
      if (!cert) throw notFound('Certificate not found');
      if (cert.instrument_id) throw conflict(`${cert.cert_type} was issued on the instrument register — withdraw it there, not on the ship`);
      await this.audit.record(c, { action: 'CERT_DELETE', entity: 'Vessel', entityId: v.id, entityLabel: `${v.name} — ${cert.cert_type}`, before: certApi(cert, this.now(), this.env.CERT_EXPIRING_DAYS) });
      await c.query('DELETE FROM vessel_certificates WHERE id = $1', [cert.id]);
      await publishCertificateDeleted(c, this.env, v, cert);
      return { ...vesselApi(v, this.env.JURISDICTION, { certificates: await certsOf(c, v.id, this.now(), this.env.CERT_EXPIRING_DAYS) }) };
    });
  }
}
