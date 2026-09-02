import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
import { REQUEST_OPEN_STATUS, getJurisdiction } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, RequirePerm, getContext } from '@maritime/service-kit';
import type { Env } from './env';
import { CATEGORY_AR, CATEGORY_ORDER } from './defaults';
import type { DefinitionContent } from './schema';
import type { DefinitionRow } from './repo';

export const D = 86_400_000;
export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';
export interface Card { label: string; value: string | number; sub: string; tone: Tone }
export const card = (label: string, value: string | number, sub = '', tone: Tone = 'default'): Card => ({ label, value, sub, tone });
type CatalogueRow = DefinitionRow & { live_version: number; form: DefinitionContent['form']; documents: DefinitionContent['documents']; fees: DefinitionContent['fees']; sla: DefinitionContent['sla']; outputs: DefinitionContent['outputs'] };
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The eight stat cards of the service desk, in the reporting card shape. */
export async function serviceCards(pool: Pool, env: Env): Promise<Card[]> {
  const now = new Date(); const d30 = new Date(now.getTime() - 30 * D); const d90 = new Date(now.getTime() - 90 * D);
  const one = async <T extends QueryResultRow>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows[0];
  const open = await one<{ open: string; submitted: string; assessing: string; info: string; breached: string; today: string }>(
    `SELECT count(*) FILTER (WHERE status = ANY($1::text[])) AS open, count(*) FILTER (WHERE status = 'SUBMITTED') AS submitted, count(*) FILTER (WHERE status = 'UNDER_ASSESSMENT') AS assessing, count(*) FILTER (WHERE status = 'INFO_REQUESTED') AS info,
       count(*) FILTER (WHERE status = ANY($1::text[]) AND sla_due_at < now()) AS breached, count(*) FILTER (WHERE submitted_at >= date_trunc('day', now())) AS today FROM service_requests`, [[...REQUEST_OPEN_STATUS]]);
  const decided = await one<{ approved30: string; rejected30: string; issued30: string; approved: string; rejected: string; avg90: string | null }>(
    `SELECT count(*) FILTER (WHERE status IN ('APPROVED','ISSUED') AND decided_at >= $1) AS approved30, count(*) FILTER (WHERE status = 'REJECTED' AND decided_at >= $1) AS rejected30, count(*) FILTER (WHERE status = 'ISSUED' AND closed_at >= $1) AS issued30,
       count(*) FILTER (WHERE status IN ('APPROVED','ISSUED')) AS approved, count(*) FILTER (WHERE status = 'REJECTED') AS rejected,
       avg(EXTRACT(EPOCH FROM (decided_at - submitted_at)) / 86400) FILTER (WHERE decided_at IS NOT NULL AND submitted_at IS NOT NULL AND decided_at >= $2) AS avg90 FROM service_requests`, [d30, d90]);
  const cat = await one<{ published: string; auto: string }>(`SELECT count(*) FILTER (WHERE status = 'PUBLISHED') AS published, count(*) FILTER (WHERE status = 'PUBLISHED' AND auto_approvable) AS auto FROM service_definitions`);
  const n = (v: string | null | undefined) => Number(v ?? 0);
  const totalDecided = n(decided.approved) + n(decided.rejected); const rate = totalDecided ? Math.round((n(decided.approved) / totalDecided) * 100) : 0;
  const avg = decided.avg90 == null ? 0 : round1(Number(decided.avg90));
  return [
    card('Open applications', n(open.open), n(open.today) ? `${n(open.today)} lodged today` : 'awaiting a decision', 'info'),
    card('Awaiting screening', n(open.submitted), 'not yet picked up', n(open.submitted) > 10 ? 'warning' : 'default'),
    card('Under assessment', n(open.assessing), `${n(open.info)} awaiting applicant information`),
    card('SLA breached', n(open.breached), 'open past their due date', n(open.breached) ? 'error' : 'success'),
    card('Decided (30 d)', n(decided.approved30) + n(decided.rejected30), `${n(decided.approved30)} approved · ${n(decided.rejected30)} rejected`),
    card('Approval rate', `${rate}%`, `${totalDecided} decided in all`, rate >= 80 ? 'success' : rate >= 60 ? 'default' : 'warning'),
    card('Avg decision', `${avg} d`, 'submission to decision, 90 days', avg > 21 ? 'warning' : 'default'),
    card('Catalogue', n(cat.published), `${n(cat.auto)} auto-approvable · ${env.RUNTIME_ENVIRONMENT}`, 'default'),
  ];
}

