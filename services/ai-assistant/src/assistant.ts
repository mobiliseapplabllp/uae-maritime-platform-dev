import type { Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { ASSISTANT_CONTRACT, type CompletionClient, type GroundingBlock, type Language } from './completion';
import { search, type CorpusIndex, type IndexedDoc } from './retrieval';
import { plan, runTools, type Citation, type Row, type ToolRefusal, type ToolRun } from './tools';

/* The answer pipeline.
 *
 * One order, always: read the question, choose the tools the asking user is allowed to use, read the records
 * through them, retrieve the passages that user may see, and only then compose. Composition is last on purpose —
 * by the time any record content is in the room, every decision about what may be read has already been made.
 *
 * Nothing an answer says is unattributed. Every finding comes from a permission-checked tool and every passage
 * carries the record it came from, so the reply the console renders is a list of citations with sentences
 * attached rather than prose with sources bolted on afterwards. */

export interface AnswerRequest {
  question: string;
  permissions: readonly string[];
  history?: { role: 'user' | 'assistant'; text: string }[];
  language?: Language;
}
export interface Source { label: string; link: string }
export interface AnswerResult {
  reply: string;
  sources: Source[];
  citations: (Citation & { score?: number })[];
  tools: { tool: string; label: string }[];
  refusals: ToolRefusal[];
  /** Retrieved passages that tried to instruct the reader. They were quoted, never followed. */
  flagged: { id: string; label: string; markers: string[] }[];
  suggestions: string[];
  engine: string;
  grounded: boolean;
  latencyMs: number;
}

export interface AssistantDeps { env: Env; db: Queryable; completion: CompletionClient; index: CorpusIndex; now?: Date }

/** The prompts the dock offers when a conversation is empty. */
export const SUGGESTIONS = [
  'Which vessels are alongside right now?',
  'What is outstanding on the billing ledger?',
  'Which certificates have lapsed across the fleet?',
  'Which ships carry the highest composite risk?',
  'What incidents are open on the desk?',
  'What does the register say about port state control inspections?',
];

/** Follow-ups worth offering after an answer, chosen from what the answer actually touched. */
export function followUps(tools: ToolRun[], hits: { doc: IndexedDoc }[]): string[] {
  const out: string[] = [];
  const used = new Set(tools.map((t) => t.tool));
  if (used.has('vessel.lookup')) out.push('What is her inspection history?');
  if (used.has('portcall.lookup')) out.push('Which berths are occupied?');
  if (used.has('invoice.summary')) out.push('What is still outstanding and from whom?');
  if (used.has('inspection.summary')) out.push('Which deficiencies are still open?');
  if (used.has('incident.open')) out.push('Which incidents are at high severity?');
  const legal = hits.find((h) => h.doc.kind === 'legislation');
  if (legal) out.push(`What does ${legal.doc.ref} require?`);
  const service = hits.find((h) => h.doc.kind === 'service');
  if (service) out.push(`What documents does ${service.doc.ref} need?`);
  return [...new Set(out)].slice(0, 4).length ? [...new Set(out)].slice(0, 4) : SUGGESTIONS.slice(0, 3);
}

/**
 * Answers one question for one user under that user's permissions.
 *
 * `permissions` is the asking principal's own list and is the only authority consulted; the assistant holds no
 * standing of its own. Everything it could not read is reported rather than silently omitted, because a reader
 * who is told nothing about invoices should know whether that is because there are none or because they may not
 * see them.
 */
export async function answer(deps: AssistantDeps, request: AnswerRequest): Promise<AnswerResult> {
  const started = process.hrtime.bigint();
  const now = deps.now ?? new Date();
  const language: Language = request.language ?? 'en';
  const question = String(request.question ?? '').trim();

  // 1. what the question asks for, and what this user is allowed to ask for
  const { allowed, refused } = plan(question, request.permissions);
  // 2. the records, read through the tool surface and never around it
  const tools = await runTools({ db: deps.db, permissions: request.permissions, now }, question, allowed);
  // 3. the passages this user may see, ranked
  const hits = search(question, deps.index.docs, deps.index.idf, {
    permissions: request.permissions, topK: deps.env.RETRIEVAL_TOP_K, minScore: deps.env.RETRIEVAL_MIN_SCORE,
  });

  const grounding: GroundingBlock[] = hits.map((h) => ({
    id: h.doc.id, label: h.doc.title, kind: h.doc.kind, link: h.doc.link, text: h.doc.body, score: h.score, untrusted: h.doc.untrusted,
  }));
  const findings = tools.flatMap((t) => t.findings);

  // 4. compose, last, from what has already been permitted
  const composed = await deps.completion.complete({
    contract: ASSISTANT_CONTRACT,
    question,
    grounding,
    findings,
    refusals: refused.map((r) => r.message),
    history: (request.history ?? []).slice(-deps.env.HISTORY_TURNS),
    language,
  });

  const citations = [
    ...tools.flatMap((t) => t.citations.map((c) => ({ ...c }))),
    ...hits.map((h) => ({ id: h.doc.id, label: h.doc.title, kind: h.doc.kind, ref: h.doc.ref, link: h.doc.link, score: h.score })),
  ];
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const c of citations) { const key = `${c.label}|${c.link}`; if (c.link && !seen.has(key)) { seen.add(key); sources.push({ label: c.label, link: c.link }); } }

  return {
    reply: composed.text,
    sources: sources.slice(0, 8),
    citations,
    tools: tools.map((t) => ({ tool: t.tool, label: t.label })),
    refusals: refused,
    flagged: hits.filter((h) => h.doc.untrusted).map((h) => ({ id: h.doc.id, label: h.doc.title, markers: h.doc.injectionMarkers })),
    suggestions: followUps(tools, hits),
    /* The profile the operator configured, never a vendor's model name. */
    engine: `${composed.profile} (grounded)`,
    grounded: composed.grounded,
    latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
  };
}

