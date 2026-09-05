import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, ServiceOnly, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { detectMode, fencesContaining, vesselsWithin } from './spatial';
import { seedGeofences } from './geofences';
import { LIVE_STATUS, iso, type IncidentRow, type Row } from './incidents';
import { incidentRowApi } from './incidents';
import {
  ALERT_SEVERITIES, ALERT_TYPES, NAV_STATUS, RESTRICTION_KINDS, alertApi, chartZones, coverageNote, portCentre, positionApi, publishAlert, publishPosition, publishRestriction,
  restrictionApi, restrictionZones, trackSummary, recordFix, type AlertRow, type PositionRow, type RestrictionRow, type VesselFacts,
} from './tracking';
import { AIS_SOURCE, feedApi, feedState, pollAis } from './feed';
import { IntegrationClient } from '@maritime/service-kit';

/* Tracking and surveillance.
 *
 * The picture is a single scan of the current fixes plus the alerts nobody has acknowledged yet, drawn on the
 * port's own chart features. Fixes arrive on the bus from the AIS feed, but the endpoint is here too so a feed
 * adapter can push without holding a bus connection; it is service-only, because a person does not report a
 * ship's position by hand. Everything derived here is advisory — an alert is acknowledged, never enforced, and
 * a restriction is proposed for the harbour master to decide. */

const blank = (v: unknown) => (v === '' || v === null ? null : v);
const text = (max: number) => z.string().trim().max(max);
const pointBody = z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) });
const fixBody = z.object({
  vesselId: z.string().trim().min(1), vesselName: text(200).optional(), mmsi: text(20).optional(),
  lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180),
  speed: z.coerce.number().min(0).max(60).optional(), sog: z.coerce.number().min(0).max(60).optional(),
  course: z.coerce.number().min(0).max(359).optional(), cog: z.coerce.number().min(0).max(359).optional(),
  heading: z.coerce.number().min(0).max(359).optional(), navStatus: z.enum(NAV_STATUS).default('UNDERWAY'),
  destination: text(120).default(''), source: text(80).optional(), receivedAt: z.preprocess(blank, z.string().nullable().optional()),
});
const alertBody = z.object({
  type: z.enum(ALERT_TYPES), severity: z.enum(ALERT_SEVERITIES).default('warning'),
  vesselId: z.preprocess(blank, z.string().trim().nullable().optional()), vesselName: text(200).default(''),
  note: text(1000).default(''), at: z.preprocess(blank, z.string().nullable().optional()), incidentId: z.preprocess(blank, z.string().trim().nullable().optional()),
});
const ackBody = z.object({ note: text(500).default('') });
const restrictionBody = z.object({
  kind: z.enum(RESTRICTION_KINDS).default('AREA_CLOSURE'), label: text(200).min(1), reason: text(2000).default(''),
  area: z.array(pointBody).min(3, 'A restricted area needs at least three points'),
  effectiveFrom: z.preprocess(blank, z.string().nullable().optional()), effectiveTo: z.preprocess(blank, z.string().nullable().optional()),
  incidentId: z.preprocess(blank, z.string().trim().nullable().optional()),
});
const decisionBody = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED']), note: text(2000).default('') });

