import type { PoolClient } from 'pg';
import { EVENTS, makeEvent, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, badRequest, enqueue, eventFromContext, notFound, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { iso, type Row } from './crew';
import { loadVocab } from './vocab';

/* The safe manning scale.
 *
 * A minimum safe manning document (SOLAS V/14, IMO resolution A.1047(27)) says what a ship must carry
 * before she sails: so many of each capacity, holding such a certificate. The document is an instrument on
 * the register; what a crew list can be checked against is its structured reading — one row per capacity,
 * with the count and the competency grade — and that reading lives here, one scale per ship.
 *
 * Ranks are `seafarerRank` codes, competency grades are `cocGrade` codes and the trading area is a
 * `tradingArea` code, each validated against this service's mirror of the master. When the document
 * arrives from the instrument register its number and dates are written onto the scale; the rows are the
 * flag desk's, entered from the document, because the instrument carries no structure the check could use. */

export interface ScaleRowInput { rank: string; count: number; cocGrade?: string; notes?: string }
export interface ScaleRow { rankCode: string; rank: string; count: number; cocGrade: string; cocGradeLabel: string; notes: string }
export interface ManningRow {
  id: string; vessel_id: string; vessel_name: string; imo: string; msmd_no: string; instrument_id: string | null; issued_on: Date | null; expires_on: Date | null;
  trading_area: string; rows: ScaleRow[]; remarks: string; recorded_by: string; created_at: Date; updated_at: Date;
}

export const scaleApi = (r: ManningRow, extra: { tradingAreaLabel?: string; onBoard?: { rankCode: string; rank: string; name: string; id: string }[] } = {}) => {
  const rows = r.rows ?? [];
  const compliance = extra.onBoard ? manningCheck(rows, extra.onBoard) : null;
  return {
    id: r.id, vesselId: r.vessel_id, vesselName: r.vessel_name, imo: r.imo, msmdNo: r.msmd_no, instrumentId: r.instrument_id, issuedOn: iso(r.issued_on), expiresOn: iso(r.expires_on),
    tradingArea: r.trading_area, tradingAreaLabel: extra.tradingAreaLabel ?? r.trading_area, rows, total: rows.reduce((t, x) => t + x.count, 0), officers: rows.filter((x) => x.cocGrade).reduce((t, x) => t + x.count, 0),
    recorded: rows.length > 0, documented: !!r.msmd_no, remarks: r.remarks, recordedBy: r.recorded_by, compliance, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
};
export type ScaleApi = ReturnType<typeof scaleApi>;

/* The check itself, a pure function: each capacity on the scale against the people listed in it. A rank
 * is counted by its code, so "Chief Mate" on a foreign form and "Chief Officer" on the master agree once
 * both resolve; a higher rank does not stand in for a lower one, because the document names capacities
 * and a master doubling as chief officer is exactly what the document exists to forbid. */
export interface ManningCheck { rows: { rankCode: string; rank: string; required: number; listed: number; shortfall: number }[]; required: number; listed: number; shortfalls: number; ok: boolean; unscheduled: { rankCode: string; rank: string; listed: number }[] }
export function manningCheck(scale: ScaleRow[], people: { rankCode: string; rank?: string }[]): ManningCheck {
  const counted = new Map<string, number>();
  for (const p of people) if (p.rankCode) counted.set(p.rankCode, (counted.get(p.rankCode) ?? 0) + 1);
  const rows = scale.map((s) => { const listed = counted.get(s.rankCode) ?? 0; return { rankCode: s.rankCode, rank: s.rank, required: s.count, listed, shortfall: Math.max(0, s.count - listed) }; });
  const scheduled = new Set(scale.map((s) => s.rankCode));
  const unscheduled = [...counted.entries()].filter(([code]) => !scheduled.has(code)).map(([rankCode, listed]) => ({ rankCode, rank: people.find((p) => p.rankCode === rankCode)?.rank ?? rankCode, listed }));
  const shortfalls = rows.reduce((t, r) => t + r.shortfall, 0);
  return { rows, required: rows.reduce((t, r) => t + r.required, 0), listed: people.length, shortfalls, ok: shortfalls === 0, unscheduled };
}

export async function loadScale(c: Queryable, vesselId: string): Promise<ManningRow | null> {
  const r = await c.query<ManningRow>('SELECT * FROM manning_scales WHERE vessel_id = $1', [vesselId]);
  return r.rows[0] ?? null;
}
export async function vesselOf(c: Queryable, ref: string) {
  const r = await c.query<{ id: string; name: string; imo: string; flag: string; status: string }>('SELECT id, name, imo, flag, status FROM vessels WHERE id = $1 OR imo = $1', [ref]);
  return r.rows[0] ?? null;
}

/** Resolves the desk's rows against the masters and writes the scale. */
export async function saveScale(c: PoolClient, env: Env, audit: AuditClient, vesselRef: string, input: { tradingArea: string; rows: ScaleRowInput[]; remarks?: string; msmdNo?: string; issuedOn?: string | null; expiresOn?: string | null }, by: Principal | null): Promise<ManningRow> {
  const vessel = await vesselOf(c, vesselRef);
  if (!vessel) throw notFound('Vessel not on the fleet snapshot');
  const [ranks, grades, areas] = await Promise.all([loadVocab(c, 'seafarerRank'), loadVocab(c, 'cocGrade'), loadVocab(c, 'tradingArea')]);
  const area = areas.resolve(input.tradingArea, 'tradingArea');
  if (!input.rows?.length) throw badRequest('A safe manning scale names at least one capacity');
  const seen = new Set<string>();
  const rows: ScaleRow[] = input.rows.map((r, i) => {
    const rank = ranks.resolve(r.rank, `rows[${i}].rank`);
    if (seen.has(rank.code)) throw badRequest(`${rank.label} appears twice on the scale — give one row with the total`);
    seen.add(rank.code);
    const count = Number(r.count);
    if (!Number.isInteger(count) || count < 1 || count > 99) throw badRequest(`rows[${i}].count: ${rank.label} needs a whole number of persons`);
    // a rating carries no competency grade; an officer's grade defaults to the one the rank master names
    const gradeValue = r.cocGrade ?? (rank.meta.officer === true ? String(rank.meta.cocGrade ?? '') : '');
    const grade = gradeValue ? grades.resolve(gradeValue, `rows[${i}].cocGrade`) : null;
    return { rankCode: rank.code, rank: rank.label, count, cocGrade: grade?.code ?? '', cocGradeLabel: grade?.label ?? '', notes: r.notes ?? '' };
  });
  const before = await loadScale(c, vessel.id);
  const r = await c.query<ManningRow>(
    `INSERT INTO manning_scales(vessel_id, vessel_name, imo, msmd_no, issued_on, expires_on, trading_area, rows, remarks, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (vessel_id) DO UPDATE SET vessel_name = EXCLUDED.vessel_name, imo = EXCLUDED.imo, msmd_no = COALESCE(NULLIF(EXCLUDED.msmd_no, ''), manning_scales.msmd_no), issued_on = COALESCE(EXCLUDED.issued_on, manning_scales.issued_on),
       expires_on = COALESCE(EXCLUDED.expires_on, manning_scales.expires_on), trading_area = EXCLUDED.trading_area, rows = EXCLUDED.rows, remarks = EXCLUDED.remarks, recorded_by = EXCLUDED.recorded_by, updated_at = now() RETURNING *`,
    [vessel.id, vessel.name, vessel.imo, input.msmdNo ?? '', input.issuedOn ? new Date(input.issuedOn) : null, input.expiresOn ? new Date(input.expiresOn) : null, area.code, JSON.stringify(rows), input.remarks ?? '', by?.name ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: before ? 'MANNING_SCALE_UPDATED' : 'MANNING_SCALE_RECORDED', entity: 'Vessel', entityId: vessel.id, entityLabel: vessel.name, before: before ? scaleApi(before) : null, after: scaleApi(row) });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.seafarers.manningScaleRecorded, { vesselId: vessel.id, vesselName: vessel.name, imo: vessel.imo, msmdNo: row.msmd_no, tradingArea: row.trading_area, total: rows.reduce((t, x) => t + x.count, 0), rows }, { subject: vessel.id }));
  return row;
}

