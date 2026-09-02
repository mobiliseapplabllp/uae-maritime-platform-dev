import { createConnection } from 'node:net';
import type { Env } from './env';

export type VirusStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED';
export interface ScanResult { status: VirusStatus; scanner: string; detail?: string }
export interface Scanner { readonly name: string; scan(buffer: Buffer, name?: string): Promise<ScanResult> }
export const SCANNER = 'DOCUMENTS_SCANNER';

/** No scanner configured: files are stored with status SKIPPED so the gap is visible, never mistaken for CLEAN. */
export class NoopScanner implements Scanner {
  readonly name = 'noop';
  async scan(): Promise<ScanResult> { return { status: 'SKIPPED', scanner: this.name }; }
}

/** ClamAV over TCP using the INSTREAM command (length-prefixed chunks, zero-length terminator); no client library needed. */
export class ClamAvScanner implements Scanner {
  readonly name = 'clamav';
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 30000, private readonly chunkSize = 64 * 1024) {}
  private exchange(send: (write: (b: Buffer) => void) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ host: this.host, port: this.port });
      const chunks: Buffer[] = []; let settled = false;
      const finish = (err?: Error, value?: string) => { if (settled) return; settled = true; sock.destroy(); if (err) reject(err); else resolve(value ?? ''); };
      const text = () => Buffer.concat(chunks).toString('utf8');
      sock.setTimeout(this.timeoutMs, () => finish(new Error(`clamav: timeout after ${this.timeoutMs}ms`)));
      sock.on('error', (e) => finish(new Error(`clamav: ${e.message}`)));
      sock.on('data', (d) => { chunks.push(d); const s = text(); const nul = s.indexOf('\0'); if (nul >= 0) finish(undefined, s.slice(0, nul)); });
      sock.on('end', () => finish(undefined, text().split('\0')[0]));
      sock.on('connect', () => send((b) => { sock.write(b); }));
    });
  }
  async ping(): Promise<boolean> { return (await this.exchange((w) => w(Buffer.from('zPING\0')))).trim() === 'PONG'; }
  async scan(buffer: Buffer): Promise<ScanResult> {
    const reply = (await this.exchange((write) => {
      write(Buffer.from('zINSTREAM\0'));
      for (let off = 0; off < buffer.length; off += this.chunkSize) {
        const chunk = buffer.subarray(off, Math.min(buffer.length, off + this.chunkSize));
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length, 0);
        write(len); write(chunk);
      }
      write(Buffer.alloc(4, 0));
    })).trim();
    if (/\bOK$/.test(reply)) return { status: 'CLEAN', scanner: this.name };
    const found = /^stream:\s*(.+?)\s+FOUND$/.exec(reply);
    if (found) return { status: 'INFECTED', scanner: this.name, detail: found[1] };
    throw new Error(`clamav: unexpected reply "${reply || '(empty)'}"`);
  }
}

export const createScanner = (env: Env): Scanner => (env.SCANNER_DRIVER === 'clamav' ? new ClamAvScanner(env.CLAMAV_HOST, env.CLAMAV_PORT, env.CLAMAV_TIMEOUT_MS) : new NoopScanner());
