import type { PoolClient } from 'pg';
import { NATIONAL_SCOPE, EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { findSeafarer, publishSeafarer, type Row } from './crew';
import { certVocab } from './vocab';

/* Local snapshot of the fleet, and the one inbound event that changes a record this service owns.
 *
 * A certificate of competency or proficiency issued by the instruments service arrives as
 * `readmodel.upserted { kind: instrument }` with `subjectKind: SEAFARER`. It is merged onto the seafarer's
 * document list keyed on the instrument, so a reissue replaces the entry rather than doubling it, and it is
 * kept read-only: the register is the authority on what it issued. */

export async function upsertVessel(c: Queryable, v: Row) {
  await c.query(`INSERT INTO vessels(id, imo, name, type, flag, status, real) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag, status = EXCLUDED.status, real = EXCLUDED.real, updated_at = now()`,
    [String(v.id), v.imo ?? '', v.name ?? '', v.type ?? 'GEN', v.flag ?? '', v.status ?? 'ACTIVE', !!v.real]);
  // a ship renamed on the register is renamed on the crew records that name her
  await c.query('UPDATE seafarers SET current_vessel_name = $2, updated_at = now() WHERE current_vessel_id = $1 AND current_vessel_name IS DISTINCT FROM $2', [String(v.id), v.name ?? '']);
  await c.query('UPDATE sea_service SET vessel_name = $2, imo = $3, updated_at = now() WHERE vessel_id = $1 AND (vessel_name IS DISTINCT FROM $2 OR imo IS DISTINCT FROM $3)', [String(v.id), v.name ?? '', v.imo ?? '']);
}

/** Merges an instrument-issued document onto the seafarer's list. Returns the seafarer whose record changed. */
export async function mergeInstrument(c: Queryable, e: Row): Promise<string | null> {
  const subjectId = String(e.subjectId ?? '');
  if (String(e.subjectKind ?? '') !== 'SEAFARER' || !subjectId) return null;
  const s = await c.query<{ id: string }>('SELECT id FROM seafarers WHERE id::text = $1', [subjectId]);
  if (!s.rowCount) return null;
  const certType = String(e.typeLabel ?? e.entityType ?? '').trim();
  const expiry = e.expiryDate ?? null;
  if (!certType || !expiry) return null;
  const instrumentId = String(e.id ?? e.instrumentId ?? '');
  // the register's label is kept as it came; the master's code travels beside it when the master knows the document
  const certCode = (await certVocab(c)).find(certType)?.code ?? (await certVocab(c)).find(String(e.entityType ?? ''))?.code ?? '';
  const cols = [certType, certCode, e.grade ?? '', e.number ?? e.licenseNo ?? '', e.issuer ?? '', e.issueDate ?? null, expiry,
    `Issued on the instrument register${e.status && e.status !== 'ISSUED' ? ` — ${String(e.status).toLowerCase()}` : ''}`,
    instrumentId, true, e.inForce ?? (e.status === 'ISSUED'), e.forceReason ?? '', !!e.signed];
  const existing = await c.query<{ id: string }>('SELECT id FROM seafarer_certificates WHERE instrument_id = $1 OR (seafarer_id = $2 AND cert_type = $3 AND instrument_id IS NOT NULL) LIMIT 1', [instrumentId, subjectId, certType]);
  if (existing.rowCount) {
    await c.query(`UPDATE seafarer_certificates SET cert_type = $2, cert_code = $3, grade = $4, number = $5, issuer = $6, issue_date = $7, expiry_date = $8, remarks = $9, instrument_id = $10, on_register = $11, in_force = $12, force_reason = $13, signed = $14, updated_at = now() WHERE id = $1`, [existing.rows[0].id, ...cols]);
  } else {
    await c.query(`INSERT INTO seafarer_certificates(seafarer_id, cert_type, cert_code, grade, number, issuer, issue_date, expiry_date, remarks, instrument_id, on_register, in_force, force_reason, signed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [subjectId, ...cols]);
  }
  return subjectId;
}

/** The light mirror of a port call a crew list is lodged against: the reference, the ship, who lodged it and the crew the general declaration gave. */
export async function upsertPortCall(c: Queryable, p: Row) {
  await c.query(`INSERT INTO port_calls(id, vcn, vessel_id, vessel_name, vessel_imo, agent_code, agent_name, status, port, berth_code, eta, ata, atd, declared_crew)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, vessel_imo = EXCLUDED.vessel_imo, agent_code = EXCLUDED.agent_code, agent_name = EXCLUDED.agent_name,
      status = EXCLUDED.status, port = EXCLUDED.port, berth_code = EXCLUDED.berth_code, eta = EXCLUDED.eta, ata = EXCLUDED.ata, atd = EXCLUDED.atd, declared_crew = EXCLUDED.declared_crew, updated_at = now()`,
    [String(p.id), String(p.vcn ?? ''), String(p.vesselId ?? ''), String(p.vesselName ?? ''), String(p.vesselImo ?? p.vessel?.imo ?? ''), String(p.agentCode ?? ''), String(p.agentName ?? ''), String(p.status ?? ''),
      String(p.scopePort ?? p.scope?.port ?? p.port ?? ''), p.berthCode ?? null, p.eta ?? null, p.ata ?? null, p.atd ?? null, p.crew?.count != null ? Number(p.crew.count) : null]);
  // a stale row holding the same reference under another id is the same call renumbered
  await c.query('DELETE FROM port_calls WHERE vcn = $1 AND id <> $2', [String(p.vcn ?? ''), String(p.id)]);
}

/** Applies a read-model event to the local snapshots. Returns the seafarer id whose record changed, if any. */
export async function projectSnapshot(c: PoolClient, env: Env, event: EventEnvelope): Promise<string | null> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {};
    if (d.kind === 'vessel' && e.id) { await upsertVessel(c, e); return null; }
    if (d.kind === 'portCall' && e.id && e.vcn) { await upsertPortCall(c, e); return null; }
    if (d.kind === 'instrument' && event.source !== env.SERVICE_NAME) return mergeInstrument(c, e);
    return null;
  }
  if (event.type === EVENTS.readModel.deleted && d.kind === 'vessel' && d.id) { await c.query('DELETE FROM vessels WHERE id = $1', [String(d.id)]); return null; }
  if (event.type === EVENTS.readModel.deleted && d.kind === 'portCall' && d.id) { await c.query('DELETE FROM port_calls WHERE id = $1', [String(d.id)]); return null; }
  if (event.type === EVENTS.mdm.vesselUpserted && d.vesselId) { await upsertVessel(c, { id: d.vesselId, imo: d.imo, name: d.name, status: d.status }); return null; }
  return null;
}

/** Republishes a seafarer whose record changed because something arrived for them. */
export async function republishSeafarer(c: PoolClient, env: Env, id: string, cause: EventEnvelope) {
  // the projection is the platform acting on itself, not a reader
  const s = await findSeafarer(c, id, NATIONAL_SCOPE);
  if (s) await publishSeafarer(c, env, s, { cause });
}
