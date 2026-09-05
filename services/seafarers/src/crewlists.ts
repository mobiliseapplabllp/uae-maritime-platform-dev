import type { PoolClient } from 'pg';
import { EVENTS, getJurisdiction, makeEvent, type Actor, type EventEnvelope, type TenancyScope } from '@maritime/contracts';
import { AuditClient, badRequest, conflict, enqueue, eventFromContext, forbidden, isNational, nextNumber, notFound, recordScope, scopeOfRecord, type Principal, type Queryable, type ScopeOptions } from '@maritime/service-kit';
import type { Env } from './env';
import { D, certsOf, daysLeft, documentGate, iso, dateOnly, type CertApi, type Row, type SeafarerRow } from './crew';
import { certRules, loadVocab, type CertRule, type Vocab } from './vocab';
import { loadScale, manningCheck, type ManningCheck, type ScaleRow } from './manning';

/* The FAL form 5 crew list, and the two things it is read against.
 *
 * A crew list arrives with a call — from the maritime single window, the agent's portal, an electronic FAL
 * message or a boarding officer's notebook — one line per person aboard. The desk does three things with
 * it, and this file is those three things.
 *
 *   It matches every line to a person. A line naming a document the national register knows (a CDC, a
 *   seafarer's identity number, a national identity) is that seafarer; a line naming a foreign passport is
 *   an entry in the foreign seafarer ledger, opened on first sight and counted on every sight after. A
 *   national of the flag who is on no register at all is neither, and is flagged, because a citizen sailing
 *   with no national documents is the one case the administration has to ask about.
 *
 *   It reads the list against the ship's safe manning scale (the MSMD, SOLAS V/14): capacity by capacity,
 *   listed against required. A ship one officer short is not cleared to sail, whatever the paperwork says.
 *
 *   It reads the register's people against their documents — the same gate a sign-on passes through — and
 *   the ledger's people against the flag's own rules: a foreign officer on a national-flag ship needs the
 *   flag's endorsement of his certificate (STCW I/10), and the ledger is where that endorsement is recorded.
 *
 * The result is written on the list as `checks`, and the desk clears or queries it. Nothing in the checks
 * is a stored fact about a person; it is what was true of the list on the day it was read, and reading it
 * again is always allowed. */

export const LIST_STATUS = ['RECEIVED', 'CHECKED', 'CLEARED', 'QUERIED'] as const;
export const MOVEMENTS = ['ARRIVAL', 'DEPARTURE'] as const;
export const MATCHES = ['REGISTER', 'FOREIGN', 'UNREGISTERED_NATIONAL'] as const;
export const FOREIGN_STATUS = ['LEDGER', 'WATCH', 'RECONCILED', 'REGISTERED'] as const;
/** A list belongs to the agent who lodged the call it is attached to; the administration reads them all. */
export const CREW_LIST_SCOPE: ScopeOptions = { columns: ['company'], publicToCompanies: false };

export interface RowInput { seq?: number; familyName: string; givenNames: string; rank: string; nationality: string; dob?: string | null; pob?: string; gender?: string; idType?: string; idNumber: string; idExpiry?: string | null; cdcNo?: string }
export interface ListInput { vcn?: string; vesselId?: string; movement: string; date?: string | null; source: string; submittedBy?: string; declaredCrew?: number | null; remarks?: string; rows: RowInput[] }

export interface CrewListRow {
  id: string; number: string; vcn: string; port_call_id: string | null; vessel_id: string; vessel_name: string; imo: string; port: string; movement: string; list_date: Date; source: string;
  agent_code: string; agent_name: string; submitted_by: string; declared_crew: number | null; row_count: number; matched: number; foreign_count: number; flagged: number; status: string; checks: Checks;
  checked_at: Date | null; checked_by: string; decided_at: Date | null; decided_by: string; decision_note: string; remarks: string; scope_company: string; created_at: Date; updated_at: Date;
}
export interface CrewListLine {
  id: string; crew_list_id: string; seq: number; family_name: string; given_names: string; rank: string; rank_code: string; nationality: string; dob: Date | null; pob: string; gender: string;
  id_type: string; id_number: string; id_expiry: Date | null; cdc_no: string; match: string; seafarer_id: string | null; foreign_id: string | null; issues: string[]; created_at: Date;
}
export interface ForeignRow {
  id: string; id_type: string; id_number: string; family_name: string; given_names: string; nationality: string; dob: Date | null; id_expiry: Date | null; cdc_no: string; last_rank: string; last_rank_code: string;
  first_seen_at: Date; last_seen_at: Date; appearances: number; vessels: { vesselId: string; vesselName: string; vcn: string; date: string; rank: string }[]; status: string; status_reason: string;
  reconciled_seafarer_id: string | null; reconciled_at: Date | null; reconciled_by: string; endorsement_no: string; endorsement_issuer: string; endorsement_expiry: Date | null; remarks: string; created_at: Date; updated_at: Date;
}
export interface PortCallRow { id: string; vcn: string; vessel_id: string; vessel_name: string; vessel_imo: string; agent_code: string; agent_name: string; status: string; port: string; berth_code: string | null; eta: Date | null; ata: Date | null; atd: Date | null; declared_crew: number | null }

