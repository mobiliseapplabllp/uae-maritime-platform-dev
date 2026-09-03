/* Retrieval over the platform's own content, offline and deterministic.
 *
 * The embedding is a normalised tf-idf vector computed from this corpus and nothing else: no network, no model,
 * no hidden state. Index the same corpus twice and every vector, every idf and every ranking is identical, which
 * is what lets a test assert that a particular answer cites a particular record.
 *
 * Two rules are structural rather than advisory. Scoping happens before ranking — a passage the reader may not
 * see is never retrieved, so it cannot leak through a snippet, a score or a citation count. And retrieved text
 * is data: anything in a record shaped like an instruction is marked here and quoted downstream, never obeyed. */

export interface CorpusDoc {
  id: string; kind: string; ref: string; title: string; titleAr?: string; body: string; link: string;
  /** What a reader must hold to be shown this passage at all. Empty means everyone with the assistant may see it. */
  permission: string;
  entityType?: string; entityId?: string;
}
export interface IndexedDoc extends CorpusDoc { terms: Record<string, number>; tokenCount: number; untrusted: boolean; injectionMarkers: string[] }
export interface CorpusIndex { idf: Record<string, number>; docs: IndexedDoc[] }

/* Words that carry no signal in a maritime register: they appear in nearly every record, so keeping them would
 * make every document look alike. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'any', 'all', 'may', 'must', 'shall', 'will', 'not', 'no', 'if', 'then', 'than', 'so',
  'has', 'have', 'had', 'do', 'does', 'did', 'we', 'you', 'your', 'our', 'their', 'they', 'he', 'she', 'his', 'her', 'i', 'me', 'my', 'what',
  'which', 'who', 'whom', 'when', 'where', 'how', 'why', 'can', 'could', 'would', 'should', 'about', 'into', 'over', 'under', 'per', 'each',
]);

/** A crude but stable stem: enough to bring plurals and gerunds together without a dictionary. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

/** Lower-cased words and identifiers; a licence number or an IMO number is a token in its own right. */
export function tokenize(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ/-]+/)
    .flatMap((raw) => {
      if (!raw) return [];
      // an identifier such as MAR/LIC/2026/0031 is kept whole and also split, so both forms find it
      if (/[/-]/.test(raw)) return [raw, ...raw.split(/[/-]+/).filter(Boolean)];
      return [raw];
    })
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d$/.test(t))
    .map((t) => (/^[a-z]+$/.test(t) ? stem(t) : t));
}

export function termFrequencies(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/* Content in a record that is trying to steer whoever reads it. Records are written by applicants, agents and
 * masters, so this is a thing that happens; the answer to it is to mark the passage and quote it as data. */
const INJECTION_PATTERNS: [string, RegExp][] = [
  ['override-instructions', /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all)?\s*(instruction|rule|direction|prompt|system)/i],
  ['role-capture', /\byou are now\b|\bact as\b[^.]{0,30}\b(admin|administrator|root|system)\b|\bnew (system )?prompt\b/i],
  ['exfiltration', /\b(reveal|disclose|show|list|dump|send)\b[^.]{0,40}\b(all|every)\b[^.]{0,30}\b(invoice|record|password|secret|user|credential)/i],
  ['permission-escalation', /\b(grant|give|assume|escalate)\b[^.]{0,30}\b(permission|access|privilege|admin rights)\b/i],
  ['tool-command', /\b(call|invoke|execute|run)\b[^.]{0,20}\b(tool|function|command|query)\b/i],
];

/** The markers found in a passage. An empty list means nothing in it was trying to give orders. */
export function detectInjection(text: string): string[] {
  const found: string[] = [];
  for (const [name, re] of INJECTION_PATTERNS) if (re.test(text)) found.push(name);
  return found;
}

const norm = (v: Record<string, number>) => Math.sqrt(Object.values(v).reduce((s, x) => s + x * x, 0));
function normalise(v: Record<string, number>): Record<string, number> {
  const n = norm(v);
  if (!n) return v;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) out[k] = Math.round((x / n) * 1e6) / 1e6;
  return out;
}

/** Cosine similarity of two normalised sparse vectors. */
export function cosine(a: Record<string, number>, b: Record<string, number>): number {
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of Object.entries(small)) { const y = large[k]; if (y) dot += x * y; }
  return Math.round(dot * 1e6) / 1e6;
}

/** The text a document is embedded from: its title carries more signal than its body, so it is weighted twice. */
export const docText = (d: CorpusDoc) => `${d.title} ${d.title} ${d.ref} ${d.ref} ${d.body}`;

/**
 * Builds the whole index in one pass: document frequencies, inverse document frequencies, and one normalised
 * tf-idf vector per document. Smoothed idf keeps a term that appears in every document from going negative.
 */
export function buildIndex(docs: CorpusDoc[]): CorpusIndex {
  const tfs = docs.map((d) => termFrequencies(tokenize(docText(d))));
  const df: Record<string, number> = {};
  for (const tf of tfs) for (const term of Object.keys(tf)) df[term] = (df[term] ?? 0) + 1;
  const n = docs.length || 1;
  const idf: Record<string, number> = {};
  for (const [term, count] of Object.entries(df)) idf[term] = Math.round(Math.log(1 + n / (1 + count)) * 1e6) / 1e6;
  const indexed = docs.map((d, i) => {
    const tf = tfs[i];
    const vector: Record<string, number> = {};
    for (const [term, freq] of Object.entries(tf)) vector[term] = (1 + Math.log(freq)) * (idf[term] ?? 0);
    const markers = detectInjection(`${d.title} ${d.body}`);
    return { ...d, terms: normalise(vector), tokenCount: Object.values(tf).reduce((s, x) => s + x, 0), untrusted: markers.length > 0, injectionMarkers: markers };
  });
  return { idf, docs: indexed };
}

/** Embeds a query against the corpus's own statistics, so a query vector and a document vector are comparable. */
export function embedQuery(query: string, idf: Record<string, number>): Record<string, number> {
  const tf = termFrequencies(tokenize(query));
  const vector: Record<string, number> = {};
  for (const [term, freq] of Object.entries(tf)) {
    const weight = idf[term];
    // a term nothing in the corpus uses cannot discriminate, so it contributes nothing rather than noise
    if (weight) vector[term] = (1 + Math.log(freq)) * weight;
  }
  return normalise(vector);
}

export interface Hit { doc: IndexedDoc; score: number }

/**
 * Ranks the passages a specific reader may see. `permissions` is the reader's own list — scoping happens here,
 * before anything is scored, so a passage outside the reader's permissions never enters the ranking at all.
 */
export function search(
  query: string,
  docs: IndexedDoc[],
  idf: Record<string, number>,
  opts: { permissions: readonly string[]; topK?: number; minScore?: number; kinds?: string[] },
): Hit[] {
  const q = embedQuery(query, idf);
  if (!Object.keys(q).length) return [];
  const allowed = docs.filter((d) => mayRead(d.permission, opts.permissions) && (!opts.kinds?.length || opts.kinds.includes(d.kind)));
  return allowed
    .map((doc) => ({ doc, score: cosine(q, doc.terms) }))
    // a document that shares no term with the question is not a hit, whatever the floor is set to
    .filter((h) => h.score > 0 && h.score >= (opts.minScore ?? 0.04))
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, opts.topK ?? 5);
}

/** Deny by default, with the wildcard honoured exactly as the platform's guards honour it. */
export function mayRead(permission: string, permissions: readonly string[]): boolean {
  if (!permission) return true;
  return permissions.includes('*') || permissions.includes(permission);
}
