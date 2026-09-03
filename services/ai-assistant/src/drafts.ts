import { EVENTS, type Actor } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import type { Citation, Row } from './tools';
import { mayRead } from './retrieval';

/* Drafting.
 *
 * Three things an officer writes over and over from records they already hold: a notice to a shipowner, a
 * decision letter on an application, and the summary of an inspection. The assistant assembles each from the
 * platform's own record and hands it back as a draft with the citations it was written from.
 *
 * A draft is never issued from here. It has no number, no signature and no effect — issuing is the instruments
 * service's business and a human's decision, and the status column says DRAFT for exactly that reason. */

export const DRAFT_KINDS = ['NOTICE', 'DECISION_LETTER', 'INSPECTION_SUMMARY'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** What a reader must hold to have a draft of each kind prepared for them. */
export const DRAFT_PERMISSION: Record<DraftKind, string> = {
  NOTICE: 'legislation.manage',
  DECISION_LETTER: 'services.assess',
  INSPECTION_SUMMARY: 'inspections.view',
};

export interface DraftRecord {
  id: string; kind: string; subject_type: string; subject_id: string; subject_label: string; title: string; body: string;
  citations: Row[]; facts: Row; language: string; status: string; engine: string;
  prepared_by_id: string; prepared_by: string; created_at: Date; updated_at: Date;
}
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const dateOnly = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '—');

export const draftApi = (d: DraftRecord) => ({
  id: d.id, kind: d.kind, subjectType: d.subject_type, subjectId: d.subject_id, subjectLabel: d.subject_label,
  title: d.title, body: d.body, citations: d.citations ?? [], facts: d.facts ?? {}, language: d.language,
  status: d.status, engine: d.engine, preparedById: d.prepared_by_id, preparedBy: d.prepared_by,
  createdAt: iso(d.created_at), updatedAt: iso(d.updated_at),
});

export interface DraftInput { kind: DraftKind; subjectId: string; language?: string; note?: string }
export interface PreparedDraft { title: string; body: string; citations: Citation[]; facts: Row; subjectType: string; subjectLabel: string }

const cite = (id: string, label: string, kind: string, ref: string, link: string): Citation => ({ id, label, kind, ref, link });

/**
 * Assembles the draft from the records the subject actually has. Nothing is invented: where the record is silent
 * the draft says so, because a notice that fills a gap with a plausible sentence is worse than one that leaves
 * the gap visible to the officer who has to sign it.
 */