@Controller('tracking')
export class TrackingController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, private readonly hub: IntegrationClient) {}

  private async vesselFacts(ids: string[]): Promise<Map<string, VesselFacts>> {
    if (!ids.length) return new Map();
    const r = await this.pool.query<VesselFacts>('SELECT id, name, imo, type, flag, status FROM vessels WHERE id = ANY($1)', [ids]);
    return new Map(r.rows.map((v) => [v.id, v]));
  }

  /** The live traffic picture: every current fix, the unacknowledged alerts and the chart the map draws them on. */
  @RequirePerm('nmc.view') @Get()
  async picture() {
    const [positions, alerts, restrictions] = await Promise.all([
      this.pool.query<PositionRow>('SELECT * FROM positions ORDER BY received_at DESC'),
      this.pool.query<AlertRow>('SELECT * FROM mda_alerts WHERE NOT acknowledged ORDER BY at DESC LIMIT 20'),
      this.pool.query<RestrictionRow>(`SELECT * FROM restrictions WHERE status IN ('PROPOSED', 'APPROVED') ORDER BY created_at`),
    ]);
    const facts = await this.vesselFacts(positions.rows.map((p) => p.vessel_id));
    return {
      positions: positions.rows.map((p) => positionApi(p, facts.get(p.vessel_id), this.env.POSITION_STALE_MIN)),
      alerts: alerts.rows.map(alertApi),
      restrictions: restrictions.rows.map(restrictionApi),
      generatedAt: new Date().toISOString(),
      coverage: coverageNote(this.env.JURISDICTION),
      port: portCentre(this.env.JURISDICTION, this.env.PICTURE_ZOOM_KM),
      zones: [...chartZones(this.env.JURISDICTION), ...restrictionZones(restrictions.rows)],
    };
  }

  /** Every current fix as a paged, searchable list — the same targets, for a table rather than a chart. */
  @RequirePerm('nmc.view') @Get('positions')
  async positions(@Query() query: PageQuery & { navStatus?: string; vessel?: string; stale?: string }) {
    const p = parsePage(query, { defaultSort: '-receivedAt', maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.navStatus) { args.push(query.navStatus); where.push(`nav_status = $${args.length}`); }
    if (query.vessel) { args.push(query.vessel); where.push(`vessel_id = $${args.length}`); }
    if (String(query.stale) === 'true') { args.push(this.env.POSITION_STALE_MIN); where.push(`received_at < now() - ($${args.length} || ' minutes')::interval`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(vessel_name ILIKE $${args.length} OR mmsi ILIKE $${args.length} OR destination ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = p.sortField === 'vesselName' ? 'vessel_name' : p.sortField === 'speed' ? 'sog' : 'received_at';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM positions ${w}`, args);
    const rows = await this.pool.query<PositionRow>(`SELECT * FROM positions ${w} ORDER BY ${order} ${p.sortDir} LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const facts = await this.vesselFacts(rows.rows.map((x) => x.vessel_id));
    return paged(rows.rows.map((x) => positionApi(x, facts.get(x.vessel_id), this.env.POSITION_STALE_MIN)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** One ship's track over the window, with the ground she covered on it. */
  @RequirePerm('nmc.view') @Get('positions/:vesselId')
  async track(@Param('vesselId') vesselId: string, @Query('hours') hoursQ?: string) {
    const hours = Math.min(720, Math.max(1, Number.parseInt(String(hoursQ ?? this.env.TRACK_HISTORY_HOURS), 10) || this.env.TRACK_HISTORY_HOURS));
    const since = new Date(Date.now() - hours * 3_600_000);
    const [current, history] = await Promise.all([
      this.pool.query<PositionRow>('SELECT * FROM positions WHERE vessel_id = $1', [vesselId]),
      this.pool.query<Row>('SELECT lat, lon, sog, cog, nav_status, received_at FROM position_history WHERE vessel_id = $1 AND received_at >= $2 ORDER BY received_at', [vesselId, since]),
    ]);
    if (!current.rows[0] && !history.rowCount) throw notFound('No position is held for that vessel');
    const facts = await this.vesselFacts([vesselId]);
    const fixes = history.rows.map((h) => ({ lat: Number(h.lat), lon: Number(h.lon), sog: Number(h.sog), cog: h.cog, navStatus: h.nav_status, receivedAt: iso(h.received_at)! }));
    return {
      vesselId, vessel: facts.get(vesselId) ?? null, hours,
      current: current.rows[0] ? positionApi(current.rows[0], facts.get(vesselId), this.env.POSITION_STALE_MIN) : null,
      track: fixes, summary: trackSummary(fixes),
    };
  }

  /** The feed's own account of itself: when it was last read and what came of it. */
  @RequirePerm('nmc.view') @Get('feed')
  async feed() { return feedApi(await feedState(this.pool), this.env.AIS_POLL_MINUTES); }

  /** Read the feed now rather than at the next scheduled minute — after switching the adapter live, for instance. */
  @RequirePerm('nmc.manage', 'settings.manage') @Post('feed/poll')
  async pollNow(@CurrentUser() user: Principal) {
    const out = await withTx(this.pool, async (c) => pollAis(c, { env: this.env, hub: this.hub }, { correlationId: `feed:${user.id}` }));
    await this.audit.record(this.pool, { action: 'POLL', entity: 'Feed', entityId: AIS_SOURCE, entityLabel: 'AIS/LRIT feed', after: { status: out.status, mode: out.mode, received: out.received, matched: out.matched } });
    return out;
  }

  /** The AIS adapter's way in. Service-only: a ship's position is reported by the feed, never typed by a person. */
  @ServiceOnly() @Post('positions')
  async ingest(@Body(zod(fixBody)) body: z.infer<typeof fixBody>) {
    return withTx(this.pool, async (c) => recordFix(c, this.env, body));
  }

  /* --------------------------------------------------------------------------- alerts --- */

  /* Spatial questions over the track store. The answers are the same whether PostGIS is present or
   * not; only the cost differs, and the mode is reported so an operator can see which they are on. */

  @RequirePerm('nmc.view') @Get('spatial/mode')
  async spatialMode() {
    const mode = await detectMode(this.pool, this.env.MC_FORCE_GEODESIC);
    const fences = await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM geofences WHERE active');
    return {
      mode,
      indexed: mode === 'postgis',
      note: mode === 'postgis'
        ? 'PostGIS: geodesic distances over a GiST index.'
        : 'PostGIS is not installed on this cluster; the same answers are computed from lat/lon with a bounding box and haversine.',
      geofences: Number(fences.rows[0].n),
    };
  }

  /** Vessels within a radius of a point — the question a duty officer asks about an incident. */
  @RequirePerm('nmc.view') @Get('spatial/near')
  async near(@Query() q: { lat?: string; lon?: string; radius?: string; limit?: string }) {
    const lat = Number(q.lat), lon = Number(q.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw badRequest('lat must be a number between -90 and 90');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw badRequest('lon must be a number between -180 and 180');
    // A radius is capped: an uncapped one is a request for every vessel in the store, dressed up.
    const radius = Math.min(500_000, Math.max(1, Number(q.radius) || 10_000));
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const rows = await vesselsWithin(this.pool, lat, lon, radius, limit, this.env.MC_FORCE_GEODESIC);
    return {
      centre: { lat, lon }, radiusMetres: radius, mode: await detectMode(this.pool, this.env.MC_FORCE_GEODESIC),
      vessels: rows.map((r) => ({
        vesselId: r.vessel_id, vesselName: r.vessel_name, mmsi: r.mmsi,
        lat: Number(r.lat), lon: Number(r.lon), sog: r.sog === null ? null : Number(r.sog),
        navStatus: r.nav_status, receivedAt: r.received_at.toISOString(), distanceMetres: r.distance_m,
      })),
    };
  }

  @RequirePerm('nmc.view') @Get('geofences')
  async geofences() {
    const r = await this.pool.query(
      `SELECT g.id::text, g.code, g.name, g.name_ar, g.kind, g.alert_on, g.geojson, g.active,
              (SELECT count(*) FROM geofence_events e WHERE e.geofence_id = g.id)::int AS events
         FROM geofences g WHERE g.active ORDER BY g.kind, g.code`);
    return r.rows.map((x: Record<string, unknown>) => ({
      id: x.id, code: x.code, name: x.name, nameAr: x.name_ar, kind: x.kind,
      alertOn: x.alert_on, geojson: x.geojson, events: x.events,
    }));
  }

  /** Which named areas contain a point. Used to label a fix, and to decide whether a crossing is
   *  worth an alert at all. */
  @RequirePerm('nmc.view') @Get('geofences/at')
  async fencesAt(@Query() q: { lat?: string; lon?: string }) {
    const lat = Number(q.lat), lon = Number(q.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw badRequest('lat and lon are required');
    return { lat, lon, fences: await fencesContaining(this.pool, lat, lon, this.env.MC_FORCE_GEODESIC) };
  }

  /** Re-seeds the published sea areas. Idempotent by code, so a re-run neither duplicates nor
   *  disturbs an area an operator has edited. */
  @RequirePerm('nmc.manage') @Post('geofences/seed')
  async reseedFences() {
    const n = await seedGeofences(this.pool);
    return { seeded: n };
  }

  @RequirePerm('nmc.view') @Get('alerts')
  async alerts(@Query() query: PageQuery & { acknowledged?: string; type?: string; severity?: string; vessel?: string }) {
    const p = parsePage(query, { defaultSort: '-at', maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.acknowledged !== undefined && query.acknowledged !== '') { args.push(String(query.acknowledged) === 'true'); where.push(`acknowledged = $${args.length}`); }
    if (query.type) { args.push(query.type); where.push(`type = $${args.length}`); }
    if (query.severity) { args.push(query.severity); where.push(`severity = $${args.length}`); }
    if (query.vessel) { args.push(query.vessel); where.push(`vessel_id = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(vessel_name ILIKE $${args.length} OR note ILIKE $${args.length} OR type ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM mda_alerts ${w}`, args);
    const rows = await this.pool.query<AlertRow>(`SELECT * FROM mda_alerts ${w} ORDER BY at ${p.sortDir} LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(alertApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** Raising an alert by hand — the watch sees something the derived signals did not. */
  @RequirePerm('nmc.manage') @Post('alerts')
  async raiseAlert(@Body(zod(alertBody)) body: z.infer<typeof alertBody>) {
    return withTx(this.pool, async (c) => {
      let name = body.vesselName ?? '';
      if (body.vesselId) {
        const v = await c.query<Row>('SELECT * FROM vessels WHERE id = $1', [body.vesselId]);
        if (!v.rows[0]) throw badRequest('Vessel not found on the register');
        name = name || v.rows[0].name;
      }
      const r = await c.query<AlertRow>('INSERT INTO mda_alerts(type, severity, vessel_id, vessel_name, note, at, incident_id) VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()), $7) RETURNING *',
        [body.type, body.severity, body.vesselId ?? null, name, body.note ?? '', body.at ?? null, body.incidentId ?? null]);
      const a = r.rows[0];
      await this.audit.record(c, { action: 'ALERT_RAISE', entity: 'MdaAlert', entityId: a.id, entityLabel: `${a.type} — ${a.vessel_name}`, after: alertApi(a) });
      return publishAlert(c, this.env, a, EVENTS.maritimeCentre.alertRaised);
    });
  }

  @RequirePerm('nmc.manage') @Post('alerts/:id/ack')
  async ackAlert(@Param('id') id: string, @Body(zod(ackBody)) body: z.infer<typeof ackBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<AlertRow>('SELECT * FROM mda_alerts WHERE id::text = $1 FOR UPDATE', [id]);
      const before = found.rows[0];
      if (!before) throw notFound('Alert not found');
      if (before.acknowledged) throw conflict(`That alert was already acknowledged by ${before.acknowledged_by || 'the watch'}`);
      const r = await c.query<AlertRow>('UPDATE mda_alerts SET acknowledged = true, acknowledged_by_id = $2, acknowledged_by = $3, acknowledged_at = now(), note = CASE WHEN $4 = \'\' THEN note ELSE note || \' · \' || $4 END WHERE id = $1 RETURNING *',
        [before.id, user?.id ?? null, user?.name ?? 'System', body.note ?? '']);
      const a = r.rows[0];
      await this.audit.record(c, { action: 'ALERT_ACK', entity: 'MdaAlert', entityId: a.id, entityLabel: `${a.type} — ${a.vessel_name}`, before: alertApi(before), after: alertApi(a) });
      return publishAlert(c, this.env, a, EVENTS.maritimeCentre.alertAcknowledged, { acknowledgedBy: a.acknowledged_by, acknowledgedAt: iso(a.acknowledged_at) });
    });
  }

  /* --------------------------------------------------------------------- restrictions --- */

  @RequirePerm('nmc.view') @Get('restrictions')
  async restrictions(@Query() query: PageQuery & { status?: string; kind?: string }) {
    const p = parsePage(query, { defaultSort: '-createdAt', maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.status) { args.push(query.status); where.push(`status = $${args.length}`); }
    if (query.kind) { args.push(query.kind); where.push(`kind = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(number ILIKE $${args.length} OR label ILIKE $${args.length} OR reason ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM restrictions ${w}`, args);
    const rows = await this.pool.query<RestrictionRow>(`SELECT * FROM restrictions ${w} ORDER BY created_at ${p.sortDir} LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(restrictionApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The centre proposes water be restricted; the harbour master decides. */
  @RequirePerm('nmc.manage') @Post('restrictions')
  async propose(@Body(zod(restrictionBody)) body: z.infer<typeof restrictionBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      let incident: IncidentRow | null = null;
      if (body.incidentId) {
        const i = await c.query<IncidentRow>('SELECT * FROM incidents WHERE id::text = $1', [body.incidentId]);
        incident = i.rows[0] ?? null;
        if (!incident) throw badRequest('Incident not found');
      }
      const year = new Date().getUTCFullYear();
      const seq = await c.query<{ last_value: string }>(
        'INSERT INTO numbering_series(series, last_value) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last_value = numbering_series.last_value + 1 RETURNING last_value',
        [`${this.env.RESTRICTION_PREFIX}-${year}`]);
      const number = `${this.env.RESTRICTION_PREFIX}-${year}-${String(seq.rows[0].last_value).padStart(3, '0')}`;
      const r = await c.query<RestrictionRow>(
        'INSERT INTO restrictions(number, kind, label, reason, area, effective_from, effective_to, incident_id, proposed_by_id, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [number, body.kind, body.label, body.reason ?? '', JSON.stringify(body.area), body.effectiveFrom ?? null, body.effectiveTo ?? null,
          incident?.id ?? null, user?.id ?? null, user?.name ?? 'System']);
      const x = r.rows[0];
      await this.audit.record(c, { action: 'RESTRICTION_PROPOSE', entity: 'Restriction', entityId: x.id, entityLabel: `${x.number} — ${x.label}`, after: restrictionApi(x) });
      return publishRestriction(c, this.env, x, EVENTS.maritimeCentre.restrictionProposed, { incidentId: incident?.id ?? null, incidentNumber: incident?.number ?? null, proposedBy: x.proposed_by });
    });
  }

  @RequirePerm('nmc.manage') @Put('restrictions/:id')
  async decide(@Param('id') id: string, @Body(zod(decisionBody)) body: z.infer<typeof decisionBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const found = await c.query<RestrictionRow>('SELECT * FROM restrictions WHERE id::text = $1 OR number = $1 FOR UPDATE', [id]);
      const before = found.rows[0];
      if (!before) throw notFound('Restriction not found');
      if (before.status !== 'PROPOSED' && body.status !== 'EXPIRED' && body.status !== 'WITHDRAWN') throw conflict(`${before.number} has already been ${before.status.toLowerCase()}`);
      const r = await c.query<RestrictionRow>('UPDATE restrictions SET status = $2, decided_by_id = $3, decided_by = $4, decided_at = now(), decision_note = $5, updated_at = now() WHERE id = $1 RETURNING *',
        [before.id, body.status, user?.id ?? null, user?.name ?? 'System', body.note ?? '']);
      const x = r.rows[0];
      await this.audit.record(c, { action: `RESTRICTION_${body.status}`, entity: 'Restriction', entityId: x.id, entityLabel: `${x.number} — ${x.label}`, before: restrictionApi(before), after: restrictionApi(x) });
      return publishRestriction(c, this.env, x, EVENTS.maritimeCentre.restrictionDecided, { decision: body.status, decidedBy: x.decided_by, note: body.note ?? '' });
    });
  }

  /** The open cases plotted on the picture — the same list the map overlays on the chart. */
  @RequirePerm('nmc.view') @Get('incidents')
  async openIncidents() {
    const r = await this.pool.query<IncidentRow>('SELECT * FROM incidents WHERE status = ANY($1) ORDER BY reported_at DESC LIMIT 50', [LIVE_STATUS]);
    return r.rows.map(incidentRowApi);
  }
}