/** A minimum safe manning document on the instrument register: its number and dates are written onto the ship's scale, whose rows the desk keeps. */
export async function applyMsmdInstrument(c: PoolClient, env: Env, audit: AuditClient, e: Row, cause: EventEnvelope): Promise<boolean> {
  if (String(e.entityType ?? '') !== 'MINIMUM_SAFE_MANNING_DOCUMENT' || String(e.subjectKind ?? '') !== 'VESSEL' || !e.subjectId) return false;
  const vessel = await vesselOf(c, String(e.subjectId));
  if (!vessel) return false;
  const number = String(e.number ?? e.licenseNo ?? ''); const status = String(e.status ?? '');
  const before = await loadScale(c, vessel.id);
  const r = await c.query<ManningRow>(
    `INSERT INTO manning_scales(vessel_id, vessel_name, imo, msmd_no, instrument_id, issued_on, expires_on, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (vessel_id) DO UPDATE SET msmd_no = EXCLUDED.msmd_no, instrument_id = EXCLUDED.instrument_id, issued_on = EXCLUDED.issued_on, expires_on = EXCLUDED.expires_on, updated_at = now() RETURNING *`,
    [vessel.id, vessel.name, vessel.imo, number, String(e.id), e.issueDate ? new Date(e.issueDate) : null, e.expiryDate ? new Date(e.expiryDate) : null, 'Minimum safe manning document mirrored from the instrument register — rows to be read from the document']);
  const row = r.rows[0];
  await audit.record(c, { action: 'MSMD_MIRRORED', entity: 'Vessel', entityId: vessel.id, entityLabel: vessel.name, before: before ? { msmdNo: before.msmd_no } : null, after: { msmdNo: number, status, rows: row.rows?.length ?? 0 }, note: status === 'ISSUED' ? 'Minimum safe manning document in force' : `Minimum safe manning document ${status.toLowerCase()}`, actor: { id: 'instruments', name: 'Instruments', kind: 'system' } });
  await enqueue(c, makeEvent({ type: EVENTS.seafarers.manningScaleRecorded, source: env.SERVICE_NAME, data: { vesselId: vessel.id, vesselName: vessel.name, imo: vessel.imo, msmdNo: number, instrumentId: String(e.id), status, rows: row.rows ?? [], recorded: (row.rows ?? []).length > 0 }, subject: vessel.id, correlationId: cause.correlationid, causationId: cause.id, actor: cause.actor }));
  return true;
}

/** Who the register has aboard a ship right now, in the shape the check reads. */
export async function onBoardOf(c: Queryable, vesselId: string) {
  const r = await c.query<{ id: string; name: string; rank: string; rank_code: string }>('SELECT id, name, rank, rank_code FROM seafarers WHERE current_vessel_id = $1 ORDER BY name', [vesselId]);
  return r.rows.map((s) => ({ id: s.id, name: s.name, rank: s.rank, rankCode: s.rank_code }));
}
