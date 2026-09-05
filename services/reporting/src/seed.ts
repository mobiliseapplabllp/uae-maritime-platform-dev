import { join } from 'node:path';
import { buildWorld, geoFor, isStatutory, stableId, type World } from '@maritime/world';
import { getJurisdiction } from '@maritime/contracts';
import { makeEvent, EVENTS } from '@maritime/contracts';
import { createDb, runMigrations, withTx, createCache } from '@maritime/service-kit';
import { env } from './env';
import { project, invalidateDerived } from './consumer';

/** Report library — saved reports run over the read models. Bilingual names; categories match the module colours. */
export const REPORTS = [
  { key: 'port-calls-by-month', name: 'Port calls by month', nameAr: 'المكالمات الميناء حسب الشهر', category: 'Traffic', description: 'Calls, sailings, turnaround and cargo per month', perm: 'portcalls.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'month', label: 'Month' }, { key: 'calls', label: 'Calls', align: 'right' }, { key: 'sailed', label: 'Sailed', align: 'right' }, { key: 'avg_turnaround_h', label: 'Avg turnaround (h)', align: 'right' }, { key: 'cargo_mt', label: 'Cargo (MT)', align: 'right' }, { key: 'teu', label: 'TEU', align: 'right' }], queryKey: 'portCallsByMonth' },
  { key: 'cargo-by-commodity', name: 'Cargo by commodity', nameAr: 'البضائع حسب السلعة', category: 'Traffic', description: 'Tonnage and operations per commodity', perm: 'portcalls.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'commodity', label: 'Commodity' }, { key: 'cargo_mt', label: 'Cargo (MT)', align: 'right' }, { key: 'operations', label: 'Operations', align: 'right' }], queryKey: 'cargoByCommodity' },
  { key: 'berth-occupancy', name: 'Berth occupancy', nameAr: 'إشغال الأرصفة', category: 'Traffic', description: 'Hours alongside and occupancy per berth, trailing 12 months', perm: 'portcalls.view', params: [], columns: [{ key: 'code', label: 'Berth' }, { key: 'terminal', label: 'Terminal' }, { key: 'berth_type', label: 'Type' }, { key: 'calls_12m', label: 'Calls', align: 'right' }, { key: 'hours_alongside', label: 'Hours alongside', align: 'right' }, { key: 'occupancy_pct', label: 'Occupancy %', align: 'right' }], queryKey: 'berthOccupancy' },
  { key: 'vessel-calls', name: 'Vessel call frequency', nameAr: 'تكرار مكالمات السفن', category: 'Fleet', description: 'Calls per vessel in the window', perm: 'vessels.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'name', label: 'Vessel' }, { key: 'imo', label: 'IMO' }, { key: 'type', label: 'Type' }, { key: 'flag', label: 'Flag' }, { key: 'calls', label: 'Calls', align: 'right' }, { key: 'last_call', label: 'Last call' }], queryKey: 'vesselCalls' },
  { key: 'agent-performance', name: 'Agent performance', nameAr: 'أداء الوكلاء', category: 'Traffic', description: 'Calls, waiting and turnaround by shipping agent', perm: 'portcalls.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'agent_code', label: 'Code' }, { key: 'agent_name', label: 'Agent' }, { key: 'calls', label: 'Calls', align: 'right' }, { key: 'avg_wait_h', label: 'Avg wait (h)', align: 'right' }, { key: 'avg_turnaround_h', label: 'Avg turnaround (h)', align: 'right' }], queryKey: 'agentPerformance' },
  { key: 'revenue-by-month', name: 'Revenue by month', nameAr: 'الإيرادات حسب الشهر', category: 'Revenue', description: 'Billed, tax and collected per month', perm: 'invoices.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'month', label: 'Month' }, { key: 'invoices', label: 'Invoices', align: 'right' }, { key: 'subtotal', label: 'Subtotal', align: 'right' }, { key: 'tax', label: 'Tax', align: 'right' }, { key: 'total', label: 'Total', align: 'right' }, { key: 'collected', label: 'Collected', align: 'right' }], queryKey: 'revenueByMonth' },
  { key: 'outstanding-invoices', name: 'Outstanding invoices', nameAr: 'الفواتير المستحقة', category: 'Revenue', description: 'Issued and unpaid, oldest first', perm: 'invoices.view', params: [], columns: [{ key: 'number', label: 'Invoice' }, { key: 'vessel_name', label: 'Vessel' }, { key: 'bill_to_name', label: 'Bill to' }, { key: 'total', label: 'Total', align: 'right' }, { key: 'issued_at', label: 'Issued' }, { key: 'days_outstanding', label: 'Days', align: 'right' }], queryKey: 'outstandingInvoices' },
  { key: 'inspection-summary', name: 'Inspection summary', nameAr: 'ملخص التفتيش', category: 'Compliance', description: 'Inspections, detentions and findings by type', perm: 'inspections.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'type', label: 'Type' }, { key: 'inspections', label: 'Inspections', align: 'right' }, { key: 'closed', label: 'Closed', align: 'right' }, { key: 'detentions', label: 'Detentions', align: 'right' }, { key: 'findings', label: 'Findings', align: 'right' }, { key: 'open_findings', label: 'Open', align: 'right' }, { key: 'avg_score', label: 'Avg score %', align: 'right' }], queryKey: 'inspectionSummary' },
  { key: 'detentions', name: 'Detention register', nameAr: 'سجل الاحتجاز', category: 'Compliance', description: 'Detentions ordered in the window', perm: 'inspections.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'number', label: 'Inspection' }, { key: 'vessel_name', label: 'Vessel' }, { key: 'type', label: 'Type' }, { key: 'inspector', label: 'Inspector' }, { key: 'closed_at', label: 'Closed' }, { key: 'total_findings', label: 'Findings', align: 'right' }], queryKey: 'detentions' },
  { key: 'certificate-expiry', name: 'Certificate expiry', nameAr: 'انتهاء الشهادات', category: 'Fleet', description: 'Fleet certificates expiring within the window', perm: 'certificates.view', params: [{ name: 'days', label: 'Days ahead', type: 'number', default: 90 }], columns: [{ key: 'vessel', label: 'Vessel' }, { key: 'imo', label: 'IMO' }, { key: 'cert_type', label: 'Certificate' }, { key: 'number', label: 'Number' }, { key: 'issuer', label: 'Issuer' }, { key: 'expiry_date', label: 'Expires' }], queryKey: 'certificateExpiry' },
  { key: 'incident-summary', name: 'Incident summary', nameAr: 'ملخص الحوادث', category: 'Safety', description: 'Cases by category, type and severity', perm: 'incidents.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'category', label: 'Category' }, { key: 'type', label: 'Type' }, { key: 'severity', label: 'Severity' }, { key: 'cases', label: 'Cases', align: 'right' }, { key: 'closed', label: 'Closed', align: 'right' }, { key: 'avg_close_days', label: 'Avg close (d)', align: 'right' }], queryKey: 'incidentSummary' },
  { key: 'crew-roster', name: 'Crew roster', nameAr: 'قائمة الطاقم', category: 'Crew', description: 'Every seafarer on the roll with assignment and alerts', perm: 'seafarers.view', params: [], columns: [{ key: 'name', label: 'Name' }, { key: 'rank', label: 'Rank' }, { key: 'cdc_no', label: 'CDC' }, { key: 'nationality', label: 'Nationality' }, { key: 'status', label: 'Status' }, { key: 'current_vessel_name', label: 'On board' }, { key: 'cert_alerts', label: 'Alerts', align: 'right' }], queryKey: 'crewRoster' },
  { key: 'licence-register', name: 'Licence register', nameAr: 'سجل التراخيص', category: 'Companies', description: 'Company and facility licences by expiry', perm: 'facilities.view', params: [], columns: [{ key: 'number', label: 'Number' }, { key: 'entity_name', label: 'Holder' }, { key: 'entity_type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'issue_date', label: 'Issued' }, { key: 'expiry_date', label: 'Expires' }, { key: 'performance_rating', label: 'Rating', align: 'right' }], queryKey: 'licenceRegister' },
  { key: 'notices-register', name: 'Notices & circulars register', nameAr: 'سجل الإشعارات والتعاميم', category: 'Compliance', description: 'Every instrument with acknowledgment counts', perm: 'legislation.view', params: [], columns: [{ key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Title' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'issued_date', label: 'Issued' }, { key: 'acknowledgments', label: 'Acknowledged', align: 'right' }], queryKey: 'noticesRegister' },
  { key: 'user-activity', name: 'User activity', nameAr: 'نشاط المستخدمين', category: 'Administration', description: 'Accounts by last sign-in', perm: 'users.view', params: [], columns: [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role_name', label: 'Role' }, { key: 'department', label: 'Department' }, { key: 'active', label: 'Active' }, { key: 'last_login_at', label: 'Last sign-in' }], queryKey: 'userActivity' },
  { key: 'audit-summary', name: 'Audit summary', nameAr: 'ملخص التدقيق', category: 'Administration', description: 'Entries by entity and action', perm: 'audit.view', params: [{ name: 'days', label: 'Days', type: 'number', default: 30 }], columns: [{ key: 'entity', label: 'Entity' }, { key: 'action', label: 'Action' }, { key: 'entries', label: 'Entries', align: 'right' }, { key: 'last_at', label: 'Last' }], queryKey: 'auditSummary' },
  { key: 'tariff-schedule', name: 'Tariff schedule', nameAr: 'جدول التعرفة', category: 'Revenue', description: 'The published rate card', perm: 'tariffs.view', params: [], columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Charge' }, { key: 'category', label: 'Category' }, { key: 'unit', label: 'Unit' }, { key: 'rate', label: 'Rate', align: 'right' }, { key: 'active', label: 'Active' }, { key: 'revisions', label: 'Revisions', align: 'right' }], queryKey: 'tariffSchedule' },
];

const ev = (kind: string, entity: unknown) => makeEvent({ type: EVENTS.readModel.upserted, source: 'seed', data: { kind, entity } });
const pick = <T>(w: World, key: string): T[] => ((w as unknown as Record<string, unknown>)[key] as T[] | undefined) ?? [];

/** Seeds the read models from the shared world through the same projections the event consumer uses, so seed and live paths cannot drift. */
export async function seedReporting(databaseUrl: string, profile?: string) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const byId = new Map(world.vessels.map((v) => [v.id, v])); const berthByCode = new Map(world.berths.map((b) => [b.code, b])); const companyByCode = new Map(world.companies.map((c) => [c.code, c]));
  const counts: Record<string, number> = {};
  /*
   * The read models are partitioned, so the seed has to stamp the same partition the domain services stamp —
   * the derivations below are the ones their own migrations use, not a second opinion:
   *   a ship belongs to its agent; a registration and a certificate follow the ship;
   *   a call belongs to its agent; an invoice to the party billed; a licence to its holder;
   *   a company is its own tenant.
   * Anything the world leaves unattributed stays unpartitioned, which for an ownership column means the
   * administration's own and for a containment column means shared.
   */
  const company = (code: string | null | undefined) => (code ? { company: code } : {});
  const callById = new Map(world.portCalls.map((p) => [p.id, p]));
  const companyById = new Map(world.companies.map((c) => [c.id, c]));
  await withTx(pool, async (c) => {
    const run = async (kind: string, rows: unknown[]) => { for (const r of rows) await project(c, ev(kind, r)); counts[kind] = rows.length; };
    await run('user', world.users.map((u) => ({ ...u, role: { name: u.roleName } })));
    await run('berth', world.berths.map((b) => ({ ...b, outages: pick<{ berthId: string }>(world, 'berthOutages').filter((o) => o.berthId === b.id) })));
    await run('company', world.companies.map((c) => ({ ...c, scope: company(c.code) })));
    await run('vessel', world.vessels.map((v) => ({ ...v, agentName: companyByCode.get(v.agentCode)?.name ?? null, registry: pick<{ vesselId: string }>(world, 'registry').find((r) => r.vesselId === v.id) ?? {}, scope: company(v.agentCode) })));
    await run('instrument', pick<{ entityType: string; status: string; holderCode?: string | null; endorsements?: { result: string }[] }>(world, 'licences').map((l) => ({ ...l, statutory: isStatutory(l.entityType), inForce: !(l.endorsements ?? []).some((x) => x.result === 'NOT_ENDORSED'), signed: l.status === 'ISSUED', scope: company(l.holderCode) })));
    await run('portCall', world.portCalls.map((p) => ({ ...p, vesselType: byId.get(p.vesselId)?.type ?? null, agentName: companyByCode.get(p.agentCode)?.name ?? null, berthId: p.berthCode ? berthByCode.get(p.berthCode)?.id ?? null : null, scope: company(p.agentCode) })));
    // A certificate, a registration and an invoice inherit the tenancy of the thing they are about.
    const ofVessel = (r: { vesselId?: string | null }) => company(r.vesselId ? byId.get(r.vesselId)?.agentCode : null);
    await run('vesselCertificate', pick<{ vesselId?: string | null }>(world, 'vesselCertificates').map((r) => ({ ...r, scope: ofVessel(r) })));
    await run('registration', pick<{ vesselId?: string | null }>(world, 'registrations').map((r) => ({ ...r, scope: ofVessel(r) })));
    await run('invoice', pick<{ portCallId?: string | null; billTo?: { companyId?: string | null } }>(world, 'invoices').map((r) => ({
      ...r,
      scope: company(r.billTo?.companyId ? companyById.get(r.billTo.companyId)?.code : (r.portCallId ? callById.get(r.portCallId)?.agentCode : null)),
    })));
    // A seafarer belongs to the agency that placed them; the world states it, so the projection carries it.
    await run('seafarer', pick<{ manningAgentCode?: string }>(world, 'seafarers').map((r) => ({ ...r, scope: company(r.manningAgentCode) })));
    // the MET register, the crew lists and the ledger behind them, as the seafarers service seeds them
    const programmesOf = (id: string) => pick<{ institutionId: string; status: string; seatsPerIntake: number; intakesPerYear: number }>(world, 'metProgrammes').filter((p) => p.institutionId === id);
    await run('metInstitution', pick<{ id: string; code: string; accreditationStatus: string; accreditedUntil: string | null }>(world, 'metInstitutions').map((m) => {
      const ps = programmesOf(m.id); const approved = ps.filter((p) => p.status === 'APPROVED');
      return { ...m, accreditation: { status: m.accreditationStatus, until: m.accreditedUntil }, programmeCount: ps.length, approvedProgrammes: approved.length, seatsPerYear: approved.reduce((t, p) => t + p.seatsPerIntake * p.intakesPerYear, 0), scope: company(m.code) };
    }));
    const nationalName = getJurisdiction(world.profile).name;
    const ledger = new Map<string, { id: string; name: string; nationality: string; idNumber: string; lastRank: string; appearances: number; status: string; lastSeenAt: string }>();
    await run('crewList', pick<{ id: string; agentCode: string; status: string; date: string; rows: { seafarerId: string | null; nationality: string; idNumber: string; familyName: string; givenNames: string; rank: string }[] }>(world, 'crewLists').map((l) => {
      for (const r of l.rows.filter((x) => !x.seafarerId && x.nationality !== nationalName)) {
        const key = `${r.nationality}:${r.idNumber}`; const seen = ledger.get(key);
        ledger.set(key, { id: stableId('foreign', key), name: `${r.givenNames} ${r.familyName}`.trim(), nationality: r.nationality, idNumber: r.idNumber, lastRank: r.rank, appearances: (seen?.appearances ?? 0) + 1, status: 'LEDGER', lastSeenAt: seen && seen.lastSeenAt > l.date ? seen.lastSeenAt : l.date });
      }
      return { ...l, rowCount: l.rows.length, matched: l.rows.filter((r) => r.seafarerId).length, foreignCount: l.rows.filter((r) => !r.seafarerId && r.nationality !== nationalName).length, ok: l.status === 'QUERIED' ? false : null, scope: company(l.agentCode) };
    }));
    await run('foreignSeafarer', [...ledger.values()]);
    for (const [kind, key] of [['inspection', 'inspections'], ['incident', 'incidents'], ['legalInstrument', 'legalInstruments'], ['tariff', 'tariffs'], ['resource', 'resources'], ['checklistTemplate', 'checklistTemplates'], ['agentDecision', 'aiDecisions']] as const) await run(kind, pick(world, key));
    /* The survey desk's dated facts, as the events it would have published: the Smart Inspection KPI cards measure from this
     * table, so the seeded world has to land here the way it lands on the desk. Keyed like the desk's own seed, so a live
     * event for the same fact is never counted twice. */
    const homePort = geoFor(world.profile).portCode;
    const callById = new Map(world.portCalls.map((c) => [c.id, c]));
    let timeline = 0;
    for (const i of world.inspections) {
      const call = i.portCallId ? callById.get(i.portCallId) : undefined;
      const scope = call?.berthCode ? homePort : '';
      const rows: { kind: string; at: string | null; source: string; meta: Record<string, unknown>; key: string }[] = [
        { kind: 'PLANNED', at: i.plannedAt, source: 'DESK', meta: { regime: i.type, subjectKind: i.subjectKind }, key: 'planned' },
        { kind: 'STARTED', at: i.startedAt, source: 'DESK', meta: {}, key: 'started' },
        { kind: 'CLOSED', at: i.status === 'CLOSED' ? i.closedAt : null, source: 'DESK', meta: { findings: i.findings.length, open: i.findings.filter((f) => f.status === 'OPEN').length, result: i.result }, key: 'closed' },
        { kind: 'DOSSIER_PREPARED', at: i.smart.dossierPreparedAt, source: i.smart.dossierSource, meta: {}, key: 'dossier' },
        { kind: 'PREDICTION_RECORDED', at: i.smart.prediction?.predictedAt ?? null, source: i.smart.prediction?.source ?? '', meta: { band: i.smart.prediction?.band }, key: 'predicted' },
        { kind: 'PREDICTION_SCORED', at: i.smart.prediction?.scoredAt ?? null, source: i.smart.prediction?.source ?? '', meta: { correlated: i.smart.prediction?.correlated }, key: 'scored' },
        { kind: 'REPORT_DRAFTED', at: i.smart.report?.draftedAt ?? null, source: i.smart.report?.source ?? '', meta: {}, key: 'report' },
        { kind: 'REPORT_ISSUED', at: i.smart.report?.issuedAt ?? null, source: i.smart.report?.source ?? '', meta: {}, key: 'report-issued' },
        { kind: 'NOTICE_DRAFTED', at: i.smart.notice?.draftedAt ?? null, source: i.smart.notice?.source ?? '', meta: {}, key: 'notice' },
        { kind: 'NOTICE_ISSUED', at: i.smart.notice?.issuedAt ?? null, source: i.smart.notice?.source ?? '', meta: {}, key: 'notice-issued' },
        { kind: 'RESTRICTION_RECOMMENDED', at: i.smart.recommendation?.recommendedAt ?? null, source: 'RULES', meta: { recommendationId: stableId('recommendation', i.number), kind: i.smart.recommendation?.kind }, key: 'recommended' },
        { kind: 'RESTRICTION_ROUTED', at: i.smart.recommendation?.routedAt ?? null, source: 'BUS', meta: { recommendationId: stableId('recommendation', i.number) }, key: 'routed' },
        { kind: 'RESTRICTION_DECIDED', at: i.smart.recommendation?.decidedAt ?? null, source: 'DESK', meta: { recommendationId: stableId('recommendation', i.number), decision: i.smart.recommendation?.decision }, key: 'decided' },
      ];
      for (const r of rows) {
        if (!r.at) continue;
        await c.query('INSERT INTO rm_inspection_timeline(event_id, inspection_id, number, kind, at, source, meta, scope_port) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_id) DO NOTHING',
          [`seed:${i.number}:${r.key}`, i.id, i.number, r.kind, r.at, r.source, JSON.stringify(r.meta), scope]);
        timeline += 1;
      }
    }
    counts.inspectionTimeline = timeline;
    const cats = new Map<string, number>(); for (const l of world.lookups) cats.set(l.category, (cats.get(l.category) ?? 0) + 1);
    for (const [category, entries] of cats) await c.query('INSERT INTO rm_lookup_counts(category, entries) VALUES ($1, $2) ON CONFLICT (category) DO UPDATE SET entries = EXCLUDED.entries', [category, entries]);
    for (const r of REPORTS) await c.query('INSERT INTO report_definitions(key, name, name_ar, category, description, perm, params, columns, query_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, category = EXCLUDED.category, description = EXCLUDED.description, perm = EXCLUDED.perm, params = EXCLUDED.params, columns = EXCLUDED.columns, query_key = EXCLUDED.query_key', [r.key, r.name, r.nameAr, r.category, r.description, r.perm, JSON.stringify(r.params), JSON.stringify(r.columns), r.queryKey]);
    counts.reports = REPORTS.length;
  });
  /* A reseed rewrites every read model, so anything derived from them is now wrong. When the deployment
   * shares a cache this clears it for every replica at once; when the cache is in-process this reaches only
   * this script's own empty one, and the running service falls back on its time to live. That asymmetry is
   * the practical reason a multi-replica deployment configures the shared driver. */
  await createCache(env()).then((cache) => invalidateDerived(cache).finally(() => cache.close())).catch(() => undefined);
  await pool.end();
  return { ...counts, profile: world.profile };
}
if (require.main === module) {
  const e = env();
  seedReporting(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
