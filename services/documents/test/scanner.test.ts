import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { ClamAvScanner, NoopScanner } from '../src/scanner';

/** A clamd stand-in that speaks the INSTREAM/PING wire protocol and flags the EICAR marker. */
export function startFakeClamAv(): Promise<{ server: Server; port: number; chunks: number[] }> {
  const chunks: number[] = [];
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.subarray(0, 6).equals(Buffer.from('zPING\0'))) { sock.end('PONG\0'); return; }
      if (buf.length < 10 || !buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let off = 10; const parts: Buffer[] = [];
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (len === 0) { chunks.push(parts.length); const content = Buffer.concat(parts).toString('latin1'); sock.end(content.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'); return; }
        if (off + 4 + len > buf.length) return;
        parts.push(buf.subarray(off + 4, off + 4 + len)); off += 4 + len;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, chunks })));
}

describe('virus scanners', () => {
  let fake: Awaited<ReturnType<typeof startFakeClamAv>>;
  beforeAll(async () => { fake = await startFakeClamAv(); });
  afterAll(() => new Promise<void>((r) => fake.server.close(() => r())));
  it('streams to clamd in length-prefixed chunks and reads OK / FOUND replies', async () => {
    const scanner = new ClamAvScanner('127.0.0.1', fake.port, 2000, 8);
    expect(await scanner.ping()).toBe(true);
    expect(await scanner.scan(Buffer.from('a perfectly ordinary attachment'))).toEqual({ status: 'CLEAN', scanner: 'clamav' });
    expect(fake.chunks.at(-1)).toBe(4);
    const infected = await scanner.scan(Buffer.from('marker: EICAR-STANDARD-ANTIVIRUS-TEST-FILE'));
    expect(infected).toEqual({ status: 'INFECTED', scanner: 'clamav', detail: 'Eicar-Test-Signature' });
  });
  it('fails loudly when clamd is unreachable and the noop scanner reports SKIPPED', async () => {
    await expect(new ClamAvScanner('127.0.0.1', 1, 500).scan(Buffer.from('x'))).rejects.toThrow(/clamav/);
    expect(await new NoopScanner().scan(Buffer.from('x'))).toEqual({ status: 'SKIPPED', scanner: 'noop' });
  });
});