/** The catalogue applicants browse and the desk dashboard — both read the published definitions of the runtime environment. */
@Controller('services')
export class CatalogueController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}
  @RequirePerm('services.view') @Get('catalogue')
  async catalogue() {
    const lang = getContext()?.language ?? 'en'; const j = getJurisdiction(this.env.JURISDICTION);
    const r = await this.pool.query<CatalogueRow>(`SELECT d.*, v.version AS live_version, v.form, v.documents, v.fees, v.sla, v.outputs FROM service_definitions d JOIN service_definition_versions v ON v.definition_id = d.id AND v.environment = $1 AND v.status = 'PUBLISHED' WHERE d.status = 'PUBLISHED' ORDER BY d.domain, d.name`, [this.env.RUNTIME_ENVIRONMENT]);
    const byCat = new Map<string, CatalogueRow[]>();
    for (const row of r.rows) (byCat.get(row.category) ?? byCat.set(row.category, []).get(row.category)!).push(row);
    const order = (c: string) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? 999 : i; };
    const categories = [...byCat.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([category, rows]) => ({
      category, categoryAr: rows[0].category_ar ?? CATEGORY_AR[category] ?? null, label: lang === 'ar' ? rows[0].category_ar ?? CATEGORY_AR[category] ?? category : category, count: rows.length,
      services: rows.map((d) => ({
        id: d.id, key: d.key, code: d.code, name: d.name, nameAr: d.name_ar, label: lang === 'ar' && d.name_ar ? d.name_ar : d.name, description: d.description, descriptionAr: d.description_ar, subjectKind: d.subject_kind, domain: d.domain, ownerModule: d.owner_module,
        issuesInstrument: d.issues_instrument, instrumentType: d.outputs?.instrumentType ?? d.issues_instrument, autoApprovable: d.auto_approvable, version: d.live_version,
        fee: { amount: (d.fees?.lines ?? []).reduce((s, l) => s + Number(l.amount || 0), 0), currency: d.fees?.currency ?? j.currency.code, ruleSetKey: d.fees?.ruleSetKey ?? null, taxRatePct: j.tax.ratePct },
        slaDays: d.sla?.days ?? 10, fields: d.form?.fields?.length ?? 0, documents: d.documents?.length ?? 0, requiredDocuments: (d.documents ?? []).filter((x) => x.required).length,
      })),
    }));
    return { total: r.rows.length, autoApprovable: r.rows.filter((d) => d.auto_approvable).length, environment: this.env.RUNTIME_ENVIRONMENT, currency: j.currency.code, categories };
  }
  @RequirePerm('services.view') @Get('dashboard')
  async dashboard() {
    const now = new Date();
    const rows = (await this.pool.query<{ status: string; category: string; definition_key: string; definition_name: string; submitted_at: Date | null; decided_at: Date | null; closed_at: Date | null; sla_due_at: Date | null; auto: boolean }>(
      `SELECT r.status, r.category, r.definition_key, r.definition_name, r.submitted_at, r.decided_at, r.closed_at, r.sla_due_at, coalesce(d.auto_approvable, false) AS auto FROM service_requests r LEFT JOIN service_definitions d ON d.id = r.definition_id`)).rows;
    const open = rows.filter((r) => (REQUEST_OPEN_STATUS as readonly string[]).includes(r.status));
    const breached = open.filter((r) => r.sla_due_at && r.sla_due_at < now);
    const decided = rows.filter((r) => r.decided_at && r.submitted_at);
    const avg = decided.length ? round1(decided.reduce((s, r) => s + (r.decided_at!.getTime() - r.submitted_at!.getTime()), 0) / decided.length / D) : 0;
    const count = <T extends string>(key: (r: (typeof rows)[number]) => T) => { const m = new Map<T, number>(); for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1); return m; };
    const byCategory = [...count((r) => r.category).entries()].sort((a, b) => b[1] - a[1]).map(([category, n]) => ({ category, categoryAr: CATEGORY_AR[category] ?? null, count: n }));
    const byStatus = [...count((r) => r.status).entries()].map(([status, n]) => ({ status, count: n }));
    const names = new Map(rows.map((r) => [r.definition_key, r.definition_name]));
    const topServices = [...count((r) => r.definition_key).entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, n]) => ({ key, name: names.get(key) ?? key, count: n }));
    const cat = await this.pool.query<{ published: string; total: string }>("SELECT count(*) FILTER (WHERE status = 'PUBLISHED') AS published, count(*) AS total FROM service_definitions");
    return {
      total: rows.length, open: open.length, breached: breached.length, slaCompliance: open.length ? Math.round(((open.length - breached.length) / open.length) * 100) : 100, avgDecisionDays: avg,
      approved: rows.filter((r) => r.status === 'APPROVED' || r.status === 'ISSUED').length, rejected: rows.filter((r) => r.status === 'REJECTED').length, issued: rows.filter((r) => r.status === 'ISSUED').length, withdrawn: rows.filter((r) => r.status === 'WITHDRAWN').length,
      automated: rows.filter((r) => r.auto && (r.status === 'APPROVED' || r.status === 'ISSUED')).length, byCategory, byStatus, topServices, catalogue: { published: Number(cat.rows[0].published), total: Number(cat.rows[0].total) }, cards: await serviceCards(this.pool, this.env),
    };
  }
  @RequirePerm('services.view') @Get('stats')
  async stats() { return serviceCards(this.pool, this.env); }
}

@Controller('stats')
export class StatsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}
  @RequirePerm('services.view') @Get('services')
  async services() { return serviceCards(this.pool, this.env); }
}