export interface Checks {
  manning: ManningCheck | null; scaleRecorded: boolean; msmdNo: string;
  documents: { seq: number; name: string; rank: string; failures: string[] }[];
  identity: { seq: number; name: string; issue: string }[];
  endorsements: { seq: number; name: string; rank: string; issue: string }[];
  unregisteredNationals: { seq: number; name: string; rank: string }[];
  unknownRanks: { seq: number; name: string; rank: string }[];
  declaration: { declared: number | null; listed: number; matches: boolean | null };
  nationalFlag: boolean; summary: string[]; ok: boolean; checkedAt: string;
}

/* ------------------------------------------------------------------- API shapes --- */

export const lineApi = (l: CrewListLine) => ({
  id: l.id, seq: l.seq, familyName: l.family_name, givenNames: l.given_names, name: `${l.given_names} ${l.family_name}`.trim(), rank: l.rank, rankCode: l.rank_code, nationality: l.nationality,
  dob: dateOnly(l.dob), pob: l.pob, gender: l.gender, idType: l.id_type, idNumber: l.id_number, idExpiry: dateOnly(l.id_expiry), cdcNo: l.cdc_no, match: l.match, seafarerId: l.seafarer_id, foreignId: l.foreign_id, issues: l.issues ?? [],
});
export type LineApi = ReturnType<typeof lineApi>;
export function crewListApi(r: CrewListRow, lines?: CrewListLine[], extra: { sourceLabel?: string } = {}) {
  return {
    id: r.id, number: r.number, vcn: r.vcn, portCallId: r.port_call_id, vesselId: r.vessel_id, vesselName: r.vessel_name, imo: r.imo, port: r.port, movement: r.movement, date: iso(r.list_date)!, source: r.source, sourceLabel: extra.sourceLabel ?? r.source,
    agentCode: r.agent_code, agentName: r.agent_name, submittedBy: r.submitted_by, declaredCrew: r.declared_crew, rowCount: r.row_count, matched: r.matched, foreignCount: r.foreign_count, flagged: r.flagged, status: r.status,
    checks: r.checks ?? null, ok: r.checks?.ok ?? null, checkedAt: iso(r.checked_at), checkedBy: r.checked_by, decidedAt: iso(r.decided_at), decidedBy: r.decided_by, decisionNote: r.decision_note, remarks: r.remarks,
    rows: lines ? lines.map(lineApi) : undefined, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}
export type CrewListApi = ReturnType<typeof crewListApi>;
export const foreignApi = (f: ForeignRow, now = new Date()) => ({
  id: f.id, idType: f.id_type, idNumber: f.id_number, familyName: f.family_name, givenNames: f.given_names, name: `${f.given_names} ${f.family_name}`.trim(), nationality: f.nationality, dob: dateOnly(f.dob), idExpiry: dateOnly(f.id_expiry),
  idExpired: !!f.id_expiry && f.id_expiry.getTime() < now.getTime(), cdcNo: f.cdc_no, lastRank: f.last_rank, lastRankCode: f.last_rank_code, firstSeenAt: iso(f.first_seen_at), lastSeenAt: iso(f.last_seen_at), appearances: f.appearances,
  vessels: f.vessels ?? [], distinctVessels: new Set((f.vessels ?? []).map((v) => v.vesselId)).size, status: f.status, statusReason: f.status_reason, reconciledSeafarerId: f.reconciled_seafarer_id, reconciledAt: iso(f.reconciled_at), reconciledBy: f.reconciled_by,
  endorsement: f.endorsement_no ? { number: f.endorsement_no, issuer: f.endorsement_issuer, expiryDate: dateOnly(f.endorsement_expiry), valid: !f.endorsement_expiry || f.endorsement_expiry.getTime() >= now.getTime() } : null,
  remarks: f.remarks, createdAt: iso(f.created_at), updatedAt: iso(f.updated_at),
});
export type ForeignApi = ReturnType<typeof foreignApi>;

/* --------------------------------------------------------------------- matching --- */

const key = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
export interface RegisterIndex { byDoc: Map<string, SeafarerRow> }
/** Every document the register can be found by, indexed once per read of a list. */
export async function registerIndex(c: Queryable): Promise<RegisterIndex> {
  const r = await c.query<SeafarerRow>('SELECT * FROM seafarers');
  const byDoc = new Map<string, SeafarerRow>();
  for (const s of r.rows) {
    if (s.cdc_no) byDoc.set(`CDC:${key(s.cdc_no)}`, s);
    if (s.seafarer_id) byDoc.set(`ID:${key(s.seafarer_id)}`, s);
    if (s.national_id) byDoc.set(`ID:${key(s.national_id)}`, s);
  }
  return { byDoc };
}
export type Match = (typeof MATCHES)[number];
/** Which person a line is: the register's, the ledger's, or a citizen on neither. */
export function matchLine(line: { idNumber: string; cdcNo?: string; nationality: string }, index: RegisterIndex, nationalName: string): { match: Match; seafarer: SeafarerRow | null } {
  const seafarer = (line.cdcNo ? index.byDoc.get(`CDC:${key(line.cdcNo)}`) : undefined) ?? index.byDoc.get(`ID:${key(line.idNumber)}`) ?? index.byDoc.get(`CDC:${key(line.idNumber)}`) ?? null;
  if (seafarer) return { match: 'REGISTER', seafarer };
  return { match: key(line.nationality) === key(nationalName) ? 'UNREGISTERED_NATIONAL' : 'FOREIGN', seafarer: null };
}

/* --------------------------------------------------------------------- the ledger --- */

/** Opens or updates the ledger entry a foreign line names, and counts the appearance once per list. Answers the entry and whether it is new. */
export async function recordAppearance(c: PoolClient, env: Env, line: { familyName: string; givenNames: string; nationality: string; dob?: string | null; idType?: string; idNumber: string; idExpiry?: string | null; cdcNo?: string; rank: string; rankCode: string }, list: { id: string; vesselId: string; vesselName: string; vcn: string; date: Date; nationalFlag: boolean }, ranks: Vocab, cause?: EventEnvelope): Promise<{ row: ForeignRow; firstSeen: boolean }> {
  const found = (await c.query<ForeignRow>('SELECT * FROM foreign_seafarers WHERE upper(id_number) = upper($1) AND upper(nationality) = upper($2) FOR UPDATE', [line.idNumber.trim(), line.nationality.trim()])).rows[0];
  const appearance = { vesselId: list.vesselId, vesselName: list.vesselName, vcn: list.vcn, date: iso(list.date)!, rank: line.rank, nationalFlag: list.nationalFlag, listId: list.id };
  if (!found) {
    const r = await c.query<ForeignRow>(
      `INSERT INTO foreign_seafarers(id_type, id_number, family_name, given_names, nationality, dob, id_expiry, cdc_no, last_rank, last_rank_code, first_seen_at, last_seen_at, appearances, vessels, status, status_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,1,$12,'LEDGER','First seen on a crew list') RETURNING *`,
      [line.idType ?? 'Passport', line.idNumber.trim(), line.familyName, line.givenNames, line.nationality.trim(), line.dob || null, line.idExpiry || null, line.cdcNo ?? '', line.rank, line.rankCode, list.date, JSON.stringify([appearance])]);
    const row = r.rows[0];
    await enqueue(c, cause
      ? makeEvent({ type: EVENTS.seafarers.foreignRecorded, source: env.SERVICE_NAME, data: { foreignId: row.id, name: `${row.given_names} ${row.family_name}`, nationality: row.nationality, rank: row.last_rank, vesselName: list.vesselName, vcn: list.vcn }, subject: row.id, correlationId: cause.correlationid, causationId: cause.id, actor: cause.actor })
      : eventFromContext(env.SERVICE_NAME, EVENTS.seafarers.foreignRecorded, { foreignId: row.id, name: `${row.given_names} ${row.family_name}`, nationality: row.nationality, rank: row.last_rank, vesselName: list.vesselName, vcn: list.vcn }, { subject: row.id }));
    await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'foreignSeafarer', entity: foreignApi(row) }, { subject: row.id }));
    return { row, firstSeen: true };
  }
  const vessels = (found.vessels ?? []).filter((v) => (v as { listId?: string }).listId !== list.id);
  vessels.push(appearance);
  vessels.sort((a, b) => b.date.localeCompare(a.date));
  const officer = ranks.find(line.rankCode)?.meta.officer === true;
  const nationalCalls = vessels.filter((v) => (v as { nationalFlag?: boolean }).nationalFlag).length;
  // an officer repeatedly aboard the flag's ships with no endorsement recorded is put on watch; the desk takes it from there
  const watch = found.status === 'LEDGER' && officer && !found.endorsement_no && nationalCalls >= env.FOREIGN_WATCH_APPEARANCES;
  const r = await c.query<ForeignRow>(
    `UPDATE foreign_seafarers SET family_name = $2, given_names = $3, dob = COALESCE($4, dob), id_expiry = COALESCE($5, id_expiry), cdc_no = COALESCE(NULLIF($6, ''), cdc_no), last_rank = $7, last_rank_code = $8,
       last_seen_at = GREATEST(last_seen_at, $9), first_seen_at = LEAST(first_seen_at, $9), appearances = $10, vessels = $11, status = $12, status_reason = $13, updated_at = now() WHERE id = $1 RETURNING *`,
    [found.id, line.familyName, line.givenNames, line.dob || null, line.idExpiry || null, line.cdcNo ?? '', line.rank, line.rankCode, list.date, vessels.length, JSON.stringify(vessels.slice(0, 50)),
      watch ? 'WATCH' : found.status, watch ? `Officer seen on ${nationalCalls} national-flag calls with no flag state endorsement recorded` : found.status_reason]);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'foreignSeafarer', entity: foreignApi(r.rows[0]) }, { subject: found.id }));
  return { row: r.rows[0], firstSeen: false };
}