/* ------------------------------------------------------------------------ loading the index --- */

/** The corpus and its statistics, read back exactly as they were written at index time. */
export async function loadIndex(db: Queryable): Promise<CorpusIndex> {
  const docs = (await db.query<Row>('SELECT * FROM corpus ORDER BY id')).rows.map((r): IndexedDoc => ({
    id: r.id, kind: r.kind, ref: r.ref, title: r.title, titleAr: r.title_ar, body: r.body, link: r.link, permission: r.permission,
    entityType: r.entity_type, entityId: r.entity_id, terms: r.terms ?? {}, tokenCount: r.token_count,
    untrusted: r.untrusted, injectionMarkers: r.injection_markers ?? [],
  }));
  const idf: Record<string, number> = {};
  for (const t of (await db.query<Row>('SELECT term, idf FROM corpus_terms')).rows) idf[t.term] = Number(t.idf);
  return { idf, docs };
}

/**
 * Keeps the index in memory and rebuilds it when the corpus changes. The stamp is the corpus's own size and
 * latest write, so a passage added by a consumer is picked up on the next question without a restart.
 */
export class IndexCache {
  private cached?: { stamp: string; index: CorpusIndex };
  constructor(private readonly db: Queryable) {}
  private async stamp(): Promise<string> {
    const r = await this.db.query<Row>('SELECT count(*)::int AS n, COALESCE(max(updated_at), to_timestamp(0)) AS at FROM corpus');
    return `${r.rows[0].n}:${new Date(r.rows[0].at).toISOString()}`;
  }
  async get(): Promise<CorpusIndex> {
    const stamp = await this.stamp();
    if (this.cached?.stamp === stamp) return this.cached.index;
    const index = await loadIndex(this.db);
    this.cached = { stamp, index };
    return index;
  }
  invalidate() { this.cached = undefined; }
}
