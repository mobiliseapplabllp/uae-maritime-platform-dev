import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AiGatewayClient, AppLogger } from '@maritime/service-kit';
import type { InferRequest, InferResult, ServingProvider } from './serving';

/*
 * Vision, in-country first.
 *
 * A document is read here, on the platform, by an OCR engine that runs in the service's own process with its language
 * data shipped in the repository's dependencies — no image leaves the platform to be read. The fields a caller asks
 * for are then found in what was read: by the labels a statutory certificate carries, by the shape of the value (an
 * IMO number has a check digit, a date has a calendar), and by the caller's own hints, which the read confirms or
 * contradicts rather than repeats. Only when fields are still unread, and only when Settings → AI names a hosted
 * provider, is the read text sent through the tool gateway — masked and fenced there like every other completion —
 * to be refined; the answer says which fields came from where.
 *
 * Every field carries a confidence and a source. A field that was not found is returned unfound, with no confidence,
 * because the difference between a field to confirm and a field to check is the whole value of the pipeline.
 */
export interface VisionOptions {
  /** The OCR languages, in tesseract's naming, joined with `+`. */
  langs: string;
  /** Where the language data is kept for the engine; the packaged data is copied there once. */
  cachePath: string;
  /** The documents service, and the token the caller carried, which is how a document is read as that person. */
  documentsUrl: string;
  ocrTimeoutMs: number;
  refine: 'off' | 'when-unread' | 'always';
  gateway?: AiGatewayClient | null;
  caller?: string;
  log?: AppLogger;
}
export interface FieldRead { value: string | null; confidence: number; source: 'read' | 'hint' | 'read+hint' | 'hosted' | 'none'; evidence?: string; conflict?: string; normalised?: string }
export interface OcrWord { text: string; confidence: number }
export interface OcrResult { text: string; confidence: number; words: OcrWord[]; ms: number }

/* ----------------------------------------------------------------------------------------- the engine --- */

type Worker = { recognize: (image: Buffer, options?: Record<string, unknown>, output?: Record<string, boolean>) => Promise<{ data: { text: string; confidence: number; blocks?: { paragraphs: { lines: { words: { text: string; confidence: number }[] }[] }[] }[] | null } }>; terminate: () => Promise<unknown> };

/** The packaged language data, copied beside the engine's cache once so the engine reads it from one directory. */
export async function prepareLanguageData(langs: string, cachePath: string): Promise<string[]> {
  await mkdir(cachePath, { recursive: true });
  const present: string[] = [];
  for (const lang of langs.split('+').map((l) => l.trim()).filter(Boolean)) {
    const target = join(cachePath, `${lang}.traineddata.gz`);
    try { await stat(target); present.push(lang); continue; } catch { /* not yet copied */ }
    let source = '';
    try {
      const pkg = require.resolve(`@tesseract.js-data/${lang}/package.json`);
      source = join(dirname(pkg), '4.0.0_best_int', `${lang}.traineddata.gz`);
      await stat(source);
    } catch { continue; }
    await copyFile(source, target); present.push(lang);
  }
  return present;
}

