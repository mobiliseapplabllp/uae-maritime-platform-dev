import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { EVENTS, getJurisdiction, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, badRequest, conflict, enqueue, eventFromContext, lookupByCode, lookupOptions, nextNumber, notFound, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { iso, vesselApi, type Row, type VesselRow } from './vessels';
import { registrationApi, transcriptOf, type RegistrationRow } from './registrations';
import { kindRules, portName, shareLedger } from './registry';

/* The registry ledger.
 *
 * Everything that happens to a ship's entry is a transaction: the grant that opened it, every mortgage
 * registered and discharged against it, every caveat, every transcript issued, the closure. The kinds of
 * transaction are the `registryTransactionType` master's; the ones marked `direct` the registrar records here
 * without an application, the rest are written by a grant. The transcript of registry is assembled from the
 * ledger and the register, numbered, and sealed with a digest of what it said on the day — so a transcript
 * a bank holds can be checked against the register later and shown to be the one the registrar issued. */

export interface TransactionRow {
  id: string; number: string; vessel_id: string; vessel_name: string; official_number: string; type: string; registration_id: string | null; application_no: string;
  particulars: Row; status: string; recorded_on: Date; recorded_by_id: string | null; recorded_by: string; notes: string; digest: string; scope_company: string; created_at: Date;
}
export interface EncumbranceRow {
  id: string; vessel_id: string; kind: string; holder: string; amount: string; currency: string; registered_on: Date; discharged_on: Date | null; reference: string;
  registration_id: string | null; transaction_id: string | null; discharge_transaction_id: string | null; notes: string; scope_company: string; created_at: Date; updated_at: Date;
}
export const transactionApi = (t: TransactionRow) => ({
  id: t.id, number: t.number, vesselId: t.vessel_id, vesselName: t.vessel_name, officialNumber: t.official_number, type: t.type, registrationId: t.registration_id, applicationNo: t.application_no,
  particulars: t.particulars ?? {}, status: t.status, recordedOn: iso(t.recorded_on)!, recordedBy: t.recorded_by, notes: t.notes, digest: t.digest || null, createdAt: iso(t.created_at),
});
export type TransactionApi = ReturnType<typeof transactionApi>;
export const encumbranceApi = (e: EncumbranceRow) => ({
  id: e.id, vesselId: e.vessel_id, kind: e.kind, holder: e.holder, amount: Number(e.amount), currency: e.currency, registeredOn: iso(e.registered_on)!, dischargedOn: iso(e.discharged_on),
  reference: e.reference, registrationId: e.registration_id, transactionId: e.transaction_id, dischargeTransactionId: e.discharge_transaction_id, notes: e.notes, live: !e.discharged_on,
});
export type EncumbranceApi = ReturnType<typeof encumbranceApi>;

export interface TransactionType { code: string; label: string; labelAr: string | null; affectsTitle: boolean; requiresConsent: boolean; direct: boolean; feeCode: string }
const typeOf = (o: { code: string; label: string; labelAr: string | null; meta: Row }): TransactionType => ({ code: o.code, label: o.label, labelAr: o.labelAr, affectsTitle: o.meta.affectsTitle === true, requiresConsent: o.meta.requiresConsent === true, direct: o.meta.direct === true, feeCode: String(o.meta.feeCode ?? '') });
export async function transactionTypes(c: Queryable): Promise<TransactionType[]> { return (await lookupOptions(c, 'registryTransactionType')).map(typeOf); }

export const nextTransactionNo = (c: Queryable, env: Env, now = new Date()) => nextNumber(c, `${env.TRANSACTION_PREFIX}-${now.getUTCFullYear()}`, `${env.TRANSACTION_PREFIX}-${now.getUTCFullYear()}-`, 5);
export const nextTranscriptNo = (c: Queryable, env: Env, now = new Date()) => nextNumber(c, `${env.TRANSCRIPT_PREFIX}-${now.getUTCFullYear()}`, `${env.TRANSCRIPT_PREFIX}-${now.getUTCFullYear()}-`, 5);

export interface RecordInput { type: string; registrationId?: string | null; applicationNo?: string; particulars?: Row; notes?: string; digest?: string; by?: Principal | Actor | null; cause?: EventEnvelope; at?: Date }
/** Writes one transaction on the ledger, audits it and announces it. The type must be one the master knows. */
export async function recordTransaction(c: PoolClient, env: Env, audit: AuditClient, vessel: VesselRow, input: RecordInput): Promise<TransactionRow> {
  const type = await lookupByCode(c, 'registryTransactionType', input.type);
  if (!type?.active) throw badRequest(`"${input.type}" is not an active entry of the registryTransactionType master`, { category: 'registryTransactionType' });
  const at = input.at ?? new Date();
  const number = await nextTransactionNo(c, env, at);
  const r = await c.query<TransactionRow>(
    `INSERT INTO registry_transactions(number, vessel_id, vessel_name, official_number, type, registration_id, application_no, particulars, recorded_on, recorded_by_id, recorded_by, notes, digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [number, vessel.id, vessel.name, vessel.official_number ?? '', input.type, input.registrationId ?? null, input.applicationNo ?? '', JSON.stringify(input.particulars ?? {}), at, input.by?.id ?? null, input.by?.name ?? 'Registry', input.notes ?? '', input.digest ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: 'REGISTRY_TRANSACTION', entity: 'Vessel', entityId: vessel.id, entityLabel: `${vessel.name} — ${type.label} (${number})`, after: transactionApi(row), note: input.notes ?? '' });
  const data = { transactionId: row.id, number, vesselId: vessel.id, vesselName: vessel.name, officialNumber: vessel.official_number, type: row.type, typeLabel: type.label, applicationNo: row.application_no, particulars: row.particulars, recordedBy: row.recorded_by };
  await enqueue(c, input.cause
    ? makeEvent({ type: EVENTS.ships.registryTransaction, source: env.SERVICE_NAME, data, subject: vessel.id, correlationId: input.cause.correlationid, causationId: input.cause.id, actor: input.cause.actor })
    : eventFromContext(env.SERVICE_NAME, EVENTS.ships.registryTransaction, data, { subject: vessel.id }));
  return row;
}

export async function encumbrancesFor(c: Queryable, vesselId: string): Promise<EncumbranceApi[]> {
  const r = await c.query<EncumbranceRow>('SELECT * FROM registry_encumbrances WHERE vessel_id = $1 ORDER BY registered_on DESC', [vesselId]);
  return r.rows.map(encumbranceApi);
}
export async function transactionsFor(c: Queryable, vesselId: string): Promise<TransactionApi[]> {
  const r = await c.query<TransactionRow>('SELECT * FROM registry_transactions WHERE vessel_id = $1 ORDER BY recorded_on DESC, number DESC', [vesselId]);
  return r.rows.map(transactionApi);
}
/** Caveats lodged and not withdrawn: each withdrawal names the caveat it lifts. */
export async function liveCaveats(c: Queryable, vesselId: string): Promise<TransactionApi[]> {
  const rows = await transactionsFor(c, vesselId);
  const withdrawn = new Set(rows.filter((t) => t.type === 'CAVEAT_WITHDRAWAL').map((t) => String(t.particulars.caveatId ?? t.particulars.caveatNo ?? '')));
  return rows.filter((t) => t.type === 'CAVEAT' && t.status === 'RECORDED' && !withdrawn.has(t.id) && !withdrawn.has(t.number));
}

export interface EncumbranceInput { kind?: string; holder: string; amount?: number; currency?: string; registeredOn?: string | Date | null; reference?: string; notes?: string; registrationId?: string | null }
/** A mortgage, lien or charge registered against the entry, with the transaction that records it. */
export async function registerEncumbrance(c: PoolClient, env: Env, audit: AuditClient, vessel: VesselRow, input: EncumbranceInput, by?: Principal | null, cause?: EventEnvelope): Promise<{ encumbrance: EncumbranceRow; transaction: TransactionRow }> {
  const j = getJurisdiction(env.JURISDICTION);
  const registeredOn = input.registeredOn ? new Date(input.registeredOn) : new Date();
  const transaction = await recordTransaction(c, env, audit, vessel, { type: 'MORTGAGE_REGISTRATION', registrationId: input.registrationId ?? null, particulars: { kind: input.kind ?? 'MORTGAGE', holder: input.holder, amount: input.amount ?? 0, currency: input.currency ?? j.currency.code, reference: input.reference ?? '' }, notes: input.notes ?? '', by, cause, at: registeredOn });
  const r = await c.query<EncumbranceRow>(
    `INSERT INTO registry_encumbrances(vessel_id, kind, holder, amount, currency, registered_on, reference, registration_id, transaction_id, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [vessel.id, input.kind ?? 'MORTGAGE', input.holder, input.amount ?? 0, input.currency ?? j.currency.code, registeredOn, input.reference ?? '', input.registrationId ?? null, transaction.id, input.notes ?? '']);
  return { encumbrance: r.rows[0], transaction };
}
export async function dischargeEncumbrance(c: PoolClient, env: Env, audit: AuditClient, vessel: VesselRow, encumbranceId: string, input: { dischargedOn?: string | null; reference?: string; notes?: string }, by?: Principal | null): Promise<{ encumbrance: EncumbranceRow; transaction: TransactionRow }> {
  const found = await c.query<EncumbranceRow>('SELECT * FROM registry_encumbrances WHERE id::text = $1 AND vessel_id = $2 FOR UPDATE', [encumbranceId, vessel.id]);
  const row = found.rows[0];
  if (!row) throw notFound('No such charge is registered against this ship');
  if (row.discharged_on) throw conflict('This charge is already discharged');
  const on = input.dischargedOn ? new Date(input.dischargedOn) : new Date();
  const transaction = await recordTransaction(c, env, audit, vessel, { type: 'MORTGAGE_DISCHARGE', particulars: { encumbranceId: row.id, kind: row.kind, holder: row.holder, amount: Number(row.amount), currency: row.currency, reference: input.reference ?? row.reference }, notes: input.notes ?? '', by, at: on });
  const r = await c.query<EncumbranceRow>('UPDATE registry_encumbrances SET discharged_on = $2, discharge_transaction_id = $3, updated_at = now() WHERE id = $1 RETURNING *', [row.id, on, transaction.id]);
  return { encumbrance: r.rows[0], transaction };
}

/* The transcript, assembled from the ledger and sealed. The digest covers the transcript's content and its number,
 * so a copy presented later is checked by rebuilding the same content from the register and comparing. A transcript
 * issued before a later transaction will no longer match — which is the point: it attests the register as it stood. */
export const digestOf = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
export async function buildTranscript(c: Queryable, vessel: VesselRow, profile: string) {
  const rows = await c.query<RegistrationRow>('SELECT * FROM registrations WHERE vessel_id = $1 ORDER BY granted_on NULLS LAST, created_at', [vessel.id]);
  const base = transcriptOf(vessel, rows.rows, profile);
  const encumbrances = await encumbrancesFor(c, vessel.id);
  const caveats = await liveCaveats(c, vessel.id);
  const ledger = await transactionsFor(c, vessel.id);
  return {
    ...base,
    encumbrances: encumbrances.filter((e) => e.live), dischargedEncumbrances: encumbrances.filter((e) => !e.live),
    caveats: caveats.map((t) => ({ number: t.number, lodgedBy: t.particulars.lodgedBy ?? '', ground: t.particulars.ground ?? '', recordedOn: t.recordedOn })),
    transactions: ledger.filter((t) => t.type !== 'TRANSCRIPT').map((t) => ({ number: t.number, type: t.type, recordedOn: t.recordedOn, applicationNo: t.applicationNo, particulars: t.particulars })),
  };
}
export async function issueTranscript(c: PoolClient, env: Env, audit: AuditClient, vessel: VesselRow, by: Principal | null, purpose = '') {
  const content = await buildTranscript(c, vessel, env.JURISDICTION);
  const now = new Date();
  const number = await nextTranscriptNo(c, env, now);
  const attested = { number, issuedOn: now.toISOString(), issuedBy: by?.name ?? 'Registry', registrar: content.registrar, purpose };
  const digest = digestOf({ number, content });
  const transaction = await recordTransaction(c, env, audit, vessel, { type: 'TRANSCRIPT', particulars: { transcriptNo: number, purpose, issuedBy: attested.issuedBy }, digest, notes: purpose, by, at: now });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ships.transcriptIssued, { vesselId: vessel.id, vesselName: vessel.name, officialNumber: vessel.official_number, transcriptNo: number, digest, issuedBy: attested.issuedBy, purpose }, { subject: vessel.id }));
  return { ...content, attestation: { ...attested, digest, transactionNo: transaction.number } };
}
/** Whether a transcript number still attests the register as it stands: the register is rebuilt and its digest compared with the one sealed on issue. */
export async function verifyTranscript(c: Queryable, vessel: VesselRow, profile: string, transcriptNo: string) {
  const t = await c.query<TransactionRow>(`SELECT * FROM registry_transactions WHERE vessel_id = $1 AND type = 'TRANSCRIPT' AND particulars->>'transcriptNo' = $2`, [vessel.id, transcriptNo]);
  const row = t.rows[0];
  if (!row) throw notFound('No transcript of that number was issued for this ship');
  const content = await buildTranscript(c, vessel, profile);
  const now = digestOf({ number: transcriptNo, content });
  const later = await c.query<{ n: string }>(`SELECT count(*) AS n FROM registry_transactions WHERE vessel_id = $1 AND recorded_on > $2 AND type <> 'TRANSCRIPT'`, [vessel.id, row.recorded_on]);
  const matches = now === row.digest;
  return { transcriptNo, issuedOn: iso(row.recorded_on), issuedBy: row.recorded_by, digest: row.digest, matches, transactionsSince: Number(later.rows[0].n), reason: matches ? 'The register stands as the transcript attested it' : `The register has moved since this transcript was issued (${later.rows[0].n} transaction(s) recorded after it)` };
}

