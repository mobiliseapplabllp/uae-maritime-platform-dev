import { join } from 'node:path';
import { buildWorld, geoFor, stableId, type WorldIncident, type WorldPosition } from '@maritime/world';
import { createDb, runMigrations, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { upsertBerth, upsertVessel } from './subjects';
import { PRIORITY_OF, type Row } from './incidents';

/* Seeds the maritime centre from the shared world: every case file since 2023 with the thread the desk worked it
 * on — communications, response tasks, documents, the operational log and the status trail — plus the live
 * surveillance picture: a current fix for every tracked target, a short track behind each one, and the MDA
 * alerts the watch has and has not yet acknowledged. The ships and berths cases are raised against are seeded
 * too, so the desk is usable before any event arrives. Idempotent: every write is an upsert on the world's
 * stable id, and the numbering series are advanced past the seeded numbers. */

async function advance(c: Queryable, series: string, value: number) {
  await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1,$2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [series, value]);
}
/** `INC-2026-0087` → the series `INC-2026` at 87. */
function noteSeries(series: Map<string, number>, value: string) {
  const at = value.lastIndexOf('-');
  if (at < 0) return;
  const key = value.slice(0, at); const n = Number(value.slice(at + 1));
  if (Number.isFinite(n)) series.set(key, Math.max(series.get(key) ?? 0, n));
}
const MIN = 60_000;
/* The track behind a target, walked back along the reciprocal of her course at the speed she is making. A moored
 * or anchored ship barely moves, so her track is a tight cluster rather than a line — which is exactly what the
 * watch expects to see when she is alongside. */
function backTrack(p: WorldPosition, fixes = 12, everyMin = 10) {
  const out: { lat: number; lon: number; sog: number; cog: number; navStatus: string; receivedAt: string }[] = [];
  const t0 = new Date(p.timestamp).getTime();
  const rad = ((p.cog + 180) % 360) * (Math.PI / 180);
  for (let k = fixes; k >= 1; k -= 1) {
    const hours = (k * everyMin) / 60;
    const nm = p.sog * hours;
    const dLat = (nm * Math.cos(rad)) / 60;
    const dLon = (nm * Math.sin(rad)) / (60 * Math.cos((p.lat * Math.PI) / 180));
    out.push({
      lat: Math.round((p.lat + dLat) * 1e5) / 1e5, lon: Math.round((p.lon + dLon) * 1e5) / 1e5,
      sog: p.sog, cog: p.cog, navStatus: p.navStatus, receivedAt: new Date(t0 - k * everyMin * MIN).toISOString(),
    });
  }
  out.push({ lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog, navStatus: p.navStatus, receivedAt: new Date(t0).toISOString() });
  return out;
}