/** One OCR worker per process, created on first use and kept: loading the language data is the slow part. */
export class OcrEngine {
  private worker: Promise<Worker> | null = null;
  private langsReady: string[] = [];
  constructor(private readonly langs: string, private readonly cachePath: string, private readonly log?: AppLogger) {}
  get languages(): string[] { return this.langsReady; }
  private async start(): Promise<Worker> {
    const ready = await prepareLanguageData(this.langs, this.cachePath);
    if (!ready.length) throw new Error(`no OCR language data for ${this.langs}`);
    this.langsReady = ready;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createWorker, OEM } = require('tesseract.js') as { createWorker: (langs: string, oem: number, opts: Record<string, unknown>) => Promise<Worker>; OEM: { LSTM_ONLY: number } };
    return createWorker(ready.join('+'), OEM.LSTM_ONLY, { langPath: this.cachePath, cachePath: this.cachePath, gzip: true, logger: () => undefined, errorHandler: (e: unknown) => this.log?.warn({ err: e }, 'OCR worker reported an error') });
  }
  async recognise(image: Buffer, timeoutMs: number): Promise<OcrResult> {
    const t0 = Date.now();
    if (!this.worker) this.worker = this.start().catch((e) => { this.worker = null; throw e; });
    const worker = await this.worker;
    const timer = new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(`OCR exceeded ${timeoutMs} ms`)), timeoutMs).unref());
    const { data } = await Promise.race([worker.recognize(image, {}, { text: true, blocks: true }), timer]);
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) words.push({ text: w.text, confidence: Math.max(0, Math.min(1, w.confidence / 100)) });
    return { text: data.text ?? '', confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)), words, ms: Date.now() - t0 };
  }
  async stop() { const w = await this.worker?.catch(() => null); await w?.terminate(); this.worker = null; }
}

/* ------------------------------------------------------------------------------------- reading fields --- */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
const clean = (s: string) => s.replace(/^[\s:.\-–—|]+|[\s:.\-–—|]+$/g, '').replace(/\s+/g, ' ').trim();
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** The labels a statutory certificate carries for the fields callers ask for; a field not listed is matched by its own name. */
const LABELS: Record<string, string[]> = {
  certificateno: ['certificate no', 'certificate number', 'cert no', 'no.', 'number'],
  certificatenumber: ['certificate no', 'certificate number', 'cert no'],
  referencenumber: ['reference no', 'reference number', 'ref no', 'ref.'],
  vesselname: ['name of ship', 'name of vessel', 'vessel name', 'ship name', 'name of the ship'],
  shipname: ['name of ship', 'name of vessel', 'vessel name', 'ship name'],
  imo: ['imo number', 'imo no', 'imo'],
  imonumber: ['imo number', 'imo no', 'imo'],
  portofregistry: ['port of registry', 'registry port'],
  flag: ['flag', 'flag state', 'port of registry'],
  grosstonnage: ['gross tonnage', 'gross tons', 'gt'],
  issueddate: ['date of issue', 'issue date', 'issued on', 'date issued', 'issued'],
  issuedate: ['date of issue', 'issue date', 'issued on', 'date issued'],
  expirydate: ['valid until', 'date of expiry', 'expiry date', 'expires on', 'valid to', 'expires'],
  validuntil: ['valid until', 'date of expiry', 'valid to'],
  issuer: ['issued by', 'issuing authority', 'authority', 'issued under the authority of'],
  issuedby: ['issued by', 'issuing authority', 'issued under the authority of'],
  holdername: ['name of holder', 'holder name', 'holder'],
  callsign: ['call sign', 'distinctive number or letters', 'distinctive letters'],
};
const isDate = (name: string) => /date|until|expir|valid|issued/.test(name.toLowerCase());
const imoValid = (d: string) => d.length === 7 && String(d.slice(0, 6).split('').reduce((s, c, i) => s + Number(c) * (7 - i), 0) % 10) === d[6];