/* ---------------------------------------------------------------------- the checks --- */

export interface CheckContext { env: Env; now: Date; rules: CertRule[]; ranks: Vocab; scale: ScaleRow[] | null; msmdNo: string; nationalFlag: boolean; declaredCrew: number | null; certs: Map<string, CertApi[]>; ledger: Map<string, ForeignRow> }
/** Everything the desk wants to know about a list, from what the lines matched to. Pure over its inputs. */
export function checkLines(lines: CrewListLine[], ctx: CheckContext): Checks {
  const name = (l: CrewListLine) => `${l.given_names} ${l.family_name}`.trim();
  const manning = ctx.scale ? manningCheck(ctx.scale, lines.map((l) => ({ rankCode: l.rank_code, rank: l.rank }))) : null;
  const documents: Checks['documents'] = []; const identity: Checks['identity'] = []; const endorsements: Checks['endorsements'] = [];
  const unregisteredNationals: Checks['unregisteredNationals'] = []; const unknownRanks: Checks['unknownRanks'] = [];
  for (const l of lines) {
    if (!l.rank_code) unknownRanks.push({ seq: l.seq, name: name(l), rank: l.rank });
    if (l.id_expiry && l.id_expiry.getTime() < ctx.now.getTime()) identity.push({ seq: l.seq, name: name(l), issue: `${l.id_type || 'Identity document'} ${l.id_number} expired on ${dateOnly(l.id_expiry)}` });
    if (l.match === 'UNREGISTERED_NATIONAL') unregisteredNationals.push({ seq: l.seq, name: name(l), rank: l.rank });
    if (l.match === 'REGISTER' && l.seafarer_id) {
      const { failures } = documentGate(ctx.certs.get(l.seafarer_id) ?? [], ctx.env, ctx.now, ctx.rules);
      if (failures.length) documents.push({ seq: l.seq, name: name(l), rank: l.rank, failures });
    }
    if (l.match === 'FOREIGN' && ctx.nationalFlag && ctx.ranks.find(l.rank_code)?.meta.officer === true) {
      const entry = l.foreign_id ? ctx.ledger.get(l.foreign_id) : undefined;
      const valid = entry?.endorsement_no && (!entry.endorsement_expiry || entry.endorsement_expiry.getTime() >= ctx.now.getTime());
      if (!valid) endorsements.push({ seq: l.seq, name: name(l), rank: l.rank, issue: entry?.endorsement_no ? `Flag state endorsement ${entry.endorsement_no} expired on ${dateOnly(entry.endorsement_expiry)}` : 'No flag state endorsement (STCW I/10) recorded for an officer on a national-flag ship' });
    }
  }
  const declaration = { declared: ctx.declaredCrew, listed: lines.length, matches: ctx.declaredCrew == null ? null : ctx.declaredCrew === lines.length };
  const summary: string[] = [];
  if (!ctx.scale) summary.push('No safe manning scale is recorded for this ship — the list could not be read against the MSMD');
  else if (manning && !manning.ok) summary.push(`Short of the safe manning scale by ${manning.shortfalls}: ${manning.rows.filter((r) => r.shortfall).map((r) => `${r.rank} ${r.listed}/${r.required}`).join(', ')}`);
  if (documents.length) summary.push(`${documents.length} register seafarer(s) with documents that block the tour`);
  if (identity.length) summary.push(`${identity.length} identity document(s) expired`);
  if (endorsements.length) summary.push(`${endorsements.length} foreign officer(s) without a valid flag state endorsement`);
  if (unregisteredNationals.length) summary.push(`${unregisteredNationals.length} national(s) not on the seafarer register`);
  if (unknownRanks.length) summary.push(`${unknownRanks.length} line(s) with a rank the master does not know`);
  if (declaration.matches === false) summary.push(`General declaration gives ${declaration.declared} crew, the list has ${declaration.listed}`);
  const ok = summary.length === 0;
  return { manning, scaleRecorded: !!ctx.scale, msmdNo: ctx.msmdNo, documents, identity, endorsements, unregisteredNationals, unknownRanks, declaration, nationalFlag: ctx.nationalFlag, summary: ok ? ['Every check passed'] : summary, ok, checkedAt: ctx.now.toISOString() };
}