/* The master record: one screen with everything the register holds on a ship — her particulars, the entry, who owns
 * and manages her, what is charged against her, what stands in the way of a transfer, every application and every
 * transaction, and the transcripts issued. Assembled, not stored. */
export async function masterRecord(c: Queryable, env: Env, vessel: VesselRow) {
  const profile = env.JURISDICTION;
  const rows = await c.query<RegistrationRow>('SELECT * FROM registrations WHERE vessel_id = $1 ORDER BY created_at DESC', [vessel.id]);
  const transcript = transcriptOf(vessel, rows.rows, profile);
  const encumbrances = await encumbrancesFor(c, vessel.id);
  const ledger = await transactionsFor(c, vessel.id);
  const caveats = await liveCaveats(c, vessel.id);
  const rules = await kindRules(c);
  const granted = rows.rows.filter((r) => r.status === 'GRANTED');
  const current = [...granted].sort((a, b) => (b.granted_on?.getTime() ?? 0) - (a.granted_on?.getTime() ?? 0)).find((r) => rules.get(r.kind)?.family === 'FIRST') ?? null;
  const certificates = granted.filter((r) => r.certificate_no).map((r) => ({ certificateNo: r.certificate_no, kind: r.kind, series: rules.get(r.kind)?.series ?? '', grantedOn: iso(r.granted_on), expiresOn: iso(r.certificate_expires_on), applicationNo: r.application_no }));
  const v = vesselApi(vessel, profile);
  return {
    vessel: { id: vessel.id, name: vessel.name, imo: vessel.imo, flag: vessel.flag, type: vessel.type, grt: vessel.grt, dwt: vessel.dwt, built: vessel.built, callSign: vessel.call_sign, mmsi: vessel.mmsi, classSociety: vessel.class_society, owner: vessel.owner, operator: vessel.operator, manager: vessel.manager, status: vessel.status },
    registry: v.registry, portOfRegistry: vessel.registry_port ? { code: vessel.registry_port, name: portName(vessel.registry_port, profile) } : null, registrar: transcript.registrar,
    onRegister: ['PROVISIONAL', 'REGISTERED', 'BAREBOAT_IN'].includes(vessel.registry_state), firstRegistered: transcript.firstRegistered,
    currentEntry: current ? { applicationNo: current.application_no, kind: current.kind, certificateNo: current.certificate_no, grantedOn: iso(current.granted_on), expiresOn: iso(current.certificate_expires_on), particulars: current.particulars ?? {} } : null,
    owners: transcript.owners, shareLedger: shareLedger(transcript.owners, profile), tonnage: transcript.tonnage,
    encumbrances: encumbrances.filter((e) => e.live), dischargedEncumbrances: encumbrances.filter((e) => !e.live), caveats,
    titleBlocked: caveats.length > 0, closure: transcript.closure,
    applications: rows.rows.map((r) => registrationApi(r, profile)), certificates, transactions: ledger,
    transcripts: ledger.filter((t) => t.type === 'TRANSCRIPT').map((t) => ({ transcriptNo: String(t.particulars.transcriptNo ?? ''), issuedOn: t.recordedOn, issuedBy: t.recordedBy, purpose: String(t.particulars.purpose ?? ''), digest: t.digest })),
    generatedAt: new Date().toISOString(),
  };
}
