import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import { recipientWhere, type Row } from './instruments';

/* The one fact this register needs from another domain: who is on the staff roll.
 *
 * An instrument that requires acknowledgement is addressed to a class of people — everybody, a role,
 * or a department — and the outstanding list is that class minus the receipts already recorded. Both
 * halves have to be answerable from one database, so the roll is projected here from identity's
 * read-model events rather than fetched over the wire while a page is rendering. */

export async function upsertUser(c: Queryable, u: Row) {
  await c.query(`INSERT INTO users(id, name, email, role_name, designation, department, active) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, role_name = EXCLUDED.role_name,
      designation = EXCLUDED.designation, department = EXCLUDED.department, active = EXCLUDED.active, updated_at = now()`,
    [String(u.id), u.name ?? '', u.email ?? '', u.roleName ?? u.role?.name ?? u.role_name ?? '', u.designation ?? '', u.department ?? '', u.active === undefined ? true : !!u.active]);
}

/** Applies a read-model event to the local roll. Returns whether the event was relevant. */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted && d.kind === 'user') {
    const e: Row = d.entity ?? {};
    if (!e.id) return false;
    await upsertUser(c, e);
    return true;
  }
  if (event.type === EVENTS.readModel.deleted && d.kind === 'user' && d.id) {
    await c.query('UPDATE users SET active = false, updated_at = now() WHERE id = $1', [String(d.id)]);
    return true;
  }
  if (event.type === EVENTS.identity.userChanged && d.user?.id) { await upsertUser(c, d.user); return true; }
  return false;
}

export interface Recipient { id: string; name: string; roleName: string; department: string; email: string }
/** Everybody an instrument is addressed to, from the local roll. */
export async function recipientsOf(c: Queryable, cls: string, value: string): Promise<Recipient[]> {
  const w = recipientWhere(cls, value);
  const r = await c.query<{ id: string; name: string; role_name: string; department: string; email: string }>(
    `SELECT id, name, role_name, department, email FROM users WHERE ${w.sql} ORDER BY name`, w.args);
  return r.rows.map((x) => ({ id: x.id, name: x.name, roleName: x.role_name, department: x.department, email: x.email }));
}
export async function recipientCount(c: Queryable, cls: string, value: string): Promise<number> {
  const w = recipientWhere(cls, value);
  const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE ${w.sql}`, w.args);
  return Number(r.rows[0].n);
}
/** Whether one person is inside an instrument's recipient class. */
export async function isRecipient(c: Queryable, cls: string, value: string, userId: string): Promise<boolean> {
  const w = recipientWhere(cls, value);
  const r = await c.query(`SELECT 1 FROM users WHERE id = $${w.args.length + 1} AND ${w.sql} LIMIT 1`, [...w.args, userId]);
  return (r.rowCount ?? 0) > 0;
}

export interface RecipientCounts { all: number; byRole: Map<string, number>; byDepartment: Map<string, number> }
/** Class sizes for the whole roll in two queries, so the dashboard never counts recipients one instrument at a time. */
export async function recipientCounts(c: Queryable): Promise<RecipientCounts> {
  const all = await c.query<{ n: string }>('SELECT count(*) AS n FROM users WHERE active');
  const grouped = await c.query<{ kind: string; key: string; n: string }>(
    `SELECT 'ROLE' AS kind, lower(role_name) AS key, count(*) AS n FROM users WHERE active GROUP BY 2
     UNION ALL
     SELECT 'DEPARTMENT' AS kind, lower(department) AS key, count(*) AS n FROM users WHERE active GROUP BY 2`);
  const byRole = new Map<string, number>(); const byDepartment = new Map<string, number>();
  for (const r of grouped.rows) (r.kind === 'ROLE' ? byRole : byDepartment).set(r.key ?? '', Number(r.n));
  return { all: Number(all.rows[0].n), byRole, byDepartment };
}
export const recipientsIn = (counts: RecipientCounts, cls: string, value: string): number =>
  (cls === 'ROLE' ? counts.byRole.get(String(value).toLowerCase()) : cls === 'DEPARTMENT' ? counts.byDepartment.get(String(value).toLowerCase()) : counts.all) ?? 0;