/* ------------------------------------------------------------------ receiving one --- */

export async function loadList(c: Queryable, ref: string, lock = false): Promise<CrewListRow | null> {
  const r = await c.query<CrewListRow>(`SELECT * FROM crew_lists WHERE id::text = $1 OR number = $1${lock ? ' FOR UPDATE' : ''}`, [ref]);
  return r.rows[0] ?? null;
}
export const linesOf = async (c: Queryable, listId: string) => (await c.query<CrewListLine>('SELECT * FROM crew_list_rows WHERE crew_list_id = $1 ORDER BY seq', [listId])).rows;
export async function portCallByVcn(c: Queryable, vcn: string): Promise<PortCallRow | null> { return (await c.query<PortCallRow>('SELECT * FROM port_calls WHERE vcn = $1 OR id = $1', [vcn])).rows[0] ?? null; }

export async function publishList(c: Queryable, env: Env, r: CrewListRow, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = crewListApi(r);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: r.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: r.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'crewList', entity: { ...entity, scope: recordScope(r) } }));
  if (opts.event) await enqueue(c, mk(opts.event, { crewListId: r.id, number: r.number, vcn: r.vcn, vesselId: r.vessel_id, vesselName: r.vessel_name, agentCode: r.agent_code, status: r.status, ok: r.checks?.ok ?? null, summary: r.checks?.summary ?? [], ...(opts.data ?? {}) }));
  return entity;
}

