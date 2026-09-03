import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import type { Row } from './directory';

/* Local snapshots of what other domains own.
 *
 * The instrument register belongs to the instruments service and is never duplicated: what is kept
 * here is a read-model snapshot of it, projected from `readmodel.upserted { kind: 'instrument' }`, so
 * that a company record can show the licences and certificates it holds and the renewal work list can
 * be built from their expiry dates — without this service calling another one while a page renders.
 *
 * Berths are the harbour estate's; the physical particulars of a facility follow the estate, while the
 * regulatory overlay on the same identifier — its operator, its ISPS standing, what it is approved to
 * handle — stays here and is never overwritten by an estate event. */

export async function upsertInstrument(c: Queryable, i: Row) {
  await c.query(`INSERT INTO instruments(id, number, subject_kind, subject_id, entity_name, entity_type, type_label, instrument_class, class_label, status,
      applied_date, issue_date, expiry_date, statutory, in_force, signed, performance_rating, audits_count, conditions)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, subject_kind = EXCLUDED.subject_kind, subject_id = EXCLUDED.subject_id,
      entity_name = EXCLUDED.entity_name, entity_type = EXCLUDED.entity_type, type_label = EXCLUDED.type_label, instrument_class = EXCLUDED.instrument_class,
      class_label = EXCLUDED.class_label, status = EXCLUDED.status, applied_date = EXCLUDED.applied_date, issue_date = EXCLUDED.issue_date,
      expiry_date = EXCLUDED.expiry_date, statutory = EXCLUDED.statutory, in_force = EXCLUDED.in_force, signed = EXCLUDED.signed,
      performance_rating = EXCLUDED.performance_rating, audits_count = EXCLUDED.audits_count, conditions = EXCLUDED.conditions, updated_at = now()`,
    [String(i.id), i.number ?? i.licenseNo ?? '', i.subjectKind ?? 'COMPANY', i.subjectId ?? null, i.entityName ?? '', i.entityType ?? '',
      i.typeLabel ?? '', i.instrumentClass ?? 'LICENCE', i.classLabel ?? '', i.status ?? 'APPLIED',
      i.appliedDate ?? null, i.issueDate ?? null, i.expiryDate ?? null, !!i.statutory, i.inForce ?? false, !!(i.signed ?? i.signature?.value),
      i.performanceRating ?? null, Number(i.auditsCount ?? (Array.isArray(i.audits) ? i.audits.length : 0)) || 0, i.conditions ?? '']);
}

/** The physical particulars of a berth, kept in step with the harbour estate; the regulatory overlay is untouched. */
export async function refreshBerth(c: Queryable, b: Row): Promise<boolean> {
  const r = await c.query(
    `UPDATE port_facilities SET name = $2, terminal = $3, berth_type = $4, loa_max = $5, draft_max = $6,
       status = CASE WHEN $7::text = 'MAINTENANCE' THEN 'MAINTENANCE' WHEN status = 'MAINTENANCE' THEN 'OPERATIONAL' ELSE status END, updated_at = now()
     WHERE id = $1 RETURNING id`,
    [String(b.id), b.name ?? '', b.terminal ?? '', b.berthType ?? '', b.loaMax ?? null, b.draftMax ?? null, b.status ?? 'OPERATIONAL']);
  return (r.rowCount ?? 0) > 0;
}

/** The golden-record identity of a company, refreshed from master data. Standing and rating are this service's own and are never touched. */
export async function refreshCompanyIdentity(c: Queryable, g: Row): Promise<boolean> {
  const r = await c.query(
    `UPDATE companies SET code = COALESCE(NULLIF($2,''), code), name = COALESCE(NULLIF($3,''), name), updated_at = now() WHERE id = $1 RETURNING id`,
    [String(g.id), g.code ?? '', g.name ?? '']);
  return (r.rowCount ?? 0) > 0;
}

export interface SnapshotResult { kind: 'instrument' | 'berth' | 'company' | 'instrumentDeleted' | null; before?: Row | null; entity?: Row }
/** Applies a read-model event to the local snapshots, reporting what it touched so the caller can react. */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<SnapshotResult> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {};
    if (!e.id) return { kind: null };
    if (d.kind === 'instrument') {
      const prev = await c.query<Row>('SELECT * FROM instruments WHERE id = $1', [String(e.id)]);
      await upsertInstrument(c, e);
      return { kind: 'instrument', before: prev.rows[0] ?? null, entity: e };
    }
    if (d.kind === 'berth') return { kind: (await refreshBerth(c, e)) ? 'berth' : null, entity: e };
    return { kind: null };
  }
  if (event.type === EVENTS.readModel.deleted && d.kind === 'instrument' && d.id) {
    await c.query('DELETE FROM instruments WHERE id = $1', [String(d.id)]);
    return { kind: 'instrumentDeleted', entity: { id: String(d.id) } };
  }
  if (event.type === EVENTS.mdm.companyUpserted && d.companyId) {
    const touched = await refreshCompanyIdentity(c, { id: d.companyId, code: d.code, name: d.name });
    return { kind: touched ? 'company' : null, entity: { id: String(d.companyId) } };
  }
  return { kind: null };
}
