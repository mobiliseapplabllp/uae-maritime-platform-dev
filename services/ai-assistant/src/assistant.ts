import type { Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { ASSISTANT_CONTRACT, type CompletionClient, type GroundingBlock, type Language } from './completion';
import { DEFAULT_DENSE_WEIGHT, embedQueryDense, search, type CorpusIndex, type Hit, type IndexedDoc } from './retrieval';
import { detectVectorMode, recall } from './vectors';
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

/* ------------------------------------------------------------------------------ retrieval --- */

/** How many candidates the recall pass asks for per passage the answer will use. The dense vector is
 *  approximate twice over — once in the hashing, once in the ANN traversal — so it is asked for a pool wide
 *  enough that the exact re-ranking, not the approximation, decides what an answer is grounded in. */
export const RECALL_FACTOR = 20;
export const RECALL_MIN = 200;

export interface RetrievalOptions {
  permissions: readonly string[];
  topK?: number;
  minScore?: number;
  kinds?: string[];
  denseWeight?: number;
  /** The corpus size at which the first pass moves into SQL. */
  annMinDocs?: number;
  /** Forces the in-process path, whatever the cluster has. */
  forceMemory?: boolean;
}

/**
 * The passages a reader may see, ranked.
 *
 * Two passes, always in this order. Recall narrows the corpus to a candidate pool; scoring ranks that pool
 * on the exact vectors. Where the recall pass runs is the only thing that changes between modes — in SQL
 * against pgvector's index once the corpus is large enough to be worth it, in process below that, where
 * scoring everything is exact and costs less than the round trip. Both give the same ordering, because the
 * pool is far wider than the answer and the exact vectors decide it either way.
 *
 * The permission filter is in the recall query's WHERE clause, not applied to its results. A passage this
 * reader may not see is never a candidate in either mode.
 */
export async function retrieve(db: Queryable, index: CorpusIndex, question: string, opts: RetrievalOptions): Promise<Hit[]> {
  const topK = opts.topK ?? 5;
  const denseWeight = opts.denseWeight ?? DEFAULT_DENSE_WEIGHT;
  const scoring = { permissions: opts.permissions, topK, minScore: opts.minScore, kinds: opts.kinds, denseWeight };

  const bigEnough = index.docs.length >= (opts.annMinDocs ?? Number.POSITIVE_INFINITY);
  if (!bigEnough || denseWeight <= 0) return search(question, index.docs, index.idf, scoring);

  const mode = await detectVectorMode(db, opts.forceMemory);
  if (mode === 'memory') return search(question, index.docs, index.idf, scoring);

  const q = embedQueryDense(question);
  if (!q.length) return search(question, index.docs, index.idf, scoring);
  const pool = await recall(db, q, { permissions: opts.permissions, kinds: opts.kinds, limit: Math.max(topK * RECALL_FACTOR, RECALL_MIN) });
  return search(question, index.docs, index.idf, { ...scoring, candidates: new Set(pool.map((c) => c.id)) });
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
  const hits = await retrieve(deps.db, deps.index, question, {
    permissions: request.permissions, topK: deps.env.RETRIEVAL_TOP_K, minScore: deps.env.RETRIEVAL_MIN_SCORE,
    denseWeight: deps.env.RETRIEVAL_DENSE_WEIGHT, annMinDocs: deps.env.RETRIEVAL_ANN_MIN_DOCS,
    forceMemory: deps.env.RETRIEVAL_VECTOR_MODE === 'memory',
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
    // the canonical numeric vector, not pgvector's copy of it: the in-process path has to work either way
    dense: Array.isArray(r.dense) ? r.dense.map(Number) : [],
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