/** Runs the checks over a list's stored lines and writes the result. The list's status moves to CHECKED unless it has already been decided. */
export async function runChecks(c: PoolClient, env: Env, audit: AuditClient, list: CrewListRow, by: Principal | null, now = new Date(), cause?: EventEnvelope): Promise<CrewListRow> {
  const lines = await linesOf(c, list.id);
  const [ranks, certs] = await Promise.all([loadVocab(c, 'seafarerRank'), loadVocab(c, 'seafarerCertType')]);
  const rules = certRules(certs);
  const scale = await loadScale(c, list.vessel_id);
  const vessel = (await c.query<{ flag: string }>('SELECT flag FROM vessels WHERE id = $1', [list.vessel_id])).rows[0];
  const nationalFlag = String(vessel?.flag ?? '').toUpperCase() === getJurisdiction(env.JURISDICTION).code.toUpperCase();
  const certMap = new Map<string, CertApi[]>();
  for (const l of lines) if (l.seafarer_id && !certMap.has(l.seafarer_id)) certMap.set(l.seafarer_id, await certsOf(c, l.seafarer_id, now, env.CERT_EXPIRING_DAYS, rules));
  const foreignIds = [...new Set(lines.map((l) => l.foreign_id).filter(Boolean))] as string[];
  const ledger = new Map<string, ForeignRow>();
  if (foreignIds.length) for (const f of (await c.query<ForeignRow>('SELECT * FROM foreign_seafarers WHERE id = ANY($1)', [foreignIds])).rows) ledger.set(f.id, f);
  const checks = checkLines(lines, { env, now, rules, ranks, scale: scale?.rows?.length ? scale.rows : null, msmdNo: scale?.msmd_no ?? '', nationalFlag, declaredCrew: list.declared_crew, certs: certMap, ledger });
  // the per-line issues are rewritten too, so a line reads the same as the summary it contributed to
  const issuesBySeq = new Map<number, string[]>();
  const add = (seq: number, issue: string) => issuesBySeq.set(seq, [...(issuesBySeq.get(seq) ?? []), issue]);
  for (const d of checks.documents) for (const f of d.failures) add(d.seq, f);
  for (const i of checks.identity) add(i.seq, i.issue);
  for (const e of checks.endorsements) add(e.seq, e.issue);
  for (const u of checks.unregisteredNationals) add(u.seq, 'National of the flag not on the seafarer register');
  for (const u of checks.unknownRanks) add(u.seq, `Rank "${u.rank}" is not an entry of the seafarerRank master`);
  for (const l of lines) {
    const issues = issuesBySeq.get(l.seq) ?? [];
    if (JSON.stringify(issues) !== JSON.stringify(l.issues ?? [])) await c.query('UPDATE crew_list_rows SET issues = $2 WHERE id = $1', [l.id, JSON.stringify(issues)]);
  }
  const flagged = issuesBySeq.size;
  const status = list.status === 'CLEARED' || list.status === 'QUERIED' ? list.status : 'CHECKED';
  const r = await c.query<CrewListRow>('UPDATE crew_lists SET checks = $2, flagged = $3, status = $4, checked_at = $5, checked_by = $6, updated_at = now() WHERE id = $1 RETURNING *',
    [list.id, JSON.stringify(checks), flagged, status, now, by?.name ?? 'Crew desk']);
  const row = r.rows[0];
  await audit.record(c, { action: 'CREW_LIST_CHECKED', entity: 'CrewList', entityId: row.id, entityLabel: `${row.number} — ${row.vessel_name}`, after: { ok: checks.ok, summary: checks.summary, flagged }, note: checks.summary.join('; ') });
  await publishList(c, env, row, { event: EVENTS.seafarers.crewListChecked, data: { flagged, manningOk: checks.manning?.ok ?? null }, cause });
  return row;
}