export async function seedMaritimeCentre(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const geo = geoFor(world.profile);
  const now = new Date(world.now);
  const berthById = new Map(world.berths.map((b) => [b.id, b]));
  const userByName = new Map(world.users.map((u) => [u.name, u]));

  const counts = await withTx(pool, async (c) => {
    for (const v of world.vessels) await upsertVessel(c, { id: v.id, imo: v.imo, mmsi: v.mmsi, name: v.name, type: v.type, flag: v.flag, status: v.status, real: v.real });
    for (const b of world.berths) await upsertBerth(c, { id: b.id, code: b.code, name: b.name, terminal: b.terminal, status: b.status });

    const series = new Map<string, number>();
    let comms = 0; let tasks = 0; let documents = 0; let logs = 0; let history = 0;
    for (const i of world.incidents as WorldIncident[]) {
      const berth = i.berthId ? berthById.get(i.berthId) : undefined;
      const responding = i.statusHistory.find((h) => h.to === 'RESPONDING')?.at ?? null;
      await c.query(`INSERT INTO incidents(id, number, category, type, severity, priority, status, title, description, vessel_id, vessel_name, berth_id, berth_code, berth_terminal,
          location, reported_at, reported_by, source, assigned_to_id, assigned_to, assets, injuries, pollution_tier, weather, rca,
          acknowledged_at, responding_at, resolved_at, closed_at, outcome, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
        ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, category = EXCLUDED.category, type = EXCLUDED.type, severity = EXCLUDED.severity, priority = EXCLUDED.priority,
          status = EXCLUDED.status, title = EXCLUDED.title, description = EXCLUDED.description, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name,
          berth_id = EXCLUDED.berth_id, berth_code = EXCLUDED.berth_code, berth_terminal = EXCLUDED.berth_terminal, location = EXCLUDED.location,
          reported_at = EXCLUDED.reported_at, reported_by = EXCLUDED.reported_by, source = EXCLUDED.source, assigned_to_id = EXCLUDED.assigned_to_id,
          assigned_to = EXCLUDED.assigned_to, assets = EXCLUDED.assets, injuries = EXCLUDED.injuries, pollution_tier = EXCLUDED.pollution_tier,
          weather = EXCLUDED.weather, rca = EXCLUDED.rca, acknowledged_at = EXCLUDED.acknowledged_at, responding_at = EXCLUDED.responding_at,
          resolved_at = EXCLUDED.resolved_at, closed_at = EXCLUDED.closed_at, outcome = EXCLUDED.outcome, created_at = EXCLUDED.created_at, updated_at = now()`,
        [i.id, i.number, i.category, i.type, i.severity, i.priority ?? PRIORITY_OF[i.severity] ?? 'P3', i.status, i.title, i.description,
          i.vesselId, i.vesselName, i.berthId, i.berthCode, berth?.terminal ?? '', JSON.stringify(i.location), i.reportedAt, i.reportedBy, i.source,
          i.assignedToId, i.assignedTo, JSON.stringify(i.assets), i.injuries, i.pollutionTier, JSON.stringify(i.weather), JSON.stringify(i.rca),
          i.acknowledgedAt, responding, i.resolvedAt, i.closedAt, i.outcome, i.reportedAt]);
      noteSeries(series, i.number);

      await c.query('DELETE FROM incident_comms WHERE incident_id = $1', [i.id]);
      for (const [ix, m] of i.comms.entries()) {
        await c.query('INSERT INTO incident_comms(id, incident_id, at, by_id, by_name, channel, direction, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [stableId('inccomm', `${i.number}:${ix}`), i.id, m.at, userByName.get(m.by)?.id ?? null, m.by, m.channel, m.direction, m.message]);
        comms += 1;
      }
      await c.query('DELETE FROM incident_tasks WHERE incident_id = $1', [i.id]);
      for (const [ix, t] of i.tasks.entries()) {
        await c.query('INSERT INTO incident_tasks(id, incident_id, title, assignee_id, assignee, due, status, done_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [stableId('inctask', `${i.number}:${ix}`), i.id, t.title, t.assigneeId, t.assignee, t.due, t.status, t.doneAt, i.reportedAt]);
        tasks += 1;
      }
      await c.query('DELETE FROM incident_documents WHERE incident_id = $1', [i.id]);
      for (const [ix, d] of i.documents.entries()) {
        await c.query('INSERT INTO incident_documents(id, incident_id, name, doc_type, size_kb, uploaded_by_id, uploaded_by, at, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [stableId('incdoc', `${i.number}:${ix}`), i.id, d.name, d.docType, d.sizeKB, userByName.get(d.uploadedBy)?.id ?? null, d.uploadedBy, d.at, d.note]);
        documents += 1;
      }
      await c.query('DELETE FROM incident_log WHERE incident_id = $1', [i.id]);
      for (const [ix, l] of i.log.entries()) {
        await c.query('INSERT INTO incident_log(id, incident_id, at, by_id, by_name, entry) VALUES ($1,$2,$3,$4,$5,$6)',
          [stableId('inclog', `${i.number}:${ix}`), i.id, l.at, userByName.get(l.by)?.id ?? null, l.by, l.entry]);
        logs += 1;
      }
      await c.query('DELETE FROM incident_status_history WHERE incident_id = $1', [i.id]);
      for (const [ix, h] of i.statusHistory.entries()) {
        await c.query('INSERT INTO incident_status_history(id, incident_id, from_status, to_status, at, by_id, by_name, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [stableId('inchist', `${i.number}:${ix}`), i.id, h.from, h.to, h.at, userByName.get(h.by)?.id ?? null, h.by, h.note]);
        history += 1;
      }
    }
    for (const [key, n] of series) await advance(c, key, n);

    let fixes = 0;
    for (const p of world.positions as WorldPosition[]) {
      await c.query(`INSERT INTO positions(id, vessel_id, vessel_name, mmsi, lat, lon, sog, cog, heading, nav_status, destination, source, received_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (vessel_id) DO UPDATE SET vessel_name = EXCLUDED.vessel_name, mmsi = EXCLUDED.mmsi, lat = EXCLUDED.lat, lon = EXCLUDED.lon, sog = EXCLUDED.sog,
          cog = EXCLUDED.cog, heading = EXCLUDED.heading, nav_status = EXCLUDED.nav_status, destination = EXCLUDED.destination, source = EXCLUDED.source,
          received_at = EXCLUDED.received_at, updated_at = now()`,
        [p.id, p.vesselId, p.vesselName, p.mmsi, p.lat, p.lon, p.sog, p.cog, p.heading, p.navStatus, p.destination, p.source, p.timestamp]);
      // the synthesised track is rebuilt rather than appended: the world's clock moves between builds, so an
      // append would stack a fresh track behind the target on every seed
      await c.query('DELETE FROM position_history WHERE vessel_id = $1', [p.vesselId]);
      for (const f of backTrack(p)) {
        await c.query('INSERT INTO position_history(vessel_id, lat, lon, sog, cog, nav_status, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [p.vesselId, f.lat, f.lon, f.sog, f.cog, f.navStatus, f.receivedAt]);
        fixes += 1;
      }
    }

    /* The world keys an alert on the moment it fired, which moves with the world's clock; the register keys it on
     * what the alert is about and where it sits in the watch's list, so re-seeding refreshes the same rows. */
    for (const [ix, a] of world.mdaAlerts.entries()) {
      await c.query(`INSERT INTO mda_alerts(id, type, severity, vessel_id, vessel_name, note, at, acknowledged, acknowledged_by_id, acknowledged_by, acknowledged_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$7)
        ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, severity = EXCLUDED.severity, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name,
          note = EXCLUDED.note, at = EXCLUDED.at, acknowledged = EXCLUDED.acknowledged, acknowledged_by_id = EXCLUDED.acknowledged_by_id,
          acknowledged_by = EXCLUDED.acknowledged_by, acknowledged_at = EXCLUDED.acknowledged_at`,
        [stableId('mdaalert', `${a.type}:${a.vesselId ?? 'none'}:${ix}`), a.type, a.severity, a.vesselId, a.vesselName, a.note, a.at, a.acknowledged, a.acknowledgedById, a.acknowledgedBy, a.acknowledgedAt]);
    }

    /* The restriction the live navigation hazard produced: the drifting container in the southern approaches is
     * under a proposed safety zone until the survey launch verifies or recovers it. */
    const hazard = world.incidents.find((i) => i.type === 'NAV_HAZARD' && i.status === 'MONITORING');
    const restrictions: Row[] = hazard ? [{
      id: stableId('restriction', `${hazard.number}:zone`), number: `NTM-${new Date(hazard.reportedAt).getUTCFullYear()}-001`, kind: 'SAFETY_ZONE',
      label: 'Southern approaches — floating object', reason: `${hazard.number}: ${hazard.title}`,
      area: [
        { lat: hazard.location.lat - 0.03, lon: hazard.location.lon - 0.03 }, { lat: hazard.location.lat - 0.03, lon: hazard.location.lon + 0.03 },
        { lat: hazard.location.lat + 0.03, lon: hazard.location.lon + 0.03 }, { lat: hazard.location.lat + 0.03, lon: hazard.location.lon - 0.03 },
      ],
      effectiveFrom: hazard.reportedAt, effectiveTo: new Date(new Date(hazard.reportedAt).getTime() + 7 * 24 * 3_600_000).toISOString(),
      status: 'PROPOSED', incidentId: hazard.id, proposedById: hazard.assignedToId, proposedBy: hazard.assignedTo,
    }] : [];
    // a standing speed limit in the approach channel, already decided, so the picture shows both states
    restrictions.push({
      id: stableId('restriction', 'channel-speed'), number: `NTM-${now.getUTCFullYear()}-002`, kind: 'SPEED_LIMIT',
      label: 'Approach channel — 8 kn limit', reason: 'Standing navigational restriction inside the fairway',
      area: [
        { lat: geo.approach[0] - 0.12, lon: geo.approach[1] - 0.12 }, { lat: geo.approach[0] - 0.10, lon: geo.approach[1] - 0.14 },
        { lat: geo.approach[0] + 0.02, lon: geo.approach[1] + 0.02 }, { lat: geo.approach[0], lon: geo.approach[1] + 0.04 },
      ],
      effectiveFrom: new Date(now.getTime() - 180 * 24 * 3_600_000).toISOString(), effectiveTo: null,
      status: 'APPROVED', incidentId: null, proposedById: null, proposedBy: 'Marine control room',
    });
    for (const r of restrictions) {
      await c.query(`INSERT INTO restrictions(id, number, kind, label, reason, area, effective_from, effective_to, status, incident_id, proposed_by_id, proposed_by, decided_by, decided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, kind = EXCLUDED.kind, label = EXCLUDED.label, reason = EXCLUDED.reason, area = EXCLUDED.area,
          effective_from = EXCLUDED.effective_from, effective_to = EXCLUDED.effective_to, status = EXCLUDED.status, incident_id = EXCLUDED.incident_id,
          proposed_by_id = EXCLUDED.proposed_by_id, proposed_by = EXCLUDED.proposed_by, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at, updated_at = now()`,
        [r.id, r.number, r.kind, r.label, r.reason, JSON.stringify(r.area), r.effectiveFrom, r.effectiveTo, r.status, r.incidentId, r.proposedById, r.proposedBy,
          r.status === 'APPROVED' ? 'Harbour Master' : '', r.status === 'APPROVED' ? r.effectiveFrom : null]);
      noteSeries(series, r.number);
    }
    for (const [key, n] of series) await advance(c, key, n);

    return {
      profile: world.profile, incidents: world.incidents.length, comms, tasks, documents, logEntries: logs, statusHistory: history,
      positions: world.positions.length, trackFixes: fixes, alerts: world.mdaAlerts.length,
      unacknowledgedAlerts: world.mdaAlerts.filter((a) => !a.acknowledged).length, restrictions: restrictions.length,
      vessels: world.vessels.length, berths: world.berths.length, series: series.size,
    };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedMaritimeCentre(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
