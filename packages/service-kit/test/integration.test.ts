import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SecretBox, digestsMatch, hmacSha256Hex, randomSecret } from '../src/crypto/secret-box';
import { HubUnavailable, IntegrationClient } from '../src/integration-client';

describe('the secret box', () => {
  it('seals and opens a value, with a fresh nonce each time and the purpose folded into the key', () => {
    const box = new SecretBox('deployment-material', 'hub');
    const a = box.seal('api-key-1'); const b = box.seal('api-key-1');
    expect(a).not.toBe(b); expect(box.open(a)).toBe('api-key-1'); expect(box.open(b)).toBe('api-key-1');
    expect(() => new SecretBox('deployment-material', 'mfa').open(a)).toThrow();
    expect(() => new SecretBox('other-material', 'hub').open(a)).toThrow();
    expect(() => box.open('not-a-sealed-value')).toThrow(/Unrecognised/);
  });
  it('seals a record of credentials and drops blanks rather than sealing nothing', () => {
    const box = new SecretBox('m', 'hub');
    const sealed = box.sealAll({ apiKey: 'k', token: '', password: undefined });
    expect(Object.keys(sealed)).toEqual(['apiKey']); expect(box.openAll(sealed)).toEqual({ apiKey: 'k' });
  });
  it('signs and compares digests in constant time, and never matches an empty digest', () => {
    const sig = hmacSha256Hex('shared', 'body');
    expect(sig).toMatch(/^[0-9a-f]{64}$/); expect(digestsMatch(sig, hmacSha256Hex('shared', 'body'))).toBe(true);
    expect(digestsMatch(sig, hmacSha256Hex('other', 'body'))).toBe(false); expect(digestsMatch('', '')).toBe(false); expect(digestsMatch(sig, sig.slice(1))).toBe(false);
    expect(randomSecret()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe('the integration client', () => {
  let server: Server; let port = 0; let last: { url?: string; token?: string; body?: unknown } = {}; let answer: (req: { operation: string }) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}; last = { url: req.url, token: req.headers['x-service-token'] as string, body };
        const a = answer(body); res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r(); }));
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  const client = () => new IntegrationClient(`http://127.0.0.1:${port}/`, 'svc-token', 2000);

  it('names the adapter and operation on the service token and hands back the outcome', async () => {
    answer = (b) => ({ status: 200, body: { data: { callId: '1', adapter: 'mohre', operation: b.operation, status: 'ok', mode: 'stub', httpStatus: 200, attempts: 1, durationMs: 3, data: { employed: true } } } });
    const out = await client().call<{ employed: boolean }>('mohre', 'verifyEmployment', { emiratesId: '784-1990-1234567-1' }, { idempotencyKey: 'k1', correlationId: 'c1' });
    expect(out.status).toBe('ok'); expect(out.data.employed).toBe(true);
    expect(last.url).toBe('/internal/call/mohre'); expect(last.token).toBe('svc-token');
    expect(last.body).toMatchObject({ operation: 'verifyEmployment', payload: { emiratesId: '784-1990-1234567-1' }, idempotencyKey: 'k1', correlationId: 'c1' });
  });
  it('treats a counterpart failure as an outcome and a hub failure as an exception', async () => {
    answer = () => ({ status: 200, body: { data: { callId: '2', adapter: 'x', operation: 'y', status: 'dead', mode: 'live', httpStatus: 503, attempts: 3, durationMs: 90, data: null, error: 'HTTP 503' } } });
    expect((await client().call('x', 'y')).status).toBe('dead');
    answer = () => ({ status: 404, body: { message: 'unknown adapter nope' } });
    await expect(client().call('nope', 'y')).rejects.toBeInstanceOf(HubUnavailable);
    await expect(client().call('nope', 'y')).rejects.toThrow(/unknown adapter nope/);
    answer = () => ({ status: 200, body: 'not json' });
    await expect(client().call('x', 'y')).rejects.toThrow(/not JSON/);
    const down = new IntegrationClient('http://127.0.0.1:1', 't', 500);
    await expect(down.call('x', 'y')).rejects.toThrow(/unreachable/);
    expect(await down.tryCall('x', 'y')).toMatchObject({ status: 'unavailable' });
  });
});