/** Receives a list: resolves the call and the ship, writes the lines, matches each one, and runs the checks. */
export async function receiveCrewList(c: PoolClient, env: Env, audit: AuditClient, input: ListInput, user: Principal | null, now = new Date()): Promise<CrewListRow> {
  const j = getJurisdiction(env.JURISDICTION);
  const sources = await loadVocab(c, 'crewListSource');
  const source = sources.resolve(input.source, 'source');
  if (!(MOVEMENTS as readonly string[]).includes(input.movement)) throw badRequest(`movement must be one of ${MOVEMENTS.join(', ')}`);
  if (!input.rows?.length) throw badRequest('A crew list names at least one person');
  if (input.rows.length > 500) throw badRequest('A crew list carries at most 500 lines');
  const call = input.vcn ? await portCallByVcn(c, input.vcn) : null;
  if (input.vcn && !call) throw badRequest(`Port call ${input.vcn} is not known to the crew desk`, { vcn: input.vcn });
  const vesselId = call?.vessel_id || input.vesselId || '';
  if (!vesselId) throw badRequest('A crew list names the call it belongs to (vcn) or the ship (vesselId)');
  const vessel = (await c.query<{ id: string; name: string; imo: string; flag: string }>('SELECT id, name, imo, flag FROM vessels WHERE id = $1 OR imo = $1', [vesselId])).rows[0];
  if (!vessel) throw badRequest('The ship is not on the fleet snapshot', { vesselId });
  if (call && call.vessel_id !== vessel.id) throw conflict(`${input.vcn} is a call by ${call.vessel_name}, not ${vessel.name}`);
  // an agent lodges lists for its own calls and nobody else's; the administration lodges for anyone
  const own = scopeOfRecord(user?.scope).company;
  const agentCode = call?.agent_code ?? own ?? '';
  if (own && agentCode && own.toUpperCase() !== agentCode.toUpperCase()) throw forbidden(`${input.vcn} was lodged by another agent`);
  if (!own && !isNational(user?.scope) && user) throw forbidden('Only the administration or the lodging agent may submit a crew list');
  const listDate = input.date ? new Date(input.date) : call?.ata ?? call?.eta ?? now;
  if (Number.isNaN(listDate.getTime())) throw badRequest('date is not a date');
  const year = listDate.getUTCFullYear();
  const number = await nextNumber(c, `crew-list:${year}`, `${env.CREW_LIST_PREFIX}-${year}-`);
  const declared = input.declaredCrew ?? call?.declared_crew ?? null;
  const r = await c.query<CrewListRow>(
    `INSERT INTO crew_lists(number, vcn, port_call_id, vessel_id, vessel_name, imo, port, movement, list_date, source, agent_code, agent_name, submitted_by, declared_crew, row_count, remarks, scope_company)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [number, call?.vcn ?? input.vcn ?? '', call?.id ?? null, vessel.id, vessel.name, vessel.imo, call?.port ?? '', input.movement, listDate, source.code, agentCode, call?.agent_name ?? '', input.submittedBy ?? user?.name ?? '', declared, input.rows.length, input.remarks ?? '', agentCode]);
  const list = r.rows[0];
  const ranks = await loadVocab(c, 'seafarerRank');
  const index = await registerIndex(c);
  const nationalFlag = String(vessel.flag ?? '').toUpperCase() === j.code.toUpperCase();
  let matched = 0; let foreign = 0;
  for (const [i, line] of input.rows.entries()) {
    const rank = ranks.find(line.rank);
    const { match, seafarer } = matchLine(line, index, j.name);
    let foreignId: string | null = null;
    if (match === 'FOREIGN') {
      const { row } = await recordAppearance(c, env, { ...line, rank: rank?.label ?? line.rank, rankCode: rank?.code ?? '' }, { id: list.id, vesselId: vessel.id, vesselName: vessel.name, vcn: list.vcn, date: listDate, nationalFlag }, ranks);
      foreignId = row.id; foreign += 1;
    } else if (match === 'REGISTER') matched += 1;
    await c.query(
      `INSERT INTO crew_list_rows(crew_list_id, seq, family_name, given_names, rank, rank_code, nationality, dob, pob, gender, id_type, id_number, id_expiry, cdc_no, match, seafarer_id, foreign_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [list.id, line.seq ?? i + 1, line.familyName.trim(), line.givenNames.trim(), rank?.label ?? line.rank.trim(), rank?.code ?? '', line.nationality.trim(), line.dob || null, line.pob ?? '', line.gender ?? '', line.idType ?? 'Passport', line.idNumber.trim(), line.idExpiry || null, line.cdcNo ?? seafarer?.cdc_no ?? '', match, seafarer?.id ?? null, foreignId]);
  }
  const received = (await c.query<CrewListRow>('UPDATE crew_lists SET matched = $2, foreign_count = $3, updated_at = now() WHERE id = $1 RETURNING *', [list.id, matched, foreign])).rows[0];
  await audit.record(c, { action: 'CREW_LIST_RECEIVED', entity: 'CrewList', entityId: received.id, entityLabel: `${received.number} — ${received.vessel_name}`, after: crewListApi(received), note: `${input.rows.length} lines from ${source.label}` });
  await publishList(c, env, received, { event: EVENTS.seafarers.crewListReceived, data: { rows: input.rows.length, matched, foreign, source: source.code } });
  return runChecks(c, env, audit, received, user, now);
}