/** A date in any of the forms a certificate is typed in, to an ISO day; null when it is not one. */
export function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\s/.-]+([A-Za-z]{3,9})[\s/.,-]+(\d{4})/.exec(s);
  if (m) { const mi = MONTHS.findIndex((x) => x.startsWith(m![2].toLowerCase().slice(0, 3))); if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = /^([A-Za-z]{3,9})[\s/.-]+(\d{1,2}),?[\s/.-]+(\d{4})/.exec(s);
  if (m) { const mi = MONTHS.findIndex((x) => x.startsWith(m![1].toLowerCase().slice(0, 3))); if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** The OCR confidence of a value: the mean over the words that make it up, or the page's when the words are unknown. */
function confidenceOf(value: string, ocr: OcrResult): number {
  const parts = value.split(/\s+/).map(norm).filter(Boolean);
  const hits = parts.map((p) => ocr.words.find((w) => norm(w.text) === p)?.confidence).filter((c): c is number => typeof c === 'number');
  const c = hits.length ? hits.reduce((s, v) => s + v, 0) / hits.length : ocr.confidence;
  return Math.round(c * 1000) / 1000;
}

/** Finds one field in the read text: by its labels on a line, by its shape, or by the certificate's title. */
function readField(name: string, lines: string[], ocr: OcrResult): { value: string; evidence: string; strength: number } | null {
  const key = name.toLowerCase().replace(/[^a-z]/g, '');
  const labels = [...(LABELS[key] ?? []), words(name)].map((l) => l.toLowerCase()).sort((a, b) => b.length - a.length);
  if (key === 'imo' || key === 'imonumber') {
    for (const line of lines) { const m = /imo\s*(?:no\.?|number)?\s*[:.]?\s*(\d{7})\b/i.exec(line); if (m) return { value: m[1], evidence: line, strength: imoValid(m[1]) ? 1 : 0.6 }; }
    for (const line of lines) { const m = /\b(\d{7})\b/.exec(line); if (m && imoValid(m[1])) return { value: m[1], evidence: line, strength: 0.7 }; }
  }
  if (key === 'certificatetype' || key === 'documenttype' || key === 'title') {
    // the title is the capitals line naming the instrument; a title wrapped over two or three lines is joined back up
    const caps = (l: string) => l.replace(/[^A-Za-z]/g, '').length > 3 && l === l.toUpperCase() && !/\d/.test(l);
    const at = lines.findIndex((l) => /certificate|licence|license|permit|declaration/i.test(l) && caps(l));
    if (at >= 0) {
      let from = at;
      // a letterhead is not part of the title: the first line of the page, or a line in brackets, stays where it is
      while (from > 1 && caps(lines[from - 1]) && !/[:.()]/.test(lines[from - 1]) && lines[from - 1].split(/\s+/).length >= 2 && at - from < 2) from -= 1;
      const title = lines.slice(from, at + 1).join(' ');
      return { value: clean(title), evidence: title, strength: 0.9 };
    }
  }
  for (const label of labels) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]; const at = line.toLowerCase().indexOf(label);
      if (at < 0) continue;
      // the label is a whole word or phrase: "name" is not the start of "name of ship", "no." is not inside "number"
      if (/[a-z]/i.test(line[at - 1] ?? '') || /[a-z]/i.test(line[at + label.length] ?? '')) continue;
      const before = line.slice(0, at).trim(); if (before.length > 24) continue; // the label is not this line's subject
      let rest = clean(line.slice(at + label.length));
      if (!rest && i + 1 < lines.length) rest = clean(lines[i + 1]);
      if (!rest) continue;
      if (isDate(name)) { const iso = toIsoDate(rest); if (iso) return { value: rest, evidence: line, strength: 1 }; const m = /(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})/.exec(rest); if (m) return { value: m[1], evidence: line, strength: 0.9 }; continue; }
      return { value: rest, evidence: line, strength: label === words(name) && !LABELS[key] ? 0.8 : 1 };
    }
  }
  void ocr;
  return null;
}