export async function prepareDraft(db: Queryable, input: DraftInput, preparedBy: string): Promise<PreparedDraft | null> {
  const today = new Date().toISOString().slice(0, 10);
  if (input.kind === 'INSPECTION_SUMMARY') {
    const r = await db.query<Row>('SELECT * FROM inspections WHERE id = $1 OR number = $1 LIMIT 1', [input.subjectId]);
    const i = r.rows[0];
    if (!i) return null;
    const findings: Row[] = (i.payload?.findings ?? []) as Row[];
    const open = findings.filter((f) => f.status === 'OPEN');
    const body = [
      `INSPECTION SUMMARY — ${i.number}`,
      '',
      `Vessel: ${i.vessel_name}`,
      `Inspection type: ${i.type}`,
      `Status: ${i.status}${i.result ? ` — ${i.result}` : ''}`,
      `Carried out: ${dateOnly(i.closed_at ?? i.planned_at)}`,
      '',
      `Deficiencies raised: ${i.total_findings}. Still open: ${open.length}.`,
      ...(findings.length ? ['', 'Deficiencies:', ...findings.slice(0, 12).map((f, n) => `${n + 1}. ${f.deficiencyCode ?? ''} — ${f.description ?? f.deficiencyLabel ?? 'described on the file'} (${f.status ?? 'OPEN'})`)] : ['', 'No deficiencies were raised on this inspection.']),
      ...(i.detention ? ['', 'The vessel was detained. The detention order and its grounds are on the inspection file.'] : []),
      ...(input.note ? ['', `Officer's note: ${input.note}`] : []),
      '',
      `Prepared from the inspection record on ${today} by ${preparedBy}. This is a draft and carries no decision.`,
    ].join('\n');
    return {
      title: `Inspection summary — ${i.number} (${i.vessel_name})`, body, facts: { number: i.number, result: i.result, openFindings: open.length, totalFindings: i.total_findings, detention: i.detention },
      subjectType: 'Inspection', subjectLabel: `${i.number} — ${i.vessel_name}`,
      citations: [cite(i.id, `Inspection ${i.number}`, 'inspection', i.number, `/inspections/${i.id}`), ...(i.vessel_id ? [cite(i.vessel_id, i.vessel_name, 'vessel', '', `/vessels/${i.vessel_id}`)] : [])],
    };
  }

  if (input.kind === 'NOTICE') {
    const r = await db.query<Row>('SELECT * FROM vessels WHERE id = $1 OR imo = $1 LIMIT 1', [input.subjectId]);
    const v = r.rows[0];
    if (!v) return null;
    const certs = (await db.query<Row>(`SELECT cert_type, expiry_date, state FROM vessel_certificates WHERE vessel_id = $1 AND state <> 'VALID' ORDER BY expiry_date NULLS LAST`, [v.id])).rows;
    const open = (await db.query<Row>(`SELECT number, result, open_findings FROM inspections WHERE vessel_id = $1 AND status <> 'CLOSED' ORDER BY planned_at DESC LIMIT 3`, [v.id])).rows;
    const body = [
      `NOTICE TO THE OWNER, MANAGER OR MASTER — ${v.name} (IMO ${v.imo})`,
      '',
      `Flag: ${v.flag || 'not recorded'} · Type: ${v.type || 'not recorded'} · Built: ${v.built || 'not recorded'}`,
      `Standing on the register: ${v.status}${v.risk_band ? ` · composite risk band ${v.risk_band}` : ''}`,
      '',
      certs.length
        ? `The following certificates are not in good standing and are to be regularised:\n${certs.map((c, n) => `${n + 1}. ${c.cert_type} — ${c.state.toLowerCase()} (expiry ${dateOnly(c.expiry_date)})`).join('\n')}`
        : 'No certificate on the register is out of force for this vessel.',
      ...(open.length ? ['', `Open survey work: ${open.map((i) => `${i.number} (${i.open_findings} deficiency/deficiencies open)`).join('; ')}.`] : []),
      ...(input.note ? ['', `Additional direction: ${input.note}`] : []),
      '',
      'A written response is required to the Authority within fourteen (14) days of the date of this notice.',
      '',
      `Prepared from the vessel record on ${today} by ${preparedBy}. This is a draft and has not been issued.`,
    ].join('\n');
    return {
      title: `Notice — ${v.name} (IMO ${v.imo})`, body, facts: { imo: v.imo, certificatesOutOfForce: certs.length, openInspections: open.length, riskBand: v.risk_band },
      subjectType: 'Vessel', subjectLabel: `${v.name} (IMO ${v.imo})`,
      citations: [cite(v.id, v.name, 'vessel', v.imo, `/vessels/${v.id}`), ...(certs.length ? [cite(`${v.id}-certs`, `${v.name} — certificates`, 'vesselCertificate', '', `/vessels/${v.id}`)] : [])],
    };
  }

  // DECISION_LETTER — written on an instrument the register already holds
  const r = await db.query<Row>('SELECT * FROM instruments WHERE id = $1 OR number = $1 LIMIT 1', [input.subjectId]);
  const ins = r.rows[0];
  if (!ins) return null;
  const decided = ins.status === 'ISSUED' ? 'approved' : ins.status === 'REJECTED' ? 'refused' : String(ins.status).toLowerCase();
  const body = [
    `DECISION — ${ins.entity_type.replace(/_/g, ' ')}`,
    '',
    `Applicant / holder: ${ins.entity_name}`,
    `Instrument number: ${ins.number}`,
    `Decision: the application is ${decided}.`,
    ins.status === 'ISSUED'
      ? `The instrument is valid from ${dateOnly(ins.issue_date)} to ${dateOnly(ins.expiry_date)} and is ${ins.in_force ? 'in force' : 'not currently in force'}.`
      : 'The reasons are recorded on the application file and may be appealed within the statutory period.',
    ...(input.note ? ['', `Officer's reasons: ${input.note}`] : []),
    '',
    'This decision may be verified publicly against the instrument register using the number above.',
    '',
    `Prepared from the instrument register on ${today} by ${preparedBy}. This is a draft and has not been signed or issued.`,
  ].join('\n');
  return {
    title: `Decision letter — ${ins.number} (${ins.entity_name})`, body,
    facts: { number: ins.number, status: ins.status, inForce: ins.in_force, entityType: ins.entity_type },
    subjectType: 'Instrument', subjectLabel: `${ins.number} — ${ins.entity_name}`,
    citations: [cite(ins.id, `Instrument ${ins.number}`, 'instrument', ins.number, '/certificates')],
  };
}

export const mayPrepare = (kind: DraftKind, permissions: readonly string[]) => mayRead(DRAFT_PERMISSION[kind], permissions);

export async function publishDraft(c: Queryable, env: Env, d: DraftRecord, opts: { actor?: Actor } = {}) {
  const entity = draftApi(d);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'aiDraft', entity }, { subject: d.id, actor: opts.actor }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ai.draftPrepared, {
    draftId: d.id, kind: d.kind, subjectType: d.subject_type, subjectId: d.subject_id, subjectLabel: d.subject_label,
    title: d.title, citations: d.citations ?? [], preparedBy: d.prepared_by, status: d.status, draft: entity,
  }, { subject: d.id, actor: opts.actor }));
  return entity;
}