/** The desk's decision on a checked list. Clearing over a manning shortfall needs a written override when the module is strict; querying always needs a reason. */
export async function decideList(c: PoolClient, env: Env, audit: AuditClient, ref: string, decision: 'CLEARED' | 'QUERIED', note: string, user: Principal | null): Promise<CrewListRow> {
  const list = await loadList(c, ref, true);
  if (!list) throw notFound('Crew list not found');
  if (list.status === decision) return list;
  if (!list.checks?.checkedAt) throw conflict('Run the checks before deciding the list');
  if (decision === 'QUERIED' && !note.trim()) throw badRequest('A query goes back to the agent with a reason');
  if (decision === 'CLEARED' && env.MANNING_STRICT_CLEARANCE && list.checks.manning && !list.checks.manning.ok && !note.trim()) throw conflict(`The list is short of the safe manning scale — clearing it needs a written override (${list.checks.summary.join('; ')})`);
  const r = await c.query<CrewListRow>('UPDATE crew_lists SET status = $2, decided_at = now(), decided_by = $3, decision_note = $4, updated_at = now() WHERE id = $1 RETURNING *', [list.id, decision, user?.name ?? 'Crew desk', note.trim()]);
  const row = r.rows[0];
  const overridden = decision === 'CLEARED' && !list.checks.ok;
  await audit.record(c, { action: `CREW_LIST_${decision}`, entity: 'CrewList', entityId: row.id, entityLabel: `${row.number} — ${row.vessel_name}`, before: { status: list.status }, after: { status: decision }, note: overridden ? `OVERRIDE: ${note} — ${list.checks.summary.join('; ')}` : note });
  await publishList(c, env, row, { event: decision === 'CLEARED' ? EVENTS.seafarers.crewListCleared : EVENTS.seafarers.crewListQueried, data: { note: note.trim(), overridden } });
  return row;
}

/* ---------------------------------------------------------------- ledger decisions --- */