/** Reads the fields asked for out of the text, confirms or contradicts the hints, and says where each came from. */
export function extractFields(fields: string[], ocr: OcrResult | null, hints: Record<string, unknown>): Record<string, FieldRead> {
  const lines = (ocr?.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Record<string, FieldRead> = {};
  for (const name of fields) {
    const hint = hints[name] === undefined || hints[name] === null || hints[name] === '' ? null : String(hints[name]);
    const read = ocr ? readField(name, lines, ocr) : null;
    if (read) {
      const iso = isDate(name) ? toIsoDate(read.value) : null;
      // a value whose shape checks out — an IMO number with its check digit, a date the calendar accepts — is trusted
      // beyond the engine's own word-level confidence, which is low on digits it read perfectly well
      const shape = (name.toLowerCase().startsWith('imo') && imoValid(read.value)) ? 0.92 : iso ? 0.85 : 0;
      const conf = Math.round(Math.max(confidenceOf(read.value, ocr!) * read.strength, shape) * 1000) / 1000;
      const agrees = hint !== null && (norm(hint) === norm(read.value) || (iso !== null && toIsoDate(hint) === iso));
      if (agrees) out[name] = { value: hint!, confidence: Math.max(conf, 0.98), source: 'read+hint', evidence: read.evidence, ...(iso ? { normalised: iso } : {}) };
      else if (hint !== null && similar(hint, read.value)) out[name] = { value: hint, confidence: Math.max(conf, 0.9), source: 'read+hint', evidence: read.evidence, ...(iso ? { normalised: iso } : {}) };
      else out[name] = { value: read.value, confidence: conf, source: 'read', evidence: read.evidence, ...(hint !== null ? { conflict: hint } : {}), ...(iso ? { normalised: iso } : {}) };
    } else if (hint !== null) {
      // the caller's own word, unconfirmed: worth keeping, not worth pretending it was read
      out[name] = { value: hint, confidence: 0.85, source: 'hint', ...(isDate(name) && toIsoDate(hint) ? { normalised: toIsoDate(hint)! } : {}) };
    } else out[name] = { value: null, confidence: 0, source: 'none' };
  }
  return out;
}
/** Two strings the engine may have read apart: the same once the letter-digit confusions are folded, within a few edits. */
function similar(a: string, b: string): boolean {
  const fold = (s: string) => norm(s).replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/2/g, 'Z');
  const x = fold(a); const y = fold(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // edit distance, on strings a certificate number long
  const prev = Array.from({ length: y.length + 1 }, (_, j) => j); let cur = new Array<number>(y.length + 1);
  for (let i = 1; i <= x.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    for (let j = 0; j <= y.length; j += 1) prev[j] = cur[j];
    cur = new Array<number>(y.length + 1);
  }
  return prev[y.length] <= Math.max(1, Math.floor(Math.max(x.length, y.length) / 6));
}

/* ------------------------------------------------------------------------------------- the provider --- */

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff'];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);
/** A document reference as callers write it: an id, or `documents://<id>`, or `documents://scan/<id>`. */
export const documentIdOf = (ref: string): string => { const s = ref.trim(); const m = /^documents:\/\/(?:[a-z]+\/)?([^/?#]+)/i.exec(s); return m ? m[1] : s.replace(/^\/+/, ''); };

export class LocalVisionProvider implements ServingProvider {
  readonly mode = 'live' as const;
  readonly servedBy = 'platform-vision';
  readonly engine: OcrEngine;
  constructor(private readonly opts: VisionOptions, private readonly fetchImpl: typeof fetch = fetch) {
    this.engine = new OcrEngine(opts.langs, opts.cachePath, opts.log);
  }

  /** The document's bytes, read from the documents service as the person asking — or nothing, with the reason. */
  private async fetchDocument(ref: string, userToken: string | undefined, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string } | { error: string }> {
    if (!ref) return { error: 'no document reference' };
    if (!userToken) return { error: 'no session to read the document as' };
    const id = documentIdOf(ref);
    try {
      const res = await this.fetchImpl(`${this.opts.documentsUrl.replace(/\/+$/, '')}/documents/${encodeURIComponent(id)}/content`, { headers: { authorization: `Bearer ${userToken}` }, signal });
      if (!res.ok) return { error: `documents service answered ${res.status}` };
      return { bytes: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
    } catch (e) { return { error: `documents service unreachable: ${(e as Error).message}` }; }
  }

  /** The hosted refinement, through the gateway, of what stayed unread. The gateway decides whether any provider is configured at all. */
  private async refine(text: string, fields: string[], userToken: string | undefined): Promise<Record<string, string>> {
    if (!this.opts.gateway || !fields.length || !text.trim()) return {};
    try {
      const r = await this.opts.gateway.complete(this.opts.caller ?? 'svc:ai-platform', {
        purpose: 'extract', contract: 'Read the document text between the fences and answer with one JSON object whose keys are exactly the fields asked for. A field the text does not state is null. Copy values as written; never guess.',
        question: `Fields: ${fields.join(', ')}. Answer with JSON only.`, language: 'en',
        grounding: [{ marker: '[D1]', label: 'document text as read by OCR', kind: 'ocr', untrusted: true, text: text.slice(0, 12_000) }], findings: [], refusals: [], history: [], temperature: 0,
      }, { userToken });
      if (r.outcome !== 'OK' || !r.text) return {};
      const m = /\{[\s\S]*\}/.exec(r.text); if (!m) return {};
      const parsed = JSON.parse(m[0]) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const f of fields) if (parsed[f] !== undefined && parsed[f] !== null && String(parsed[f]).trim()) out[f] = String(parsed[f]).trim();
      return out;
    } catch (e) { this.opts.log?.warn({ err: e }, 'hosted refinement failed; the local read stands'); return {}; }
  }

  async infer(req: InferRequest, signal: AbortSignal): Promise<InferResult> {
    const f = req.features as { documentRef?: string; pages?: number; content?: string; hints?: Record<string, unknown> };
    const fields = req.fields?.length ? req.fields : ['documentType', 'referenceNumber', 'issuedDate'];
    const hints = f.hints ?? {};
    let ocr: OcrResult | null = null; let source: 'image' | 'text' | 'none' = 'none'; let warning: string | undefined; let digest: string | undefined;
    if (f.content && f.content.trim()) {
      ocr = { text: f.content, confidence: 1, words: [], ms: 0 }; source = 'text';
    } else {
      const doc = await this.fetchDocument(f.documentRef ?? '', req.userToken, signal);
      if ('error' in doc) warning = `the document could not be read: ${doc.error}`;
      else if (!IMAGE_TYPES.includes(doc.mime)) warning = `${doc.mime || 'the document'} is not an image the in-country engine reads; lodge a scanned page or a photograph`;
      else {
        digest = sha(doc.bytes);
        try { ocr = await this.engine.recognise(doc.bytes, this.opts.ocrTimeoutMs); source = 'image'; }
        catch (e) { warning = `the in-country engine could not read the image: ${(e as Error).message}`; }
      }
    }
    const read = extractFields(fields, ocr, hints);
    const unread = fields.filter((n) => read[n].source === 'none' || (read[n].source === 'read' && read[n].confidence < 0.6));
    let refined: string[] = [];
    if (ocr && this.opts.refine !== 'off' && (this.opts.refine === 'always' || unread.length)) {
      const hosted = await this.refine(ocr.text, this.opts.refine === 'always' ? fields : unread, req.userToken);
      for (const [name, value] of Object.entries(hosted)) {
        if (read[name].source === 'none' || read[name].source === 'read') { read[name] = { value, confidence: read[name].source === 'read' ? Math.max(read[name].confidence, 0.7) : 0.7, source: 'hosted', ...(isDate(name) && toIsoDate(value) ? { normalised: toIsoDate(value)! } : {}) }; refined.push(name); }
      }
    }
    refined = refined.sort();
    const confidences = fields.map((n) => read[n].confidence);
    return {
      output: {
        fields: read, pages: Number(f.pages ?? 1), source,
        ocr: ocr && source === 'image' ? { engine: 'tesseract', languages: this.engine.languages, confidence: ocr.confidence, ms: ocr.ms, words: ocr.words.length, digest } : null,
        refined, ...(warning ? { warning } : {}),
      },
      confidence: Math.round((confidences.reduce((s, c) => s + c, 0) / Math.max(1, confidences.length)) * 1000) / 1000,
    };
  }
}
