import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppLogger } from '@maritime/service-kit';
import type { InferRequest, InferResult, ServingProvider } from './serving';

/*
 * Speech, on the host.
 *
 * A recording is transcribed by a speech model installed on the machine the platform runs on — a whisper-class
 * command-line model, typically — reached through one seam: the command and its arguments come from the service's
 * environment, never from a request or a setting, and the command runs without a shell. The recording is read from
 * the documents service as the person asking, handed to the command as a file, and the file is removed afterwards.
 * The command's answer is read three ways: JSON on its standard output, a JSON file it wrote beside the recording,
 * or plain text with or without timestamps. Without a command configured, the stub answers and says so.
 */
export interface SpeechOptions {
  command: string; args: string[]; timeoutMs: number;
  documentsUrl: string; log?: AppLogger;
}
export interface Segment { from: number | null; to: number | null; text: string }
export const documentIdOf = (ref: string): string => { const s = ref.trim(); const m = /^documents:\/\/(?:[a-z]+\/)?([^/?#]+)/i.exec(s); return m ? m[1] : s.replace(/^\/+/, ''); };

/** The command's arguments with the placeholders filled: `{file}`, `{language}`, `{dir}`. */
export const fillArgs = (template: string[], vars: Record<string, string>): string[] => template.map((a) => a.replace(/\{(file|language|dir)\}/g, (_m, k: string) => vars[k] ?? ''));
/** The arguments as they are written in the environment: whitespace-separated, a quoted run kept together. */
export const parseArgs = (s: string): string[] => { const out: string[] = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m: RegExpExecArray | null; while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]); return out; };

const stamp = (s: string): number | null => { const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim()); if (!m) return null; return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000; };
/** What the command said, read as JSON, as a whisper-style timestamped listing, or as plain text. */
export function parseTranscript(raw: string): { text: string; language: string | null; duration: number | null; segments: Segment[]; confidence: number | null } {
  const s = raw.trim();
  const tryJson = (t: string) => { try { return JSON.parse(t) as Record<string, unknown>; } catch { return null; } };
  const j = tryJson(s) ?? (() => { const m = /\{[\s\S]*\}/.exec(s); return m ? tryJson(m[0]) : null; })();
  if (j && typeof j === 'object') {
    const segs = Array.isArray(j.segments) ? (j.segments as Record<string, unknown>[]) : Array.isArray((j.transcription as unknown[])) ? (j.transcription as Record<string, unknown>[]) : [];
    const segments: Segment[] = segs.map((x) => {
      const ts = (x.timestamps ?? {}) as Record<string, unknown>; const off = (x.offsets ?? {}) as Record<string, unknown>;
      const from = typeof x.start === 'number' ? x.start : typeof off.from === 'number' ? off.from / 1000 : typeof ts.from === 'string' ? stamp(ts.from) : null;
      const to = typeof x.end === 'number' ? x.end : typeof off.to === 'number' ? off.to / 1000 : typeof ts.to === 'string' ? stamp(ts.to) : null;
      return { from, to, text: String(x.text ?? '').trim() };
    }).filter((x) => x.text);
    const text = String(j.text ?? j.transcript ?? segments.map((x) => x.text).join(' ')).trim();
    const probs = segs.map((x) => (typeof x.avg_logprob === 'number' ? Math.exp(x.avg_logprob) : typeof x.confidence === 'number' ? x.confidence : null)).filter((p): p is number => p !== null);
    const lang = typeof j.language === 'string' ? j.language : ((j.result as Record<string, unknown> | undefined)?.language as string | undefined) ?? null;
    const duration = typeof j.duration === 'number' ? j.duration : segments.length && segments[segments.length - 1].to !== null ? segments[segments.length - 1].to : null;
    return { text, language: lang, duration, segments, confidence: probs.length ? Math.round((probs.reduce((a, b) => a + b, 0) / probs.length) * 1000) / 1000 : null };
  }
  const segments: Segment[] = []; const plain: string[] = [];
  for (const line of s.split(/\r?\n/)) {
    const m = /^\[?\s*(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*\]?\s*(.*)$/.exec(line.trim());
    if (m) segments.push({ from: stamp(m[1]), to: stamp(m[2]), text: m[3].trim() }); else if (line.trim()) plain.push(line.trim());
  }
  const text = (segments.length ? segments.map((x) => x.text) : plain).join(' ').replace(/\s+/g, ' ').trim();
  return { text, language: null, duration: segments.length ? segments[segments.length - 1].to : null, segments, confidence: null };
}

export class CommandSpeechProvider implements ServingProvider {
  readonly mode = 'live' as const;
  readonly servedBy = 'platform-speech';
  constructor(private readonly opts: SpeechOptions, private readonly fetchImpl: typeof fetch = fetch) {}

  private async fetchAudio(ref: string, userToken: string | undefined, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string } | { error: string }> {
    if (!ref) return { error: 'no recording reference' };
    if (!userToken) return { error: 'no session to read the recording as' };
    try {
      const res = await this.fetchImpl(`${this.opts.documentsUrl.replace(/\/+$/, '')}/documents/${encodeURIComponent(documentIdOf(ref))}/content`, { headers: { authorization: `Bearer ${userToken}` }, signal });
      if (!res.ok) return { error: `documents service answered ${res.status}` };
      return { bytes: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
    } catch (e) { return { error: `documents service unreachable: ${(e as Error).message}` }; }
  }

  /** Runs the configured command on a file, without a shell, under the time limit; answers its output and the JSON file it may have written. */
  private run(dir: string, file: string, language: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const args = fillArgs(this.opts.args, { file, language, dir });
    return new Promise((resolve) => {
      const child = execFile(this.opts.command, args, { timeout: this.opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd: dir, signal }, (err, stdout, stderr) => {
        const code = err ? (err as { code?: unknown }).code : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: typeof code === 'number' ? code : null });
      });
      child.on('error', () => undefined);
    });
  }

  async infer(req: InferRequest, signal: AbortSignal): Promise<InferResult> {
    const f = req.features as { audioRef?: string; durationSec?: number; language?: string };
    const language = String(f.language ?? 'en').slice(0, 12);
    const audio = await this.fetchAudio(f.audioRef ?? '', req.userToken, signal);
    if ('error' in audio) return { output: { transcript: '', language, durationSec: Number(f.durationSec ?? 0), words: 0, segments: [], warning: `the recording could not be read: ${audio.error}` }, confidence: 0 };
    const ext = audio.mime.includes('wav') ? 'wav' : audio.mime.includes('mpeg') || audio.mime.includes('mp3') ? 'mp3' : audio.mime.includes('ogg') ? 'ogg' : audio.mime.includes('flac') ? 'flac' : audio.mime.includes('mp4') || audio.mime.includes('m4a') ? 'm4a' : 'bin';
    const dir = await mkdtemp(join(tmpdir(), 'maritime-speech-'));
    const file = join(dir, `recording.${ext}`);
    try {
      await writeFile(file, audio.bytes);
      const t0 = Date.now();
      const r = await this.run(dir, file, language, signal);
      const sidecar = await readFile(`${file}.json`, 'utf8').catch(() => '');
      const parsed = parseTranscript(sidecar || r.stdout);
      if (r.code !== 0 && !parsed.text) {
        this.opts.log?.warn({ code: r.code, stderr: r.stderr.slice(0, 400) }, 'speech command failed');
        return { output: { transcript: '', language, durationSec: Number(f.durationSec ?? 0), words: 0, segments: [], warning: `the speech command failed (exit ${r.code ?? 'signal'}): ${r.stderr.trim().slice(0, 200) || 'no output'}` }, confidence: 0 };
      }
      const words = parsed.text ? parsed.text.split(/\s+/).filter(Boolean).length : 0;
      return {
        output: { transcript: parsed.text || '(no speech detected)', language: parsed.language ?? language, durationSec: parsed.duration ?? Number(f.durationSec ?? 0), words, segments: parsed.segments, engine: { command: this.opts.command.split(/[\\/]/).pop(), ms: Date.now() - t0, confidenceBasis: parsed.confidence === null ? 'not reported by the command' : 'reported by the command' } },
        confidence: parsed.confidence ?? (words ? 0.75 : 0.1),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