export async function loadForeign(c: Queryable, id: string, lock = false): Promise<ForeignRow | null> {
  const r = await c.query<ForeignRow>(`SELECT * FROM foreign_seafarers WHERE id::text = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ?? null;
}
async function publishForeign(c: Queryable, env: Env, row: ForeignRow, event?: string, data: Row = {}) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'foreignSeafarer', entity: foreignApi(row) }, { subject: row.id }));
  if (event) await enqueue(c, eventFromContext(env.SERVICE_NAME, event, { foreignId: row.id, name: `${row.given_names} ${row.family_name}`, nationality: row.nationality, status: row.status, ...data }, { subject: row.id }));
}

/** Records the flag's endorsement of a foreign officer's certificate (STCW I/10) against the ledger entry. */
export async function recordEndorsement(c: PoolClient, env: Env, audit: AuditClient, id: string, input: { number: string; issuer?: string; expiryDate?: string | null; remarks?: string }, user: Principal | null): Promise<ForeignRow> {
  const f = await loadForeign(c, id, true);
  if (!f) throw notFound('Ledger entry not found');
  const expiry = input.expiryDate ? new Date(input.expiryDate) : null;
  if (expiry && expiry.getTime() < Date.now()) throw badRequest('The endorsement has already expired');
  const r = await c.query<ForeignRow>(`UPDATE foreign_seafarers SET endorsement_no = $2, endorsement_issuer = $3, endorsement_expiry = $4, status = CASE WHEN status = 'WATCH' THEN 'LEDGER' ELSE status END, status_reason = CASE WHEN status = 'WATCH' THEN 'Flag state endorsement recorded' ELSE status_reason END, remarks = COALESCE(NULLIF($5, ''), remarks), updated_at = now() WHERE id = $1 RETURNING *`,
    [f.id, input.number.trim(), input.issuer ?? getJurisdiction(env.JURISDICTION).authority, expiry, input.remarks ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: 'FOREIGN_ENDORSEMENT', entity: 'ForeignSeafarer', entityId: row.id, entityLabel: `${row.given_names} ${row.family_name}`, before: f.endorsement_no ? { number: f.endorsement_no } : null, after: { number: row.endorsement_no, expiryDate: dateOnly(row.endorsement_expiry) }, note: user?.name ?? '' });
  await publishForeign(c, env, row);
  return row;
}

/** Links a ledger entry to a seafarer already on the register — the same person under a different document — and re-points the lines that named it. */
export async function reconcileForeign(c: PoolClient, env: Env, audit: AuditClient, id: string, seafarerRef: string, note: string, user: Principal | null): Promise<{ row: ForeignRow; relinked: number }> {
  const f = await loadForeign(c, id, true);
  if (!f) throw notFound('Ledger entry not found');
  const s = (await c.query<SeafarerRow>('SELECT * FROM seafarers WHERE id::text = $1 OR cdc_no = $1', [seafarerRef])).rows[0];
  if (!s) throw notFound('Seafarer not found on the register');
  const relinked = (await c.query(`UPDATE crew_list_rows SET match = 'REGISTER', seafarer_id = $2, cdc_no = CASE WHEN cdc_no = '' THEN $3 ELSE cdc_no END WHERE foreign_id = $1`, [f.id, s.id, s.cdc_no])).rowCount ?? 0;
  const r = await c.query<ForeignRow>(`UPDATE foreign_seafarers SET status = 'RECONCILED', status_reason = $2, reconciled_seafarer_id = $3, reconciled_at = now(), reconciled_by = $4, updated_at = now() WHERE id = $1 RETURNING *`, [f.id, note.trim() || `Reconciled to ${s.name} (${s.cdc_no})`, s.id, user?.name ?? 'Crew desk']);
  const row = r.rows[0];
  await audit.record(c, { action: 'FOREIGN_RECONCILED', entity: 'ForeignSeafarer', entityId: row.id, entityLabel: `${row.given_names} ${row.family_name}`, after: { seafarerId: s.id, cdcNo: s.cdc_no, relinked }, note: note.trim() });
  await audit.record(c, { action: 'LEDGER_RECONCILED', entity: 'Seafarer', entityId: s.id, entityLabel: s.name, after: { foreignId: row.id, idNumber: row.id_number, appearances: row.appearances }, note: `Foreign ledger entry reconciled to this record${note ? ` — ${note}` : ''}` });
  await publishForeign(c, env, row, EVENTS.seafarers.foreignReconciled, { seafarerId: s.id, relinked });
  return { row, relinked };
}

/* ---------------------------------------------------------------------- dashboard --- */

export function crewListDashboard(lists: CrewListApi[], ledger: ForeignApi[], now = new Date()) {
  const since30 = now.getTime() - 30 * D;
  const recent = lists.filter((l) => new Date(l.date).getTime() >= since30);
  const byStatus = (s: string) => lists.filter((l) => l.status === s).length;
  const short = lists.filter((l) => l.checks?.manning && !l.checks.manning.ok);
  const bySource = [...new Set(lists.map((l) => l.source))].map((source) => ({ source, label: lists.find((l) => l.source === source)?.sourceLabel ?? source, lists: lists.filter((l) => l.source === source).length })).sort((a, b) => b.lists - a.lists);
  const officersWithoutEndorsement = ledger.filter((f) => f.status === 'WATCH').length;
  return {
    kpis: {
      lists: lists.length, last30Days: recent.length, received: byStatus('RECEIVED'), checked: byStatus('CHECKED'), cleared: byStatus('CLEARED'), queried: byStatus('QUERIED'),
      passing: lists.filter((l) => l.ok === true).length, shortOfManning: short.length, unregisteredNationals: lists.reduce((t, l) => t + (l.checks?.unregisteredNationals.length ?? 0), 0),
      linesRead: lists.reduce((t, l) => t + l.rowCount, 0), registerMatched: lists.reduce((t, l) => t + l.matched, 0), foreignLines: lists.reduce((t, l) => t + l.foreignCount, 0),
      ledger: ledger.length, ledgerWatch: officersWithoutEndorsement, ledgerReconciled: ledger.filter((f) => f.status === 'RECONCILED' || f.status === 'REGISTERED').length, repeatAppearances: ledger.filter((f) => f.appearances > 1).length,
    },
    bySource,
    attention: lists.filter((l) => l.status !== 'CLEARED' && l.ok === false).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10).map((l) => ({ id: l.id, number: l.number, vesselName: l.vesselName, vcn: l.vcn, date: l.date, status: l.status, summary: l.checks?.summary ?? [] })),
    generatedAt: now.toISOString(),
  };
}

/** Days ahead of a foreign person's document lapse, for the ledger list's sort. */
export const ledgerDaysLeft = (f: ForeignRow, now = new Date()) => (f.id_expiry ? daysLeft(f.id_expiry, now) : null);
export const scopeOf = (scope: TenancyScope | undefined) => scopeOfRecord(scope);
